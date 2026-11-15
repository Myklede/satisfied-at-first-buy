"""Vertical drape support from the actual torso/shoulder surface below the neck."""

import numpy as np
import trimesh

from .. import config


def shoulder_support(
    mesh: trimesh.Trimesh,
    points: np.ndarray,
    clearance: float,
    neck: np.ndarray,
    neck_normal: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Lift a yoke over skin; do not push adjacent nodes onto opposite body sides.

    The anatomical neck-base plane excludes the head from these garment supports.
    Rays outside the torso silhouette have no support and remain free.
    """
    origins = points.copy()
    origins[:, 1] = mesh.bounds[0, 1] - clearance
    directions = np.tile([0.0, 1.0, 0.0], (len(points), 1))
    hits, rays, faces = mesh.ray.intersects_location(origins, directions, multiple_hits=True)
    valid = (mesh.face_normals[faces, 1] > config.PLANE_VERTEX_EPS) & (
        ((hits - neck) @ neck_normal) <= config.SECTION_EPS
    )
    hits, rays = hits[valid], rays[valid]
    result = points.copy()
    bounds = np.full(len(points), np.nan)
    if len(rays):
        order = np.lexsort((abs(hits[:, 1] - points[rays, 1]), rays))
        rays, hits = rays[order], hits[order]
        first = np.r_[True, rays[1:] != rays[:-1]]
        ids = rays[first]
        bounds[ids] = hits[first, 1] + clearance
        result[ids, 1] = np.maximum(points[ids, 1], bounds[ids])
    return result, bounds
