"""Fit Agent (M5) fast tests: parser, conversion, learning, providers, privacy, router.

Bodies here are SYNTHETIC stand-ins (explicit numbers, labelled) for the body-chart path, which
only reads body measurements; the real Anny body path is in test_fit_agent_slow.py. HTML inputs
are parser-structure fixtures (tests/fixtures/fit_agent/README.md), never product data.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from body_service.agent import agent_config as ac
from body_service.agent import learning, providers, store
from body_service.agent.cli import SCHEMA_PATH, schema
from body_service.agent.cli import main as cli_main
from body_service.agent.convert import apply_offsets, estimated_garment, to_spec
from body_service.agent.extract import ExtractionFailed, from_llm, resolve
from body_service.agent.models import PageContent, PageTable
from body_service.agent.numbers import all_numbers, parse_cell
from body_service.agent.pagetext import read_saved_page
from body_service.agent.router import create_router
from body_service.agent.rules import ChartUnclear, canonical_size, parse_rules
from body_service.schemas import Measurement
from fastapi import FastAPI
from fastapi.testclient import TestClient

FIXTURES = Path(__file__).parent / "fixtures" / "fit_agent"
BODY_KEYS = (
    "height_cm",
    "weight_kg",
    "fit_request",
    "known_measurements",
    "sex",
    "profile",
    "feedback",
    "purchases",
    "chest_cm",
    'measurements":{"chest',
)


def page(name: str) -> PageContent:
    return read_saved_page((FIXTURES / name).read_text(encoding="utf-8")).content


@pytest.fixture(autouse=True)
def isolated_store(tmp_path, monkeypatch):
    monkeypatch.setenv(ac.STORE_DIR_ENV, str(tmp_path / "store"))
    monkeypatch.setenv("FIT_AGENT_REVIEWED_DIR", str(tmp_path / "reviewed"))
    monkeypatch.delenv(ac.KIOSK_MODE_ENV, raising=False)
    monkeypatch.delenv(ac.ALLOW_PAID_ENV, raising=False)
    monkeypatch.delenv(ac.EXTENSION_ID_ENV, raising=False)
    return tmp_path


# --- numbers and parsing ---------------------------------------------------------------
@pytest.mark.parametrize(
    ("cell", "expected"),
    [
        ("38", (38.0, None, None)),
        ("38.5 in", (38.5, None, None)),
        ("38 1/2", (38.5, None, None)),
        ("21½", (21.5, None, None)),
        ("36-38", (None, 36.0, 38.0)),
        ("36 – 38", (None, 36.0, 38.0)),
        ("96~101 cm", (None, 96.0, 101.0)),
        ("n/a", (None, None, None)),
    ],
)
def test_parse_cell(cell, expected):
    assert parse_cell(cell) == expected


def test_all_numbers_reads_mixed_fractions_and_ranges():
    assert {38.5, 38.0, 0.5, 36.0, 40.0} <= all_numbers("Chest 38 1/2 | 36-40")


@pytest.mark.parametrize(
    ("label", "name"),
    [
        ("X-Large", "XL"),
        ("XX-Large", "2XL"),
        ("Small", "S"),
        ("M", "M"),
        ("3X", "3XL"),
        ("Medium (38-40)", "M"),
        ("10", "10"),
        ("Chest", None),
    ],
)
def test_canonical_size(label, name):
    assert canonical_size(label) == name


def test_rules_garment_chart_inches_flat_chest():
    extraction = parse_rules(page("parser-structure-garment.html"))
    assert extraction.chart_type == "garment"
    assert extraction.unit == "in"
    assert extraction.flat_fields == ["chest"]
    assert [s.name for s in extraction.sizes] == ["S", "M", "L", "XL"]
    medium = extraction.sizes[1].measurements
    assert medium["chest"].value == 21.5 and medium["chest"].raw == "21½"
    assert extraction.category == "jacket" and extraction.provenance.source == "rules"


def test_rules_body_chart_ranges():
    extraction = parse_rules(page("parser-structure-body.html"))
    assert extraction.chart_type == "body" and extraction.unit == "cm"
    assert extraction.sizes[0].measurements["chest"].min == 78
    assert any("body measurements" in e for e in extraction.evidence)


def test_rules_unclear_chart_needs_a_decision():
    content = page("parser-structure-unclear.html")
    with pytest.raises(ChartUnclear):
        parse_rules(content)
    assert parse_rules(content, "garment").chart_type == "garment"


# --- conversion ----------------------------------------------------------------------
def test_garment_conversion_inches_and_flat_doubling():
    spec, notes = to_spec(parse_rules(page("parser-structure-garment.html")))
    medium = spec.sizes["M"]
    assert medium.chest.value_cm == pytest.approx(21.5 * 2 * 2.54)
    assert medium.length_hps.value_cm == pytest.approx(28 * 2.54)
    assert medium.shoulder.value_cm == pytest.approx(17.75 * 2.54)
    assert "flat half-width ×2" in medium.chest.source_detail
    assert spec.loft_cm == 0.0  # thin nylon shell, no insulation words


def test_body_chart_estimated_garment_is_body_plus_standard_ease():
    extraction = parse_rules(page("parser-structure-body.html"))
    spec, _ = to_spec(extraction)
    assert spec.chart_type == "body"
    assert spec.sizes["S"].chest.min_cm == 82 and spec.sizes["S"].hem.max_cm == 94  # hip → hem
    estimate = estimated_garment(extraction)
    ease = ac.STANDARD_CHEST_EASE_CM["regular"]
    assert estimate["S"]["chest"] == [82 + ease, 86 + ease]


def test_offsets_shift_sizes_without_touching_the_original():
    spec, _ = to_spec(parse_rules(page("parser-structure-garment.html")))
    shifted = apply_offsets(spec, {"chest": 2.0, "shoulder": 1.0})
    assert shifted.sizes["M"].chest.value_cm == pytest.approx(spec.sizes["M"].chest.value_cm - 2)
    assert shifted.sizes["M"].shoulder.value_cm == pytest.approx(
        spec.sizes["M"].shoulder.value_cm - 2
    )
    # The cuff stays put: the sleeve gains what the half-shoulder lost.
    assert shifted.sizes["M"].sleeve.value_cm == pytest.approx(spec.sizes["M"].sleeve.value_cm + 1)
    assert apply_offsets(spec, {}) == spec


# --- learning --------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("answer", "predicted", "sign"),
    [
        ("tight", "fit", 1),
        ("tight", "tight", 0),
        ("loose", "fit", -1),
        ("loose", "relaxed", 0),
        ("right", "tight", -1),
        ("right", "too_big", 1),
        ("right", "fit", 0),
        ("tight", "unknown", 0),
    ],
)
def test_learning_step_only_on_disagreement(answer, predicted, sign):
    value = learning.step(answer, predicted, "chest")
    assert value == sign * ac.LEARN_STEP_CM["chest"]


def test_learning_offsets_are_bounded_and_explained():
    purchases = [
        {
            "id": f"{i:032x}",
            "asin": "B0PARSER01",
            "size": "M",
            "title": "Fixture",
            "snapshot": {"chest": {"status": "fit", "value_cm": 8.0}},
            "feedback": {"answers": {"chest": "tight"}},
        }
        for i in range(10)
    ]
    offsets, items = learning.offsets(purchases)
    assert offsets == {"chest": ac.LEARN_MAX_CM["chest"]}
    assert "you said 'tight' for size M" in items[0]["text"]
    assert learning.describe(offsets)[0].startswith("You prefer 6.0 cm")


# --- providers: billing guard, untrusted content, paid switch ---------------------------
class FakeRun:
    def __init__(self, auth: dict, output: dict | None = None, code: int = 0) -> None:
        self.auth, self.output, self.code, self.calls = auth, output, code, []

    def __call__(self, args, stdin, env, timeout, cwd):
        self.calls.append({"args": args, "stdin": stdin, "env": dict(env), "timeout": timeout})
        stdout = json.dumps(self.auth if args[1:3] == ["auth", "status"] else self.output)
        return subprocess.CompletedProcess(args, self.code, stdout, "")


SUBSCRIPTION = {
    "loggedIn": True,
    "authMethod": "claude.ai",
    "apiProvider": "firstParty",
    "subscriptionType": "max",
}


def llm_answer(chest: float = 102, chart_type: str = "garment") -> dict:
    return {
        "found": True,
        "category": "sweatshirt",
        "chart_type": chart_type,
        "unit": "cm",
        "flat_fields": [],
        "fit_intent": "regular",
        "construction": "set_in",
        "fabric": "",
        "evidence": ["test"],
        "headers": [{"field": "chest", "header": "Chest (cm)"}],
        "sizes": [
            {
                "name": "M",
                "measurements": [
                    {"field": "chest", "value": chest, "min": None, "max": None, "raw": str(chest)}
                ],
            }
        ],
    }


def test_billing_guard_strips_api_and_cloud_variables(monkeypatch):
    for name in ac.CLAUDE_CLI_STRIPPED_ENV:
        monkeypatch.setenv(name, "must-not-reach-the-cli")
    monkeypatch.setenv("PATH_MARKER_FOR_TEST", "kept")
    run = FakeRun(
        SUBSCRIPTION,
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "structured_output": llm_answer(),
        },
    )
    cli = providers.ClaudeCliProvider(runner=run, executable="claude.exe")
    cli.extract(page("parser-structure-unclear.html"))
    assert len(run.calls) == 2  # auth status, then the prompt
    for call in run.calls:
        for name in ac.CLAUDE_CLI_STRIPPED_ENV:
            assert name not in call["env"]
        assert call["env"]["PATH_MARKER_FOR_TEST"] == "kept"


def test_cli_runs_without_tools_and_page_goes_on_stdin():
    run = FakeRun(SUBSCRIPTION, {"subtype": "success", "result": json.dumps(llm_answer())})
    cli = providers.ClaudeCliProvider(runner=run, executable="claude.exe")
    content = page("parser-structure-unclear.html")
    cli.extract(content)
    args, stdin = run.calls[1]["args"], run.calls[1]["stdin"]
    assert args[args.index("--tools") + 1] == ""
    assert {"--strict-mcp-config", "--safe-mode", "--disable-slash-commands", "-p"} <= set(args)
    assert not any("skip-permissions" in a or a == "--add-dir" for a in args)
    assert content.title in stdin and content.title not in " ".join(args)
    assert run.calls[1]["timeout"] == ac.CLAUDE_CLI_TIMEOUT_S


def test_default_runner_never_uses_a_shell(monkeypatch, tmp_path):
    seen = {}

    def fake_run(args, **kwargs):
        seen.update(kwargs, args=args)
        return subprocess.CompletedProcess(args, 0, "{}", "")

    monkeypatch.setattr(providers.subprocess, "run", fake_run)
    providers._run(["claude.exe", "-p"], "x", {}, 5.0, tmp_path / "cwd")
    assert seen["shell"] is False and seen["input"] == "x" and seen["timeout"] == 5.0


def test_cli_refuses_without_a_subscription_login():
    run = FakeRun({"loggedIn": True, "authMethod": "api_key", "apiProvider": "firstParty"})
    cli = providers.ClaudeCliProvider(runner=run, executable="claude.exe")
    assert not cli.status().available
    with pytest.raises(providers.ProviderUnavailable):
        cli.extract(page("parser-structure-unclear.html"))
    assert len(run.calls) == 2  # only `auth status`, never a prompt


def test_cli_rate_limit():
    now = [0.0]
    run = FakeRun(SUBSCRIPTION, {"subtype": "success", "structured_output": llm_answer()})
    cli = providers.ClaudeCliProvider(runner=run, executable="claude.exe", clock=lambda: now[0])
    content = page("parser-structure-unclear.html")
    for _ in range(ac.CLAUDE_CLI_MAX_CALLS_PER_MINUTE):
        cli.extract(content)
    with pytest.raises(providers.ProviderUnavailable, match="rate limit"):
        cli.extract(content)
    now[0] = 61.0
    cli.extract(content)


def test_paid_providers_are_off_without_the_explicit_flag(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-not-used")
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")
    for provider in (
        providers.AnthropicProvider(client=object()),
        providers.BedrockProvider(client=object()),
    ):
        state = provider.status()
        assert not state.available and state.reason == ac.PAID_DISABLED_MESSAGE
        with pytest.raises(providers.ProviderUnavailable, match="disabled by user rule"):
            provider.extract(page("parser-structure-unclear.html"))


class FakeMessages:
    def __init__(self, stop_reason="end_turn", text=None):
        self.kwargs, self.stop_reason = None, stop_reason
        self.text = text if text is not None else json.dumps(llm_answer())

    def create(self, **kwargs):
        self.kwargs = kwargs
        block = SimpleNamespace(type="text", text=self.text)
        return SimpleNamespace(
            stop_reason=self.stop_reason,
            content=[block],
            stop_details=SimpleNamespace(category="cyber"),
        )


def test_paid_provider_payload_is_product_only_and_refusal_is_handled(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-not-used")
    monkeypatch.setenv(ac.ALLOW_PAID_ENV, "1")
    messages = FakeMessages()
    provider = providers.AnthropicProvider(
        client=SimpleNamespace(beta=SimpleNamespace(messages=messages))
    )
    provider.extract(page("parser-structure-unclear.html"))
    sent = json.dumps(messages.kwargs, default=str)
    assert messages.kwargs["model"] == "claude-opus-5-5"
    assert messages.kwargs["output_config"]["format"]["type"] == "json_schema"
    assert messages.kwargs["fallbacks"] == "default"
    assert not any(key in sent for key in BODY_KEYS)
    refused = providers.AnthropicProvider(
        client=SimpleNamespace(beta=SimpleNamespace(messages=FakeMessages(stop_reason="refusal")))
    )
    with pytest.raises(providers.ProviderFailed, match="refused"):
        refused.extract(page("parser-structure-unclear.html"))


class FakeProvider(providers.LLMProvider):
    name = "claude_cli"

    def __init__(self, answer: dict | None = None) -> None:
        self.answer, self.messages = answer or llm_answer(), []

    def status(self):
        return providers.ProviderStatus(self.name, False, True, "test double")

    def _complete(self, system, user):
        self.messages.append(user)
        return self.answer


def test_llm_numbers_must_be_printed_on_the_page():
    content = page("parser-structure-unclear.html")
    assert from_llm(llm_answer(102), content, "claude_cli").sizes[0].name == "M"
    with pytest.raises(providers.ProviderFailed, match="not printed"):
        from_llm(llm_answer(103.5), content, "claude_cli")


# --- resolution order --------------------------------------------------------------------
def reviewed_file(tmp_path: Path) -> Path:
    data = parse_rules(page("parser-structure-garment.html")).model_dump(mode="json")
    data["provenance"] = {
        "source": "reviewed",
        "provider": None,
        "extracted_by": "coordinator",
        "reviewed": True,
        "date": "2026-11-12",
        "source_page": "parser-structure-garment.html",
    }
    path = tmp_path / "reviewed" / "B0PARSER01.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def test_resolution_order_reviewed_then_rules_then_llm(isolated_store):
    llm = FakeProvider()
    assert (
        resolve(page("parser-structure-garment.html"), None, {"claude_cli": llm}).label == "rules"
    )
    reviewed_file(isolated_store)
    resolved = resolve(page("parser-structure-garment.html"), None, {"claude_cli": llm})
    assert resolved.label == "reviewed extraction"
    resolved = resolve(page("parser-structure-unclear.html"), None, {"claude_cli": llm})
    assert resolved.label == "LLM (claude_cli)" and len(llm.messages) == 1
    # Cached by ASIN + page content: no second LLM call.
    again = resolve(page("parser-structure-unclear.html"), None, {"claude_cli": llm})
    assert again.label == "LLM (claude_cli), cached" and len(llm.messages) == 1


def test_llm_failure_is_labelled_and_paid_rule_is_reported(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-not-used")
    pool = {
        "claude_cli": FakeProvider(llm_answer(999)),
        "anthropic": providers.AnthropicProvider(client=object()),
    }
    with pytest.raises(ExtractionFailed) as caught:
        resolve(page("parser-structure-unclear.html"), None, pool)
    notes = " ".join(caught.value.notes)
    assert "claude_cli: failed" in notes and "fell back" in notes
    assert ac.PAID_DISABLED_MESSAGE in notes and caught.value.unclear


# --- CLI ------------------------------------------------------------------------------
def test_cli_validate_accepts_printed_numbers_and_rejects_invented(isolated_store, capsys):
    path = reviewed_file(isolated_store)
    html = FIXTURES / "parser-structure-garment.html"
    assert cli_main(["validate", str(path), str(html)]) == 0
    data = json.loads(path.read_text(encoding="utf-8"))
    data["sizes"][0]["measurements"]["chest"]["value"] = 20.75
    path.write_text(json.dumps(data), encoding="utf-8")
    assert cli_main(["validate", str(path), str(html)]) == 1
    assert "S.chest=20.75" in capsys.readouterr().err


def test_committed_schema_matches_the_model():
    assert json.loads(SCHEMA_PATH.read_text(encoding="utf-8")) == schema()


# --- router: privacy, profile, feedback ------------------------------------------------
def synthetic_body() -> SimpleNamespace:
    """SYNTHETIC body (explicit test numbers, not a person): body-chart mode reads only these."""
    values = {
        "chest": 88.0,
        "hip": 96.0,
        "shoulder_width": 38.0,
        "arm_length": 56.0,
        "upper_arm": 27.0,
    }
    measurements = {
        k: Measurement(value_cm=v, method="synthetic test value") for k, v in values.items()
    }
    return SimpleNamespace(
        response=SimpleNamespace(measurements=measurements),
        geometry=SimpleNamespace(landmarks={}),
        uncertainty=None,
    )


class SyntheticFitter:
    def __init__(self) -> None:
        self.requests = []

    def fit(self, request):
        self.requests.append(request)
        return synthetic_body()


FIT_REQUEST = {
    "height_cm": 181.5,
    "weight_kg": 77.7,
    "sex": "female",
    "known_measurements": {"chest_cm": 88.0},
}


def client(pool=None, fitter=None) -> tuple[TestClient, SyntheticFitter]:
    fitter = fitter or SyntheticFitter()
    app = FastAPI()
    app.include_router(create_router(lambda: fitter, pool or {"claude_cli": FakeProvider()}))
    return TestClient(app), fitter


def test_outgoing_llm_payload_has_no_body_fields():
    llm = FakeProvider(llm_answer(chart_type="body"))  # body chart: synthetic body suffices
    api, _ = client({"claude_cli": llm})
    response = api.post(
        "/agent/recommend",
        json={
            "page": page("parser-structure-unclear.html").model_dump(mode="json"),
            "body": {"mode": "session", "fit_request": FIT_REQUEST},
        },
    )
    assert response.status_code == 200, response.text
    assert len(llm.messages) == 1
    sent = llm.messages[0]
    assert not any(key in sent for key in BODY_KEYS)
    assert "181.5" not in sent and "77.7" not in sent


def test_profile_opt_in_view_and_one_call_deletion(isolated_store):
    api, _ = client()
    assert (
        api.put("/agent/profile", json={"consent": False, "fit_request": FIT_REQUEST}).status_code
        == 422
    )
    assert (
        api.put("/agent/profile", json={"consent": True, "fit_request": FIT_REQUEST}).status_code
        == 200
    )
    assert store.profile_path().exists()
    view = api.get("/agent/profile").json()
    assert view["saved"] and view["profile"]["fit_request"]["height_cm"] == 181.5
    deleted = api.delete("/agent/profile").json()
    assert deleted["deleted"] == ["profile.json"]
    assert not store.profile_path().exists() and not store.learning_path().exists()
    assert api.get("/agent/profile").json() == {
        "saved": False,
        "kiosk_mode": False,
        "profile": None,
        "location": "local file .cache/fit-agent/profile.json (never uploaded)",
    }
    assert not any(isolated_store.joinpath("store").glob("profile*"))


def test_kiosk_mode_never_persists_or_reads_a_profile(monkeypatch):
    api, _ = client()
    api.put("/agent/profile", json={"consent": True, "fit_request": FIT_REQUEST})
    monkeypatch.setenv(ac.KIOSK_MODE_ENV, "1")
    assert api.get("/agent/profile").json()["saved"] is False
    store.delete_personal()
    response = api.put("/agent/profile", json={"consent": True, "fit_request": FIT_REQUEST})
    assert response.status_code == 403 and not store.profile_path().exists()
    recommend = api.post(
        "/agent/recommend",
        json={
            "page": page("parser-structure-body.html").model_dump(mode="json"),
            "body": {"mode": "profile"},
        },
    )
    assert recommend.status_code == 403


@pytest.mark.parametrize("origin", ["http://127.0.0.1:5730", "https://evil.example"])
def test_web_origins_cannot_touch_personal_data(origin):
    api, _ = client()
    headers = {"Origin": origin}
    assert api.get("/agent/profile", headers=headers).status_code == 403
    assert (
        api.put(
            "/agent/profile", headers=headers, json={"consent": True, "fit_request": FIT_REQUEST}
        ).status_code
        == 403
    )
    assert api.delete("/agent/learning", headers=headers).status_code == 403
    ok = api.get("/agent/profile", headers={"Origin": "chrome-extension://abcdefghijklmnop"})
    assert ok.status_code == 200


def test_body_chart_recommendation_feedback_learning_and_undo():
    api, fitter = client()
    content = page("parser-structure-body.html").model_dump(mode="json")
    api.put("/agent/profile", json={"consent": True, "fit_request": FIT_REQUEST})
    first = api.post("/agent/recommend", json={"page": content, "body": {"mode": "profile"}})
    assert first.status_code == 200, first.text
    result = first.json()
    # Synthetic chest 88 / hip 96 sits inside M's body ranges (86-90, 94-98).
    assert result["recommended_size"] == "M"
    assert result["extraction"]["source_label"] == "rules"
    assert result["extraction"]["garment_estimated"] is True
    assert [s["step"] for s in result["trace"]] == [
        "read_page",
        "classify_chart",
        "compute_fit",
        "choose",
        "explain",
    ]
    chest = next(
        z for s in result["sizes"] if s["size"] == "M" for z in s["zones"] if z["zone"] == "chest"
    )
    assert chest["status"] == "fit" and chest["value_cm"] == 0 and chest["value_in"] == 0
    assert fitter.requests[-1].height_cm == 181.5

    bought = api.post("/agent/purchases", json={"asin": "B0PARSER02", "size": "M"}).json()
    learned = api.post(
        "/agent/feedback", json={"purchase_id": bought["id"], "answers": {"chest": "tight"}}
    ).json()
    assert learned["offsets_cm"] == {"chest": ac.LEARN_STEP_CM["chest"]}
    assert "more room at chest" in learned["learned"][0]

    second = api.post("/agent/recommend", json={"page": content, "body": {"mode": "profile"}})
    after = second.json()
    chest = next(
        z for s in after["sizes"] if s["size"] == "M" for z in s["zones"] if z["zone"] == "chest"
    )
    assert chest["value_cm"] == 0  # the real number is unchanged
    assert chest["personal_offset_cm"] == ac.LEARN_STEP_CM["chest"]
    assert chest["adjusted_status"] == "fit"  # 88 + 2 = 90, still inside 86-90

    undone = api.delete(f"/agent/learning/{bought['id']}").json()
    assert undone["offsets_cm"] == {} and undone["purchases"] == []


def test_session_body_never_writes_files(isolated_store):
    api, _ = client()
    response = api.post(
        "/agent/recommend",
        json={
            "page": page("parser-structure-body.html").model_dump(mode="json"),
            "body": {"mode": "session", "fit_request": FIT_REQUEST},
        },
    )
    assert response.status_code == 200
    stored = {p.name for p in (isolated_store / "store").rglob("*") if p.is_file()}
    assert stored == {"B0PARSER02.json"}  # product extraction cache only
    cached = (isolated_store / "store" / "extractions" / "B0PARSER02.json").read_text()
    assert "181.5" not in cached and "height_cm" not in cached


def test_status_reports_the_paid_rule(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-not-used")
    api, _ = client(
        {"claude_cli": FakeProvider(), "anthropic": providers.AnthropicProvider(client=object())}
    )
    status = api.get("/agent/status").json()
    paid = next(p for p in status["providers"] if p["name"] == "anthropic")
    assert paid["reason"] == ac.PAID_DISABLED_MESSAGE and not paid["available"]
    assert status["resolution_order"][:2] == ["reviewed extraction", "rules"]


def test_page_content_rejects_unknown_fields_and_non_amazon_urls():
    with pytest.raises(ValueError):
        PageContent(asin="B0PARSER01", url="https://evil.example/dp/B0PARSER01")
    with pytest.raises(ValueError):
        PageContent.model_validate(
            {"asin": "B0PARSER01", "url": "https://www.amazon.com/dp/x", "height_cm": 180}
        )
    assert PageTable(rows=[["Size", "Chest"], ["M", "40"]]).rows[1] == ["M", "40"]


# --- user's saved pages (gitignored); skip when absent ------------------------------------
SAVED = sorted(ac.PAGES_DIR.glob("*.htm*")) if ac.PAGES_DIR.exists() else []


@pytest.mark.skipif(not SAVED, reason="No saved Amazon pages in data/amazon-pages/ (user to add)")
@pytest.mark.parametrize("path", SAVED, ids=lambda p: p.name)
def test_saved_amazon_page_reads_and_never_invents(path):
    saved = read_saved_page(path.read_text(encoding="utf-8", errors="replace"))
    try:
        extraction = parse_rules(saved.content)
    except ValueError as error:
        pytest.skip(f"{path.name}: rules parser cannot decide ({error}); needs review or LLM")
    from body_service.agent.extract import missing_numbers

    assert missing_numbers(extraction, saved.text) == []


def test_ranges_in_girth_columns_are_body_chart_evidence():
    """Structure seen on Amazon's standard size-chart popover: no words, only ranges."""
    rows = [
        ["Brand Size", "Chest (in)", "Waist (in)", "Sleeve Length (in)"],
        ["Small", "35 - 37", "29.5 - 31.5", "34"],
        ["Medium", "38 - 40", "32.5 - 34.5", "34.5 - 35"],
        ["Large", "42 - 44", "36.5 - 38.5", "35.5 - 36"],
    ]
    content = PageContent(
        asin="B0PARSER04",
        url="https://www.amazon.com/dp/B0PARSER04",
        title="Fixture Men's Puffer Jacket",
        tables=[PageTable(heading="US MEN OUTERWEAR", rows=rows)],
    )
    extraction = parse_rules(content)
    assert extraction.chart_type == "body" and extraction.unit == "in"
    assert extraction.evidence == [
        "body: girths are printed as ranges (a range describes the bodies a size fits)"
    ]
    spec, notes = to_spec(extraction)
    assert spec.sizes["M"].chest.min_cm == pytest.approx(38 * 2.54)
    assert any("sleeve" in note and "waist" in note for note in notes)


