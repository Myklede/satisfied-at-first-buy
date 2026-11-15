import io
from types import SimpleNamespace

import numpy as np
import pytest
import trimesh
from body_service import app as module
from body_service.garment.builder import build_garment, clearance_samples, radial_resample
from body_service.garment.fit_math import (
    arm_route,
    back_route,
    fit_size,
    inner_girth,
    score_zones,
    unknown,
    walk,
)
from body_service.garment.models import GarmentFitRequest, SourcedMeasurement
from body_service.garment.products import load_products, product_hash
from body_service.garment.service import GarmentService
from body_service.garment.validation import WornObservation, comparison
from body_service.schemas import FitRequest
from fastapi.testclient import TestClient
from performance_budget import build_with_budget
from pydantic import ValidationError


def test_build_budget_passes_without_retry_when_fast():
    calls = []

    def build():
        calls.append(1)
        return SimpleNamespace(build_ms=900.0)

    _, samples = build_with_budget(build)
    assert samples == [900.0] and len(calls) == 1


def test_build_budget_retries_fresh_work_after_a_scheduler_stall():
    work = iter([1800.0, 1600.0, 700.0])
    result, samples = build_with_budget(lambda: SimpleNamespace(build_ms=next(work)))
    assert samples == [1800.0, 1600.0, 700.0]
    assert result.build_ms == 700.0


def test_build_budget_preserves_real_regressions_and_reports_all_samples():
    work = iter([1800.0, 1600.0, 1550.0])
    with pytest.raises(AssertionError, match=r"1800.0, 1600.0, 1550.0.*1500"):
        build_with_budget(lambda: SimpleNamespace(build_ms=next(work)))


@pytest.fixture(scope="module")
def catalogue():
    return {product.style: product for product in load_products().values()}


def test_approved_jacket_data_and_provenance(catalogue):
    assert len(catalogue) == 2
    first, second = catalogue["FB7675-100"], catalogue["DQ4920-206"]
    assert first.url == "https://www.amazon.com/dp/B0C9TQTNYH"
    assert second.url == "https://www.ebay.com/itm/278055652565"
    for product in catalogue.values():
        assert product.product_id == product_hash(product)
        assert product.construction == "set_in" and product.fit_intent == "loose"
        assert product.sizes["S"].chest.source == "tape_measured"
        assert product.sizes["M"].chest.source == "derived_grading"
        assert product.sizes["M"].shoulder is None
        assert product.sizes["M"].sleeve is None
        assert product.sizes["M"].length_hps is None
    assert first.sizes["S"].sleeve.value_cm == 53
    assert first.sizes["S"].sleeve_cb.value_cm == 82
    assert first.sizes["S"].chest.value_cm == 108
    assert second.loft_cm == 2.75 and second.loft_uncertainty_cm == 0.25
    assert second.sizes["S"].hem.value_cm == 110 and second.hem_elastic
    assert first.sizes["M"].chest.value_cm == 115
    assert second.sizes["M"].chest.value_cm == pytest.approx(127.6)


def test_polyline_walk_and_radial_intersection():
    p = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0]])
    np.testing.assert_allclose(walk(p, 1.5), [1.0, 0.5, 0.0])
    np.testing.assert_allclose(walk(p, 3.0), [1.0, 2.0, 0.0])
    np.testing.assert_allclose(walk(p, -0.5), [-0.5, 0.0, 0.0])
    square = np.array([[-1.0, 0.0, -1.0], [1.0, 0.0, -1.0], [1.0, 0.0, 1.0], [-1.0, 0.0, 1.0]])
    ring = radial_resample(
        square,
        np.zeros(3),
        np.array([1.0, 0.0, 0.0]),
        np.array([0.0, 0.0, 1.0]),
        np.arange(4) * np.pi / 2,
    )
    np.testing.assert_allclose(ring, [[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1]], atol=1e-12)


