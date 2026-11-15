"""Synthetic collar sections and public garment tapes; no personal body fixture."""

from types import SimpleNamespace

import numpy as np
import pytest
import trimesh
from body_service import config
from body_service.garment.fit_math import (
    collar_ease_metric,
    collar_fit,
    score_zones,
    unknown,
)
from body_service.garment.models import GarmentSize, SourcedMeasurement
from body_service.neck_girth import measure_neck
from pydantic import ValidationError


def tape(value, **kwargs):
    return SourcedMeasurement(
        value_cm=value, source="tape_measured", source_detail="synthetic tape", **kwargs
    )


def measured_size():
    return GarmentSize(collar_inner=tape(35.0), collar_height=tape(8.0))


def cylinder_body(top_radius=None):
    # A 128-sided neck section whose polygon tape is exactly 33 cm.
    n = 128
    radius = 0.33 / (2 * n * np.sin(np.pi / n))
    mesh = trimesh.creation.cylinder(radius=radius, height=0.4, sections=n)
    mesh.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0]))
    if top_radius is not None:
        upper = mesh.vertices[:, 1] > 0
        mesh.vertices[upper, 0] *= top_radius / radius
        mesh.vertices[upper, 2] *= top_radius / radius
    return SimpleNamespace(
        mesh=mesh,
        geometry=SimpleNamespace(
            landmarks={
                "C7": np.array([0.0, 0.0, -0.06]),
                "jugular_notch": np.array([0.0, 0.0, 0.06]),
            }
        ),
    )


def test_observed_two_cm_ease_is_slightly_snug_without_fitting_a_person():
    result = collar_ease_metric(33.0, 35.0, 8.0)
    assert result.value_cm == 2
    assert result.status == "tight"
    assert "slightly snug" in result.explanation
    assert "one measured collar" in result.explanation
    assert "uncalibrated" in result.explanation
    assert result.estimated
    assert result.lower_cm is result.upper_cm is None


def test_actual_mesh_section_not_a_neck_base_proxy():
    body = cylinder_body()
    neck = measure_neck(
        body.mesh.vertices,
        body.mesh.faces,
        np.ones(len(body.mesh.vertices), dtype=bool),
        np.zeros(3),
        np.array([0, 0.1, 0]),
        8.0,
    )
    result, points = collar_fit(body, measured_size(), neck)
    assert result.value_cm == pytest.approx(2, abs=1e-10)
    assert result.status == "tight"
    assert points is not None
    assert points[:, 1] == pytest.approx(0.08)


def test_missing_tape_never_claims_fit_or_needs_a_mesh():
    result, points = collar_fit(None, GarmentSize())
    assert result.status == "unknown"
    assert result.value_cm is None and points is None
    assert "not measured" in result.explanation


def test_expanding_section_abstains_instead_of_calling_a_head_a_neck():
    body = cylinder_body(top_radius=0.1)
    result, points = collar_fit(body, measured_size())
    assert result.status == "unknown"
    assert result.value_cm is None and points is None
    assert "jaw/head" in result.explanation and "no neck-fit claim" in result.explanation


def test_measured_collar_does_not_change_common_zone_score_or_coverage():
    zones = {key: unknown(key, "absent") for key in config.ZONE_WEIGHTS}
    before = score_zones(zones)
    zones["collar"] = collar_ease_metric(33, 35, 8)
    assert score_zones(zones) == before


@pytest.mark.parametrize(
    "inner,height", [(9.9, 8), (100.1, 8), (35, 0.9), (35, 30.1), (float("inf"), 8)]
)
def test_collar_physical_ranges(inner, height):
    with pytest.raises(ValidationError):
        GarmentSize(collar_inner=tape(inner), collar_height=tape(height))


def test_measured_pair_exactness_source_and_unknown_fields():
    with pytest.raises(ValidationError, match="both"):
        GarmentSize(collar_inner=tape(35))
    with pytest.raises(ValidationError, match="exact measured"):
        GarmentSize(
            collar_inner=SourcedMeasurement(
                value_cm=35, source="derived_grading", source_detail="not measured"
            ),
            collar_height=tape(8),
        )
    with pytest.raises(ValidationError, match="exact measured"):
        GarmentSize(
            collar_inner=SourcedMeasurement(
                min_cm=34, max_cm=36, source="tape_measured", source_detail="range"
            ),
            collar_height=tape(8),
        )
    with pytest.raises(ValidationError):
        GarmentSize(collar_inner=tape(35, uncertainty_cm=35), collar_height=tape(8))
    with pytest.raises(ValidationError):
        GarmentSize(collar_inner=tape(35), collar_height=tape(8), collar_fake=2)
    with pytest.raises(ValueError):
        collar_ease_metric(float("nan"), 35, 8)
