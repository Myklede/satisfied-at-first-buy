"""Body-conforming initialisation. Never changes a canonical rest edge length."""

from dataclasses import dataclass, replace

import numpy as np
import trimesh
from scipy.interpolate import CubicHermiteSpline
from scipy.optimize import brentq

from .. import config
from ..fit import FittedBody
from ..pose import DisplayBody
from .builder import radial_resample
from .fit_math import wrapped_section
from .models import SizeFit
from .pattern import Pattern, perimeter
from .seams import attach_accessories
from .shoulder_surface import shoulder_support


@dataclass
class WrappedTorso:
    positions: np.ndarray
    grid: np.ndarray
    upward_contact: np.ndarray


def limb_frames(
    route: np.ndarray, distances: np.ndarray, sign: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Smooth bone-centre curve with a front-stable frame (no elbow roll jump)."""
    segments = np.diff(route, axis=0)
    lengths = np.linalg.norm(segments, axis=1)
    directions = segments / lengths[:, None]
    derivatives = np.vstack((directions[0], (directions[:-1] + directions[1:]) / 2, directions[-1]))
    curve = CubicHermiteSpline(np.r_[0.0, np.cumsum(lengths)], route, derivatives)
    centres = curve(distances)
    tangent = curve(distances, 1)
    tangent /= np.linalg.norm(tangent, axis=1)[:, None]
    front = np.array([0.0, 0.0, 1.0]) - tangent * tangent[:, 2, None]
    front /= np.linalg.norm(front, axis=1)[:, None]
    normal = np.cross(front, tangent) * sign
    return centres, tangent, normal, front


def perimeter_ring(
    support: np.ndarray,
    centre: np.ndarray,
    u: np.ndarray,
    v: np.ndarray,
    angles: np.ndarray,
    target: float,
    reference: np.ndarray | None = None,
) -> np.ndarray:
    """Convex section + radial ease, root-solved against the actual polygon tape.

    An impossible circumference raises, rather than silently inflating the garment.
    Clearance is checked independently; this function preserves the supplied tape.
    """
    dense_angles = angles[0] + np.arange(len(angles) * config.WRAP_RING_OVERSAMPLE) * (
        2 * np.pi / (len(angles) * config.WRAP_RING_OVERSAMPLE)
    )
    sampled = radial_resample(support, centre, u, v, dense_angles)
    direction = sampled - centre
    radii = np.linalg.norm(direction, axis=1)
    direction /= radii[:, None]
    low = -float(radii.min()) + config.SECTION_EPS
    fractions = (
        np.arange(len(angles)) / len(angles) if reference is None else ring_fractions(reference)
    )

    def ring(amount: float) -> np.ndarray:
        return resample_sectors(sampled + direction * amount, fractions)

    amount = brentq(lambda x: perimeter(ring(x)) - target, low, target)
    return ring(amount)


def ring_fractions(points: np.ndarray) -> np.ndarray:
    lengths = np.linalg.norm(np.roll(points, -1, axis=0) - points, axis=1)
    return np.r_[0.0, np.cumsum(lengths)[:-1]] / lengths.sum()


def resample_closed(points: np.ndarray, fractions: np.ndarray) -> np.ndarray:
    closed = np.vstack((points, points[0]))
    arc = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(closed, axis=0), axis=1))]
    return np.c_[[np.interp(fractions * arc[-1], arc, closed[:, k]) for k in range(3)]].T


def resample_sectors(points: np.ndarray, fractions: np.ndarray) -> np.ndarray:
    """Arc-match within anatomical quadrants; do not rotate a front seam off-centre."""
    sectors = config.WRAP_RING_SECTORS
    if len(points) % sectors or len(fractions) % sectors:
        raise ValueError("Material ring resolution must preserve its anatomical sectors")
    result = np.empty((len(fractions), 3))
    material = np.r_[fractions, 1.0]
    width = len(fractions) // sectors
    dense = len(points) // sectors
    for sector in range(sectors):
        start = sector * width
        end = (sector + 1) * width
        segment = points[np.arange(sector * dense, (sector + 1) * dense + 1) % len(points)]
        arc = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(segment, axis=0), axis=1))]
        fraction = (material[start:end] - material[start]) / (material[end] - material[start])
        result[start:end] = np.c_[
            [np.interp(fraction * arc[-1], arc, segment[:, k]) for k in range(3)]
        ].T
    return result


def closest_route_distance(route: np.ndarray, point: np.ndarray) -> float:
    segments = np.diff(route, axis=0)
    lengths = np.linalg.norm(segments, axis=1)
    fractions = np.clip(np.einsum("ij,ij->i", point - route[:-1], segments) / lengths**2, 0, 1)
    closest = route[:-1] + fractions[:, None] * segments
    index = int(np.linalg.norm(closest - point, axis=1).argmin())
    return float(np.r_[0.0, np.cumsum(lengths)][index] + fractions[index] * lengths[index])


def posed_support(body: FittedBody, posed: DisplayBody) -> FittedBody:
    """Reuse torso section extraction on the display mesh, with rest tapes intact."""
    return replace(
        body, mesh=posed.mesh, geometry=replace(body.geometry, landmarks=posed.landmarks)
    )


def neck_frame(landmarks: dict[str, np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
    """Sloped neck base follows C7 to the jugular notch, rather than the jaw."""
    centre = (landmarks["C7"] + landmarks["jugular_notch"]) / 2
    front = landmarks["jugular_notch"] - landmarks["C7"]
    front[0] = 0
    front /= np.linalg.norm(front)
    lateral = np.array([1.0, 0, 0])
    up = np.cross(front, lateral)
    return centre, np.c_[lateral, up, front]


def sleeve_stations(
    material_advance: np.ndarray, start: float, elbow: float, stop: float
) -> np.ndarray:
    """Keep upper-arm material length; place excess distal to the elbow."""
    if stop <= start:
        raise ValueError("The hand barrier must be distal to the sleeve seam")
    upper = min(max(0.0, elbow - start), stop - start)
    advance = np.maximum(0, material_advance)
    scale = min(1.0, (stop - start - upper) / max(advance[-1] - upper, config.SECTION_EPS))
    return start + np.minimum(advance, upper) + np.maximum(advance - upper, 0) * scale


def wrap_torso(
    pattern: Pattern, body: FittedBody, posed: DisplayBody, metrics: SizeFit, thickness: float
) -> WrappedTorso:
    rest = pattern.mesh.vertices
    n, rows = config.CLOTH_TORSO_N, config.CLOTH_TORSO_ROWS
    grid_positions = np.empty((rows, n, 3))
    angles = np.arange(n) * 2 * np.pi / n
    g = body.geometry
    neck, frame = neck_frame(posed.landmarks)
    result = rest @ frame.T + neck
    collar = np.r_[pattern.torso_grid[0], np.flatnonzero(pattern.panels == 6)]
    for height in np.unique(rest[collar, 1]):
        ids = collar[np.isclose(rest[collar, 1], height, atol=config.SECTION_EPS)]
        points = rest[ids]
        angles_collar = np.arctan2(points[:, 2], points[:, 0])
        order = np.argsort(angles_collar)
        ids, points, angles_collar = ids[order], points[order], angles_collar[order]
        origin = neck + frame[:, 1] * height
        lines = trimesh.intersections.mesh_plane(posed.mesh, frame[:, 1], origin)
        if not len(lines):
            raise ValueError("No actual neck surface for the collar wrap")
        result[ids] = perimeter_ring(
            lines.reshape(-1, 3),
            origin,
            frame[:, 0],
            frame[:, 2],
            angles_collar,
            perimeter(points),
            points,
        )
    neck_ring = result[pattern.torso_grid[0]].copy()
    shoulder = np.empty((n, 3))
    seams = {}
    for side in ("L", "R"):
        axis = posed.landmarks[f"elbow_{side}"] - posed.landmarks[f"acromion_{side}"]
        axis /= np.linalg.norm(axis)
        seams[side] = (
            posed.landmarks[f"acromion_{side}"] + axis * metrics.zones["shoulder"].value_cm / 100
        )
    shoulder_rest = pattern.torso_reference[config.CLOTH_SHOULDER_ROW]
    shoulder = shoulder_rest @ frame.T + neck
    left = seams["L"] - shoulder[0]
    right = seams["R"] - shoulder[n // 2]
    correction = np.where((np.cos(angles) >= 0)[:, None], left, right)
    shoulder += correction * np.cos(angles)[:, None] ** 2
    support = g.tapes["chest"].points
    end_y = metrics.anchors["hem_back"][1]
    view = posed_support(body, posed)
    chest_row = config.CLOTH_CHEST_ROW
    # The garment's pit tape need not share the body's maximal-chest plane.
    # Preserve the actual canonical neck-to-pit back seam instead of stretching
    # that short yoke to an independently measured body tape level.
    upper = []
    for r in range(config.CLOTH_SHOULDER_ROW + 1):
        t = r / config.CLOTH_SHOULDER_ROW
        canonical = pattern.torso_reference[r] @ frame.T + neck
        canonical += (neck_ring - (pattern.torso_reference[0] @ frame.T + neck)) * (1 - t)
        canonical += correction * np.cos(angles)[:, None] ** 2 * t
        upper.append(canonical)
    upper = np.array(upper)
    back = n * 3 // 4
    path = rest[pattern.tapes["length_hps"][: chest_row + 1]]
    remaining = (
        np.linalg.norm(np.diff(path, axis=0), axis=1).sum()
        - np.linalg.norm(np.diff(upper[:, back], axis=0), axis=1).sum()
    )

    def chest_at(y):
        support = wrapped_section(view, float(y))
        centre = np.array([0.0, y, (support[:, 2].min() + support[:, 2].max()) / 2])
        ids = pattern.torso_grid[chest_row]
        return perimeter_ring(
            support,
            centre,
            np.array([1.0, 0, 0]),
            np.array([0.0, 0, 1.0]),
            angles,
            perimeter(rest[ids]),
            rest[ids],
        )

    shoulder_back = upper[-1, back]
    chest_y = brentq(
        lambda y: np.linalg.norm(chest_at(y)[back] - shoulder_back) - remaining,
        shoulder_back[1] - remaining,
        shoulder_back[1] - config.SECTION_EPS,
    )
    chest_ring = None
    for r in range(chest_row, rows):
        t = (r - chest_row) / (rows - 1 - chest_row)
        y = chest_y * (1 - t) + end_y * t
        support = wrapped_section(view, float(y))
        centre = np.array([0.0, y, (support[:, 2].min() + support[:, 2].max()) / 2])
        ring = perimeter_ring(
            support,
            centre,
            np.array([1.0, 0, 0]),
            np.array([0.0, 0, 1.0]),
            angles,
            perimeter(rest[pattern.torso_grid[r]]),
            rest[pattern.torso_grid[r]],
        )
        result[pattern.torso_grid[r]] = ring
        grid_positions[r] = ring
        if r == chest_row:
            chest_ring = ring
    for r in range(chest_row):
        if r <= config.CLOTH_SHOULDER_ROW:
            ring = upper[r]
        else:
            t = (r - config.CLOTH_SHOULDER_ROW) / (chest_row - config.CLOTH_SHOULDER_ROW)
            ring = shoulder * (1 - t) + chest_ring * t
        grid = pattern.torso_grid[r]
        result[grid[grid >= 0]] = ring[grid >= 0]
        grid_positions[r] = ring
    support_bounds = np.full(len(result), np.nan)
    ids = np.unique(pattern.torso_grid[1:chest_row].ravel())
    ids = ids[ids >= 0]
    result[ids], support_bounds[ids] = shoulder_support(
        posed.mesh, result[ids], thickness, neck, frame[:, 1]
    )
    for row, grid in enumerate(pattern.torso_grid):
        valid = grid >= 0
        grid_positions[row, valid] = result[grid[valid]]
    return WrappedTorso(result, grid_positions, support_bounds)


def wrap_folded_hood(
    pattern: Pattern, positions: np.ndarray, neck: np.ndarray, frame: np.ndarray
) -> np.ndarray:
    result = positions.copy()
    ids = np.flatnonzero(pattern.panels == 7)
    rest = pattern.mesh.vertices[ids]
    points = rest @ frame.T + neck
    result[ids] = points
    return result


def wrap_cloth(
    pattern: Pattern,
    body: FittedBody,
    posed: DisplayBody,
    metrics: SizeFit,
    thickness: float,
    cuff_distances: dict[str, float],
) -> WrappedTorso:
    torso = wrap_torso(pattern, body, posed, metrics, thickness)
    positions = wrap_sleeves(pattern, torso.positions, posed, cuff_distances)
    neck, frame = neck_frame(posed.landmarks)
    positions = wrap_folded_hood(pattern, positions, neck, frame)
    return WrappedTorso(attach_accessories(pattern, positions), torso.grid, torso.upward_contact)


def wrap_sleeves(
    pattern: Pattern, positions: np.ndarray, body: DisplayBody, cuff_distances: dict[str, float]
) -> np.ndarray:
    result = positions.copy()
    rest = pattern.mesh.vertices
    for side, sign in (("L", 1), ("R", -1)):
        cap_ids = pattern.tapes[f"cap_{side}"][:-1]
        cap = result[cap_ids]
        ids = pattern.sleeve_grids[side]
        arm_mesh = trimesh.Trimesh(body.mesh.vertices, body.arm_faces[side], process=False)
        route = body.arm_centres[side]
        arm_length = np.linalg.norm(np.diff(route, axis=0), axis=1).sum()
        end = min(arm_length, cuff_distances[side])
        # Source is the exact original outer seam, not a shopper-specific offset.
        cap_centre = rest[cap_ids].mean(0)
        seam = pattern.landmarks[f"seam_{side}"]
        start_distance = closest_route_distance(route, result[seam])
        x = (rest[ids].mean(1)[:, 0] - rest[seam, 0]) * sign
        # Preserve the cap/upper-arm material advance. Uniformly shortening the
        # whole sleeve puts its narrow bicep row over the wider deltoid. Excess
        # belongs distal to the elbow, where the hand arrests the cuff and the
        # forearm material can stack during the short relaxation.
        distance = sleeve_stations(
            x, start_distance, float(np.linalg.norm(route[1] - route[0])), end
        )
        centres, tangent, normal, front = limb_frames(route, distance, sign)
        first = config.CLOTH_BICEP_ROW - 1
        theta = np.arctan2(rest[ids[first], 2] - cap_centre[2], rest[ids[first], 1] - cap_centre[1])
        for r in range(first, len(ids)):
            ring_ids = ids[r]
            point, axis = centres[r], tangent[r]
            lines = trimesh.intersections.mesh_plane(arm_mesh, axis, point)
            if not len(lines):
                raise ValueError(f"No actual arm surface at {side} sleeve row {r}")
            support = lines.reshape(-1, 3)
            centre = support.mean(0)
            centre -= axis * ((centre - point) @ axis)
            ring = perimeter_ring(
                support,
                centre,
                normal[r],
                front[r],
                theta,
                perimeter(rest[ring_ids]),
                rest[ring_ids],
            )
            result[ring_ids] = ring
        for r in range(first):
            t = (r + 1) / (first + 1)
            ring = cap * (1 - t) + result[ids[first]] * t
            result[ids[r]] = ring
        inner = pattern.tapes.get(f"cuff_inner_{side}")
        if inner:
            centre = result[ids[-1]].mean(0)
            radial = result[ids[-1]] - centre
            radial *= perimeter(rest[inner[:-1]]) / perimeter(result[ids[-1]])
            result[inner[:-1]] = centre + radial - tangent[-1] * config.GARMENT_BAND_HEIGHT_M
    return result
