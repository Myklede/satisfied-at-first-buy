"""Rear envelope of a torso ring grid, including virtual armhole grid locations."""

import numpy as np

from .. import config


def back_surface(grid: np.ndarray, points_xy: np.ndarray) -> np.ndarray:
    """Interpolate each meridian at Y, then intersect its polygon with the X ray.

    Outside the grid's X range, use the rear-most plane (conservative overhang),
    rather than projecting the hood through a shoulder or inventing body values.
    """
    count, columns = len(points_xy), grid.shape[1]
    x, z = np.empty((count, columns)), np.empty((count, columns))
    for col in range(columns):
        order = np.argsort(grid[:, col, 1], kind="stable")
        y = grid[order, col, 1]
        x[:, col] = np.interp(points_xy[:, 1], y, grid[order, col, 0])
        z[:, col] = np.interp(points_xy[:, 1], y, grid[order, col, 2])
    end_x, end_z = np.roll(x, -1, axis=1), np.roll(z, -1, axis=1)
    delta = end_x - x
    fraction = np.divide(
        points_xy[:, 0, None] - x,
        delta,
        out=np.full_like(delta, np.inf),
        where=abs(delta) > config.PLANE_VERTEX_EPS,
    )
    valid = (fraction >= 0) & (fraction <= 1)
    candidate = np.where(valid, z + fraction * (end_z - z), np.inf)
    result = candidate.min(1)
    return np.where(np.isfinite(result), result, z.min(1))
