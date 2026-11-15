import io

import numpy as np
import pytest
import trimesh
from body_service import config
from body_service.fit import Fitter, input_hash
from body_service.landmarks import generate, load_indices
from body_service.measure_body import measure_body
from body_service.model import scene_points
from body_service.schemas import FitRequest, FitResponse, KnownMeasurements
from pydantic import ValidationError


@pytest.mark.slow
@pytest.mark.parametrize(
    "sex,height,weight",
    [("female", 158, 52), ("female", 170, 68), ("male", 172, 65), ("male", 185, 92)],
)
def test_reference_people(fitter, sex, height, weight):
    request = FitRequest(height_cm=height, weight_kg=weight, sex=sex)
    body = fitter.fit(request)
    result = body.response
    assert abs(result.residuals["stature"]) < 0.5
    assert abs(result.residuals["mass_kg"]) < 1
    assert result.converged
    FitResponse.model_validate(result.model_dump())
    assert fitter.fit(request) is body
    mesh = trimesh.load(io.BytesIO(body.glb), file_type="glb", force="mesh")
    assert np.ptp(mesh.vertices[:, 1]) == pytest.approx(height / 100, abs=0.005)
    assert "NORMAL" in body.glb.decode("latin1")
    landmarks = body.landmarks.landmarks
    for side in ("L", "R"):
        assert landmarks[f"acromion_{side}"][1] > landmarks[f"elbow_{side}"][1]
        assert landmarks[f"elbow_{side}"][1] > landmarks[f"wrist_{side}"][1]
    assert landmarks["C7"][1] > landmarks["waist_level"][1] > landmarks["hip_level"][1]
    assert 20 < result.measurements["upper_arm"].value_cm < 50
    assert 60 < result.measurements["chest"].value_cm < 140
    assert result.fit_ms < 5000


@pytest.mark.slow
def test_determinism_without_cache(engine):
    request = FitRequest(height_cm=172, weight_kg=65, sex="male")
    first, second = (Fitter(engine).fit(request) for _ in range(2))
    assert first.response.phenotypes == second.response.phenotypes
    assert first.response.measurements == second.response.measurements
    assert first.glb == second.glb


@pytest.mark.slow
def test_optional_targets(fitter):
    request = FitRequest(
        height_cm=172,
        weight_kg=65,
        sex="male",
        known_measurements=KnownMeasurements(
            chest_cm=94,
            waist_cm=80,
            hip_cm=99,
            shoulder_width_cm=40,
            arm_length_cm=60,
            back_length_cm=43,  # revised synthetic C7 definition; not real-person tape data
        ),
    )
    result = fitter.fit(request).response
    print("optional targets:", result.residuals, "fit_ms", result.fit_ms)
    assert result.converged
    assert all(
        abs(value) < (0.5 if name == "stature" else 1 if name == "mass_kg" else 1.5)
        for name, value in result.residuals.items()
    )
    assert result.fit_ms < 5000


@pytest.mark.slow
@pytest.mark.parametrize("gender,weight,muscle", [(0.0, 0.02, 0.02), (1.0, 0.98, 0.98)])
def test_extreme_shape_ordering(engine, gender, weight, muscle):
    native = engine.rest(
        {"gender": gender, "age": config.ADULT_AGE, "weight": weight, "muscle": muscle}
    ).numpy()[0]
    vertices = scene_points(native, float(native[:, 2].min()))
    joints = engine.rest_joints(
        {"gender": gender, "age": config.ADULT_AGE, "weight": weight, "muscle": muscle},
        {},
        float(native[:, 2].min()),
    )
    result = measure_body(vertices, engine.faces, load_indices(), joints, gender)
    for side in ("L", "R"):
        assert result.landmarks[f"acromion_{side}"][1] > result.landmarks[f"elbow_{side}"][1]
        assert result.landmarks[f"elbow_{side}"][1] > result.landmarks[f"wrist_{side}"][1]
        assert result.landmarks[f"acromion_{side}"][1] > result.tapes["chest"].points[:, 1].mean()
    assert result.landmarks["C7"][1] > result.landmarks["waist_level"][1]


def test_landmark_generation_is_reproducible(engine):
    generated = generate(engine.vertices, engine.bones, engine.model.bone_labels)
    assert {k: v["vertex_index"] for k, v in generated.items()} == load_indices()


def test_normalised_hash_and_strict_boundary():
    request = FitRequest(height_cm=172, weight_kg=65, sex="male")
    assert input_hash(request) == input_hash(
        FitRequest(height_cm=172.0, weight_kg=65.0, sex="male")
    )
    for bad in (
        {"height_cm": 20},
        {"weight_kg": 500},
        {"height_cm": "172"},
        {"extra": 1},
        {"height_cm": float("nan")},
        {"weight_kg": True},
    ):
        with pytest.raises(ValidationError):
            FitRequest.model_validate({**request.model_dump(), **bad})
