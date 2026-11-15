import numpy as np
import pytest
from body_service.anatomy import neck_plane
from body_service.schemas import FitRequest


def test_inclined_plane_contains_anatomical_endpoints():
    c7, notch = np.array([0.0, 1.5, -0.05]), np.array([0.0, 1.44, 0.09])
    origin, normal = neck_plane(c7, notch)
    assert abs((c7 - origin) @ normal) < 1e-12
    assert abs((notch - origin) @ normal) < 1e-12
    assert normal[1] > 0 and abs(normal[2]) > 0.1


@pytest.mark.slow
def test_per_body_shoulder_and_neck_regression(fitter):
    bodies = [
        fitter.fit(FitRequest(height_cm=175, weight_kg=weight, sex="male"))
        for weight in (65, 75, 92)
    ]
    widths = [body.response.measurements["shoulder_width"].value_cm for body in bodies]
    print("M175 shoulder widths / 65,75,92kg:", widths)
    assert (widths[-1] - widths[0]) / widths[0] < (92 - 65) / 65
    assert len({body.geometry.indices["acromion_L"] for body in bodies}) > 1
    assert 38 < widths[1] < 45  # sanity only; no clamp to a population mean
    for body in bodies:
        lm = body.geometry.landmarks
        origin, normal = neck_plane(lm["C7"], lm["jugular_notch"])
        assert abs((lm["C7"] - origin) @ normal) < 1e-8
        assert abs((lm["jugular_notch"] - origin) @ normal) < 1e-8
        assert np.max(abs((body.geometry.tapes["neck_base"].points - origin) @ normal)) < 1e-7
        assert (
            body.response.measurements["shoulder_arc"].value_cm
            > body.response.measurements["shoulder_width"].value_cm
        )
        assert body.geometry.indices["C7"] in body.geometry.paths["shoulder_arc"]
        assert 25 < body.response.measurements["neck_base"].value_cm < 50


@pytest.mark.slow
def test_conditional_uncertainty_is_computed_and_cached(fitter):
    body = fitter.fit(FitRequest(height_cm=172, weight_kg=65, sex="male"))
    result = fitter.uncertainty(body.response.body_id)
    assert result.accepted_samples >= 3
    assert result.attempted_samples == 9
    assert result.bands["chest"].upper_cm > result.bands["chest"].lower_cm
    assert result is fitter.uncertainty(body.response.body_id)
    print("Conditional ensemble:", result.accepted_samples, "samples,", result.compute_ms, "ms")


@pytest.mark.slow
@pytest.mark.parametrize(
    "sex,height,weight",
    [("female", 158, 52), ("female", 170, 68), ("male", 172, 65), ("male", 185, 92)],
)
def test_unobserved_skeleton_keeps_model_prior(fitter, sex, height, weight):
    body = fitter.fit(FitRequest(height_cm=height, weight_kg=weight, sex=sex))
    prior = fitter.engine.unobserved_shape(sex == "female")
    assert body.response.phenotypes["proportions"] == prior["proportions"]
    assert body.response.phenotypes["cupsize"] == prior["cupsize"]
    assert body.response.phenotypes["firmness"] == prior["firmness"]
    g = body.geometry
    assert (
        np.min(np.linalg.norm(g.surface_paths["shoulder_arc"] - g.landmarks["C7"], axis=1)) < 1e-8
    )
    assert (
        body.response.measurements["shoulder_arc"].value_cm
        > body.response.measurements["shoulder_width"].value_cm
    )