def test_strict_fields_and_direct_lining(catalogue):
    product = catalogue["DQ4920-206"].model_copy(deep=True)
    size = product.sizes["S"]
    assert inner_girth(size, "chest", product) == pytest.approx(120 - 2 * np.pi * 2.75)
    size.chest_inner = SourcedMeasurement(
        value_cm=106, source="tape_measured", source_detail="unit-test lining input"
    )
    assert inner_girth(size, "chest", product) == 106
    for data in ({"value_cm": 50, "min_cm": 40, "max_cm": 60}, {"min_cm": 60, "max_cm": 40}):
        with pytest.raises(ValidationError):
            SourcedMeasurement(**data, source="tape_measured", source_detail="invalid fixture")


def test_unknown_scores_and_private_worn_errors():
    assert score_zones(
        {name: unknown(name, "missing") for name in ("shoulder", "chest", "hem", "sleeve", "bicep")}
    ) == (None, 0.0)
    assert comparison(2.0, 1.5) == ("+2.00", "+1.50", "+0.50")
    assert comparison(None, None) == ("unknown", "pending", "pending")
    assert comparison(2.0, None)[-1] == "pending"
    with pytest.raises(ValidationError):
        WornObservation(person_id="test", product_id="0" * 64, size="S", cuff_offset_cm=100)


@pytest.mark.slow
def test_synthetic_size_monotonicity_shared_topology_and_raglan(fitter, catalogue):
    """Full synthetic M is test-only; never written into the real product catalogue."""
    body = fitter.fit(FitRequest(height_cm=172, weight_kg=65, sex="male"))
    product = catalogue["DQ4920-206"].model_copy(deep=True)
    product.sizes["M"] = product.sizes["S"].model_copy(deep=True)
    for field, increment in (
        ("shoulder", 2),
        ("chest", 6),
        ("hem", 4),
        ("sleeve", 1),
        ("bicep", 2),
    ):
        getattr(product.sizes["M"], field).value_cm += increment
    routes = {"L": arm_route(body, "L"), "R": arm_route(body, "R"), "back": back_route(body)}
    small, large = (fit_size(body, product, name, 0.3, "regular", routes) for name in ("S", "M"))
    for zone in small.zones:
        if small.zones[zone].value_cm is None:
            assert large.zones[zone].value_cm is None
            continue  # Missing collar tapes/invalid neck section do not become a numeric claim.
        assert large.zones[zone].value_cm >= small.zones[zone].value_cm
    small_mesh, large_mesh = (
        build_garment(body, product, name, fit, routes, 0.3).mesh
        for name, fit in (("S", small), ("M", large))
    )
    assert small_mesh.vertices.shape == large_mesh.vertices.shape
    np.testing.assert_array_equal(small_mesh.faces, large_mesh.faces)
    thick = fit_size(body, product, "S", 0.9, "regular", routes)
    assert thick.zones["chest"].value_cm == pytest.approx(
        small.zones["chest"].value_cm - 2 * np.pi * 0.6
    )
    relaxed = fit_size(body, product, "S", 0.3, "relaxed", routes)
    assert relaxed.zones["chest"].design_ease_cm == small.zones["chest"].design_ease_cm + 4
    product.construction = "raglan"
    product.sizes["S"].sleeve_cb = SourcedMeasurement(
        value_cm=83, source="tape_measured", source_detail="synthetic CB fixture"
    )
    raglan = fit_size(body, product, "S", 0.3, "regular", routes)
    assert raglan.zones["shoulder"].status == "unknown"
    assert raglan.zones["sleeve"].value_cm is not None
    assert "seam_L" not in raglan.anchors


