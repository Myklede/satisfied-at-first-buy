"""Hierarchical intrinsic upper bounds for a freely moving cloth grid."""

import numpy as np

from .. import config
from .pattern import Pattern


def grid_supports(rest: np.ndarray, grid: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Coarse longitudinal distances are sums of real material edges, never chords.

    Missing armhole vertices break a path; no constraint crosses a pattern hole.
    Shortening/folding is unrestricted. Both dynamic endpoints receive reaction.
    """
    pairs, bounds = [], []
    stride = config.CLOTH_SUPPORT_COARSENING
    while stride < len(grid):
        for row in range(stride, len(grid)):
            path = grid[row - stride : row + 1]
            valid = (path >= 0).all(0)
            columns = path[:, valid]
            if not columns.size:
                continue
            length = np.linalg.norm(np.diff(rest[columns], axis=0), axis=2).sum(0)
            pairs.extend(np.c_[columns[0], columns[-1]])
            bounds.extend(length)
        stride *= config.CLOTH_SUPPORT_COARSENING
    return np.asarray(pairs, dtype=int).reshape(-1, 2), np.asarray(bounds)


def fabric_supports(pattern: Pattern) -> tuple[np.ndarray, np.ndarray]:
    grids = [pattern.torso_grid]
    for side, grid in pattern.sleeve_grids.items():
        grids.append(np.vstack((pattern.tapes[f"cap_{side}"][:-1], grid)))
    hood = np.flatnonzero(pattern.panels == 7)
    if (len(hood) - 1) % config.CLOTH_HOOD_N != 0:
        raise ValueError("Folded hood grid topology changed")
    grids.append(hood[:-1].reshape(-1, config.CLOTH_HOOD_N))
    data = [grid_supports(pattern.mesh.vertices, grid) for grid in grids]
    return np.vstack([p for p, _ in data]), np.concatenate([b for _, b in data])
