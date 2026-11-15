"""Catalogue jacket: the Fit Agent's pick is the 3D studio's own engine pick (slow, real Anny).

The page is built like scripts/amazon-demo-catalogue.mjs builds its local demonstration page: the
real local catalogue data printed as a chart to 0.1 cm (JS Math.round), not a retailer page.
Bodies are public-range example requests, not people; "e2e profile" is the extension e2e's
profile (70 in, 160 lb, chest 38 in).
"""

import math
import re

import pytest
from body_service import config
from body_service.agent import agent_config as ac
from body_service.agent.convert import catalogue_match
from body_service.agent.extract import Resolved
from body_service.agent.models import PageContent, PageTable
from body_service.agent.recommend import engine_ranking, recommend
from body_service.agent.router import create_router
from body_service.agent.rules import parse_rules
from body_service.garment.models import GarmentFitRequest, GarmentOptions
from body_service.garment.service import GarmentService
from body_service.schemas import FitRequest, KnownMeasurements
from fastapi import FastAPI
from fastapi.testclient import TestClient

BODIES = {
    "e2e profile": FitRequest(
        sex="male",
        height_cm=177.8,
        weight_kg=72.6,
        known_measurements=KnownMeasurements(chest_cm=96.5),
    ),
    "female 165 cm 58 kg": FitRequest(sex="female", height_cm=165, weight_kg=58),
    "male 185 cm 95 kg": FitRequest(sex="male", height_cm=185, weight_kg=95),
}
SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "2XL", "3XL"]


@pytest.fixture(autouse=True)
def isolated_store(tmp_path, monkeypatch):
    monkeypatch.setenv(ac.STORE_DIR_ENV, str(tmp_path / "store"))
    monkeypatch.setenv("FIT_AGENT_REVIEWED_DIR", str(tmp_path / "reviewed"))
    monkeypatch.delenv(ac.KIOSK_MODE_ENV, raising=False)


@pytest.fixture(scope="module")
def garments(fitter):
    return GarmentService(fitter)


@pytest.fixture(scope="module")
def product(garments):
    return next(p for p in garments.products.values() if re.search(r"/dp/[A-Z0-9]{10}", p.url))


@pytest.fixture(scope="module")
def page(product):
    asin = re.search(r"/dp/([A-Z0-9]{10})", product.url).group(1)
    assert catalogue_match(asin).product_id == product.product_id
    fields = ("chest", "shoulder", "sleeve", "length_hps")
    rows = [["Size", "Chest", "Shoulder", "Sleeve", "Length"]]
    for name, size in product.sizes.items():
        rows.append(
            [name]
            + [
                str(math.floor(getattr(size, f).value_cm * 10 + 0.5) / 10)
                if getattr(size, f) is not None and getattr(size, f).value_cm is not None
                else "not measured"
                for f in fields
            ]
        )
    return PageContent(
        asin=asin,
        url=f"https://www.amazon.com/dp/{asin}",
        title=f"{product.brand} {product.style} {product.category} — local catalogue",
        brand=product.brand,
        size_options=list(product.sizes),
        tables=[
            PageTable(
                heading="Garment measurements (cm), local tapes and estimated grades", rows=rows
            )
        ],
    )


def studio_fit(garments, body, product, layer="t-shirt", preference="regular"):
    """Exactly the studio's /garment/fit request: FitStudio.tsx sends layer_cm =
    GarmentOptions.layer_presets_cm[under] and the preference; with a hand-off, `under` and
    `preference` are the shopper's Fit Agent choices (handoff.ts knownChoices)."""
    return garments.fit(
        GarmentFitRequest(
            body_id=body.response.body_id,
            product_id=product.product_id,
            layer_cm=GarmentOptions().layer_presets_cm[layer],
            preference=preference,
        )
    ).response


@pytest.mark.slow
@pytest.mark.parametrize("label", list(BODIES))
def test_catalogue_pick_and_zones_are_the_studio_engine(fitter, garments, product, page, label):
    app = FastAPI()
    app.include_router(create_router(lambda: fitter, {}))
    response = TestClient(app).post(
        "/agent/recommend",
        json={
            "page": page.model_dump(mode="json"),
            "body": {"mode": "session", "fit_request": BODIES[label].model_dump(mode="json")},
        },
    )
    assert response.status_code == 200, response.text
    data = response.json()
    studio = studio_fit(garments, fitter.fit(BODIES[label]), product)
    assert studio.recommended_size is not None
    assert data["recommended_size"] == studio.recommended_size
    assert data["comparison_zones"] == studio.comparison_zones
    assert {s["size"] for s in data["sizes"]} == set(studio.sizes)
    for view in data["sizes"]:
        engine = studio.sizes[view["size"]]
        assert view["score"] == pytest.approx(engine.score, abs=0.05)
        for zone in view["zones"]:  # collar included
            metric = engine.zones[zone["zone"]]
            assert zone["status"] == metric.status
            assert zone["metric"] == metric.metric
            if metric.value_cm is None:
                assert zone["value_cm"] is None
            else:
                assert zone["value_cm"] == pytest.approx(metric.value_cm, abs=0.005)
    assert data["three_d"]["basis"] == ac.CATALOGUE_ENGINE_BASIS
    compute = next(step for step in data["trace"] if step["step"] == "compute_fit")
    assert "full engine" in compute["detail"] and "printed chart" not in compute["detail"]
    notes = data["extraction"]["notes"]
    assert any(note.startswith("Cross-check only, not the basis") for note in notes)
    assert not any("inner room unknown" in z["text"] for s in data["sizes"] for z in s["zones"])


