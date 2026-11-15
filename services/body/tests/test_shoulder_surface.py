import numpy as np
import trimesh
from body_service.garment.shoulder_surface import shoulder_support


def test_yoke_support_lifts_over_skin_and_excludes_head_above_neck_plane():
    torso = trimesh.creation.box([0.4, 0.2, 0.2])
    torso.apply_translation([0, 1.0, 0])
    head = trimesh.creation.box([0.15, 0.2, 0.15])
    head.apply_translation([0, 1.4, 0])
    mesh = trimesh.util.concatenate([torso, head])
    points = np.array([[0.1, 1.05, 0], [0.0, 1.15, 0], [0.3, 1.0, 0]])
    result, bounds = shoulder_support(
        mesh, points, 0.005, np.array([0.0, 1.2, 0]), np.array([0.0, 1.0, 0])
    )
    assert abs(result[0, 1] - 1.105) < 1e-12
    np.testing.assert_array_equal(result[1], points[1])
    np.testing.assert_array_equal(result[2], points[2])
    assert np.isnan(bounds[2])
    assert bounds[1] < 1.2
