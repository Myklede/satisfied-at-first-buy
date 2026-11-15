import numpy as np
from body_service.garment.back_surface import back_surface


def test_rear_grid_envelope_and_conservative_overhang():
    angle = np.arange(96) * 2 * np.pi / 96
    grid = np.array(
        [
            np.c_[0.2 * np.cos(angle), np.full(96, y), (0.1 + y * 0.02) * np.sin(angle)]
            for y in np.linspace(-1, 0, 20)
        ]
    )
    query = np.array([[0.0, -0.5], [0.1, -0.5], [0.3, -0.5]])
    expected = np.array([-0.09, -0.09 * np.sqrt(1 - (0.1 / 0.2) ** 2), -0.09])
    np.testing.assert_allclose(back_surface(grid, query), expected, atol=0.0001)
