"""Per-shape shoulder ridge and neck anatomy, with explicit surface attachment indices."""

import numpy as np
import trimesh
from scipy.ndimage import gaussian_filter1d

from . import config
from .landmarks import nearest
from .measure import section


def neck_plane(c7: np.ndarray, notch: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Plane contains C7, jugular notch and the transverse X direction."""
    c7, notch = c7.astype(np.float64), notch.astype(np.float64)
    normal = np.cross(np.array([1.0, 0.0, 0.0]), notch - c7)
    normal /= np.linalg.norm(normal)
    if normal[1] < 0:
        normal *= -1
    return (c7 + notch) / 2, normal


def shoulder_ridge_index(
    vertices: np.ndarray,
    faces: np.ndarray,
    hps: np.ndarray,
    joint: np.ndarray,
    elbow: np.ndarray,
    sign: int,
    gender: float,
) -> np.ndarray:
    """Top coronal surface slope turn in the bony-head neighbourhood, not deltoid extent."""
    start = abs(hps[0])
    stop = abs(elbow[0])
    xs = np.linspace(start, stop, config.RIDGE_SAMPLES)
    band = abs(vertices[:, 2] - joint[2]) < config.RIDGE_CORONAL_BAND
    band &= (vertices[:, 1] > elbow[1]) & (vertices[:, 1] < hps[1] + config.RIDGE_HEAD_EXCLUSION)
    segments = trimesh.intersections.mesh_plane(
        trimesh.Trimesh(vertices, faces, process=False),
        np.array([0.0, 0.0, 1.0]),
        np.array([0.0, 0.0, joint[2]]),
    )
    sx = segments[:, :, 0] * sign
    dx = sx[:, 1] - sx[:, 0]
    ys = np.full_like(xs, np.nan)
    for i, value in enumerate(xs):
        mask = (sx.min(axis=1) <= value) & (sx.max(axis=1) >= value) & (abs(dx) > 1e-12)
        p = segments[mask]
        fraction = (value - sx[mask, 0]) / dx[mask]
        y = p[:, 0, 1] + fraction * (p[:, 1, 1] - p[:, 0, 1])
        y = y[(y > elbow[1]) & (y < hps[1] + config.RIDGE_HEAD_EXCLUSION)]
        if len(y):
            ys[i] = y.max()
    valid = np.isfinite(ys)
    if valid.sum() < 5:
        raise ValueError("Shoulder ridge has insufficient surface support")
    ys = np.interp(xs, xs[valid], ys[valid])
    smooth = gaussian_filter1d(ys, config.RIDGE_SMOOTH_SIGMA)
    slope = np.gradient(smooth, xs)
    curvature = -np.gradient(slope, xs)
    window = (
        np.array(config.RIDGE_WINDOW_MALE) * (1 - gender)
        + np.array(config.RIDGE_WINDOW_FEMALE) * gender
    )
    region = (xs >= abs(joint[0]) * window[0]) & (xs <= abs(joint[0]) * window[1])
    candidates = np.flatnonzero(region)
    if not len(candidates):
        raise ValueError("Shoulder ridge does not cover humeral-head neighbourhood")
    turns = candidates[slope[candidates] <= config.RIDGE_SLOPE]
    selected = int(turns[0]) if len(turns) else int(candidates[np.argmax(curvature[candidates])])
    target = np.array([sign * xs[selected], ys[selected], joint[2]])
    return target  # continuous triangle-plane point; no coarse vertex is required here


def detect_anatomy(
    vertices: np.ndarray,
    faces: np.ndarray,
    seed_indices: dict[str, int],
    joints: dict[str, np.ndarray],
    gender: float,
) -> tuple[dict[str, int], dict[str, np.ndarray]]:
    indices = seed_indices.copy()
    midline = abs(vertices[:, 0]) < config.MIDLINE_WIDTH
    neck = joints["neck01"]
    scale = np.ptp(vertices[:, 1]) / config.ANATOMY_REFERENCE_STATURE
    c7_y = neck[1] + config.C7_HEIGHT_OFFSET * scale
    posterior = midline & (abs(vertices[:, 1] - c7_y) < config.C7_LEVEL_BAND)
    candidates = np.flatnonzero(posterior)
    indices["C7"] = int(candidates[np.argmin(vertices[candidates, 2])])
    # The anterior sternal notch is at the medial clavicle level, below C7.
    notch_y = neck[1] + config.NOTCH_HEIGHT_OFFSET * scale
    anterior = midline & (abs(vertices[:, 1] - notch_y) < config.NOTCH_LEVEL_BAND)
    candidates = np.flatnonzero(anterior)
    indices["jugular_notch"] = int(candidates[np.argmax(vertices[candidates, 2])])
    indices["neck_base_front"] = indices["jugular_notch"]
    indices["neck_base_back"] = indices["C7"]  # documented alias of the same anatomical point
    points = {name: vertices[index] for name, index in indices.items()}
    origin, normal = neck_plane(points["C7"], points["jugular_notch"])
    section(vertices, faces, origin, normal, origin)  # requires a real closed neck section
    for side, sign in (("L", 1), ("R", -1)):
        point = shoulder_ridge_index(
            vertices,
            faces,
            points[f"HPS_{side}"],
            joints[f"upperarm01.{side}"],
            joints[f"lowerarm01.{side}"],
            sign,
            gender,
        )
        indices[f"acromion_{side}"] = nearest(vertices, point)
        points[f"acromion_{side}"] = point
    return indices, points