@pytest.mark.slow
@pytest.mark.parametrize(("layer", "preference"), [("hoodie", "relaxed"), ("t-shirt", "fitted")])
def test_non_default_choices_give_the_studio_pick_for_the_same_choices(
    fitter, garments, product, page, layer, preference
):
    app = FastAPI()
    app.include_router(create_router(lambda: fitter, {}))
    request = BODIES["e2e profile"]
    response = TestClient(app).post(
        "/agent/recommend",
        json={
            "page": page.model_dump(mode="json"),
            "body": {"mode": "session", "fit_request": request.model_dump(mode="json")},
            "layer": layer,
            "preference": preference,
        },
    )
    assert response.status_code == 200, response.text
    data = response.json()
    studio = studio_fit(garments, fitter.fit(request), product, layer, preference)
    assert (data["layer"], data["preference"]) == (layer, preference)
    assert data["recommended_size"] == studio.recommended_size is not None
    compute = next(step for step in data["trace"] if step["step"] == "compute_fit")
    assert f"layer {layer} ({GarmentOptions().layer_presets_cm[layer]} cm)" in compute["detail"]


@pytest.mark.slow
def test_e2e_profile_gets_m_and_the_printed_chart_is_only_a_cross_check(
    fitter, garments, product, page
):
    body = fitter.fit(BODIES["e2e profile"])
    resolved = Resolved(parse_rules(page), "rules", [])
    engine = recommend(body, resolved, "regular", "t-shirt", {}, "test", garments)
    chart_only = recommend(body, resolved, "regular", "t-shirt", {}, "test")  # no engine
    assert engine.recommended_size == "M" == studio_fit(garments, body, product).recommended_size
    assert "basis" not in chart_only.three_d
    word = "also picks" if chart_only.recommended_size == "M" else "would pick"
    assert any(
        f"printed chart alone, at its printed precision, {word} {chart_only.recommended_size}"
        in note
        for note in engine.extraction.notes
    )


@pytest.mark.slow
@pytest.mark.parametrize(
    "offsets", [{"chest": 4.0}, {"hem": -5.0}, {"bicep": 3.0}, {"shoulder": 1.6}, {"sleeve": -2.4}]
)
def test_engine_offsets_shift_only_their_zone_and_keep_the_jackets_target(
    fitter, garments, product, offsets
):
    """convert.apply_offsets semantics on engine zones: that zone's ease/offset moves by −X, the
    jacket's design ease (target) and every other zone stay exactly the engine's."""
    body = fitter.fit(BODIES["e2e profile"])
    layer = config.LAYER_PRESETS_CM["t-shirt"]
    ranking = engine_ranking(garments, body, product.product_id, layer, "regular", offsets)
    ((zone, shift),) = offsets.items()
    for name, base in ranking.base.items():
        adjusted = ranking.adjusted[name]
        for key in config.ZONE_WEIGHTS:
            before, after = base.zones[key], adjusted.zones[key]
            assert after.design_ease_cm == pytest.approx(before.design_ease_cm, abs=1e-9)
            if before.value_cm is None:
                assert after.value_cm is None
                continue
            expected = before.value_cm - shift if key == zone else before.value_cm
            assert after.value_cm == pytest.approx(expected, abs=1e-9)
            if key != zone:
                assert after.status == before.status


@pytest.mark.slow
def test_learned_chest_room_moves_the_pick_the_same_way_on_both_paths(
    fitter, garments, product, page
):
    """+4 cm learned chest room: real numbers unchanged, target ease raised, and on this body both
    the printed-chart path and the full engine move one size up and say what they would pick."""
    body = fitter.fit(BODIES["e2e profile"])
    resolved = Resolved(parse_rules(page), "rules", [])
    offsets = {"chest": 4.0}
    for service in (None, garments):
        plain = recommend(body, resolved, "regular", "t-shirt", {}, "test", service)
        learned = recommend(body, resolved, "regular", "t-shirt", offsets, "test", service)
        before = SIZE_ORDER.index(plain.recommended_size)
        assert SIZE_ORDER.index(learned.recommended_size) == before + 1
        assert any(
            f"Without it we would pick {plain.recommended_size}" in line
            for line in learned.explanation
        )
        for a, b in zip(plain.sizes, learned.sizes, strict=True):
            chest_a = next(z for z in a.zones if z.zone == "chest")
            chest_b = next(z for z in b.zones if z.zone == "chest")
            assert chest_b.value_cm == chest_a.value_cm  # the shown number stays the real one
            assert chest_b.adjusted_value_cm == pytest.approx(chest_a.value_cm - 4.0, abs=0.01)
            assert chest_b.personal_offset_cm == 4.0
