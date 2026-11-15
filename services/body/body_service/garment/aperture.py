"""A closed cuff stays around the arm until its opening can clear the hand.

The barrier comes from mesh cross-sections and the supplied/inferred opening,
not an offset to a wrist landmark. Large openings have no distal barrier.
"""

from dataclasses import dataclass

import numpy as np
import trimesh
from scipy.spatial import ConvexHull

from .. import config
from ..measure import section_loops
from ..schemas import Point, StrictModel
from .dressing import walk_many


class CuffCollider(StrictModel):
    path: list[Point]
    distances_m: list[float]
    guide_radii_m: list[float]
    stop_distance_m: float | None
    opening_m: float
    fits_minimum_section: bool
    source: str


@dataclass
class ArmProfile:
    centres: np.ndarray
    distances: np.ndarray
    girths: np.ndarray
    wrist_distance: float


def arm_profile(mesh: trimesh.Trimesh, route: np.ndarray) -> ArmProfile:
    length = float(np.linalg.norm(np.diff(route, axis=0), axis=1).sum())
    distances = np.linspace(0, length, int(np.ceil(length / config.CLOTH_CUFF_SECTION_STEP_M)) + 1)
    points = walk_many(route, distances)
    tangents = walk_many(route, distances + config.GARMENT_TANGENT_STEP_M) - walk_many(
        route, distances - config.GARMENT_TANGENT_STEP_M
    )
    tangents /= np.linalg.norm(tangents, axis=1)[:, None]
    centres = []
    girths = []
    for point, normal in zip(points, tangents, strict=True):
        loops = section_loops(mesh.vertices, mesh.faces, point, normal)
        near = [
            loop.points
            for loop in loops
            if np.linalg.norm(loop.points.mean(0) - point) < config.GARMENT_CUFF_SUPPORT_MAX_M
        ]
        if not near:
            raise ValueError("Unable to section the actual forearm/hand for cuff contact")
        vertices = np.vstack(near)
        u = np.cross(normal, np.eye(3)[np.argmin(abs(normal))])
        u /= np.linalg.norm(u)
        v = np.cross(normal, u)
        planar = np.c_[(vertices - point) @ u, (vertices - point) @ v]
        hull = planar[ConvexHull(planar).vertices]
        centre = (hull.min(0) + hull.max(0)) / 2
        centres.append(point + centre[0] * u + centre[1] * v)
        girths.append(float(np.linalg.norm(hull - np.roll(hull, 1, axis=0), axis=1).sum()))
    centres = np.array(centres)
    actual = np.r_[0, np.cumsum(np.linalg.norm(np.diff(centres, axis=0), axis=1))]
    wrist = float(np.linalg.norm(route[1] - route[0]))
    wrist_index = int(np.argmin(abs(distances - wrist)))
    return ArmProfile(centres, actual, np.array(girths), float(actual[wrist_index]))


def cuff_collider(
    profile: ArmProfile, opening: float, layer: float, stretch_max: float
) -> CuffCollider:
    required = profile.girths + 2 * np.pi * layer
    before = np.flatnonzero(profile.distances <= profile.wrist_distance)
    narrow = int(before[np.argmin(required[before])])
    capacity = opening * stretch_max
    fits = bool(required[narrow] <= capacity)
    stop = None
    for index in range(narrow + 1, len(required)):
        if required[index] > capacity:
            low = max(narrow, index - 1)
            fraction = float(
                np.clip(
                    (capacity - required[low]) / max(required[index] - required[low], 1e-12), 0, 1
                )
            )
            stop = float(
                profile.distances[low]
                + fraction * (profile.distances[index] - profile.distances[low])
            )
            break
    radii = np.maximum(config.CLOTH_CUFF_GUIDE_MIN_M, (opening - required) / (2 * np.pi))
    return CuffCollider(
        path=profile.centres.tolist(),
        distances_m=profile.distances.tolist(),
        guide_radii_m=radii.tolist(),
        stop_distance_m=stop,
        opening_m=opening,
        fits_minimum_section=fits,
        source="Computed posed-mesh cross-sections; closed-ring winding/contact guide. "
        "Opening currently inferred; replace with cuff tape. No wrist-position target.",
    )


def neck_collider(
    mesh: trimesh.Trimesh,
    landmarks: dict[str, np.ndarray],
    opening: float,
    layer: float,
    stretch_max: float,
) -> CuffCollider:
    """A closed neckline cannot pass the wider shoulder aperture.

    This is the same topology/contact approximation as the closed hand cuff:
    section geometry sets the free radial slack and distal barrier, never a
    fixed neckline world position. An overlarge opening has no shoulder stop.
    """
    from .wrap import neck_frame

    centre, frame = neck_frame(landmarks)
    up = frame[:, 1]
    shoulder = (landmarks["acromion_L"] + landmarks["acromion_R"]) / 2
    bottom = float((shoulder - centre) @ up)
    stations = np.linspace(
        config.GARMENT_COLLAR_HEIGHT_M,
        bottom,
        int(np.ceil((config.GARMENT_COLLAR_HEIGHT_M - bottom) / config.CLOTH_CUFF_SECTION_STEP_M))
        + 1,
    )
    centres, girths = [], []
    for station in stations:
        origin = centre + station * up
        lines = trimesh.intersections.mesh_plane(mesh, up, origin)
        if not len(lines):
            raise ValueError("Missing neck/shoulder section for closed-neckline contact")
        planar = (lines.reshape(-1, 3) - origin) @ frame[:, [0, 2]]
        hull = planar[ConvexHull(planar).vertices]
        midpoint = (hull.min(0) + hull.max(0)) / 2
        centres.append(origin + frame[:, [0, 2]] @ midpoint)
        girths.append(float(np.linalg.norm(hull - np.roll(hull, 1, 0), axis=1).sum()))
    centres = np.array(centres)
    distance = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(centres, axis=0), axis=1))]
    result = cuff_collider(
        ArmProfile(centres, distance, np.array(girths), float(distance[-1])),
        opening,
        layer,
        stretch_max,
    )
    return result.model_copy(
        update={
            "source": "Computed sloped neck/shoulder mesh sections; closed-neckline aperture "
            "barrier, not a world pin. Opening is an uncalibrated construction assumption."
        }
    )
