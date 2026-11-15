"""Synthetic charts, real Anny body/fit/ranking; no expected fit is hard-coded."""

import pytest
from body_service.agent.explanation import explain_ranking, status_words
from body_service.agent.extract import Resolved
from body_service.agent.models import PageContent, PageTable
from body_service.agent.recommend import recommend
from body_service.agent.rules import parse_rules
from body_service.schemas import FitRequest


@pytest.mark.slow
@pytest.mark.parametrize("chart_type", ["body", "garment"])
@pytest.mark.parametrize("offset", [0.0, 4.0])
def test_story_matches_real_engine_grid(fitter, chart_type, offset):
    body = fitter.fit(FitRequest(height_cm=170, weight_kg=70, sex="male"))
    chest = body.response.measurements["chest"].value_cm
    seen = set()
    for shift in [-35, 0, 35]:
        page = PageContent(
            asin="B0STORY001",
            title="Synthetic shirt",
            url="https://www.amazon.com/dp/B0STORY001",
            tables=[
                PageTable(
                    heading=f"{chart_type} measurements cm",
                    rows=[
                        ["Size", "Chest"],
                        ["S", str(chest + shift + (10 if chart_type == "garment" else 0))],
                        ["M", str(chest + shift + (14 if chart_type == "garment" else 4))],
                        ["L", str(chest + shift + (18 if chart_type == "garment" else 8))],
                    ],
                )
            ],
        )
        resolved = Resolved(parse_rules(page), "rules", [])
        base = recommend(body, resolved, "regular", "t-shirt", {}, "test")
        result = recommend(body, resolved, "regular", "t-shirt", {"chest": offset}, "test")
        pick = next(s for s in result.sizes if s.size == result.recommended_size)
        for zone in pick.zones:
            if zone.value_cm is not None:
                seen.add(zone.adjusted_status or zone.status)
                assert status_words(zone) in result.explanation[0]
        changed = base.recommended_size != result.recommended_size
        assert any("Without it we would pick" in line for line in result.explanation) == changed
        assert len(result.explanation) <= 3
        assert result.explanation == explain_ranking(
            result.sizes, result.recommended_size, base.recommended_size, {"chest": offset}
        )
    assert {"tight", "fit", "too_big"} <= seen


def test_round_before_formatting_negative_zero():
    from body_service.agent.explanation import signed

    assert signed(-0.0) == "0.0"
    assert signed(-0.04) == "0.0"
    assert signed(0.04) == "0.0"
    assert signed(-1.26) == "-1.3"


def test_printed_outer_chest_explains_missing_insulation(fitter):
    body = fitter.fit(FitRequest(height_cm=170, weight_kg=70, sex="male"))
    page = PageContent(
        asin="B0STORY001",
        title="Synthetic insulated puffer jacket",
        url="https://www.amazon.com/dp/B0STORY001",
        tables=[
            PageTable(
                heading="Garment measurements cm",
                rows=[["Size", "Chest", "Shoulder"], ["S", "100", "44"], ["M", "110", "46"]],
            )
        ],
    )
    result = recommend(
        body, Resolved(parse_rules(page), "rules", []), "regular", "t-shirt", {}, "test"
    )
    for size in result.sizes:
        chest = next(z for z in size.zones if z.zone == "chest")
        assert chest.value_cm is None
        assert chest.text == "chart lists outer chest; inner room unknown (insulation not measured)"
