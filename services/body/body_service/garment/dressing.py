"""Vectorised skeletal-frame initial placement; original rest geometry is untouched."""

import numpy as np

from .. import config


def walk_many(path: np.ndarray, distances: np.ndarray) -> np.ndarray:
    delta = np.diff(path, axis=0)
    lengths = np.linalg.norm(delta, axis=1)
    if np.any(lengths <= 0):
        raise ValueError("Dressing route must contain nonzero segments")
    cumulative = np.r_[0, np.cumsum(lengths)]
    segments = np.clip(np.searchsorted(cumulative, distances, side="right") - 1, 0, len(delta) - 1)
    fraction = (distances - cumulative[segments]) / lengths[segments]
    return path[segments] + fraction[:, None] * delta[segments]


def dress_sleeve(
    points: np.ndarray,
    cap_centre: np.ndarray,
    seam: np.ndarray,
    route: np.ndarray,
    drop: float,
    sign: int,
) -> np.ndarray:
    start = walk_many(route, np.array([drop]))[0]
    path = np.vstack((start, route[1:]))
    distance = (points[:, 0] - seam[0]) * sign
    available = (
        np.linalg.norm(np.diff(path, axis=0), axis=1).sum() - config.CLOTH_DRESS_CUFF_PROXIMAL_M
    )
    # The small closed cuff starts above the hand. Only the dressing state is
    # compressed: original rest edges still drive emergent sleeve stacking.
    distance *= min(1, max(0, available) / max(float(distance.max()), 1e-12))
    centre = walk_many(path, distance)
    tangent = walk_many(path, distance + config.GARMENT_TANGENT_STEP_M) - walk_many(
        path, distance - config.GARMENT_TANGENT_STEP_M
    )
    tangent /= np.linalg.norm(tangent, axis=1)[:, None]
    normal = np.array([0.0, 1.0, 0.0]) - tangent * tangent[:, 1, None]
    normal /= np.linalg.norm(normal, axis=1)[:, None]
    front = np.cross(tangent, normal) * sign
    return (
        centre
        + normal * (points[:, 1] - cap_centre[1])[:, None]
        + front * (points[:, 2] - cap_centre[2])[:, None]
    )