# --- rules parser: several chart tables, conflicts, reviewed answers (R1) ------------------
def test_multitable_title_words_pick_the_table():
    """Structure test: 'Softshell' is in the product title, so that table wins over the others."""
    extraction = parse_rules(page("parser-structure-multitable.html"))
    assert [s.name for s in extraction.sizes] == ["S", "M", "L", "XL"]
    assert extraction.evidence[0].startswith("Chart table 'US Softshell' chosen among 3")
    assert "title words appear in the product title" in extraction.evidence[0]
    assert extraction.chart_type == "garment"


def test_multitable_size_rows_then_regular():
    """Structure test: exact size-set match beats superset; the tie is broken by 'Regular'."""
    extraction = parse_rules(page("parser-structure-multitable-size.html"))
    assert extraction.evidence[0].startswith("Chart table 'US Regular' chosen among 3")
    assert "exactly the page's size options" in extraction.evidence[0]
    assert "'Regular'/'Standard'" in extraction.evidence[0]
    assert "length" in extraction.sizes[0].measurements


def test_multitable_still_tied_is_unclear_and_lists_tables():
    with pytest.raises(ChartUnclear, match="Chart A.*Chart B"):
        parse_rules(page("parser-structure-multitable-tied.html"))


def test_conflicting_evidence_is_unclear():
    """Structure test: 'body measurements' wording against single-value garment-shaped columns."""
    with pytest.raises(ChartUnclear, match="body or garment"):
        parse_rules(page("parser-structure-conflict.html"))


