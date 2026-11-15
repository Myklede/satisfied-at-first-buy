import numpy as np
import pytest
from body_service import config
from body_service.pose import display_body, forearm_alignment
from body_service.schemas import FitRequest
from body_service.validation import REFERENCES
from scipy.spatial.transform import Rotation


@pytest.mark.parametrize("sign", [1, -1])
@pytest.mark.parametrize("rest_angle", [0, 25, 45, 65])
def test_absolute_elbow_flexion_is_independent_of_rest_flexion(sign, rest_angle):
    upper = np.array([sign * 0.45, -0.89, 0.0])
    upper /= np.linalg.norm(upper)
    axis = np.cross(upper, [0, 0, 1.0])
    axis /= np.linalg.norm(axis)
    current = Rotation.from_rotvec(axis * np.deg2rad(rest_angle)).apply(upper)
    aligned = Rotation.from_rotvec(forearm_alignment(upper, current, 12)).apply(current)
    angle = np.rad2deg(np.arccos(np.clip(aligned @ upper, -1, 1)))
    assert abs(angle - 12) < 1e-10
    assert aligned[2] > 0


def test_actual_anny_pose_sets_requested_angles_on_all_reference_bodies(fitter):
    for sex, height, weight in REFERENCES:
        body = fitter.fit(FitRequest(sex=sex, height_cm=height, weight_kg=weight))
        saved = body.mesh.vertices.copy()
        posed = display_body(fitter.engine, body)
        for route in posed.arm_centres.values():
            upper, lower = np.diff(route, axis=0)
            flexion = np.rad2deg(
                np.arccos(
                    np.clip(upper @ lower / np.linalg.norm(upper) / np.linalg.norm(lower), -1, 1)
                )
            )
            elevation = np.rad2deg(np.arctan2(abs(upper[0]), -upper[1]))
            assert abs(flexion - config.DISPLAY_ELBOW_BEND_DEG) < 1e-8
            assert abs(elevation - config.DISPLAY_ARM_ANGLE_DEG) < 1e-8
        np.testing.assert_array_equal(saved, body.mesh.vertices)
