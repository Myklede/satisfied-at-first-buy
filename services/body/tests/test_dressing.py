import numpy as np
from body_service.garment.dressing import dress_sleeve, walk_many
from body_service.garment.fit_math import walk


def test_vectorised_route_preserves_extrapolation_and_mirrored_sleeves():
    path = np.array([[0.0, 0.0, 0.0], [0.2, -0.3, 0.0], [0.3, -0.5, 0.05]])
    distances = np.array([-0.1, 0, 0.1, 0.4, 0.9])
    np.testing.assert_allclose(
        walk_many(path, distances), np.array([walk(path, d) for d in distances])
    )
    points = np.array([[0.1, 0.03, 0.0], [0.3, -0.02, 0.01], [0.5, 0.01, -0.01]])
    a = dress_sleeve(points, np.zeros(3), np.zeros(3), path, 0.01, 1)
    mirror = np.array([-1.0, 1.0, 1.0])
    b = dress_sleeve(points * mirror, np.zeros(3), np.zeros(3), path * mirror, 0.01, -1)
    np.testing.assert_allclose(a * mirror, b, atol=1e-12)
