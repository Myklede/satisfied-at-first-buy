"""LLM regular-size filtering via an injected runner; never invokes a real CLI or API."""

import json
import subprocess

import pytest
from body_service.agent import providers
from body_service.agent.extract import from_llm
from body_service.agent.models import PageContent, PageTable
from body_service.agent.rules import ChartUnclear, canonical_size, parse_rules


@pytest.mark.parametrize(
    "variant",
    ["Medium Tall", "Big Medium", "Small Petite", "Large Long", "M (Tall)", "M_Tall", "M(Tall)"],
)
def test_fake_cli_filters_variant_rows_without_renaming_them(variant, tmp_path, monkeypatch):
    monkeypatch.setenv("FIT_AGENT_STORE_DIR", str(tmp_path))
    page = PageContent(
        asin="B0SYNTH001",
        title="Synthetic shirt",
        url="https://www.amazon.com/dp/B0SYNTH001",
        tables=[
            PageTable(
                heading="Body measurements cm",
                rows=[
                    ["Size", "Chest"],
                    ["Small", "90"],
                    ["Medium", "100"],
                    [variant, "110"],
                ],
            )
        ],
    )
    answer = {
        "found": True,
        "category": "shirt",
        "chart_type": "body",
        "unit": "cm",
        "flat_fields": [],
        "fit_intent": "regular",
        "construction": "set_in",
        "fabric": "",
        "evidence": ["Body measurements cm"],
        "headers": [],
        "sizes": [
            {
                "name": name,
                "measurements": [
                    {"field": "chest", "value": value, "min": None, "max": None, "raw": str(value)},
                ],
            }
            for name, value in [("Small", 90), (variant, 110), ("Medium", 100)]
        ],
    }
    calls = []

    def runner(args, stdin, env, timeout, cwd):
        calls.append(args)
        result = (
            {
                "loggedIn": True,
                "authMethod": "claude.ai",
                "apiProvider": "firstParty",
                "subscriptionType": "max",
            }
            if args[1:3] == ["auth", "status"]
            else {"subtype": "success", "structured_output": answer}
        )
        return subprocess.CompletedProcess(args, 0, json.dumps(result), "")

    cli = providers.ClaudeCliProvider(runner=runner, executable="fake-claude.exe")
    extraction = from_llm(cli.extract(page), page, "claude_cli")
    assert canonical_size(variant) is None
    assert [(s.name, s.measurements["chest"].value) for s in extraction.sizes] == [
        ("S", 90),
        ("M", 100),
    ]
    assert [s.name for s in parse_rules(page).sizes] == ["S", "M"]
    assert "Excluded 1" in extraction.assumptions[-1]
    prompt_args = calls[1]
    schema = json.loads(prompt_args[prompt_args.index("--json-schema") + 1])
    name_schema = schema["properties"]["sizes"]["items"]["properties"]["name"]
    assert name_schema["pattern"] == r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,23}$"
    assert name_schema["pattern"] in prompt_args[prompt_args.index("--system-prompt") + 1]
    answer["sizes"] = [answer["sizes"][1]]
    with pytest.raises(ChartUnclear, match="no recognizable regular sizes"):
        from_llm(answer, page, "claude_cli")
