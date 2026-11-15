"""Neck semantic isolation, capped-height truth and unchanged body measurements."""

import numpy as np
import pytest
import trimesh
from body_service import collar_config
from body_service.garment.fit_math import collar_fit
from body_service.garment.models import GarmentFitRequest
from body_service.garment.service import GarmentService
from body_service.neck_girth import body_neck_girth, measure_neck, neck_vertex_mask
from body_service.schemas import FitRequest


def cylinder(radius: float, height: float, centre_y: float) -> trimesh.Trimesh:
    mesh = trimesh.creation.cylinder(radius=radius, height=height, sections=128)
    mesh.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0]))
    mesh.vertices[:, 1] += centre_y
    return mesh


def test_neck_bone_group_dominates_without_adding_any_head_weight():
    labels = ["neck01", "neck02", "neck03", "head", "spine"]
    indices = np.array([[0, 1, 3], [0, 1, 3], [0, 1, 4]])
    weights = np.array([[0.3, 0.3, 0.4], [0.2, 0.2, 0.6], [0.1, 0.1, 0.8]])
    assert neck_vertex_mask(indices, weights, labels).tolist() == [True, False, False]


def test_neck_only_section_caps_before_head_and_preserves_requested_height():
    n = 128
    neck = cylinder(0.33 / (2 * n * np.sin(np.pi / n)), 0.1, 0.025)
    head = cylinder(0.13, 0.14, 0.145)
    combined = trimesh.util.concatenate([neck, head])
    mask = np.arange(len(combined.vertices)) < len(neck.vertices)
    report = measure_neck(
        combined.vertices, combined.faces, mask, np.zeros(3), np.array([0, 0.2, 0]), 8.0
    )
    assert report.girth_cm == pytest.approx(33, abs=1e-10)
    assert report.requested_height_cm == 8
    assert report.band_requested_cm == (5.0, 9.0)
    assert 7.3 <= report.actual_height_cm <= 7.5
    assert report.capped
    assert report.band_girth_cm == pytest.approx((33, 33))
    assert report.points[:, 1].max() < 0.075
    assert report.band_actual_height_cm[1] < 8
    with pytest.raises(ValueError, match="No neck-only faces"):
        measure_neck(
            combined.vertices,
            combined.faces,
            np.zeros_like(mask),
            np.zeros(3),
            np.array([0, 0.2, 0]),
            8,
        )


@pytest.mark.slow
def test_neck_analysis_does_not_change_existing_body_measurements(fitter, engine):
    body = fitter.fit(FitRequest(height_cm=172.0, weight_kg=65.0, sex="male"))
    response = body.response.model_dump_json()
    measurements = {k: v.model_dump_json() for k, v in body.geometry.measurements.items()}
    vertices, faces = body.mesh.vertices.copy(), body.mesh.faces.copy()
    landmarks = {k: v.copy() for k, v in body.geometry.landmarks.items()}
    report = body_neck_girth(body, engine, 8.0)
    assert np.isfinite(report.girth_cm)
    assert body.response.model_dump_json() == response
    assert {k: v.model_dump_json() for k, v in body.geometry.measurements.items()} == measurements
    np.testing.assert_array_equal(body.mesh.vertices, vertices)
    np.testing.assert_array_equal(body.mesh.faces, faces)
    for key, value in landmarks.items():
        np.testing.assert_array_equal(body.geometry.landmarks[key], value)


@pytest.mark.slow
@pytest.mark.parametrize(
    "sex,height,weight",
    [
        ("male", 172.0, 65.0),
        ("female", 162.0, 57.0),
        ("male", 185.0, 95.0),
        ("female", 180.0, 75.0),
    ],
)
def test_four_reference_bodies_give_finite_tapes(fitter, engine, sex, height, weight):
    body = fitter.fit(FitRequest(height_cm=height, weight_kg=weight, sex=sex))
    report = body_neck_girth(body, engine, 8.0)
    assert 10 < report.girth_cm < 80
    assert 0 < report.actual_height_cm <= 8
    assert 0 < report.band_actual_height_cm[0] <= report.band_actual_height_cm[1] <= 9
    assert np.isfinite(report.points).all()


@pytest.mark.slow
def test_service_exposes_estimated_capped_neck_without_collar_grading(fitter, monkeypatch):
    service = GarmentService(fitter)
    product = next(p for p in service.products.values() if p.style == "DQ4920-206")
    body = fitter.fit(FitRequest(height_cm=172.0, weight_kg=65.0, sex="male"))
    response = service.fit(
        GarmentFitRequest(body_id=body.response.body_id, product_id=product.product_id)
    ).response
    collar = response.sizes["S"].zones["collar"]
    assert collar.status != "unknown"
    first = collar.explanation.split(";")[0]
    assert "estimated neck" in first and "capped below jaw" in first
    assert collar.value_cm is not None
    assert "not an actual collar-top measurement" in collar.explanation
    for name, size in response.sizes.items():
        if name != "S":
            assert product.sizes[name].collar_inner is None
            assert size.zones["collar"].status == "unknown"
    monkeypatch.setattr(collar_config, "NECK_LABEL_VALIDATED", False)
    metric, _ = collar_fit(body, product.sizes["S"])
    assert metric.status == "unknown"

