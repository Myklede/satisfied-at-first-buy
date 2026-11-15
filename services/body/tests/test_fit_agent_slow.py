"""Fit Agent on a real Anny body (slow): the numbers are exactly the analytic engine's.

The chart is the parser-structure fixture (NOT product data); the body is a public-range example
request (170 cm / 70 kg), not a person.
"""

from pathlib import Path

import pytest
from body_service import config
from body_service.agent import agent_config as ac
from body_service.agent.convert import to_spec
from body_service.agent.extract import Resolved
from body_service.agent.pagetext import read_saved_page
from body_service.agent.recommend import recommend
from body_service.agent.router import create_router
from body_service.agent.rules import parse_rules
from body_service.garment.fit_math import arm_route, back_route, fit_size
from body_service.schemas import FitRequest
from fastapi import FastAPI
from fastapi.testclient import TestClient

FIXTURE = Path(__file__).parent / "fixtures" / "fit_agent" / "parser-structure-garment.html"
REQUEST = FitRequest(height_cm=170, weight_kg=70, sex="male")


@pytest.fixture(autouse=True)
def isolated_store(tmp_path, monkeypatch):
    monkeypatch.setenv(ac.STORE_DIR_ENV, str(tmp_path / "store"))
    monkeypatch.setenv("FIT_AGENT_REVIEWED_DIR", str(tmp_path / "reviewed"))


@pytest.mark.slow
def test_agent_reuses_fit_math_numbers_exactly(fitter):
    page = read_saved_page(FIXTURE.read_text(encoding="utf-8")).content
    extraction = parse_rules(page)
    body = fitter.fit(REQUEST)
    result = recommend(body, Resolved(extraction, "rules", []), "regular", "t-shirt", {}, "test")
    spec, _ = to_spec(extraction)
    routes = {"L": arm_route(body, "L"), "R": arm_route(body, "R"), "back": back_route(body)}
    layer = config.LAYER_PRESETS_CM["t-shirt"]
    for view in result.sizes:
        direct = fit_size(body, spec, view.size, layer, "regular", routes)
        for zone in view.zones:
            metric = direct.zones[zone.zone]
            assert zone.status == metric.status
            if metric.value_cm is None:
                assert zone.value_cm is None
            else:
                assert zone.value_cm == pytest.approx(metric.value_cm, abs=0.005)
                assert zone.value_in == pytest.approx(metric.value_cm / 2.54, abs=0.005)
    assert {"shoulder", "chest", "sleeve"} <= set(result.comparison_zones)
    assert result.recommended_size in {"S", "M", "L", "XL"}


@pytest.mark.slow
def test_chest_offset_moves_the_target_not_the_shown_number(fitter):
    page = read_saved_page(FIXTURE.read_text(encoding="utf-8")).content
    resolved = Resolved(parse_rules(page), "rules", [])
    body = fitter.fit(REQUEST)
    plain = recommend(body, resolved, "regular", "t-shirt", {}, "test")
    learned = recommend(body, resolved, "regular", "t-shirt", {"chest": 4.0}, "test")
    for before, after in zip(plain.sizes, learned.sizes, strict=True):
        a = next(z for z in before.zones if z.zone == "chest")
        b = next(z for z in after.zones if z.zone == "chest")
        assert b.value_cm == a.value_cm  # real ease unchanged
        assert b.adjusted_value_cm == pytest.approx(a.value_cm - 4.0, abs=0.01)


@pytest.mark.slow
def test_router_session_recommendation_on_a_real_body(fitter):
    app = FastAPI()
    app.include_router(create_router(lambda: fitter, {}))
    page = read_saved_page(FIXTURE.read_text(encoding="utf-8")).content
    response = TestClient(app).post(
        "/agent/recommend",
        json={
            "page": page.model_dump(mode="json"),
            "body": {"mode": "session", "fit_request": REQUEST.model_dump(mode="json")},
            "layer": "hoodie",
        },
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["layer"] == "hoodie" and data["trace"][2]["status"] == "done"
    assert any("cm" in line and "in)" in line for line in data["explanation"])
