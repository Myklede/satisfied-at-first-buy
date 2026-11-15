import numpy as np
from body_service.garment.supports import grid_supports


def test_intrinsic_bounds_allow_folds_and_do_not_cross_pattern_holes():
    theta = np.arange(20) * 0.2
    rest = np.c_[np.sin(theta), np.cos(theta), np.zeros(len(theta))]
    grid = np.arange(len(rest)).reshape(-1, 1)
    pairs, bounds = grid_supports(rest, grid)
    assert (bounds >= np.linalg.norm(rest[pairs[:, 1]] - rest[pairs[:, 0]], axis=1)).all()
    assert (bounds > np.linalg.norm(rest[pairs[:, 1]] - rest[pairs[:, 0]], axis=1) + 0.001).any()
    broken = grid.copy()
    broken[8] = -1
    pairs, _ = grid_supports(rest, broken)
    assert not ((pairs[:, 0] < 8) & (pairs[:, 1] > 8)).any()
    assert not (pairs == 8).any()