@pytest.mark.slow
def test_fit_offsets_unknown_zones_loft_and_body_chart(fitter, catalogue):
    body = fitter.fit(FitRequest(height_cm=172, weight_kg=65, sex="male"))
    product = catalogue["DQ4920-206"].model_copy(deep=True)
    fit = fit_size(body, product, "S", 0.3, "regular")
    assert fit.geometry_available
    band = body.uncertainty.bands["chest"] if body.uncertainty else None
    body_width = band.upper_cm - band.lower_cm if band else 0
    assert fit.zones["chest"].upper_cm - fit.zones["chest"].lower_cm == pytest.approx(
        4 * np.pi * 0.25 + body_width
    )
    product.sizes["S"].shoulder.value_cm = body.response.measurements["shoulder_arc"].value_cm
    neutral = fit_size(body, product, "S", 0.3, "regular")
    assert abs(neutral.zones["shoulder"].value_cm) < 1e-4
    product.sizes["S"].shoulder.value_cm += 4
    larger = fit_size(body, product, "S", 0.3, "regular")
    assert larger.zones["shoulder"].value_cm == pytest.approx(
        neutral.zones["shoulder"].value_cm + 2
    )
    assert larger.zones["sleeve"].value_cm == pytest.approx(neutral.zones["sleeve"].value_cm + 2)
    unknown = fit_size(body, product, "M", 0.3, "regular")
    assert not unknown.geometry_available
    assert unknown.zones["shoulder"].status == "unknown"
    assert unknown.zones["sleeve"].status == "unknown"
    assert unknown.zones["hem"].status == "unknown"
    assert unknown.zones["chest"].estimated
    product.chart_type = "body"
    product.sizes["S"].chest = SourcedMeasurement(
        min_cm=90, max_cm=100, source="retailer_chart", source_detail="synthetic body range"
    )
    body_chart = fit_size(body, product, "S", 0.9, "relaxed")
    assert not body_chart.geometry_available and body_chart.estimated
    assert body_chart.zones["chest"].metric == "body_chart_distance_cm"
    assert not any(name.startswith("seam") for name in body_chart.anchors)


@pytest.mark.slow
def test_real_products_geometry_topology_collisions_cache_and_api(fitter, catalogue, monkeypatch):
    body = fitter.fit(FitRequest(height_cm=172, weight_kg=65, sex="male"))
    service = GarmentService(fitter)
    monkeypatch.setattr(module, "fitter", fitter)
    monkeypatch.setattr(module, "garment_engine", service)
    client = TestClient(module.app)
    assert len(client.get("/products").json()) == 2
    shapes = []
    for product in catalogue.values():
        request = GarmentFitRequest(body_id=body.response.body_id, product_id=product.product_id)
        fit = service.fit(request)
        assert service.fit(request) is fit

        def fresh_mesh(fit=fit):
            # Retry actual geometry, never the service's already-built mesh.
            fit.meshes.pop("S", None)
            return service.get_mesh(fit.response.fit_id, "S")

        built, samples = build_with_budget(fresh_mesh)
        print(product.style, "fresh build samples ms", samples)
        points, signed, _ = clearance_samples(built.mesh, body.mesh)
        assert signed.min() > -0.002
        assert not body.mesh.contains(points).any()
        assert "_gap_cm" in built.glb.decode("latin1")
        assert "_inner_gap_cm" in built.glb.decode("latin1")
        assert "_elastic_gather" in built.glb.decode("latin1")
        assert set(np.unique(built.mesh.vertex_attributes["elastic_gather"])) == {0.0, 1.0}
        assert "sleeve" in fit.response.sizes["S"].elastic_zones
        loaded = trimesh.load(io.BytesIO(built.glb), file_type="glb", force="mesh")
        assert len(loaded.vertices) == len(built.mesh.vertices)
        shapes.append((built.mesh.vertices.shape, built.mesh.faces.copy()))
        response = client.post("/fit/garment", json=request.model_dump())
        assert response.status_code == 200
        assert client.get(f"/fit/{fit.response.fit_id}/S/garment.glb").content[:4] == b"glTF"
        assert client.get(f"/fit/{fit.response.fit_id}/M/garment.glb").status_code == 200
        assert client.get(f"/products/{product.product_id}").status_code == 200
    assert shapes[0][0] == shapes[1][0]
    np.testing.assert_array_equal(shapes[0][1], shapes[1][1])
    assert client.get("/products/unsafe").status_code == 422
    assert client.get("/collision/unsafe.bin").status_code == 422
    assert client.get(f"/collision/{'0' * 64}.bin").status_code == 404
    assert (
        client.post(
            "/fit/garment", json={"body_id": body.response.body_id, "product_id": "0" * 64}
        ).status_code
        == 404
    )
    assert (
        client.post(
            "/fit/garment",
            json={
                "body_id": body.response.body_id,
                "product_id": next(iter(service.products)),
                "layer_cm": -1,
            },
        ).status_code
        == 422
    )
