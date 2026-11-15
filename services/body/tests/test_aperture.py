import numpy as np
import trimesh
from body_service.garment.aperture import ArmProfile, arm_profile, cuff_collider, neck_collider


def test_actual_sections_and_opening_dependent_barrier():
    cylinder = trimesh.creation.cylinder(radius=0.03, height=0.5, sections=64)
    route = np.array([[0.0, 0.0, -0.15], [0.0, 0.0, 0.0], [0.0, 0.0, 0.15]])
    profile = arm_profile(cylinder, route)
    np.testing.assert_allclose(profile.girths, 2 * np.pi * 0.03, atol=0.001)
    model = ArmProfile(
        np.array([[0.0, 0.0, 0.0], [0.0, -0.1, 0.0], [0.0, -0.2, 0.0], [0.0, -0.3, 0.0]]),
        np.array([0.0, 0.1, 0.2, 0.3]),
        np.array([0.28, 0.18, 0.24, 0.30]),
        0.1,
    )
    small = cuff_collider(model, 0.21, 0, 1.0)
    assert small.fits_minimum_section
    assert abs(small.stop_distance_m - 0.15) < 1e-12
    assert cuff_collider(model, 0.4, 0, 1.0).stop_distance_m is None
    assert not cuff_collider(model, 0.1, 0, 1.0).fits_minimum_section


def test_neck_stop_comes_from_shoulder_aperture_and_translates_with_body():
    profile = np.array([[0, 1.2], [0.18, 1.2], [0.18, 1.35], [0.05, 1.5], [0.05, 1.56], [0, 1.56]])
    body = trimesh.creation.revolve(profile, sections=64)
    body.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0]))
    landmarks = {
        "C7": np.array([0.0, 1.5, -0.05]),
        "jugular_notch": np.array([0.0, 1.5, 0.05]),
        "acromion_L": np.array([0.18, 1.35, 0]),
        "acromion_R": np.array([-0.18, 1.35, 0]),
    }
    small = neck_collider(body, landmarks, 0.36, 0, 1)
    assert small.fits_minimum_section and small.stop_distance_m is not None
    assert neck_collider(body, landmarks, 1.5, 0, 1).stop_distance_m is None
    delta = np.array([0.2, 1.0, -0.1])
    body.apply_translation(delta)
    moved = neck_collider(body, {k: p + delta for k, p in landmarks.items()}, 0.36, 0, 1)
    assert abs(moved.stop_distance_m - small.stop_distance_m) < 1e-10
    np.testing.assert_allclose(np.array(moved.path), np.array(small.path) + delta)