def test_fit_type_row_sets_fit_intent():
    content = page("parser-structure-garment.html").model_copy(
        update={
            "tables": [PageTable(heading="Style", rows=[["Color", "Red"], ["Fit Type", "Slim"]])]
            + page("parser-structure-garment.html").tables
        }
    )
    extraction = parse_rules(content)
    assert extraction.fit_intent == "slim"
    assert "Fit intent 'slim' from the page's 'Fit Type: Slim'" in extraction.assumptions


REVIEWED = ac.PAGES_DIR / "reviewed"


def _reviewed_cases():
    cases = []
    for path in SAVED:
        text = path.read_text(encoding="utf-8", errors="replace")
        asin = read_saved_page(text).content.asin
        reviewed = REVIEWED / f"{asin}.json"
        if reviewed.exists():
            cases.append((path, reviewed))
    return cases


@pytest.mark.skipif(not _reviewed_cases(), reason="No saved page with a reviewed answer (local)")
@pytest.mark.parametrize("pair", _reviewed_cases(), ids=lambda p: p[0].name)
def test_rules_match_reviewed_answer_for_saved_pages(pair):
    path, reviewed_path = pair
    saved = read_saved_page(path.read_text(encoding="utf-8", errors="replace"))
    got = parse_rules(saved.content).model_dump(mode="json")
    want = json.loads(reviewed_path.read_text(encoding="utf-8"))
    assert got["chart_type"] == want["chart_type"] and got["unit"] == want["unit"]
    assert got["fit_intent"] == want["fit_intent"]
    assert [canonical_size(s["name"]) for s in got["sizes"]] == [
        canonical_size(s["name"]) for s in want["sizes"]
    ]
    for g, w in zip(got["sizes"], want["sizes"], strict=True):
        # The reviewer files "Sleeve Length" of a body chart as sleeve_cb (centre-back convention);
        # the rules parser cannot know that, so the same number under either key is accepted.
        norm = lambda m: {("sleeve" if k == "sleeve_cb" else k): v for k, v in m.items()}  # noqa: E731
        assert norm(g["measurements"]) == norm(w["measurements"]), g["name"]


def test_heading_with_identical_sibling_wrappers_does_not_recurse() -> None:
    """Regression: Node equality compared parents recursively (RecursionError on twin wrappers)."""
    from body_service.agent.pagetext import _heading, _TreeBuilder

    html = (
        "<div><div class='w'><table><tr><td>a</td></tr></table></div>"
        "<div class='w'><table><tr><td>b</td></tr></table></div></div>"
    )
    builder = _TreeBuilder()
    builder.feed(html)
    tables = builder.root.find_all("table")
    assert len(tables) == 2
    for table in tables:
        assert isinstance(_heading(table), str)
