"""Tape-true garment shell built directly on the posed body (03c fallback construction).

Every ring circumference comes from the garment tape (chest, hem, bicep) or, where no
tape exists, from the body section plus the minimum layer clearance. Lengths come from
the analytic fit (hem height from ``length_hps``, seam from ``shoulder``) and the
``sleeve`` tape. Rest == initial except where the real garment is not at rest when worn:

* sleeve material beyond the hand barrier is compressed axially (stacking above the cuff);
* an elastic hem keeps its relaxed tape as rest and is stretched over the body.

Seams are shared vertices: torso, sleeves, collar and hood are one connected mesh.
"""

from dataclasses import dataclass, field
from itertools import chain

import numpy as np
import trimesh
from scipy.optimize import brentq
from scipy.spatial import ConvexHull, cKDTree

from .. import config
from ..fit import FittedBody
from ..pose import DisplayBody
from .models import GarmentSpec, SizeFit
from .wrap import limb_frames, neck_frame

PANEL_FRONT_L, PANEL_FRONT_R, PANEL_BACK, PANEL_YOKE = 0, 1, 2, 3
PANEL_SLEEVE = {"L": 4, "R": 5}
PANEL_COLLAR, PANEL_HOOD = 6, 7


@dataclass
class Shell:
    rest: np.ndarray
    initial: np.ndarray
    faces: np.ndarray
    panels: np.ndarray
    elastic: np.ndarray
    stitch: np.ndarray
    uv: np.ndarray
    quilt: np.ndarray
    paths: dict[str, list[int]]
    landmarks: dict[str, int]
    torso_grid: np.ndarray
    sleeve_grids: dict[str, np.ndarray]
    hood_grid: np.ndarray | None
    levels: dict[str, float]
    warnings: list[str] = field(default_factory=list)
    # Material (rest) arc along each sleeve from the armhole, metres; uv v elsewhere. Where
    # a sleeve stacks above the cuff this exceeds the shown arc (uv v).
    material_v: np.ndarray | None = None


def unique_pairs(pairs: np.ndarray) -> np.ndarray:
    """``np.unique(pairs, axis=0)`` for non-negative integer pairs with ``a <= b`` (sorted edge
    pairs): the same rows in the same lexicographic order, through one integer key per row
    (``axis=0`` lexsorts a void view, ~6 % of a shell build; P2's profile, L3)."""
    if not len(pairs):
        return np.unique(pairs, axis=0)
    pairs = np.asarray(pairs)
    n = int(pairs.max()) + 1
    keys = np.unique(pairs[:, 0].astype(np.int64) * n + pairs[:, 1].astype(np.int64))
    return np.stack((keys // n, keys % n), axis=1).astype(pairs.dtype, copy=False)


def closed(ids: np.ndarray) -> list[int]:
    ids = [int(i) for i in ids]
    return ids + ids[:1]


def ring_perimeter(points: np.ndarray) -> float:
    return float(np.linalg.norm(points - np.roll(points, 1, axis=0), axis=1).sum())


_OCTAGON = np.c_[np.cos(np.arange(8) * np.pi / 4), np.sin(np.arange(8) * np.pi / 4)]


def hull_polygon(points2: np.ndarray) -> np.ndarray:
    """CCW convex hull of 2D points (same vertex set as qhull, which on Windows also opens a
    temporary file per call).

    Akl-Toussaint filter (drop points strictly inside the octagon of extreme points), then
    Andrew's monotone chain on the few remaining points; collinear points are dropped.
    """
    points2 = np.asarray(points2, dtype=np.float64)
    extreme = np.argmax(points2 @ _OCTAGON.T, axis=0)  # in direction (CCW) order
    _, first = np.unique(extreme, return_index=True)
    octagon = points2[extreme[np.sort(first)]]
    if len(octagon) >= 3:
        start = octagon
        end = np.roll(octagon, -1, axis=0)
        edge = end - start
        rel = points2[:, None, :] - start[None, :, :]
        cross = edge[None, :, 0] * rel[:, :, 1] - edge[None, :, 1] * rel[:, :, 0]
        candidates = points2[~(cross > 1e-12).all(1)]
    else:
        candidates = points2
    pts = np.unique(candidates, axis=0)  # sorted by x then y
    if len(pts) < 3:
        return points2[ConvexHull(points2).vertices]  # raises for degenerate input

    def cross2(o, a, b) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    rows = [tuple(p) for p in pts]
    lower: list[tuple[float, float]] = []
    for p in rows:
        while len(lower) >= 2 and cross2(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper: list[tuple[float, float]] = []
    for p in reversed(rows):
        while len(upper) >= 2 and cross2(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    hull = np.array(lower[:-1] + upper[:-1])
    if len(hull) < 3:
        return points2[ConvexHull(points2).vertices]
    return hull


def offset_basis(poly: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """The offset-independent part of ``offset_polygon`` (edge normals, corner arc directions):
    a ring search offsets one hull several times (L3, from P2's profile)."""
    edge = np.roll(poly, -1, axis=0) - poly
    normal = np.c_[edge[:, 1], -edge[:, 0]] / np.maximum(
        np.linalg.norm(edge, axis=1)[:, None], 1e-12
    )
    # Corner at vertex i+1 sweeps from this edge's normal to the next edge's normal.
    a0 = np.arctan2(normal[:, 1], normal[:, 0])
    a1 = np.roll(a0, -1)
    sweep = (a1 - a0 + np.pi) % (2 * np.pi) - np.pi
    steps = config.SHELL_OFFSET_ARC_STEPS
    t = np.arange(steps + 1) / steps
    corner = np.roll(poly, -1, axis=0)
    angles = a0[:, None] + sweep[:, None] * t[None, :]
    return poly, normal, corner, np.stack((np.cos(angles), np.sin(angles)), axis=2)


def offset_polygon(poly: np.ndarray, distance: float, basis=None) -> np.ndarray:
    """Dense Minkowski-style outward offset of a CCW convex polygon (perimeter + 2*pi*d).

    ``basis``: ``offset_basis(poly)`` when the same polygon is offset repeatedly.
    """
    poly, normal, corner, directions = basis if basis is not None else offset_basis(poly)
    arc = corner[:, None, :] + distance * directions
    start = (poly + normal * distance)[:, None, :]
    return np.concatenate((start, arc), axis=1).reshape(-1, 2)


def ray_sample(poly: np.ndarray, centre: np.ndarray, angles: np.ndarray) -> np.ndarray:
    """Intersect rays from an interior centre with a closed polygon (furthest hit).

    Convex CCW polygons (every hull/offset ring here) take an exact O(n log n) path: each ray
    meets the one edge whose angular span about the centre contains it. Anything else falls
    back to testing every edge.
    """
    rel = poly - centre
    ang = np.unwrap(np.arctan2(rel[:, 1], rel[:, 0]))
    spans = np.r_[ang, ang[0] + 2 * np.pi]
    # Duplicate offset-corner points differ by ~1e-17 m; clamp that round-off to zero span
    # (a zero-span edge is never selected) instead of falling back.
    if len(poly) >= 3 and (np.diff(spans) >= -1e-9).all():
        spans = np.maximum.accumulate(spans)
        direction = np.c_[np.cos(angles), np.sin(angles)]
        wrapped = ang[0] + np.mod(angles - ang[0], 2 * np.pi)
        index = np.clip(np.searchsorted(spans, wrapped, side="right") - 1, 0, len(poly) - 1)
        a = rel[index]
        edge = rel[(index + 1) % len(poly)] - a
        cross = direction[:, 0] * edge[:, 1] - direction[:, 1] * edge[:, 0]
        if (np.abs(cross) >= 1e-14).all():
            radii = (a[:, 0] * edge[:, 1] - a[:, 1] * edge[:, 0]) / cross
            if (radii >= 0).all():
                return centre + radii[:, None] * direction
    return _ray_sample_dense(poly, centre, angles)


def _ray_sample_dense(poly: np.ndarray, centre: np.ndarray, angles: np.ndarray) -> np.ndarray:
    a = poly - centre
    b = np.roll(poly, -1, axis=0) - centre
    edge = b - a
    direction = np.c_[np.cos(angles), np.sin(angles)]
    cross = direction[:, 0, None] * edge[None, :, 1] - direction[:, 1, None] * edge[None, :, 0]
    denom = np.where(np.abs(cross) < 1e-14, np.nan, cross)
    distance = (a[:, 0] * edge[:, 1] - a[:, 1] * edge[:, 0])[None, :] / denom
    fraction = (
        a[None, :, 0] * direction[:, None, 1] - a[None, :, 1] * direction[:, None, 0]
    ) / denom
    distance[(fraction < -1e-9) | (fraction > 1 + 1e-9) | (distance < 0)] = np.nan
    radii = np.nanmax(distance, axis=1)
    if not np.isfinite(radii).all():
        raise ValueError("Ring centre lies outside its convex support")
    return centre + radii[:, None] * direction


def clip_polygon_x(poly: np.ndarray, low: float, high: float) -> np.ndarray:
    """Convex polygon clipped to low <= x <= high (Sutherland-Hodgman, two half-planes)."""
    for sign, bound in ((1.0, high), (-1.0, -low)):
        if not np.isfinite(bound):
            continue
        inside = sign * poly[:, 0] <= bound
        if inside.all():
            continue
        # Per edge (a -> b): keep a if inside, then the crossing point if the edge crosses
        # (vectorised; same points in the same order as the per-edge loop).
        nxt = np.roll(poly, -1, axis=0)
        crosses = inside != np.roll(inside, -1)
        rows = np.flatnonzero(crosses)
        a, b = poly[rows], nxt[rows]
        t = (bound - sign * a[:, 0]) / (sign * (b[:, 0] - a[:, 0]))
        points = np.empty((len(poly), 2, poly.shape[1]))
        points[:, 0] = poly
        points[rows, 1] = a + t[:, None] * (b - a)
        poly = points[np.c_[inside, crosses]]
    return poly


def fitted_ring(
    hull: np.ndarray,
    centre: np.ndarray,
    angles: np.ndarray,
    target: float | None,
    minimum: float,
    clip: tuple[float, float] | None = None,
    post=None,
) -> tuple[np.ndarray, float, bool]:
    """Sampled ring with perimeter == target (if achievable) and clearance >= minimum.

    ``clip`` = (low, high) x bounds: the ring is flattened there (the hanging arms press the
    side panels in) and the tape is taken up front and back instead; bounds closer to the hull
    than ``minimum`` are relaxed to hull + minimum (body clearance wins). ``post`` (sampled
    ring -> ring) reshapes each candidate ring before it is measured (a sleeve ring flattened
    on the torso shell); the tape is solved on the reshaped ring.
    Returns (2D ring, offset, clamped). ``clamped`` marks a tape smaller than body+clearance.
    """
    if clip is not None:
        clip = (
            min(clip[0], float(hull[:, 0].min()) - minimum),
            max(clip[1], float(hull[:, 0].max()) + minimum),
        )

    memo: dict[float, np.ndarray] = {}
    basis = offset_basis(hull)

    def ring(d: float) -> np.ndarray:
        # Deterministic in d: repeated offsets (the bracket ends, brentq's last point, the final
        # ring) are built once (L3, P2's profile: ~2.5 rings per call).
        key = float(d)
        if key not in memo:
            poly = offset_polygon(hull, d, basis)
            if clip is not None:
                poly = clip_polygon_x(poly, *clip)
            sampled = ray_sample(poly, centre, angles)
            memo[key] = sampled if post is None else post(sampled)
        return memo[key]

    smallest = ring(minimum)
    if target is None or ring_perimeter(smallest) >= target:
        return smallest, minimum, target is not None and ring_perimeter(smallest) > target
    high = minimum + target / (2 * np.pi)
    while (clip is not None or post is not None) and ring_perimeter(ring(high)) < target:
        high *= 2  # clipped/flattened sides: the perimeter grows only on the others
    # The sampled perimeter grows almost linearly with the offset (slope just under 2*pi), so
    # a bracketed secant hits the tape in 2-3 rings; perimeter tolerance 1e-7 m (tighter than
    # the previous brentq xtol). Bracket safeguard and brentq fallback keep it exact.
    lo, hi = minimum, high
    prev_d, prev_f = minimum, ring_perimeter(smallest) - target
    d = min(minimum - prev_f / (2 * np.pi), (lo + hi) / 2)
    for _ in range(config.SHELL_RING_SECANT_STEPS):
        candidate = ring(d)
        f = ring_perimeter(candidate) - target
        if abs(f) <= config.SHELL_RING_TOLERANCE_M:
            return candidate, d, False
        if f < 0:
            lo = d
        else:
            hi = d
        slope = (f - prev_f) / (d - prev_d) if d != prev_d else 0.0
        step = d - f / slope if slope > 0 else (lo + hi) / 2
        prev_d, prev_f = d, f
        d = step if lo < step < hi else (lo + hi) / 2
    d = brentq(lambda x: ring_perimeter(ring(x)) - target, lo, hi, xtol=1e-9)
    return ring(d), d, False


def hang_rings(
    rings: np.ndarray,
    levels: np.ndarray,
    info: list[tuple[np.ndarray, float, tuple[float, float]] | None],
    centre: np.ndarray,
    angles: np.ndarray,
    minimum: float,
    band_floor: float,
) -> None:
    """Loose torso rows hang from the row above instead of following the body section (L2).

    A loose jacket's fabric falls straight from the widest part above it (bust, shoulder
    blades, seat); fitted to every horizontal body section, each row hugged the waist and belly
    and the shell showed the body through it (the user: "hug or bulge"). Rows at or above
    ``band_floor`` (the arm band, where the hanging arm presses the side panels in; it holds the
    chest tape ring) keep their fitted shape and the lowest of them seeds the hang. Below it,
    each taped row becomes r(theta) = smoothmax(s * r_above(theta), r_body(theta)) about the
    shell axis: the row above scaled uniformly, never closer to the body than ``minimum`` and
    never past the hanging arms' inner sides (``arm_clearance`` bounds, relaxed to the body
    clearance), with s solved so the row's perimeter is its tape (girth unchanged). Rows whose
    tape is already tighter than body + clearance keep their fitted shape. In place.
    """
    seed = None
    cos = np.cos(angles)
    for i, y in enumerate(levels):
        if info[i] is None:
            continue
        fitted = rings[i, :, [0, 2]].T
        if seed is None or y >= band_floor:
            # Arm band rows keep their fitted (arm-clipped) shape; the lowest one seeds the hang
            # (reshaped there, the sleeve's underside lost its room: new sleeve/torso crossings
            # on 2XL over small bodies).
            seed = fitted - centre
            continue
        hull, target, (low, high) = info[i]
        floor2, _, _ = fitted_ring(hull, centre, angles, None, minimum)
        r_body = np.linalg.norm(floor2 - centre, axis=1)
        r_seed = np.linalg.norm(seed, axis=1)
        unit = seed / np.maximum(r_seed, 1e-12)[:, None]
        # Lateral bounds along each ray: the hanging arms' inner sides with room for the sleeve
        # (``arm_clearance``: a hung row widened toward the forearms crossed the sleeves).
        right, left = high - centre[0], centre[0] - low
        reach = np.where(cos > 0, right, left)
        r_cap = np.full(len(angles), np.inf)
        side = np.abs(cos) > 1e-6
        r_cap[side] = np.maximum(reach[side], 0.0) / np.abs(cos[side])
        r_cap = np.maximum(r_cap, r_body)  # body clearance wins (as in fitted_ring)

        def ring_at(scale, unit=unit, r_seed=r_seed, r_body=r_body, r_cap=r_cap):
            # Smooth max: the fabric drapes over a body bulge (seat, hip) instead of creasing
            # where the body takes over from the row above; never inside max(...).
            a, k = scale * r_seed, config.SHELL_HANG_BLEND_M
            r = np.minimum(0.5 * (a + r_body + np.sqrt((a - r_body) ** 2 + k * k)), r_cap)
            return centre + unit * r[:, None]

        if ring_perimeter(ring_at(0.0)) >= target or ring_perimeter(ring_at(1e3)) <= target:
            seed = fitted - centre
            continue
        high = 1.0
        while ring_perimeter(ring_at(high)) < target:
            high *= 1.5
        scale = brentq(lambda k, t=target: ring_perimeter(ring_at(k)) - t, 0.0, high, xtol=1e-12)
        ring2 = ring_at(scale)
        rings[i, :, 0], rings[i, :, 2] = ring2[:, 0], ring2[:, 1]
        seed = ring2 - centre


def torso_only(posed: DisplayBody) -> trimesh.Trimesh:
    faces = posed.mesh.faces
    arm = np.vstack([posed.arm_faces[s] for s in ("L", "R")])
    key = np.sort(faces, axis=1) @ np.array([1, 1 << 20, 1 << 40], dtype=np.int64)
    arm_key = np.sort(arm, axis=1) @ np.array([1, 1 << 20, 1 << 40], dtype=np.int64)
    keep = ~np.isin(key, arm_key)
    return trimesh.Trimesh(posed.mesh.vertices, faces[keep], process=False)


def horizontal_hull(mesh: trimesh.Trimesh, y: float, max_x: float) -> np.ndarray | None:
    lines = trimesh.intersections.mesh_plane(mesh, [0.0, 1.0, 0.0], [0.0, y, 0.0])
    if not len(lines):
        return None
    points = lines.reshape(-1, 3)[:, [0, 2]]
    points = points[np.abs(points[:, 0]) <= max_x]
    if len(points) < 3:
        return None
    return hull_polygon(points)


class PlaneSlicer:
    """Points where a fixed triangle set's edges cross a plane (a mesh section's vertices).

    Same points as ``trimesh.intersections.mesh_plane`` endpoints, without rebuilding mesh
    caches per call; only their convex hull is used, so segment pairing is not needed.
    """

    def __init__(self, vertices: np.ndarray, faces: np.ndarray) -> None:
        edges = np.sort(faces[:, [[0, 1], [1, 2], [2, 0]]].reshape(-1, 2), axis=1)
        self.edges = unique_pairs(edges)
        self.vertices = vertices
        self.start = vertices[self.edges[:, 0]]
        self.vector = vertices[self.edges[:, 1]] - self.start

    def points(self, origin: np.ndarray, normal: np.ndarray) -> np.ndarray:
        d = (self.vertices - origin) @ normal
        d0, d1 = d[self.edges[:, 0]], d[self.edges[:, 1]]
        cross = ((d0 <= 0) & (d1 > 0)) | ((d0 > 0) & (d1 <= 0))
        t = d0[cross] / (d0[cross] - d1[cross])
        return self.start[cross] + t[:, None] * self.vector[cross]


class ShellBodyCache:
    """Body-only inputs of ``build_shell``, computed once per posed body and reused across
    products and sizes (sections, armpit level, surface query)."""

    def __init__(self, posed: DisplayBody, armpit: float | None = None) -> None:
        from ..surface_query import SurfaceQuery

        self.posed = posed
        self.torso = torso_only(posed)
        self.torso_slicer = PlaneSlicer(posed.mesh.vertices, self.torso.faces)
        self.full_slicer = PlaneSlicer(posed.mesh.vertices, posed.mesh.faces)
        self.arm_slicers = {
            side: PlaneSlicer(posed.mesh.vertices, posed.arm_faces[side]) for side in ("L", "R")
        }
        self.query = SurfaceQuery(posed.mesh)
        self.armpit = armpit_level(posed) if armpit is None else armpit
        self.hulls: dict[tuple[bool, float, float], np.ndarray | None] = {}
        self._parts = None

    @property
    def parts(self):
        """Surface queries of the torso (body minus arms) and of each arm (unfold pass)."""
        if self._parts is None:
            from .shell_defects import body_parts

            self._parts = body_parts(self.posed.mesh, self.posed.arm_faces)
        return self._parts

    def __reduce__(self):
        # Ship only what is slow to recompute (armpit search); indices rebuild in ~0.1 s.
        return (ShellBodyCache, (self.posed, self.armpit))

    def arm_clearance(self, y: float, minimum: float) -> tuple[float, float]:
        """(low, high) x bounds that keep a torso ring at level ``y`` clear of the inner side of
        each hanging arm, with room for the sleeve underside between them:
        SHELL_ARM_SIDE_ROOM_LAYERS clearances plus the sleeve/torso separation (-inf / inf where
        that arm does not cross the level)."""
        origin, up = np.array([0.0, y, 0.0]), np.array([0.0, 1.0, 0.0])
        bounds = [-np.inf, np.inf]
        for k, (side, sign) in enumerate((("R", -1.0), ("L", 1.0))):
            points = self.arm_slicers[side].points(origin, up)
            points = points[sign * points[:, 0] > 0]
            if len(points):
                room = minimum * config.SHELL_ARM_SIDE_ROOM_LAYERS + config.SHELL_SEPARATION_M
                bounds[k] = float(sign * (np.abs(points[:, 0]).min() - room))
        return bounds[0], bounds[1]

    def horizontal_hull(self, full: bool, y: float, max_x: float) -> np.ndarray | None:
        key = (full, float(y), float(max_x))
        if key not in self.hulls:
            slicer = self.full_slicer if full else self.torso_slicer
            points = slicer.points(np.array([0.0, y, 0.0]), np.array([0.0, 1.0, 0.0]))[:, [0, 2]]
            points = points[np.abs(points[:, 0]) <= max_x]
            self.hulls[key] = hull_polygon(points) if len(points) >= 3 else None
        return self.hulls[key]


def armpit_level(posed: DisplayBody) -> float:
    """Lowest level at which a horizontal body section joins arm and torso."""
    mesh = posed.mesh
    acromion = abs(posed.landmarks["acromion_L"][0])
    from ..measure import section_loops

    top = float(posed.landmarks["acromion_L"][1])
    # Only faces reaching into the scanned band can cross a level; section those, in their
    # original order (the same crossing triangles in the same order at every level, so the same
    # loops). Sectioning the whole mesh 150 times was ~0.5 s on the asset's critical path (P2).
    heights = mesh.vertices[mesh.faces, 1]
    band = (heights.min(1) <= top + 0.01) & (heights.max(1) >= top - 0.31)
    faces = mesh.faces[band]
    for y in np.arange(top - 0.30, top, 0.002):
        loops = section_loops(mesh.vertices, faces, np.array([0.0, y, 0.0]), np.array([0, 1.0, 0]))
        central = [lp.points for lp in loops if abs(lp.points[:, 0].mean()) < 0.05]
        if central and max(np.abs(c[:, 0]).max() for c in central) > 0.9 * acromion:
            return float(y)
    raise ValueError("Armpit level not found on the posed body")


def smoothstep(t: np.ndarray | float) -> np.ndarray | float:
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3 - 2 * t)


class ClosestMemo:
    """``SurfaceQuery.closest`` remembered per exact query point (one shell build).

    The clearance repairs re-check the same samples many times (about 30 % of the queried
    points are bit-identical repeats: unmoved vertices, edge midpoints and centroids). The
    answer is a pure function of the point's coordinates, so a hit returns exactly what the
    query would. ``closest`` is the only method the repairs use.
    """

    def __init__(self, query) -> None:
        self.query = query
        self.index: dict[bytes, int] = {}
        self.closest_points = np.empty((0, 3))
        self.distances = np.empty(0)
        self.triangles = np.empty(0, np.int64)

    def closest(self, points: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        points = np.ascontiguousarray(points, dtype=np.float64)
        keys = points.view(np.dtype((np.void, 8 * points.shape[1]))).ravel().tolist()
        found = np.fromiter((self.index.get(k, -1) for k in keys), np.int64, len(keys))
        miss = np.flatnonzero(found < 0)
        if len(miss):
            closest, distance, triangle = self.query.closest(points[miss])
            start = len(self.distances)
            self.closest_points = np.vstack((self.closest_points, closest))
            self.distances = np.r_[self.distances, distance]
            self.triangles = np.r_[self.triangles, triangle]
            found[miss] = np.arange(start, start + len(miss))
            self.index.update(
                zip([keys[k] for k in miss.tolist()], found[miss].tolist(), strict=True)
            )
        return self.closest_points[found], self.distances[found], self.triangles[found]


def build_shell(
    product: GarmentSpec,
    size_name: str,
    metrics: SizeFit,
    body: FittedBody,
    posed: DisplayBody,
    layer_m: float,
    cuff_stop: dict[str, float],
    cache: ShellBodyCache | None = None,
) -> Shell:
    cache = cache if cache is not None else ShellBodyCache(posed)
    query = ClosestMemo(cache.query)  # this build's clearance re-checks share their answers
    size = product.sizes[size_name]
    loft = product.loft_cm / 100
    two_pi_loft = 2 * np.pi * loft
    minimum = layer_m + config.SHELL_CLEARANCE_M
    warnings: list[str] = []
    n = config.SHELL_TORSO_N
    angles = np.arange(n) * 2 * np.pi / n  # 0 = +X (left), pi/2 = front (+Z)
    lm = posed.landmarks
    neck, neck_axes = neck_frame(lm)
    acromion_x = abs(float(lm["acromion_L"][0]))
    hip_points = body.geometry.tapes["hip"].points
    hip_x = float(np.abs(hip_points[:, 0]).max())
    y_pit = cache.armpit
    y_ah = y_pit - config.SHELL_ARMHOLE_DROP_M
    y_top = float(lm["acromion_L"][1])
    hem_y = float(np.mean([metrics.anchors["hem_back"][1], metrics.anchors["hem_front"][1]]))
    if hem_y >= y_ah - 0.05:
        raise ValueError("Garment length ends above the armhole")
    chest_inner = size.chest.value_cm / 100 - two_pi_loft
    hem_inner = size.hem.value_cm / 100 - two_pi_loft
    band = config.GARMENT_BAND_HEIGHT_M * 3 if product.hem_elastic else 0.0

    def tape_target(y: float) -> float | None:
        if y > y_ah:
            return None
        if product.hem_elastic:
            t = smoothstep((hem_y + band - y) / max(band, 1e-6))
            return chest_inner * (1 - t) + hem_inner * t
        t = (y_ah - y) / (y_ah - hem_y)
        return chest_inner * (1 - t) + hem_inner * t

    # Axis: vertical line inside every torso section.
    chest_hull = cache.horizontal_hull(False, y_ah, acromion_x + 0.02)
    axis_z = float((chest_hull[:, 1].min() + chest_hull[:, 1].max()) / 2)
    centre2 = np.array([0.0, axis_z])

    # Neckline in the sloped neck-base plane, sampled by rays from the shared axis.
    lateral, up, front = neck_axes[:, 0], neck_axes[:, 1], neck_axes[:, 2]
    neck_pts = cache.torso_slicer.points(neck, up)
    local = np.c_[(neck_pts - neck) @ lateral, (neck_pts - neck) @ front]
    neck_hull = hull_polygon(local)
    axis_point = np.array([0.0, 0.0, axis_z])
    # Where the vertical axis pierces the neck plane, in plane coordinates.
    t_axis = ((neck - axis_point) @ up) / up[1]
    pierce = axis_point + np.array([0.0, t_axis, 0.0])
    pierce2 = np.array([(pierce - neck) @ lateral, (pierce - neck) @ front])
    directions = np.c_[np.cos(angles), np.zeros(n), np.sin(angles)]
    plane_dir = np.c_[directions @ lateral, directions @ front]
    plane_angles = np.arctan2(plane_dir[:, 1], plane_dir[:, 0])
    neck_ring2, _, _ = fitted_ring(neck_hull, pierce2, plane_angles, None, minimum)
    neckline = neck + neck_ring2[:, :1] * lateral + neck_ring2[:, 1:] * front

    # Dense horizontal rings from the neck down to the hem.
    step = config.SHELL_LEVEL_STEP_M
    levels = np.arange(float(neckline[:, 1].max()) - step / 2, hem_y - step, -step)
    levels = np.r_[levels[levels > hem_y], hem_y]
    # The armhole-bottom ring is an exact (taped, torso-only) section. Interpolated between the
    # level above (whose full-body section wraps the arm root) and the one below, that row lay
    # half-way across the arm, up to 2.7 cm inside it (sleeve-cap wings).
    levels = np.sort(np.unique(np.r_[levels, y_ah]))[::-1]
    offsets_at_ah = None
    last_taped = None
    arm_band = config.SHELL_ARM_SIDE_BAND_M

    rings = []
    hang_info: list[tuple[np.ndarray, float] | None] = []  # (body hull, tape) per taped level
    clamped_levels = []
    for y in levels[::-1]:  # bottom-up so the yoke can blend to the armhole offset
        if y > y_ah:
            # Above the armhole the shell must also clear the deltoid/upper-arm root.
            hull = cache.horizontal_hull(True, float(y), acromion_x + config.SHELL_SHOULDER_REACH_M)
        else:
            hull = cache.horizontal_hull(False, float(y), max(hip_x + 0.03, acromion_x))
        if hull is None:
            rings.append(None)
            hang_info.append(None)
            continue
        target = tape_target(float(y))
        hang_info.append(
            (hull, target, cache.arm_clearance(float(y), minimum)) if target is not None else None
        )
        if target is not None:
            # Just below the armhole the hanging upper arm lies closer to the torso than the
            # taped ring's ease: the arm presses the side panel in (the ring is flattened to
            # clear the arm) and the tape length goes front and back. Without this the ring
            # cut up to 3.7 cm into the arm and the sleeve cap started inside it (wings).
            clip = cache.arm_clearance(float(y), minimum) if y >= y_ah - arm_band else None
            ring2, d, clamped = fitted_ring(hull, centre2, angles, target, minimum, clip)
            if clamped:
                clamped_levels.append(float(y))
            offsets_at_ah = d
            last_taped = (hull, target, clip is not None)
        else:
            if last_taped is not None and last_taped[2]:
                # The yoke eases from the armhole offset of the unflattened tape ring (the
                # flattened ring's larger front/back offset would puff the shoulders).
                hull_ah, target_ah, _ = last_taped
                _, offsets_at_ah, _ = fitted_ring(hull_ah, centre2, angles, target_ah, minimum)
            last_taped = None
            d_ah = offsets_at_ah if offsets_at_ah is not None else minimum
            t = smoothstep((y - y_ah) / max(y_top - y_ah, 1e-6))
            ring2, _, _ = fitted_ring(hull, centre2, angles, None, d_ah * (1 - t) + minimum * t)
        rings.append(np.c_[ring2[:, 0], np.full(n, y), ring2[:, 1]])
    rings = rings[::-1]
    hang_info = hang_info[::-1]
    valid = [r is not None for r in rings]
    levels = levels[valid]
    hang_info = [h for h, ok in zip(hang_info, valid, strict=True) if ok]
    rings = np.array([r for r in rings if r is not None])  # (L, n, 3)
    if product.fit_intent in config.SHELL_HANG_FIT_INTENTS:
        hang_rings(rings, levels, hang_info, centre2, angles, minimum, y_ah - arm_band)
    if clamped_levels:
        warnings.append(
            f"Garment tape is tighter than body + {minimum * 100:.1f} cm clearance over "
            f"{len(clamped_levels)} levels ({min(clamped_levels):.2f}-{max(clamped_levels):.2f} m);"
            " ring held at minimum clearance (stretched)."
        )

    # Column meridians: neckline point, then ring points below it.
    rows_top, rows_mid = config.SHELL_ROWS_TOP, config.SHELL_ROWS_MID
    rows_low = max(8, int(round((y_ah - hem_y) / config.SHELL_ROW_SPACING_M)))
    total_rows = rows_top + rows_mid + rows_low + 1
    grid_pos = np.empty((total_rows, n, 3))
    for j in range(n):
        start = neckline[j]
        below = levels < start[1] - step * 0.5
        path = np.vstack((start, rings[below, j]))
        arc = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(path, axis=0), axis=1))]
        ys = path[:, 1]
        s_ah = float(np.interp(-y_ah, -ys, arc))
        s_hem = float(arc[-1])
        # Shoulder ridge: first point where the meridian slope exceeds 45 degrees.
        seg = np.diff(path, axis=0)
        steep = np.abs(seg[:, 1]) > np.linalg.norm(seg[:, [0, 2]], axis=1)
        steep &= path[1:, 1] < y_top + 0.02
        ridge = int(np.argmax(steep)) if steep.any() else 0
        s_top = float(min(arc[ridge], s_ah * 0.8))
        s_top = max(s_top, config.SHELL_MIN_YOKE_M)
        stations = np.r_[
            np.linspace(0, s_top, rows_top, endpoint=False),
            np.linspace(s_top, s_ah, rows_mid, endpoint=False),
            np.linspace(s_ah, s_hem, rows_low + 1),
        ]
        for k in range(3):
            grid_pos[:, j, k] = np.interp(stations, arc, path[:, k])
        # Rows at and below the armhole bottom are exactly horizontal.
        low = slice(rows_top + rows_mid, total_rows)
        target_y = np.linspace(y_ah, hem_y, rows_low + 1)
        for r, yy in zip(range(low.start, low.stop), target_y, strict=True):
            idx = np.argmin(np.abs(levels - yy))
            grid_pos[r, j] = (
                rings[idx, j]
                if abs(levels[idx] - yy) < 1e-9
                else _interp_ring(levels, rings, yy, j)
            )
    r_top, r_ah = rows_top, rows_top + rows_mid
    # Remove section-sampling stair-steps over the shoulders (rows above the armhole
    # bottom only, so the chest/hem tape rows are untouched). Body clearance is re-checked.
    grid_pos[1:r_top] = taubin_grid(grid_pos, 1, r_top, config.SHELL_SMOOTH_PASSES)[1:r_top]
    # Same for the rows between the shoulder ridge and the armhole bottom (no tape: they are
    # body + clearance sections): their meridian kinks drew faceted highlights on the glossy
    # shell. Row r_ah (the first taped ring) stays fixed; the push repair re-checks clearance.
    if config.SHELL_MID_SMOOTH_PASSES:
        smooth = taubin_grid(grid_pos, r_top, r_ah, config.SHELL_MID_SMOOTH_PASSES)
        grid_pos[r_top:r_ah] = smooth[r_top:r_ah]

    # Armhole holes.
    span = int(round(np.deg2rad(config.SHELL_ARMHOLE_HALF_ANGLE_DEG) / (2 * np.pi / n)))
    side_col = {"L": 0, "R": n // 2}
    hole = np.zeros((total_rows - 1, n), bool)  # quad (r, j) spans rows r..r+1, cols j..j+1
    for c in side_col.values():
        for j in range(c - span, c + span):
            hole[r_top:r_ah, j % n] = True
    for c in side_col.values():
        grid_pos = round_armhole(grid_pos, r_top, r_ah, c, span)

    vertices: list[np.ndarray] = []
    torso_ids = np.arange(total_rows * n).reshape(total_rows, n)
    vertices.append(grid_pos.reshape(-1, 3))
    faces = []
    for r in range(total_rows - 1):
        for j in range(n):
            if hole[r, j]:
                continue
            a, b = torso_ids[r, j], torso_ids[r, (j + 1) % n]
            c, d = torso_ids[r + 1, (j + 1) % n], torso_ids[r + 1, j]
            faces.extend(((a, b, c), (a, c, d)))
    panel = np.where(np.sin(angles) < 0, PANEL_BACK, np.where(np.cos(angles) >= 0, 0, 1))
    panels = [np.tile(panel, total_rows)]
    panels[0][: r_top * n] = PANEL_YOKE

    # Sleeves.
    sleeve_grids = {}
    landmarks: dict[str, int] = {}
    paths: dict[str, list[int]] = {}
    sleeve_rest = {}
    seam_lines: dict[str, tuple[np.ndarray, np.ndarray, float]] = {}
    elastic_rows: list[np.ndarray] = []
    route_len_upper = {}
    for side, sign in (("L", 1), ("R", -1)):
        c = side_col[side]
        cols = [(c + j) % n for j in range(-span, span + 1)]
        # Loop orientation: top edge front->back etc. Build a closed boundary list.
        top = [torso_ids[r_top, j] for j in cols]
        back_edge = [torso_ids[r, cols[-1]] for r in range(r_top + 1, r_ah + 1)]
        bottom = [torso_ids[r_ah, j] for j in cols[::-1]][1:]
        front_edge = [torso_ids[r, cols[0]] for r in range(r_ah - 1, r_top, -1)]
        loop = np.array(top + back_edge + bottom + front_edge)
        loop_pos = vertices[0][loop]
        route = posed.arm_centres[side]
        route_len_upper[side] = float(np.linalg.norm(route[1] - route[0]))
        upper_axis = (route[1] - route[0]) / route_len_upper[side]
        along = (loop_pos - route[0]) @ upper_axis
        d_cap = float(along.max() + config.SHELL_CAP_CLEAR_M)
        # Seam (visual) distance from the joint: acromion projection + dropped shoulder.
        acr = (lm[f"acromion_{side}"] - route[0]) @ upper_axis
        drop = max(
            0.0,
            (size.shoulder.value_cm - body.response.measurements["shoulder_arc"].value_cm) / 200,
        )
        d_seam = float(max(acr, 0.0) + drop)
        d_cuff_rest = d_seam + size.sleeve.value_cm / 100
        d_stop = min(cuff_stop[side], d_cuff_rest)
        if d_stop <= d_cap + 0.05:
            raise ValueError("Sleeve ends inside the armhole")
        k_rows = max(10, int(round((d_cuff_rest - d_cap) / config.SHELL_ROW_SPACING_M)))
        rest_stations = np.linspace(d_cap, d_cuff_rest, k_rows + 1)
        # The excess sleeve length (tape longer than the arm to where the hand stops the cuff)
        # stacks along the whole sleeve, a little more toward the cuff: compression
        # c(a) = c_mean (1 + ramp (2 a / A - 1)) over the material advance a in [0, A], so the
        # shown chambers shorten steadily toward the wrist (user photos Puffer2/Parka2: even
        # tubes, steady taper). All of it below the elbow (before L1b) drew full upper-arm tubes
        # over squashed forearm ones. Rest stations (tapes) are unchanged.
        advance = rest_stations - d_cap
        total = float(advance[-1])
        c_mean = max(0.0, 1.0 - (d_stop - d_cap) / max(total, 1e-9))
        ramp = config.SHELL_SLEEVE_STACK_RAMP
        shown = advance - c_mean * ((1 - ramp) * advance + ramp * advance**2 / max(total, 1e-9))
        init_stations = d_cap + shown
        m = len(loop)
        # Angular correspondence by loop arc fraction.
        loop_arc = np.r_[
            0.0,
            np.cumsum(np.linalg.norm(np.diff(np.vstack((loop_pos, loop_pos[:1])), axis=0), axis=1)),
        ]
        fraction = loop_arc[:-1] / loop_arc[-1]
        ext_route = np.vstack(
            (
                route,
                route[-1] + (route[-1] - route[-2]) / np.linalg.norm(route[-1] - route[-2]) * 0.4,
            )
        )
        centres_i, tangent_i, normal_i, front_i = limb_frames(ext_route, init_stations, sign)
        centres_r, tangent_r, normal_r, front_r = limb_frames(ext_route, rest_stations, sign)
        # Orientation offset: angle of loop vertex 0 around the cap-end axis.
        v0 = loop_pos[0] - centres_i[0]
        phi0 = np.arctan2(v0 @ front_i[0], v0 @ normal_i[0])
        # Ensure loop direction matches increasing phi.
        v1 = loop_pos[m // 4] - centres_i[0]
        phi1 = np.arctan2(v1 @ front_i[0], v1 @ normal_i[0])
        direction = 1.0 if ((phi1 - phi0) % (2 * np.pi)) < np.pi else -1.0
        arm_slicer = cache.arm_slicers[side]
        torso_low = grid_pos[r_ah:]
        bicep_inner = size.bicep.value_cm / 100 - two_pi_loft
        cuff_inner = config.CLOTH_CUFF_INNER_M
        sleeve_init = np.empty((k_rows + 1, m, 3))
        sleeve_rst = np.empty((k_rows + 1, m, 3))
        for k in range(k_rows + 1):
            t = k / k_rows
            target = bicep_inner * (1 - t) + cuff_inner * t
            point, axis = centres_i[k], tangent_i[k]
            pts = arm_slicer.points(point, axis)
            u_ax, v_ax = normal_i[k], front_i[k]
            if len(pts):
                near = np.linalg.norm(pts - point, axis=1) < config.GARMENT_CUFF_SUPPORT_MAX_M
                pts = pts[near]
            else:
                pts = np.empty((0, 3))
            if len(pts) >= 3:
                pts2 = np.c_[(pts - point) @ u_ax, (pts - point) @ v_ax]
                hull = hull_polygon(pts2)
                ctr = np.zeros(2)
                if not _inside_convex(hull, ctr):
                    ctr = hull.mean(0)
            else:
                radius = body.geometry.measurements["wrist"].value_cm / (200 * np.pi)
                hull = (
                    radius
                    * np.c_[
                        np.cos(np.linspace(0, 2 * np.pi, 24, endpoint=False)),
                        np.sin(np.linspace(0, 2 * np.pi, 24, endpoint=False)),
                    ]
                )
                ctr = np.zeros(2)
            dense_phis = phi0 + direction * 2 * np.pi * np.arange(720) / 720

            def flatten(ring2, point=point, u_ax=u_ax, v_ax=v_ax, torso_low=torso_low):
                # Where the hanging arm presses on the torso there is no room for the sleeve's
                # underside between them: it rests on the torso shell (+ separation) and the
                # sleeve tape goes round the rest of the arm (SleeveBarrier). Shaped here, at
                # construction, so the ring is evenly spaced along its flat side (radial pushes
                # afterwards bunched the ring and folded the underside).
                pts = point + ring2[:, :1] * u_ax + ring2[:, 1:] * v_ax
                moved = _outside_torso(pts, torso_low, centre2)
                if moved is None:
                    return ring2
                rel = moved - point
                return np.c_[rel @ u_ax, rel @ v_ax]

            dense, _, clamped = fitted_ring(hull, ctr, dense_phis, target, minimum, post=flatten)
            # Equal material spacing by arc length (angle sampling bunches on flat sides).
            closed_ring = np.vstack((dense, dense[:1]))
            arc = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(closed_ring, axis=0), axis=1))]
            ring2 = np.c_[
                np.interp(fraction * arc[-1], arc, closed_ring[:, 0]),
                np.interp(fraction * arc[-1], arc, closed_ring[:, 1]),
            ]
            if clamped and k == 0:
                warnings.append(f"Sleeve {side} bicep tape tighter than arm + clearance.")
            if clamped and k == k_rows:
                warnings.append(
                    f"Sleeve {side} cuff opening ({cuff_inner * 100:.1f} cm, inferred) is "
                    "smaller than the section where the hand stops it + clearance; the shown "
                    "cuff ring is that section (stretched)."
                )
            local2 = ring2  # coordinates in (normal, front)
            sleeve_init[k] = point + local2[:, :1] * u_ax + local2[:, 1:] * v_ax
            sleeve_rst[k] = centres_r[k] + local2[:, :1] * normal_r[k] + local2[:, 1:] * front_r[k]
        # Cap: blend from the armhole loop to the first arm ring.
        cap_rows = config.SHELL_CAP_ROWS
        cap = np.empty((cap_rows, m, 3))
        for q in range(cap_rows):
            t = smoothstep((q + 1) / (cap_rows + 1))
            cap[q] = loop_pos * (1 - t) + sleeve_init[0] * t
        start = sum(len(v) for v in vertices)
        block_init = np.vstack((cap.reshape(-1, 3), sleeve_init.reshape(-1, 3)))
        block_rest = np.vstack((cap.reshape(-1, 3), sleeve_rst.reshape(-1, 3)))
        vertices.append(block_init)
        sleeve_rest[side] = (start, block_rest - block_init)
        rows_total = cap_rows + k_rows + 1
        ids = np.vstack((loop[None, :], start + np.arange(rows_total * m).reshape(rows_total, m)))
        sleeve_grids[side] = ids
        # The two loops run in mirrored directions (L back->front over the top, R front->back),
        # so the left sleeve takes the other quad diagonal: both sleeves are then mirror
        # images. With the same diagonal on both, the left cap's sheared underarm quads were
        # split along their short diagonal (0.5-2 mm edges).
        mirror = side == "L"
        for r in range(len(ids) - 1):
            for j in range(m):
                a, b = ids[r, j], ids[r, (j + 1) % m]
                c2, d = ids[r + 1, (j + 1) % m], ids[r + 1, j]
                faces.extend(((a, b, d), (b, c2, d)) if mirror else ((a, b, c2), (a, c2, d)))
        panels.append(np.full(rows_total * m, PANEL_SLEEVE[side]))
        landmarks[f"cuff_{side}"] = int(ids[-1, 0])
        paths[f"cuff_{side}"] = closed(ids[-1])
        paths[f"bicep_{side}"] = closed(ids[cap_rows + 1])
        paths[f"sleeve_{side}"] = [int(i) for i in ids[:, 0]]
        if product.style in config.ADJUSTABLE_CUFF_STYLES:
            elastic_rows.append(ids[-2:].ravel())
        # Seam landmark on the top line of the sleeve: the row whose top vertex lies the
        # dropped-shoulder distance past the acromion along the upper arm (tape `shoulder`).
        # (picked on the final positions, after the cap rows are re-spaced; see below)
        seam_lines[side] = (ids[:, span], upper_axis, drop)

    # Collar: rows rising from the neckline along the neck (shape by construction kind).
    hood_kind = (
        product.visual.hood.value
        if product.visual is not None and product.visual.hood is not None
        else None
    )
    # Funnel collar tapes for this size (the user's tape, product sizes collar_inner /
    # collar_height; None = body-clearing construction). They are outside product_hash and inside
    # the fit_id payload (service.py), so the asset key changes with them.
    collar_tape = collar_tape_height = None
    measured = size.collar_inner is not None and size.collar_height is not None
    tape_size = size
    if hood_kind == "removable" and not measured and product.owned_size is not None:
        # Sizes without their own collar tape (L3): the same funnel construction as the owned,
        # taped size, with that size's tape (no collar grade is assumed, as for the other
        # untaped dimensions). Body-clearing rings for these sizes made the collar depend on
        # the size's own (absent) data: XS/M could come out larger than the taped S.
        owned = product.sizes.get(product.owned_size)
        if owned is not None and owned.collar_inner is not None and owned.collar_height is not None:
            tape_size = owned
            warnings.append(
                f"Collar tape for {size_name} not measured: the funnel uses the owned size "
                f"{product.owned_size} tape ({owned.collar_inner.value_cm:.1f} cm round, "
                f"{owned.collar_height.value_cm:.1f} cm high); no collar grade assumed."
            )
    if hood_kind == "removable" and tape_size.collar_inner is not None:
        collar_tape = tape_size.collar_inner.value_cm / 100
        collar_tape_height = tape_size.collar_height.value_cm / 100
    collar, collar_top, collar_clamped = build_collar(
        neckline,
        neck,
        (lateral, up, front),
        pierce2,
        plane_angles,
        cache,
        minimum,
        hood_kind,
        collar_tape,
        collar_tape_height,
    )
    if collar_clamped:
        warnings.append(
            f"Collar tape ({collar_tape * 100:.1f} cm) is tighter than the neck + "
            f"{minimum * 100:.1f} cm clearance; the collar is held at that clearance (stretched)."
        )
    collar_rows = len(collar)
    start = sum(len(v) for v in vertices)
    vertices.append(collar.reshape(-1, 3))
    collar_ids = np.vstack(
        (torso_ids[0][None, :], start + np.arange(collar_rows * n).reshape(collar_rows, n))
    )
    for r in range(collar_rows):
        for j in range(n):
            a, b = collar_ids[r, j], collar_ids[r, (j + 1) % n]
            c2, d = collar_ids[r + 1, (j + 1) % n], collar_ids[r + 1, j]
            faces.extend(((a, b, c2), (a, c2, d)))
    panels.append(np.full(collar_rows * n, PANEL_COLLAR))

    positions = np.vstack(vertices)
    hood_grid = None
    # The folded hood rests on the crowns of the shell's rendered relief (drawn outward from
    # this inner surface, up to the loft): 4 mm above the inner shell, the yoke/chambers under its
    # edges were drawn through it (dark shards at the pillow's sides and root ends, G4).
    hood_gap = config.SHELL_HOOD_GAP_M + loft
    if product.visual is not None and product.visual.hood is not None:
        # The hood rolls over from the collar's top edge behind the neck: an attached hood is
        # sewn into the neckline and folds back over itself (the collar is its lower part); a
        # removable one hangs from the funnel collar's top. Rooted at the neckline under the
        # collar, the pillow's root ends crossed the yoke/collar (dark shards, G4).
        attached = product.visual.hood.value == "attached"
        positions, hood_faces, hood_grid = folded_hood(
            positions,
            torso_ids,
            n,
            r_ah,
            collar_ids,
            root_row=collar_top + 1,  # collar_ids row 0 is the neckline
            length=config.SHELL_HOOD_ATTACHED_FOLD_M if attached else None,
            root_sin=config.SHELL_HOOD_ROOT_SIN if attached else config.SHELL_HOOD_REMOVABLE_SIN,
            gap=hood_gap,
            half_width=(
                config.SHELL_HOOD_ATTACHED_HALF_WIDTH_M
                if attached
                else config.SHELL_HOOD_REMOVABLE_HALF_WIDTH_M
            ),
            thickness=config.SHELL_HOOD_ATTACHED_THICK_M if attached else None,
            roll_taper=0.0 if attached else config.SHELL_HOOD_REMOVABLE_ROLL_TAPER,
        )
        hood_base = positions.copy()  # the back the pillow was laid on (see follow_back)
        faces.extend(hood_faces)
        panels.append(np.full(len(positions) - sum(len(p) for p in panels), PANEL_HOOD))
    faces = np.array(faces, dtype=np.int64)
    panels = np.concatenate(panels)

    # Sleeve/torso separation below the armhole: the sleeve rests on the torso shell.
    positions = separate_sleeves(positions, panels, grid_pos, r_ah, total_rows, n, centre2)
    faces = orient_faces(positions, faces, panels, centre2)
    rim_ids = np.empty((0,), np.int64)
    if product.visual is not None and product.visual.hood is not None:
        if product.visual.hood.value == "attached":
            # The opening edge runs from the zip round the sides of the neck to where the hood
            # rolls over (the pillow's root columns): no edge under the roll.
            positions, rim_faces, rim_ids = hood_rim(
                positions, collar_ids, n, loft, stop_cols=hood_root_columns(n)
            )
            faces = np.vstack((faces, rim_faces))
            panels = np.r_[panels, np.full(len(rim_ids), PANEL_HOOD)]
    # Residual armhole/cap contacts: move offending vertices to the clearance surface.
    # Taped torso rows (armhole bottom and below) clear the torso only; sleeves stay outside
    # the torso shell below the armhole (TorsoClearance, SleeveBarrier).
    low_rows = np.zeros(len(positions), bool)
    low_rows[torso_ids[r_ah:].ravel()] = True
    torso_part = cache.parts["torso"]
    torso_clear = TorsoClearance(low_rows, ClosestMemo(torso_part), torso_part.body.face_normals)
    barrier = SleeveBarrier(torso_ids, r_ah, centre2, np.isin(panels, list(PANEL_SLEEVE.values())))

    region = (positions[:, 1] > y_ah - config.SHELL_REPAIR_BELOW_M) & (
        positions[:, 1] < y_top + config.SHELL_REPAIR_ABOVE_M
    )
    # Torso rows at/below the armhole bottom already clear the body by construction (hull
    # offset) and carry the chest tape: they are never moved by the repair.
    band_faces = faces[region[faces].all(1)]
    # Where the hanging arm presses the torso side just below the armhole, the shell is
    # pushed out by the body (it cannot pass through the arm); the chest tape row sits
    # below that contact band (checked in tests).
    region_faces = band_faces
    # Sleeve vertices are never pushed along their own ring: the closest-point push
    # collapsed ring neighbours where the arm is concave or the sleeve tape is tighter than
    # arm + clearance (0.26 mm edges, 0.5 deg cap slivers). The armhole loop (torso) may
    # still slide: holding it too left a short, overstretched underarm cap edge in motion.
    slide = sleeve_ring_tangents(positions, sleeve_grids)
    positions = push_region(
        positions, region_faces, posed.mesh, minimum, query, slide, None, torso_clear, barrier
    )
    # The three untangle calls test the same band faces: later calls re-test only moved ones.
    crossings: dict = {}
    positions = untangle(
        positions,
        band_faces,
        panels,
        centre2,
        posed.mesh,
        minimum,
        query,
        slide,
        state=crossings,
        torso=torso_clear,
        barrier=barrier,
    )
    if config.SHELL_FINAL_SMOOTH_PASSES:
        # The clearance push moves vertices one by one and crumples the untaped yoke/shoulder
        # rows (creases > 20 deg drew glassy shards). Smooth those rows once more (armhole
        # loop, neckline and taped rows fixed), then re-check body clearance.
        movable = np.zeros((total_rows, n), bool)
        movable[1:r_ah] = True
        for c in side_col.values():
            for j in range(c - span, c + span + 1):
                movable[r_top : r_ah + 1, j % n] = False
        grid = positions[torso_ids]
        grid = taubin_masked(grid, movable, config.SHELL_FINAL_SMOOTH_PASSES)
        positions[torso_ids[movable]] = grid[movable]
        if config.SHELL_ARMHOLE_EDGE_SMOOTH_PASSES:
            # The armhole's front/back edge columns are loop vertices (fixed above: the hole is
            # their other neighbour); the clearance push left them stair-stepped where a loose
            # cap meets the back (G4 open item, 2XL). Fair them along the column only, ends fixed.
            for c in side_col.values():
                for j in (c - span, c + span):
                    ids = torso_ids[r_top : r_ah + 1, j % n]
                    positions[ids] = taubin_line(
                        positions[ids], config.SHELL_ARMHOLE_EDGE_SMOOTH_PASSES
                    )
        slide = sleeve_ring_tangents(positions, sleeve_grids)
        positions = push_region(
            positions, region_faces, posed.mesh, minimum, query, slide, None, torso_clear, barrier
        )
    # Rest == worn shape except the axially compressed (stacked) sleeve material.
    rest_delta = np.zeros_like(positions)
    for start, delta in sleeve_rest.values():
        rest_delta[start : start + len(delta)] = delta
    if config.SHELL_SLEEVE_RESPACE_PASSES:
        # Cap rows: even spacing along each column (the smoothstep blend crowded the rows next
        # to the bicep ring), then re-check clearance across the rings (small moves).
        # Only the armhole band is re-checked (as before): the forearm/cuff rings are never
        # pushed, so their tapes stay as built.
        sleeve_faces = region_faces[
            np.isin(panels[region_faces], list(PANEL_SLEEVE.values())).all(1)
        ]
        # The bicep rings are taped: they stay fixed here (moving them out in the re-checks
        # grew XL/2XL biceps by 2-15 cm).
        bicep_rings = np.zeros(len(positions), bool)
        for grid in sleeve_grids.values():
            bicep_rings[grid[cap_rows + 1]] = True
        for _ in range(config.SHELL_SLEEVE_RESPACE_PASSES):
            for grid in sleeve_grids.values():
                positions, rest_delta = respace_sleeve(positions, rest_delta, grid, cap_rows)
            slide = sleeve_ring_tangents(positions, sleeve_grids)
            positions = push_region(
                positions,
                sleeve_faces,
                posed.mesh,
                minimum,
                query,
                slide,
                bicep_rings,
                torso_clear,
                barrier,
            )
        # The cap moved: re-check sleeve/torso crossings (same repair as above).
        positions = untangle(
            positions,
            band_faces,
            panels,
            centre2,
            posed.mesh,
            minimum,
            query,
            slide,
            bicep_rings,
            crossings,
            torso_clear,
            barrier,
        )
    chest_row = r_ah + config.SHELL_CHEST_ROW_BELOW_ARMHOLE
    if config.SHELL_UNFOLD_PASSES:
        # Residual creases where the armhole repair folded the cap or the armhole edge over
        # (faces turned toward the body: the lining shows as a dark line or patch). Fair only
        # those faces' vertices; taped rings stay fixed and body clearance is re-checked.
        fixed = np.ones(len(positions), bool)
        fixed[torso_ids[1:chest_row].ravel()] = False
        for grid in sleeve_grids.values():
            fixed[grid[1 : cap_rows + 1].ravel()] = False
            fixed[grid[cap_rows + 2 : cap_rows + 2 + config.SHELL_UNFOLD_SLEEVE_ROWS].ravel()] = (
                False
            )
        fixed[np.flatnonzero(~np.isin(panels, [0, 1, 2, 3, 4, 5]))] = True
        fixed[collar_ids[0]] = True
        taped_bicep = np.zeros(len(positions), bool)
        for grid in sleeve_grids.values():
            taped_bicep[grid[cap_rows + 1]] = True
        positions = unfold(
            positions,
            faces,
            panels,
            fixed,
            cache,
            posed.mesh,
            minimum,
            sleeve_grids,
            query,
            torso_clear,
            barrier,
        )
        positions = untangle(
            positions,
            band_faces,
            panels,
            centre2,
            posed.mesh,
            minimum,
            query,
            sleeve_ring_tangents(positions, sleeve_grids),
            taped_bicep,
            crossings,
            torso_clear,
            barrier,
        )
    for side, grid in sleeve_grids.items():
        # Say so where the arm presses on the torso (no room for the sleeve's underside: it
        # rests on the side panel, SleeveBarrier); the display body has no soft tissue.
        underarm = grid[1:].ravel()
        underarm = underarm[positions[underarm, 1] < y_ah]
        if not len(underarm):
            continue
        arm = cache.parts[side]
        near, _, tri = arm.closest(positions[underarm])
        depth = -np.einsum("ij,ij->i", positions[underarm] - near, arm.body.face_normals[tri])
        if depth.max() > config.SHELL_PINCH_WARN_M:
            warnings.append(
                f"{'Left' if side == 'L' else 'Right'} arm presses on the torso below the "
                f"armhole (no room for both layers): the sleeve underside rests on the side "
                f"panel, up to {depth.max() * 100:.1f} cm into the arm's surface there (display "
                "pose; soft tissue not modelled)."
            )
    if hood_grid is not None and config.SHELL_HOOD_CLEAR_PASSES:
        # Last: the back/yoke rows under the folded hood moved out in the clearance repairs
        # and smoothing after the hood was laid on them (hood root rows 1-4 cut the yoke near
        # the neck, the pillow's sides the mid back).
        # The pillow rides on the back it was laid on: each vertex follows the move of its
        # closest back/yoke/collar point since then. Then what is left is cleared (the root's
        # chord across the convex yoke near the neck).
        positions = follow_back(positions, hood_base, faces, panels, hood_grid)
        positions = clear_hood(positions, faces, panels, hood_grid, hood_gap)
    dropped_caps: dict[str, np.ndarray] = {}
    for side, (column, axis, drop) in seam_lines.items():
        past = (positions[column] - lm[f"acromion_{side}"]) @ axis
        landmarks[f"seam_{side}"] = int(column[int(np.argmin(np.abs(past - drop)))])
        if drop >= config.SHELL_DROPPED_SEAM_MIN_M:
            cap = dropped_cap(positions, sleeve_grids[side], landmarks[f"seam_{side}"], axis)
            if len(cap):
                dropped_caps[side] = cap
    rest = positions + rest_delta

    elastic = np.zeros(len(positions))
    for ids in elastic_rows:
        elastic[ids] = 1
    hem_ids = torso_ids[-1]
    paths["hem"] = closed(hem_ids)
    if product.hem_elastic:
        # An elastic casing gathers the body fabric (taken as the chest tape: straight-cut body,
        # no hem flat-width tape) onto the band. Rows worn at or near that length (hips wider
        # than the band, or a small size: the elastic is stretched out) have nothing left to
        # gather: the casing is taut, so they are not elastic-gather rows (no gathers drawn,
        # woven stretch limit). Flagging them anyway drew deep gathers on a flared, stretched
        # band (the "frayed" puffer hem on every female soak body and on XS).
        taut = 0
        for ids in torso_ids[-3:]:
            if ring_perimeter(positions[ids]) <= chest_inner * (1 - config.SHELL_HEM_GATHER_MIN):
                elastic[ids] = 1
            else:
                taut += 1
        if taut:
            warnings.append(
                f"Elastic hem: {taut} of 3 band rows worn within "
                f"{config.SHELL_HEM_GATHER_MIN * 100:.0f}% of the body fabric length "
                f"({chest_inner * 100:.1f} cm inner); shown taut (no gathers)."
            )
        # The worn elastic band is the solver's rest state (it is already in equilibrium
        # on the hip); its stretch over the relaxed tape is computed and reported.
        worn = ring_perimeter(positions[hem_ids])
        if worn > hem_inner:
            warnings.append(
                f"Elastic hem worn at {worn / hem_inner * 100 - 100:.1f}% stretch over its "
                f"relaxed tape ({hem_inner * 100:.1f} cm inner)."
            )
    paths["neckline"] = closed(torso_ids[0])
    paths["chest"] = closed(torso_ids[chest_row])
    paths["length_hps"] = [int(i) for i in torso_ids[:, n // 4 + 2]]
    # Zip / centre-front line for the client's interactive zipper (agent Z contract, L2): from
    # the collar's top edge down the collar and the torso's CF column to the hem. Wearer's left
    # front = render_uv u > 0 side (scene +X), right front = u < 0.
    paths["center_front"] = [int(i) for i in collar_ids[collar_top + 1 : 0 : -1, n // 4]] + [
        int(i) for i in torso_ids[:, n // 4]
    ]
    paths["collar_top"] = closed(collar_ids[collar_top + 1])
    if hood_grid is not None and hood_kind == "removable":
        # The hood (panel 7) is joined to the rest only along this row (its root = the collar's
        # top edge on the puffer, a zip in the real jacket): duplicate it to detach the hood.
        paths["hood_zip"] = [int(i) for i in hood_grid[0]]
    landmarks["hem_back"] = int(hem_ids[3 * n // 4])
    stitch = np.zeros(len(positions))
    uv, quilt = shell_render_coordinates(
        product, positions, panels, torso_ids, sleeve_grids, hood_grid, n, r_top, lm, collar_ids
    )
    if len(rim_ids):
        # Hood face-opening edge: plain (no hood quilting); u = lateral, v = depth below HPS.
        uv[rim_ids] = np.c_[positions[rim_ids, 0], float(lm["HPS_L"][1]) - positions[rim_ids, 1]]
        quilt[rim_ids] = 0
    material_v = uv[:, 1].copy()
    pitch = (
        product.visual.sleeve_chamber_height.value_cm / 100
        if product.visual is not None and product.visual.sleeve_chamber_height is not None
        else None
    )
    for grid in sleeve_grids.values():
        centres = rest[grid].mean(1)
        along = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(centres, axis=0), axis=1))]
        material_v[grid[1:].ravel()] = np.repeat(along[1:], grid.shape[1])
        if pitch is not None:
            # Sleeve cap: the chambers are straight across the sleeve pattern (parallel to the
            # bicep ring) and the curved cap seam cuts them, so each cap vertex sits its
            # column's material arc above the bicep ring. One v per cap row put a 15 cm arc
            # of the cap top into the first 7.6 cm chamber (puffer M): a lumpy deltoid bulge.
            column = rest[grid[: cap_rows + 2]]
            below = np.cumsum(np.linalg.norm(np.diff(column, axis=0), axis=2)[::-1], axis=0)
            cap_v = along[cap_rows + 1] - below[::-1][1:]  # rows 1..cap_rows
            # Whole chambers added to every sleeve vertex keep the stitch phase and v > 0
            # (the renderer reads 0 as "not provided").
            lift = pitch * max(0.0, np.ceil((pitch / 2 - cap_v.min()) / pitch))
            material_v[grid[1 : cap_rows + 1]] = cap_v
            material_v[grid[1:].ravel()] += lift
    for side, cap in dropped_caps.items():
        # Dropped shoulder (L3): the body panel runs over the shoulder down to the tape-true seam
        # on the arm, so the cap above that seam is drawn in the body's chart (horizontal
        # channels at the body's heights) and the visible seam is the seam ring, not the armhole.
        # Render coordinates only: positions, panels and every tape are unchanged.
        paths[f"dropped_cap_{side}"] = [int(i) for i in cap]
        uv[cap] = np.c_[np.zeros(len(cap)), float(lm["HPS_L"][1]) - positions[cap, 1]]
        quilt[cap] = quilt[torso_ids[r_ah, side_col[side]]]
        material_v[cap] = 0.0
    # Drop torso grid vertices inside the armhole openings (no incident face).
    used = np.zeros(len(positions), bool)
    used[faces.ravel()] = True
    remap = np.full(len(positions), -1, dtype=np.int64)
    remap[used] = np.arange(used.sum())

    def ids_map(ids):
        return remap[np.asarray(ids)]

    for key, ids in paths.items():
        mapped = ids_map(ids)
        if (mapped < 0).any():
            raise ValueError(f"Shell path {key} references a removed vertex")
        paths[key] = mapped.tolist()
    landmarks = {k: int(remap[v]) for k, v in landmarks.items()}
    if min(landmarks.values()) < 0:
        raise ValueError("Shell landmark references a removed vertex")
    return Shell(
        rest=rest[used],
        initial=positions[used],
        faces=remap[faces],
        panels=panels[used],
        elastic=elastic[used],
        stitch=stitch[used],
        uv=uv[used],
        quilt=quilt[used],
        paths=paths,
        landmarks=landmarks,
        torso_grid=ids_map(torso_ids),
        sleeve_grids={k: ids_map(v) for k, v in sleeve_grids.items()},
        hood_grid=None if hood_grid is None else ids_map(hood_grid),
        levels={"armpit": y_pit, "armhole": y_ah, "hem": hem_y, "shoulder": y_top},
        warnings=warnings,
        material_v=material_v[used],
    )


def unfold(
    positions: np.ndarray,
    faces: np.ndarray,
    panels: np.ndarray,
    fixed: np.ndarray,
    cache: "ShellBodyCache",
    body: trimesh.Trimesh,
    minimum: float,
    sleeve_grids: dict[str, np.ndarray],
    query=None,
    torso: "TorsoClearance | None" = None,
    barrier: "SleeveBarrier | None" = None,
) -> np.ndarray:
    """Fair the vertices of inverted (body-facing) torso/sleeve faces and their neighbours.

    Each pass finds the inverted faces (``shell_defects.inverted_mask``), moves their free
    vertices half-way to the mean of their edge neighbours (umbrella operator, a crease
    unfolds onto the surrounding fabric), then re-checks body clearance on the touched faces.
    """
    from scipy.sparse import coo_matrix

    from .shell_defects import inverted_mask

    edges = face_edges(faces)
    count = len(positions)
    adjacency = coo_matrix(
        (
            np.ones(2 * len(edges)),
            (np.r_[edges[:, 0], edges[:, 1]], np.r_[edges[:, 1], edges[:, 0]]),
        ),
        shape=(count, count),
    ).tocsr()
    degree = np.maximum(np.asarray(adjacency.sum(1)).ravel(), 1)
    result = positions.copy()
    # Only an inverted face with a vertex in (free vertices + their 1-ring) can put a free
    # vertex into the moving set; the others (e.g. creases on fixed taped rows, hem, hood)
    # would only be found and discarded (moving = region & ~fixed). Testing just these faces
    # gives the same moves and the same stop (no bad face here <=> nothing would move).
    free = ~fixed
    near = free | (np.asarray(adjacency @ free.astype(np.float64)).ravel() > 0)
    candidates = faces[near[faces].any(1)]
    bad = None
    moved = np.zeros(count, bool)
    for _ in range(config.SHELL_UNFOLD_PASSES):
        if bad is None:
            bad = inverted_mask(result, candidates, panels, cache.parts)
        else:
            # A face's flag depends only on its own corners: re-test faces with a moved corner.
            stale = moved[candidates].any(1)
            if stale.any():
                bad[stale] = inverted_mask(result, candidates[stale], panels, cache.parts)
        if not bad.any():
            break
        region = np.zeros(count, bool)
        region[candidates[bad].ravel()] = True
        region |= np.asarray(adjacency[region].sum(0)).ravel() > 0  # plus their 1-ring
        moving = region & ~fixed
        if not moving.any():
            break
        before = result.copy()
        for _ in range(config.SHELL_UNFOLD_SMOOTH_STEPS):
            mean = (adjacency @ result) / degree[:, None]
            result[moving] += 0.5 * (mean[moving] - result[moving])
        touched = faces[moving[faces].any(1)]
        result = push_region(
            result,
            touched,
            body,
            minimum,
            query if query is not None else cache.query,
            sleeve_ring_tangents(result, sleeve_grids),
            fixed,
            torso,
            barrier,
        )
        moved = (result != before).any(1)
    return result


def orient_faces(
    positions: np.ndarray, faces: np.ndarray, panels: np.ndarray, centre2: np.ndarray
) -> np.ndarray:
    """Consistent outward winding per panel (torso/collar radial, sleeves about ring axis)."""
    faces = faces.copy()
    tri = positions[faces]
    normal = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    centre = tri.mean(1)
    face_panel = panels[faces].max(1)
    radial = centre.copy()
    radial[:, 0] -= centre2[0]
    radial[:, 1] = 0
    radial[:, 2] -= centre2[1]
    groups = {
        "torso": np.isin(face_panel, [0, 1, 2, 3]),
        "collar": face_panel == PANEL_COLLAR,
        "hood": face_panel == PANEL_HOOD,
    }
    for name, mask in groups.items():
        if not mask.any():
            continue
        if name == "hood":
            score = np.median(-normal[mask, 2])
        else:
            score = np.median(np.einsum("ij,ij->i", normal[mask], radial[mask]))
        if score < 0:
            faces[mask] = faces[mask][:, [0, 2, 1]]
    for panel in PANEL_SLEEVE.values():
        mask = face_panel == panel
        if not mask.any():
            continue
        # Outward from the local sleeve axis: compare with direction from the panel centroid
        # projected off the principal axis.
        pts = centre[mask]
        mean = pts.mean(0)
        axis = np.linalg.svd(pts - mean, full_matrices=False)[2][0]
        rel = pts - mean
        rel -= np.outer(rel @ axis, axis)
        if np.median(np.einsum("ij,ij->i", normal[mask], rel)) < 0:
            faces[mask] = faces[mask][:, [0, 2, 1]]
    return faces


def crossing_pairs(
    positions: np.ndarray, faces: np.ndarray, first: np.ndarray, second: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Edges of ``first`` faces crossing ``second`` faces (shared vertices excluded).

    Exact segment/triangle test (Moller-Trumbore) on candidate pairs from a bounding-sphere
    broad phase: a triangle lies inside its centre/radius sphere, so a segment that misses
    every sphere within (half length + radius) of its midpoint cannot cross it.
    """
    if not len(first) or not len(second):
        return np.empty((0, 2), np.int64), np.empty(0, np.int64)
    edges = face_edges(first)
    e, t = segment_hits(positions, edges, second)
    return edges[e], t


def face_edges(faces: np.ndarray) -> np.ndarray:
    return unique_pairs(np.sort(faces[:, [[0, 1], [1, 2], [2, 0]]].reshape(-1, 2), 1))


def segment_hits(
    positions: np.ndarray, edges: np.ndarray, second: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """(edge row, triangle row) pairs where a segment crosses a triangle (no shared vertex)."""
    empty = np.empty(0, np.int64), np.empty(0, np.int64)
    if not len(edges) or not len(second):
        return empty
    start = positions[edges[:, 0]]
    vector = positions[edges[:, 1]] - start
    length = np.linalg.norm(vector, axis=1)
    tri = positions[second]
    centre = tri.mean(1)
    radius = np.linalg.norm(tri - centre[:, None, :], axis=2).max(1)
    e, t = sphere_pairs(start + vector / 2, length / 2 + 1e-9, centre, radius + 1e-9)
    if not len(e):
        return empty
    keep = ~(second[t][:, :, None] == edges[e][:, None, :]).any((1, 2))
    e, t = e[keep], t[keep]
    v0 = tri[t, 0]
    e1, e2 = tri[t, 1] - v0, tri[t, 2] - v0
    d = vector[e]
    p = np.cross(d, e2)
    det = np.einsum("ij,ij->i", e1, p)
    valid = np.abs(det) > 1e-20
    inv = np.where(valid, 1.0 / np.where(valid, det, 1.0), 0.0)
    s = start[e] - v0
    u = np.einsum("ij,ij->i", s, p) * inv
    q = np.cross(s, e1)
    v = np.einsum("ij,ij->i", d, q) * inv
    along = np.einsum("ij,ij->i", e2, q) * inv * length[e]
    tol = 1e-12
    hit = valid & (u >= -tol) & (v >= -tol) & (u + v <= 1 + tol)
    hit &= (along > 1e-6) & (along < length[e] - 1e-6)
    return e[hit], t[hit]


def _flatten(lists) -> tuple[np.ndarray, np.ndarray]:
    counts = np.fromiter((len(c) for c in lists), np.int64, len(lists))
    rows = np.repeat(np.arange(len(lists)), counts)
    return rows, np.fromiter(chain.from_iterable(lists), np.int64, int(counts.sum()))


def sphere_pairs(
    ca: np.ndarray, ra: np.ndarray, cb: np.ndarray, rb: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Every (i, j) with |ca_i - cb_j| <= ra_i + rb_j (exact; two KD-tree passes so a few
    large spheres do not inflate every query radius)."""
    cut = float(np.percentile(rb, 90))
    small = np.flatnonzero(rb <= cut)
    large = np.flatnonzero(rb > cut)
    i, j = _flatten(cKDTree(cb[small]).query_ball_point(ca, ra + cut))
    j = small[j]
    if len(large):
        jj, ii = _flatten(cKDTree(ca).query_ball_point(cb[large], rb[large] + ra.max()))
        i, j = np.r_[i, ii], np.r_[j, large[jj]]
    keep = np.linalg.norm(ca[i] - cb[j], axis=1) <= ra[i] + rb[j]
    return i[keep], j[keep]


def untangle(
    positions: np.ndarray,
    faces: np.ndarray,
    panels: np.ndarray,
    centre2: np.ndarray,
    body: trimesh.Trimesh,
    minimum: float,
    query=None,
    slide: np.ndarray | None = None,
    fixed: np.ndarray | None = None,
    state: dict | None = None,
    torso: "TorsoClearance | None" = None,
    barrier: "SleeveBarrier | None" = None,
) -> np.ndarray:
    """Move sleeve vertices outward (away from the torso axis) until no sleeve/torso crossing.

    Shared armhole vertices never move; the torso stays where the tape put it.
    ``state`` (a dict, empty on the first call) carries the crossing pairs and the positions
    they were found on to the next call with the same ``faces``/``panels``: that call
    re-tests only primitives with a vertex moved since (same answer as testing everything).
    """
    result = positions.copy()
    face_panel = panels[faces]
    sleeve_faces = faces[np.isin(face_panel, list(PANEL_SLEEVE.values())).all(1)]
    torso_faces = faces[np.isin(face_panel, [0, 1, 2, 3, PANEL_COLLAR]).all(1)]
    torso_vertices = np.unique(torso_faces)
    # Two directions: sleeve edges x torso triangles, torso edges x sleeve triangles. After
    # the first pass only primitives with a moved vertex are re-tested; a pair of unmoved
    # primitives keeps its previous answer, so this equals re-testing everything.
    tests = [(face_edges(sleeve_faces), torso_faces), (face_edges(torso_faces), sleeve_faces)]
    hits: list[tuple[np.ndarray, np.ndarray] | None] = [None, None]
    previous = result.copy()
    if state:
        hits, previous = list(state["hits"]), state["positions"]
    for _ in range(config.SHELL_UNTANGLE_PASSES):
        moved = (result != previous).any(1)
        previous = result.copy()
        for k, (edges, tris) in enumerate(tests):
            if hits[k] is None:
                hits[k] = segment_hits(result, edges, tris)
                continue
            stale_e = moved[edges].any(1)
            stale_t = moved[tris].any(1)
            old_e, old_t = hits[k]
            keep = ~stale_e[old_e] & ~stale_t[old_t]
            rows_e = np.flatnonzero(stale_e)
            rows_t = np.flatnonzero(stale_t)
            fresh_rows = np.flatnonzero(~stale_e)
            e1, t1 = segment_hits(result, edges[rows_e], tris)
            e2, t2 = segment_hits(result, edges[fresh_rows], tris[rows_t])
            hits[k] = (
                np.r_[old_e[keep], rows_e[e1], fresh_rows[e2]],
                np.r_[old_t[keep], t1, rows_t[t2]],
            )
        moving = np.r_[tests[0][0][hits[0][0]].ravel(), tests[1][1][hits[1][1]].ravel()]
        ids = np.setdiff1d(np.unique(moving.astype(np.int64)), torso_vertices)
        if state is not None:
            state["hits"], state["positions"] = list(hits), previous
        if fixed is not None:
            ids = ids[~fixed[ids]]
        if not len(ids):
            break
        radial = result[ids][:, [0, 2]] - centre2
        radial /= np.maximum(np.linalg.norm(radial, axis=1)[:, None], 1e-9)
        result[ids, 0] += radial[:, 0] * config.SHELL_UNTANGLE_STEP_M
        result[ids, 2] += radial[:, 1] * config.SHELL_UNTANGLE_STEP_M
        touched = faces[np.isin(faces, ids).any(1)]
        result = push_region(result, touched, body, minimum, query, slide, fixed, torso, barrier)
    return result


def push_region(
    positions: np.ndarray,
    faces: np.ndarray,
    body: trimesh.Trimesh,
    minimum: float,
    query=None,
    slide: np.ndarray | None = None,
    fixed: np.ndarray | None = None,
    torso: "TorsoClearance | None" = None,
    barrier: "SleeveBarrier | None" = None,
) -> np.ndarray:
    """Body clearance repair (vertex/edge/face samples) restricted to ``faces``.

    Same rule as ``builder.push_out``; ``query`` reuses the body's surface index. ``slide``
    (per vertex unit vector, zero = free) removes that component from each vertex's move;
    ``fixed`` (per vertex mask) vertices do not move. ``torso``: samples made only of its
    vertices clear the torso (body minus arms) instead of the whole body. ``barrier``: sleeve
    vertices are then kept outside the torso shell (see ``SleeveBarrier``).
    """
    from ..surface_query import SurfaceQuery

    ids = np.unique(faces)
    if not len(ids):
        return positions
    remap = np.full(len(positions), -1, dtype=np.int64)
    remap[ids] = np.arange(len(ids))
    local_faces = remap[faces]
    query = query if query is not None else SurfaceQuery(body)
    result = positions[ids].copy()
    edges = unique_pairs(np.sort(local_faces[:, [[0, 1], [1, 2], [2, 0]]].reshape(-1, 2), 1))
    # Sample -> vertices (vertex, edge midpoint, face centroid). Only samples with a moved
    # vertex are re-queried after the first pass; the others' answers cannot change.
    members = np.full((len(ids) + len(edges) + len(local_faces), 3), -1, dtype=np.int64)
    members[: len(ids), 0] = np.arange(len(ids))
    members[len(ids) : len(ids) + len(edges), :2] = edges
    members[len(ids) + len(edges) :] = local_faces
    on_torso = None
    if torso is not None:
        own = torso.mask[ids]
        on_torso = np.where(members >= 0, own[np.maximum(members, 0)], True).all(1)
        if not on_torso.any():
            on_torso = None

    def closest_to(points: np.ndarray, rows: np.ndarray | None):
        """(closest, distance, outward normal) per sample point (rows: sample indices)."""
        if on_torso is None:
            c, d, t = query.closest(points)
            return c, d, body.face_normals[t]
        part = on_torso if rows is None else on_torso[rows]
        c = np.empty((len(points), 3))
        d = np.empty(len(points))
        nrm = np.empty((len(points), 3))
        sources = ((~part, query, body.face_normals), (part, torso.query, torso.normals))
        for mask, q, normals in sources:
            if mask.any():
                c[mask], d[mask], t = q.closest(points[mask])
                nrm[mask] = normals[t]
        return c, d, nrm

    on_sleeve = None
    if barrier is not None:
        own = barrier.sleeve[ids]
        on_sleeve = np.where(members >= 0, own[np.maximum(members, 0)], True).all(1)
    closest = distance = normal = None
    moved = np.ones(len(ids), bool)
    for _ in range(config.GARMENT_COLLISION_PASSES):
        points = np.vstack((result, result[edges].mean(1), result[local_faces].mean(1)))
        if closest is None:
            closest, distance, normal = closest_to(points, None)
        else:
            stale = (moved[members] & (members >= 0)).any(1)
            if stale.any():
                rows = np.flatnonzero(stale)
                c, d, nrm = closest_to(points[rows], rows)
                closest[rows], distance[rows], normal[rows] = c, d, nrm
        signed = np.einsum("ij,ij->i", points - closest, normal)
        bad = (signed < 0) | (distance < minimum)
        if on_sleeve is not None:
            # Where the arm presses on the torso the sleeve rests on the torso shell: arm
            # surface inside the torso shell (+ separation) is not its obstacle, and a sleeve
            # sample resting on the torso shell is not pushed into it by the arm.
            rows = np.flatnonzero(bad & on_sleeve)
            if len(rows):
                rest = barrier.covers(closest[rows], positions) | barrier.covers(
                    points[rows], positions, minimum + config.SHELL_PINCH_REST_M
                )
                bad[rows[rest]] = False
        if not bad.any():
            break
        correction = np.zeros_like(points)
        correction[bad] = closest[bad] + normal[bad] * minimum - points[bad]
        changes = np.zeros_like(result)
        counts = np.zeros(len(result))
        nv, ne = len(result), len(edges)
        changes += correction[:nv]
        counts += bad[:nv]
        for corner in range(2):
            np.add.at(changes, edges[:, corner], correction[nv : nv + ne])
            np.add.at(counts, edges[:, corner], bad[nv : nv + ne])
        for corner in range(3):
            np.add.at(changes, local_faces[:, corner], correction[nv + ne :])
            np.add.at(counts, local_faces[:, corner], bad[nv + ne :])
        moved = counts > 0
        step = changes / np.maximum(counts, 1)[:, None] * config.GARMENT_COLLISION_GAIN
        if slide is not None:
            axis = slide[ids]
            step -= np.einsum("ij,ij->i", step, axis)[:, None] * axis
        if fixed is not None:
            step[fixed[ids]] = 0
        result[moved] += step[moved]
        if barrier is not None:
            before = result
            result = barrier.clamp(result, ids, positions)
            if result is not before:
                if fixed is not None:
                    result[fixed[ids]] = before[fixed[ids]]
                moved |= (result != before).any(1)
    out = positions.copy()
    out[ids] = result
    return out


@dataclass
class TorsoClearance:
    """Vertices (``mask``) whose samples clear the torso only: the taped torso rings at and
    below the armhole bottom. The hanging arm is not their obstacle: where it presses on the
    side panel the arm push moved the taped rings out by up to the arm's depth (chest tape off
    by 5-8 cm on heavy bodies) and into the sleeve."""

    mask: np.ndarray
    query: object
    normals: np.ndarray


def grid_point(grid: np.ndarray, r: np.ndarray, j: np.ndarray) -> np.ndarray:
    """Bilinear point of a column-cyclic (rows, n, 3) grid at fractional (row, column)."""
    n = grid.shape[1]
    r0 = np.clip(np.floor(r).astype(int), 0, grid.shape[0] - 2)
    fr = (r - r0)[:, None]
    j0 = np.floor(j).astype(int)
    fj = (j - j0)[:, None]
    j0, j1 = j0 % n, (j0 + 1) % n
    return (
        grid[r0, j0] * (1 - fr) * (1 - fj)
        + grid[r0, j1] * (1 - fr) * fj
        + grid[r0 + 1, j0] * fr * (1 - fj)
        + grid[r0 + 1, j1] * fr * fj
    )


def round_armhole(grid: np.ndarray, r_top: int, r_ah: int, c: int, span: int) -> np.ndarray:
    """Move the armhole boundary vertices onto a rounded loop (superellipse in grid space).

    The hole is a rectangle of grid cells; following it made the sleeve-cap seam zig-zag at
    the four corners. Each boundary vertex is moved radially (in grid coordinates, about the
    hole centre) onto the superellipse |x|^p + |y|^p = 1 inscribed in that rectangle, and
    re-evaluated on the same bilinear torso surface: it stays on the tape-built shell (no new
    surface), only the seam line is rounded. Side and top/bottom mid-points do not move.
    """
    p = config.SHELL_ARMHOLE_ROUNDNESS
    rc, half_r = (r_top + r_ah) / 2, (r_ah - r_top) / 2
    rows, cols = [], []
    for j in range(-span, span + 1):
        rows += [r_top, r_ah]
        cols += [j, j]
    for r in range(r_top + 1, r_ah):
        rows += [r, r]
        cols += [-span, span]
    rows, cols = np.array(rows, float), np.array(cols, float)
    x, y = cols / span, (rows - rc) / half_r
    scale = (np.abs(x) ** p + np.abs(y) ** p) ** (-1 / p)
    target = grid_point(grid, rc + y * scale * half_r, c + x * scale * span)
    result = grid.copy()
    result[rows.astype(int), (c + cols.astype(int)) % grid.shape[1]] = target
    return result


def sleeve_ring_tangents(positions: np.ndarray, sleeve_grids: dict[str, np.ndarray]) -> np.ndarray:
    """Unit tangent of its ring at each sleeve grid vertex (rows 1..; central difference);
    zero elsewhere (the shared armhole loop and the other panels move freely)."""
    tangent = np.zeros_like(positions)
    for grid in sleeve_grids.values():
        rows = grid[1:]
        t = positions[np.roll(rows, -1, axis=1)] - positions[np.roll(rows, 1, axis=1)]
        tangent[rows] = t / np.maximum(np.linalg.norm(t, axis=2, keepdims=True), 1e-12)
    return tangent


def respace_sleeve(
    positions: np.ndarray, delta: np.ndarray, grid: np.ndarray, cap_rows: int
) -> tuple[np.ndarray, np.ndarray]:
    """Re-space the cap rows by arc along each sleeve column (graded, see below), between the
    armhole loop (row 0, shared with the torso) and the bicep ring (both fixed). The points stay
    on the column polylines. ``delta`` (rest - shown) is interpolated with the same weights."""
    positions, delta = positions.copy(), delta.copy()
    m = grid.shape[1]
    # Row q sits at arc fraction (q / (cap_rows + 1)) ** g. Short columns (the underarm, where
    # raised arms stretch the cap most) take g = SHELL_CAP_ROW_GRADING, so their first gap next
    # to the loop is the longest; long columns (top of the shoulder) stay even (g = 1).
    columns = grid[: cap_rows + 2].T  # (m, cap_rows + 2)
    path = positions[columns]
    path_delta = delta[columns]
    seg = np.linalg.norm(np.diff(path, axis=1), axis=2)
    arc = np.concatenate((np.zeros((m, 1)), np.cumsum(seg, axis=1)), axis=1)
    short, long = config.SHELL_CAP_GRADED_COLUMN_M
    grading = np.interp(arc[:, -1], [short, long], [config.SHELL_CAP_ROW_GRADING, 1.0])
    for q in range(1, cap_rows + 1):
        want = arc[:, -1] * (q / (cap_rows + 1)) ** grading
        k = np.clip((arc <= want[:, None]).sum(1) - 1, 0, cap_rows)
        rows = np.arange(m)
        w = ((want - arc[rows, k]) / np.maximum(seg[rows, k], 1e-15))[:, None]
        positions[columns[:, q]] = path[rows, k] * (1 - w) + path[rows, k + 1] * w
        delta[columns[:, q]] = path_delta[rows, k] * (1 - w) + path_delta[rows, k + 1] * w
    return positions, delta


def taubin_masked(grid: np.ndarray, movable: np.ndarray, passes: int) -> np.ndarray:
    """Taubin (lambda/mu) smoothing of the ``movable`` vertices of a column-cyclic grid
    (4-neighbour average; first/last rows only act as fixed neighbours)."""
    result = grid.copy()
    for _ in range(passes):
        for factor in (0.5, -0.53):
            average = result.copy()
            average[1:-1] = (
                result[:-2]
                + result[2:]
                + np.roll(result, 1, 1)[1:-1]
                + np.roll(result, -1, 1)[1:-1]
            ) / 4
            result[movable] += factor * (average[movable] - result[movable])
    return result


def taubin_line(points: np.ndarray, passes: int) -> np.ndarray:
    """Taubin passes along a polyline, both ends fixed (volume-preserving, numerical)."""
    out = points.copy()
    for _ in range(passes):
        for factor in (0.5, -0.53):
            out[1:-1] += factor * ((out[:-2] + out[2:]) / 2 - out[1:-1])
    return out


def taubin_grid(grid: np.ndarray, first: int, last: int, passes: int) -> np.ndarray:
    """Taubin (lambda/mu) smoothing of rows [first, last) of a cyclic (rows, cols, 3) grid."""
    result = grid.copy()
    for _ in range(passes):
        for factor in (0.5, -0.53):
            inner = result[first:last]
            average = (
                result[first - 1 : last - 1]
                + result[first + 1 : last + 1]
                + np.roll(inner, 1, axis=1)
                + np.roll(inner, -1, axis=1)
            ) / 4
            result[first:last] = inner + factor * (average - inner)
    return result


def _interp_ring(levels: np.ndarray, rings: np.ndarray, y: float, j: int) -> np.ndarray:
    order = np.argsort(levels)
    return np.array([np.interp(y, levels[order], rings[order, j, k]) for k in range(3)])


def _inside_convex(poly: np.ndarray, point: np.ndarray) -> bool:
    a = poly - point
    b = np.roll(poly, -1, axis=0) - point
    cross = a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0]
    return bool((cross > 0).all() or (cross < 0).all())


class SleeveBarrier:
    """The torso shell below the armhole bottom, as a barrier the sleeves stay outside of.

    Where the hanging arm presses on the torso (heavy or short bodies: arm-torso gap below
    torso clearance + separation + sleeve clearance), the sleeve's underside cannot clear both
    the arm and the torso shell. The torso shell carries the chest tape and wins: sleeve
    vertices are kept SHELL_SEPARATION_M outside it (radially from the torso axis), even if the
    arm's clearance push would move them in (the arm is pressed into the side panel there; the
    pinched skin is hidden between sleeve and torso). Without this the arm push and the
    crossing repair fought each other and crumpled the sleeve underside (visible inside-out
    creases, sleeve/torso crossings).
    """

    def __init__(self, torso_ids: np.ndarray, r_ah: int, centre2: np.ndarray, sleeve: np.ndarray):
        self.rows = torso_ids[r_ah:]
        self.centre2 = centre2
        self.sleeve = sleeve  # per-vertex mask

    def clamp(self, positions: np.ndarray, ids: np.ndarray, torso: np.ndarray) -> np.ndarray:
        """``positions`` rows (vertex ids ``ids``) with their sleeve vertices moved out of the
        torso shell given by ``torso`` (full positions array the torso rows are read from)."""
        grid = torso[self.rows]
        local = np.flatnonzero(self.sleeve[ids])
        if not len(local):
            return positions
        moved = _outside_torso(positions[local], grid, self.centre2)
        if moved is None:
            return positions
        result = positions.copy()
        result[local] = moved
        return result

    def covers(self, points: np.ndarray, torso: np.ndarray, extra: float = 0.0) -> np.ndarray:
        """Mask of ``points`` inside the torso shell + separation (+ ``extra``)."""
        sub, dist, radius = _torso_radius(points, torso[self.rows], self.centre2)
        result = np.zeros(len(points), bool)
        result[sub] = dist < radius + config.SHELL_SEPARATION_M + extra
        return result


def _torso_radius(
    points: np.ndarray, grid: np.ndarray, centre2: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(rows of ``points`` within the torso grid's height range, their distance from the torso
    axis, the grid's radius at their angle and height), bilinear in (column, row)."""
    n = grid.shape[1]
    ys = grid[:, 0, 1]
    sub = np.flatnonzero((points[:, 1] <= ys[0]) & (points[:, 1] >= ys[-1]))
    if not len(sub):
        return sub, np.empty(0), np.empty(0)
    q = points[sub]
    radii = np.linalg.norm(grid[:, :, [0, 2]] - centre2, axis=2)  # (rows', n)
    rel = q[:, [0, 2]] - centre2
    phi = np.mod(np.arctan2(rel[:, 1], rel[:, 0]), 2 * np.pi)
    col = phi / (2 * np.pi / n)
    j0 = np.floor(col).astype(int) % n
    j1 = (j0 + 1) % n
    w = col - np.floor(col)
    order = np.argsort(ys)
    row_f = np.interp(q[:, 1], ys[order], np.arange(len(ys))[order])
    r0 = np.floor(row_f).astype(int)
    r1 = np.minimum(r0 + 1, len(ys) - 1)
    v = row_f - r0
    radius = (
        radii[r0, j0] * (1 - w) * (1 - v)
        + radii[r0, j1] * w * (1 - v)
        + radii[r1, j0] * (1 - w) * v
        + radii[r1, j1] * w * v
    )
    return sub, np.linalg.norm(rel, axis=1), radius


def _outside_torso(points: np.ndarray, grid: np.ndarray, centre2: np.ndarray) -> np.ndarray | None:
    """``points`` moved radially (about the torso axis) to at least the torso grid's radius +
    SHELL_SEPARATION_M where they lie within its height range; None if none had to move."""
    sub, dist, radius = _torso_radius(points, grid, centre2)
    inside = dist < radius + config.SHELL_SEPARATION_M
    if not inside.any():
        return None
    rel = points[sub[inside]][:, [0, 2]] - centre2
    rel *= ((radius[inside] + config.SHELL_SEPARATION_M) / np.maximum(dist[inside], 1e-9))[:, None]
    result = points.copy()
    rows = sub[inside]
    result[rows, 0] = centre2[0] + rel[:, 0]
    result[rows, 2] = centre2[1] + rel[:, 1]
    return result


def separate_sleeves(
    positions: np.ndarray,
    panels: np.ndarray,
    grid: np.ndarray,
    r_ah: int,
    rows: int,
    n: int,
    centre2: np.ndarray,
) -> np.ndarray:
    """Push sleeve vertices that fall inside the torso shell back onto it (+margin)."""
    result = positions.copy()
    sleeve = np.flatnonzero(np.isin(panels, list(PANEL_SLEEVE.values())))
    moved = _outside_torso(result[sleeve], grid[r_ah:], centre2)
    if moved is not None:
        result[sleeve] = moved
    return result


def neckline_arc_from_cf(ring: np.ndarray) -> np.ndarray:
    """Signed arc (m) from centre front (column n/4) along a closed ring, in (-L/2, L/2]."""
    n = len(ring)
    seg = np.linalg.norm(np.roll(ring, -1, axis=0) - ring, axis=1)
    cum = np.r_[0.0, np.cumsum(seg)[:-1]]
    total = float(seg.sum())
    s = cum - cum[n // 4]
    s = np.where(s > total / 2, s - total, s)
    return np.where(s < -total / 2, s + total, s)


def collar_shape(s: np.ndarray, total: float, hood_kind: str | None):
    """Per neckline column: collar top height above the neckline and outward lean at the top (m).

    ``s``: signed arc from centre front; ``total``: neckline length. Look conventions from the
    user's photos (config, uncalibrated, no tape):
    - attached hood (FB7675-100): no stand collar. Zipped, the hood's lower front is a level
      stand at the chin round the front and sides (user, 2026-11-13: "fully zipped, the top
      reaches the chin, no higher"; video 12-13 s, 26-31 s: the opening edges at the jaw);
      behind the neck it rises into the hood, loose (leaning out, more behind the neck where
      the hood gathers) - Parka1/3/4.
    - removable hood (DQ4920-206): a tall insulated funnel collar of even height - Puffer1/2.
    - no hood: the old short stand.
    """
    behind = np.clip(-np.cos(np.pi * np.abs(s) / (total / 2)), 0.0, 1.0) ** 2
    if hood_kind == "attached":
        past_zip = np.abs(s) - config.SHELL_HOOD_BASE_LEVEL_M
        rise = smoothstep(np.clip(past_zip / config.SHELL_HOOD_BASE_V_M, 0, 1))
        # Level stand round the front and sides, rising into the hood behind the neck only
        # (CH: rising from the sides, the band stood beside the jaw up to the ear lobes). The
        # rise follows -cos round the back (its square left 2.99 deg slivers at the hood root).
        front_h, back_h = config.SHELL_HOOD_BASE_FRONT_M, config.SHELL_HOOD_BASE_SIDE_M
        height = front_h + (back_h - front_h) * np.sqrt(behind)
        lean_side, lean_back = config.SHELL_HOOD_BASE_LEAN_M
        lean = lean_side * rise + (lean_back - lean_side) * behind
        return height, lean
    if hood_kind == "removable":
        return (
            np.full(len(s), config.SHELL_FUNNEL_COLLAR_M),
            np.full(len(s), config.SHELL_FUNNEL_LEAN_M),
        )
    return np.full(len(s), config.GARMENT_COLLAR_HEIGHT_M), np.zeros(len(s))


def build_collar(
    neckline: np.ndarray,
    neck: np.ndarray,
    axes: tuple[np.ndarray, np.ndarray, np.ndarray],
    pierce2: np.ndarray,
    plane_angles: np.ndarray,
    cache: ShellBodyCache,
    minimum: float,
    hood_kind: str | None,
    tape: float | None = None,
    tape_height: float | None = None,
) -> tuple[np.ndarray, int, bool]:
    """Collar rows (rows, n, 3) rising from the neckline, shaped by ``collar_shape``, the
    index of the row the folded hood roots on (the collar's top edge), and whether the collar
    tape had to be held at body clearance.

    ``tape`` / ``tape_height`` (m): the funnel's measured inner circumference and height (user's
    tape, sizes that have one; agent L2). The rings then narrow from the neckline to the tape
    (smoothstep over the height) with the outward lean taken out of the target, so the top
    ring's perimeter is the tape; a tape tighter than the neck + ``minimum`` is held there.

    Body-clearing rings (neckline perimeter, as before) are fitted at evenly spaced heights in
    the sloped neck-base plane; each column then takes its own height profile (rows evenly
    spaced up to that column's top) and leans out horizontally from the neck centre, growing
    as (row fraction)^1.5 so the collar leaves the neck softly instead of hugging it.
    """
    lateral, up, front = axes
    s = neckline_arc_from_cf(neckline)
    total = ring_perimeter(neckline)
    height, lean = collar_shape(s, total, hood_kind)
    if tape_height is not None:
        height = np.full_like(height, tape_height)
    top = float(height.max())
    rows = max(config.SHELL_COLLAR_ROWS, int(np.ceil(top / config.SHELL_COLLAR_ROW_M)))
    levels = top * np.arange(1, rows + 1) / rows  # one body section per row (build time)
    rings = [neckline]
    clamped_any = False
    for h in levels:
        origin = neck + up * h
        pts = cache.torso_slicer.points(origin, up)
        local = np.c_[(pts - origin) @ lateral, (pts - origin) @ front]
        hull = hull_polygon(local)
        target = total
        if tape is not None:
            f = h / top
            push = float(np.mean(lean)) * f**1.5  # the lean below adds ~2 pi push of perimeter
            target = total + (tape - total) * float(smoothstep(f)) - 2 * np.pi * push
        ring2, _, clamped = fitted_ring(hull, pierce2, plane_angles, target, minimum)
        clamped_any |= bool(clamped) and tape is not None
        rings.append(origin + ring2[:, :1] * lateral + ring2[:, 1:] * front)
    rings = np.array(rings)  # (rows + 1, n, 3)
    stack = np.r_[0.0, levels]
    centre = neckline[:, [0, 2]].mean(0)
    collar = np.empty((rows, len(neckline), 3))
    for q in range(rows):
        f = (q + 1) / rows
        for j in range(len(neckline)):
            h = height[j] * f
            k = int(np.clip(np.searchsorted(stack, h) - 1, 0, len(stack) - 2))
            t = (h - stack[k]) / (stack[k + 1] - stack[k])
            collar[q, j] = rings[k, j] * (1 - t) + rings[k + 1, j] * t
        out = collar[q][:, [0, 2]] - centre
        out /= np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-9)
        push = lean * f**1.5
        collar[q, :, 0] += out[:, 0] * push
        collar[q, :, 2] += out[:, 1] * push
    if hood_kind != "removable":
        return collar, rows - 1, clamped_any
    # Insulated funnel: its top edge is a thick rounded fold, turned in and down inside the
    # collar (a single sheet drew a paper-thin rim with the lining showing). Cross-section
    # relative to the top point, (inward, up) in units of the thickness, kept clear of the neck.
    thick = config.SHELL_FUNNEL_THICK_M
    min_rings = []
    crest = 0.45 * thick  # the rounded top rises this much above the outer top row
    for h in np.r_[top, top - np.array(config.SHELL_FUNNEL_TURN_DEPTHS_M), top + crest]:
        origin = neck + up * h
        pts = cache.torso_slicer.points(origin, up)
        hull = hull_polygon(np.c_[(pts - origin) @ lateral, (pts - origin) @ front])
        ring2, _, _ = fitted_ring(hull, pierce2, plane_angles, None, minimum)
        min_rings.append(origin + ring2[:, :1] * lateral + ring2[:, 1:] * front)
    top_ring = collar[-1]
    inward = centre - top_ring[:, [0, 2]]
    inward /= np.maximum(np.linalg.norm(inward, axis=1, keepdims=True), 1e-9)
    inward3 = np.c_[inward[:, 0], np.zeros(len(inward)), inward[:, 1]]
    # Room between the collar and the neck at the top (radial, horizontal).
    room = np.einsum("ij,ij->i", min_rings[0] - top_ring, inward3)
    # Under the removable hood's root (back of the neck) the hood covers the collar top: the
    # turn fades to a small cap there, so the hood's first rows cannot pass inside it.
    angle = 2 * np.pi * np.arange(len(neckline)) / len(neckline)
    open_w = np.clip((np.sin(angle) - config.SHELL_FUNNEL_COVERED_SIN) / 0.3, 0.2, 1.0)
    depth = np.clip(np.minimum(thick, room - 0.002), 0.001, None) * open_w
    turned = []
    # Rounded top: up and over. Where the jaw comes close above the collar (sides of the neck)
    # the crest rises and reaches in less (room at crest height; floor keeps the rows apart).
    above = top_ring + up * (crest * open_w)[:, None]
    room_crest = np.einsum("ij,ij->i", min_rings[-1] - above, inward3)
    g = np.clip((room_crest - 0.002) / np.maximum(0.75 * depth, 1e-6), 0.15, 1.0)
    for a in (0.3, 0.75):
        turned.append(
            top_ring + inward3 * (a * depth * g)[:, None] + up * (crest * open_w * g)[:, None]
        )
    for k, below in enumerate(config.SHELL_FUNNEL_TURN_DEPTHS_M):
        base = top_ring - up * (below * open_w)[:, None]
        r = np.einsum("ij,ij->i", min_rings[k + 1] - base, inward3)
        d = np.clip(np.minimum(depth, r - 0.002), 0.001, None)
        turned.append(base + inward3 * d[:, None])
    # The hood hangs from the crest of the fold (the collar's highest row).
    return np.concatenate((collar, np.array(turned))), rows - 1, clamped_any


def hood_root_columns(n: int, root_sin: float = config.SHELL_HOOD_ROOT_SIN) -> list[int]:
    """Neckline columns the folded hood roots on (sin(angle) < ``root_sin``: the back), ordered
    from the right side (-X) round the back to +X."""
    cols = [j for j in range(n) if np.sin(2 * np.pi * j / n) < root_sin]
    return sorted(cols, key=lambda j: np.mod(2 * np.pi * j / n - np.pi + 0.3, 2 * np.pi))


def folded_hood(
    positions: np.ndarray,
    torso_ids: np.ndarray,
    n: int,
    r_ah: int,
    collar_ids: np.ndarray,
    root_row: int = 0,
    length: float | None = None,
    root_sin: float = config.SHELL_HOOD_ROOT_SIN,
    gap: float = config.SHELL_HOOD_GAP_M,
    half_width: float | None = None,
    thickness: float | None = None,
    roll_taper: float = 0.0,
) -> tuple[np.ndarray, list, np.ndarray]:
    """Hood lying folded on the upper back: a pillow rooted on collar row ``root_row`` (0 =
    the back neckline; -1 = the collar's top edge, an attached hood rolling over behind the neck).

    Dimensions are the uncalibrated config hood assumptions (awaiting tape).
    """
    # Back half of the neckline, ordered from the right side (-X) around the back to +X.
    root_cols = hood_root_columns(n, root_sin)
    root = collar_ids[root_row][root_cols]  # shared with the collar (row 0: the torso neckline)
    root_pos = positions[root]
    m = len(root)
    rows = config.SHELL_HOOD_ROWS
    if length is None:
        length = config.CLOTH_HOOD_HEIGHT_M * config.SHELL_HOOD_FOLD_FRACTION
    if thickness is None:
        thickness = config.CLOTH_HOOD_DEPTH_M * config.SHELL_HOOD_FLAT_FRACTION
    # Back shell as a mesh for ray placement.
    back_faces = []
    for r in range(min(r_ah + 14, torso_ids.shape[0] - 1)):
        for j in range(n):
            a, b = torso_ids[r, j], torso_ids[r, (j + 1) % n]
            c, d = torso_ids[r + 1, (j + 1) % n], torso_ids[r + 1, j]
            back_faces.extend(((a, b, c), (a, c, d)))
    # The collar too: an attached hood's root (the collar top) is above the neckline, and its
    # first rows lie over the collar's back wall.
    for r in range(len(collar_ids) - 1):
        for j in range(n):
            a, b = collar_ids[r, j], collar_ids[r, (j + 1) % n]
            c, d = collar_ids[r + 1, (j + 1) % n], collar_ids[r + 1, j]
            back_faces.extend(((a, b, c), (a, c, d)))
    shell = trimesh.Trimesh(positions, np.array(back_faces), process=False)
    root_half = np.abs(root_pos[:, 0]).max()
    width = config.CLOTH_HOOD_WIDTH_M if half_width is None else half_width
    # Lateral parameter by arc length along the root (not uniform): the pillow's columns then
    # start where the root vertices are, so the root rows are not sheared into slivers.
    root_arc = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(root_pos, axis=0), axis=1))]
    lateral = 2 * root_arc / root_arc[-1] - 1
    y_root = root_pos[:, 1].min()
    grid = np.empty((rows, m, 3))
    for q in range(1, rows + 1):
        s = q / rows
        y = y_root - length * s
        # Folded outline: widens from the neckline root to the flat hood width, then rounds.
        grow = root_half + (width - root_half) * float(smoothstep(s / 0.4))
        tip = np.sqrt(np.clip(1 - max(0.0, (s - 0.55) / 0.45) ** 2, config.SHELL_HOOD_TIP_MIN, 1.0))
        half = grow * tip
        xs = lateral * half if q < rows else lateral * half * config.SHELL_HOOD_TIP_ROW_SCALE
        origins = np.c_[xs, np.full(m, y), np.full(m, -1.0)]
        locs, index_ray, tri = shell.ray.intersects_location(
            origins, np.tile([0.0, 0.0, 1.0], (m, 1)), multiple_hits=False
        )
        hit = np.full((m, 3), np.nan)
        normal = np.tile([0.0, 0.0, -1.0], (m, 1))
        hit[index_ray] = np.reshape(locs, (-1, 3))
        fn = shell.face_normals[tri]
        fn = np.where((fn[:, 2] > 0)[:, None], -fn, fn)
        normal[index_ray] = fn
        missing = ~np.isfinite(hit[:, 0])
        if missing.any():
            hit[missing] = np.c_[
                xs[missing], np.full(missing.sum(), y), np.full(missing.sum(), root_pos[:, 2].min())
            ]
        edge = 1 - np.abs(lateral) ** 4
        lift = thickness * np.sin(np.pi * min(1.0, s * 1.15)) ** 0.6 * edge
        roll = config.SHELL_HOOD_ROLL_M * np.exp(-s * 6)
        # Gap eased in from the root (see clear_hood): no sheared root triangles.
        ease = float(smoothstep(min(1.0, q / config.SHELL_HOOD_BLEND_ROWS)))
        lift = np.maximum(
            lift + roll, config.SHELL_HOOD_GAP_M + (gap - config.SHELL_HOOD_GAP_M) * ease
        )
        grid[q - 1] = hit + normal * lift[:, None]
    # Blend first rows from the root so the hood rises from the neckline.
    # The roll offset eases in from zero (sin^2), over SHELL_HOOD_BLEND_ROWS rows: the old
    # 3-row blend put the first row 3.4 cm from the root (vs 2-9 mm columns: slivers).
    blend = min(config.SHELL_HOOD_BLEND_ROWS, rows)
    # The roll leaves the neckline across it (horizontal outward from the neck centre), not
    # straight back: at the sides of the neck the root runs front-back, and a backward roll
    # lay along it (0.5 deg root slivers).
    neck_centre = positions[collar_ids[0]][:, [0, 2]].mean(0)
    outward = root_pos[:, [0, 2]] - neck_centre
    outward /= np.maximum(np.linalg.norm(outward, axis=1, keepdims=True), 1e-9)
    # Rooted on a collar's top edge, the fold must first clear the collar's outer wall.
    # It hangs from that edge: no upward roll (rising above the collar, its inside showed beside
    # the collar from the front).
    out_m = 0.03 if root_row == 0 else config.SHELL_HOOD_TOP_ROLL_OUT_M
    up_m = 0.012 if root_row == 0 else 0.0
    # ``roll_taper``: fraction of the roll removed toward the root's two ends (smoothly); a
    # removable hood rolling 4.5 cm outward at its ends stood beside the funnel top (L2).
    out_k = out_m * (1 - roll_taper * np.abs(lateral) ** 2)
    roll_dir = np.c_[out_k * outward[:, 0], np.full(m, up_m), out_k * outward[:, 1]]
    for q in range(blend):
        t = (q + 1) / (blend + 1)
        roll = roll_dir * np.sin(np.pi * t) ** config.SHELL_HOOD_ROLL_POWER
        grid[q] = root_pos * (1 - t) + grid[q] * t + roll
    # Smooth the pillow (root row fixed): per-row ray hits and the root blend left kinks that
    # drew glassy shards. Lift only grows outward after this (max with the smoothed offset).
    if config.SHELL_HOOD_SMOOTH_PASSES:
        full = np.vstack((root_pos[None], grid))
        padded = np.concatenate((full[:, :1], full, full[:, -1:]), axis=1)
        for _ in range(config.SHELL_HOOD_SMOOTH_PASSES):
            for factor in (0.5, -0.53):
                average = (
                    padded[:-2, 1:-1] + padded[2:, 1:-1] + padded[1:-1, :-2] + padded[1:-1, 2:]
                ) / 4
                padded[1:-1, 1:-1] += factor * (average - padded[1:-1, 1:-1])
                padded[:, 0], padded[:, -1] = padded[:, 1], padded[:, -2]
        grid = padded[1:, 1:-1]
    base = len(positions)
    positions = np.vstack((positions, grid.reshape(-1, 3)))
    ids = np.vstack((root[None, :], base + np.arange(rows * m).reshape(rows, m)))
    faces = []
    for r in range(rows):
        for j in range(m - 1):
            a, b = ids[r, j], ids[r, j + 1]
            c, d = ids[r + 1, j + 1], ids[r + 1, j]
            faces.extend(((a, c, b), (a, d, c)))
    return positions, faces, ids


def follow_back(
    positions: np.ndarray,
    laid: np.ndarray,
    faces: np.ndarray,
    panels: np.ndarray,
    hood_grid: np.ndarray,
) -> np.ndarray:
    """Pillow vertices moved with the back/yoke/collar surface they were laid on.

    ``laid``: positions when the hood was built. Each pillow vertex's closest point on that
    shell (same triangle, same barycentric coordinates) is found again on the current shell;
    the vertex moves by the same vector. The clearance repairs and smoothing that follow the
    hood's construction move the back out by up to 2 cm under the pillow's sides (wide sizes)
    and the yoke near the neck; a static pillow then crossed them.
    """
    from ..surface_query import SurfaceQuery

    under = faces[np.isin(panels[faces], (PANEL_BACK, PANEL_YOKE, PANEL_COLLAR)).all(1)]
    pillow = np.unique(hood_grid[1:])
    if not len(under) or not len(pillow):
        return positions
    query = SurfaceQuery(trimesh.Trimesh(laid, under, process=False))
    closest, _, triangle = query.closest(laid[pillow])
    corners = under[triangle]
    bary = trimesh.triangles.points_to_barycentric(laid[corners], closest)
    now = np.einsum("ij,ijk->ik", bary, positions[corners])
    result = positions.copy()
    result[pillow] = laid[pillow] + now - closest
    return result


def smooth_pillow(positions: np.ndarray, hood_grid: np.ndarray, passes: int) -> np.ndarray:
    """Taubin passes over the folded hood grid (root row fixed, side columns clamped)."""
    full = positions[hood_grid]
    padded = np.concatenate((full[:, :1], full, full[:, -1:]), axis=1)
    for _ in range(passes):
        for factor in (0.5, -0.53):
            average = (
                padded[:-2, 1:-1] + padded[2:, 1:-1] + padded[1:-1, :-2] + padded[1:-1, 2:]
            ) / 4
            padded[1:-1, 1:-1] += factor * (average - padded[1:-1, 1:-1])
            padded[:, 0], padded[:, -1] = padded[:, 1], padded[:, -2]
    result = positions.copy()
    result[hood_grid[1:-1]] = padded[1:-1, 1:-1]
    return result


def clear_hood(
    positions: np.ndarray,
    faces: np.ndarray,
    panels: np.ndarray,
    hood_grid: np.ndarray,
    gap: float = config.SHELL_HOOD_GAP_M,
) -> np.ndarray:
    """Folded hood kept outside the back, yoke, collar and sleeve caps it lies on.

    Each pillow vertex (root row fixed: it is the neckline) that is nearer than
    ``gap`` to that shell, or behind it, moves out along the shell's normal to the gap.
    Then pillow vertices of edges/triangles still crossing it step out along the normal of the
    shell triangle they cross (SHELL_UNTANGLE_STEP_M per pass): a chord between two cleared
    vertices can still cut a convex yoke near the neck.
    """
    from ..surface_query import SurfaceQuery

    face_panel = panels[faces]
    hood = faces[(face_panel == PANEL_HOOD).all(1)]
    # The sleeve caps too: on narrow backs the pillow's sides reach the back armholes.
    lying_on = (PANEL_BACK, PANEL_YOKE, PANEL_COLLAR, *PANEL_SLEEVE.values())
    under = faces[np.isin(face_panel, lying_on).all(1)]
    if not len(hood) or not len(under):
        return positions
    # Only shell faces near the hood can meet it (the pillow moves out by at most the gap plus
    # SHELL_HOOD_CLEAR_PASSES steps): same answers, a fraction of the crossing tests.
    span = positions[np.unique(hood)]
    reach = gap + config.SHELL_HOOD_CLEAR_PASSES * config.SHELL_UNTANGLE_STEP_M
    low, high = span.min(0) - 2 * reach, span.max(0) + 2 * reach
    near = ((positions >= low) & (positions <= high)).all(1)
    under = under[near[under].any(1)]
    if not len(hood) or not len(under):
        return positions
    pillow = np.unique(hood_grid[1:])
    movable = np.zeros(len(positions), bool)
    movable[pillow] = True
    # The gap eases in from the old 4 mm at the fixed root over the blend rows: lifted to the
    # full gap at once (3 cm on the puffer), row 1 sheared the root triangles into slivers.
    row_of = np.zeros(len(positions))
    for r, ids in enumerate(hood_grid):
        row_of[ids] = r
    ease = smoothstep(np.clip(row_of[pillow] / config.SHELL_HOOD_BLEND_ROWS, 0.0, 1.0))
    gaps = config.SHELL_HOOD_GAP_M + (gap - config.SHELL_HOOD_GAP_M) * ease
    shell = trimesh.Trimesh(positions, under, process=False)
    normals = shell.face_normals
    query = SurfaceQuery(shell)
    result = positions.copy()
    # Drape: lift to the gap, smooth, repeat. Lifted vertex by vertex, the pillow's sides copied
    # every stair-step of the yoke/armhole under them (jagged edges, L1b); smoothed between the
    # lifts it settles as a sheet over the bumps.
    for k in range(config.SHELL_HOOD_DRAPE_ROUNDS + 1):
        closest, _, triangle = query.closest(result[pillow])
        normal = normals[triangle]
        short = gaps - np.einsum("ij,ij->i", result[pillow] - closest, normal)
        lift = short > 0
        result[pillow[lift]] += normal[lift] * short[lift, None]
        if k < config.SHELL_HOOD_DRAPE_ROUNDS:
            result = smooth_pillow(result, hood_grid, config.SHELL_HOOD_DRAPE_PASSES)
    hood_edges, under_edges = face_edges(hood), face_edges(under)
    e1, t1 = segment_hits(result, hood_edges, under)
    e2, t2 = segment_hits(result, under_edges, hood)
    for _ in range(config.SHELL_HOOD_CLEAR_PASSES):
        if not len(e1) and not len(e2):
            break
        move = np.zeros_like(result)
        count = np.zeros(len(result))
        for ids, tri in ((hood_edges[e1], t1), (hood[t2], None)):
            if not len(ids):
                continue
            if tri is None:
                # A shell edge through a pillow triangle: out along the nearest shell normal.
                c, _, t = query.closest(result[ids].reshape(-1, 3))
                direction = normals[t].reshape(ids.shape + (3,))
            else:
                direction = np.repeat(normals[tri][:, None, :], ids.shape[1], axis=1)
            for k in range(ids.shape[1]):
                np.add.at(move, ids[:, k], direction[:, k])
                np.add.at(count, ids[:, k], 1)
        step = movable & (count > 0)
        if not step.any():
            break
        direction = move[step] / np.maximum(np.linalg.norm(move[step], axis=1)[:, None], 1e-12)
        result[step] += direction * config.SHELL_UNTANGLE_STEP_M
        # Only the hood moves: re-test the hood edges/triangles with a moved corner; the other
        # pairs keep their answer (same result as testing everything again).
        stale_e = np.flatnonzero(step[hood_edges].any(1))
        stale_t = np.flatnonzero(step[hood].any(1))
        keep1, keep2 = ~np.isin(e1, stale_e), ~np.isin(t2, stale_t)
        n1, m1 = segment_hits(result, hood_edges[stale_e], under)
        n2, m2 = segment_hits(result, under_edges, hood[stale_t])
        e1, t1 = np.r_[e1[keep1], stale_e[n1]], np.r_[t1[keep1], m1]
        e2, t2 = np.r_[e2[keep2], n2], np.r_[t2[keep2], stale_t[m2]]
    return result


def hood_rim(
    positions: np.ndarray,
    collar_ids: np.ndarray,
    n: int,
    loft: float,
    stop_cols: list[int] | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Attached hood worn down: its padded face-opening edges round the neck (two strips).

    Each strip runs from just beside the zip (``SHELL_HOOD_RIM_OPENING_M`` of collar arc
    from centre front) round the side of the neck for ``SHELL_HOOD_RIM_LENGTH_M`` (None: one
    edge continuing round the back of the neck), to where
    the folded hood lies on the back. Cross-section (outward, up) relative to the collar's top
    edge: rooted on the collar's middle ring (shared vertices, one connected mesh), padded
    outer face standing clear of the collar's relief, a rolled edge of radius ``RADIUS`` rising
    ``RISE`` above the collar, and an inner lip. Rise and radius ease in over ``RAMP`` at both
    ends. All sizes are uncalibrated look values (photo look; no hood tape yet).
    ``stop_cols``: neckline columns with no edge (where the hood rolls over behind the neck);
    each side's strip then runs from the opening to the last column before them.
    """
    top, mid = collar_ids[-1], collar_ids[len(collar_ids) // 2]
    ring = positions[top]
    seg = np.linalg.norm(np.roll(ring, -1, axis=0) - ring, axis=1)
    cum = np.r_[0.0, np.cumsum(seg)[:-1]]
    total = float(seg.sum())
    s = cum - cum[n // 4]
    s = np.where(s > total / 2, s - total, s)
    s = np.where(s < -total / 2, s + total, s)
    centre = ring[:, [0, 2]].mean(0)
    opening, length = config.SHELL_HOOD_RIM_OPENING_M, config.SHELL_HOOD_RIM_LENGTH_M
    ramp = config.SHELL_HOOD_RIM_RAMP_M
    lift = config.SHELL_HOOD_RIM_LIFT_LOFT * loft + config.SHELL_HOOD_RIM_GAP_M
    new_points: list[np.ndarray] = []
    strips: list[np.ndarray] = []
    base_index = len(positions)
    count = 0
    lengths: list[float | None] = []
    if stop_cols is not None:
        free = ~np.isin(np.arange(n), stop_cols)
        orders = []
        for sign in (1, -1):
            cols = np.flatnonzero((s * sign >= opening) & free)
            orders.append(cols[np.argsort(np.abs(s[cols]))])
            lengths.append(float(np.abs(s[cols]).max() - opening) if len(cols) else 0.0)
    elif length is None:
        # One continuous edge from beside the zip round the back of the neck to the other
        # side (the worn-down hood's fold stands behind the neck in the product photos).
        right = np.flatnonzero(s >= opening)
        left = np.flatnonzero(s <= -opening)
        orders = [np.r_[right[np.argsort(s[right])], left[np.argsort(s[left])]]]
    else:
        orders = []
        for sign in (1, -1):
            cols = np.flatnonzero((s * sign >= opening) & (np.abs(s) <= opening + length))
            orders.append(cols[np.argsort(np.abs(s[cols]))])
    for k_order, cols in enumerate(orders):
        strip, outs = [], []
        span = lengths[k_order] if lengths else length
        for j in cols:
            along = abs(s[j]) - opening
            back_end = np.inf if span is None else (span - along) / ramp
            t = float(np.clip(min(along / ramp, back_end), 0.0, 1.0))
            ease = max(float(smoothstep(t)), config.SHELL_HOOD_RIM_MIN_EASE)
            r = config.SHELL_HOOD_RIM_RADIUS_M * np.sqrt(ease)
            # Behind the neck the folded hood stands higher (photos): rise grows to BACK_RISE
            # at centre back (0 at the sides, smooth in the collar arc).
            behind = float(np.clip(-np.cos(np.pi * abs(s[j]) / (total / 2)), 0.0, 1.0)) ** 2
            rise = config.SHELL_HOOD_RIM_RISE_M * ease + config.SHELL_HOOD_RIM_BACK_RISE_M * behind
            p_top, p_mid = positions[top[j]], positions[mid[j]]
            base = p_top[1] - p_mid[1]
            section = [(lift + 1.6 * r, -0.6 * base)]
            for k in range(7):
                angle = np.pi * k / 6
                section.append((lift + r + r * np.cos(angle), rise + r * np.sin(angle)))
            section.append((lift + 0.2 * r, rise * 0.35))
            out = np.array([p_top[0] - centre[0], 0.0, p_top[2] - centre[1]])
            out /= np.linalg.norm(out)
            pts = np.array([p_top + out * x + np.array([0.0, y, 0.0]) for x, y in section])
            new_points.append(pts)
            strip.append(np.r_[mid[j], base_index + count + np.arange(len(pts))])
            outs.append(out)
            count += len(pts)
        if len(strip) < 2:
            continue
        quads = []
        for a_ids, b_ids in zip(strip[:-1], strip[1:], strict=True):
            for k in range(len(a_ids) - 1):
                quads.append([a_ids[k], b_ids[k], a_ids[k + 1]])
                quads.append([a_ids[k + 1], b_ids[k], b_ids[k + 1]])
        strip_faces = np.array(quads, dtype=np.int64)
        strips.append((strip_faces, len(strip[0]) - 1, np.mean(outs, axis=0)))
    if not new_points:
        return positions, np.empty((0, 3), np.int64), np.empty((0,), np.int64)
    positions = np.vstack((positions, *new_points))
    oriented = []
    for strip_faces, per_column, out in strips:
        # Section segment 1 is the padded outer face: its normal must point outward.
        tri = positions[strip_faces]
        normal = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        k = (np.arange(len(strip_faces)) // 2) % per_column
        if np.median(normal[k == 1] @ out) < 0:
            strip_faces = strip_faces[:, [0, 2, 1]]
        oriented.append(strip_faces)
    return positions, np.vstack(oriented), np.arange(base_index, len(positions))


def dropped_cap(positions: np.ndarray, grid: np.ndarray, seam: int, axis: np.ndarray) -> np.ndarray:
    """Sleeve vertices (cap side) above a dropped shoulder's seam ring.

    The seam ring runs from the tape-true seam point on top of the arm (``seam``, the dropped
    shoulder distance past the acromion) down to the armhole bottom (the loop's lowest vertex)
    under the arm: a plane through both, containing the arm's front-back direction. Vertices on
    the body side of it belong to the body panel's cap. Row 0 (the armhole loop) is torso.
    """
    loop = grid[0]
    rows = np.flatnonzero((grid == seam).any(1))
    if not len(rows) or rows[0] == 0:
        return np.empty(0, np.int64)  # the seam is the armhole itself (no drop past it)
    under = positions[loop[int(np.argmin(positions[loop, 1]))]]
    top = positions[seam]
    across = np.cross(axis, np.array([0.0, 1.0, 0.0]))
    across /= max(float(np.linalg.norm(across)), 1e-9)
    normal = np.cross(top - under, across)
    normal /= max(float(np.linalg.norm(normal)), 1e-9)
    if (positions[grid[-1]].mean(0) - under) @ normal < 0:
        normal = -normal
    ids = grid[1 : rows[0] + 1].ravel()  # never past the seam's own row
    return ids[(positions[ids] - under) @ normal < 0]


def shell_render_coordinates(
    product: GarmentSpec,
    positions: np.ndarray,
    panels: np.ndarray,
    torso_ids: np.ndarray,
    sleeve_grids: dict[str, np.ndarray],
    hood_grid: np.ndarray | None,
    n: int,
    r_top: int,
    landmarks: dict[str, np.ndarray],
    collar_ids: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """UV in metres: u = arc from centre front, v = depth below HPS (torso) / along sleeve.

    Collar rings: u = signed arc from centre front (column n/4) along the ring, wrapped at
    centre back to (-L/2, L/2]; v = depth below HPS (same v chart as the torso, negative
    above it). Same definition the renderer used client-side before.
    """
    visual = product.visual
    uv = np.zeros((len(positions), 2))
    quilt = np.zeros((len(positions), 4))
    hps_y = float(landmarks["HPS_L"][1])
    kind = 0
    if visual is not None:
        kind = 2 if visual.quilting.value == "box" else 1
    for r, ids in enumerate(torso_ids):
        ring = positions[ids]
        seg = np.linalg.norm(ring - np.roll(ring, 1, axis=0), axis=1)
        arc = np.cumsum(seg)
        arc -= arc[n // 4]
        uv[ids, 0] = arc
        uv[ids, 1] = hps_y - ring[:, 1]
        if visual is not None and r >= 1:
            quilt[ids] = [
                visual.chamber_width.value_cm / 100 if visual.chamber_width else 0,
                visual.chamber_height.value_cm / 100,
                visual.yoke_depth.value_cm / 100,
                kind,
            ]
    if collar_ids is not None:
        for ids in collar_ids[1:]:
            ring = positions[ids]
            seg = np.linalg.norm(np.roll(ring, -1, axis=0) - ring, axis=1)
            cum = np.r_[0.0, np.cumsum(seg)[:-1]]
            total = float(seg.sum())
            arc = cum - cum[n // 4]
            arc = np.where(arc > total / 2, arc - total, arc)
            arc = np.where(arc < -total / 2, arc + total, arc)
            uv[ids, 0] = arc
            uv[ids, 1] = hps_y - ring[:, 1]
    for grid in sleeve_grids.values():
        pts = positions[grid]
        centres = pts.mean(1)
        along = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(centres, axis=0), axis=1))]
        underarm = int(np.argmin(positions[grid[0], 1]))  # u seam hidden under the arm
        for r, ids in enumerate(grid[1:], start=1):
            ring = positions[ids]
            seg = np.linalg.norm(ring - np.roll(ring, 1, axis=0), axis=1)
            arc = np.cumsum(seg)
            uv[ids, 0] = np.mod(arc - arc[underarm], arc[-1])
            uv[ids, 1] = along[r]
            if visual is not None and r < len(grid) - 2:
                quilt[ids] = [0, visual.sleeve_chamber_height.value_cm / 100, 0, 1]
    if hood_grid is not None:
        pts = positions[hood_grid[1:]]
        uv[hood_grid[1:].ravel(), 0] = pts[..., 0].ravel()
        uv[hood_grid[1:].ravel(), 1] = (positions[hood_grid[0]][:, 1].max() - pts[..., 1]).ravel()
        if visual is not None:
            quilt[hood_grid[1:].ravel()] = [0, config.CLOTH_HOOD_CHAMBER_M, 0, 1]
    return uv, quilt


def chamber_profile(uv: np.ndarray, quilt: np.ndarray) -> np.ndarray:
    """Cosine chamber (0 on a stitch line, 1 at chamber centre); same formula as the shader."""
    kind = quilt[:, 3]
    period = np.maximum(quilt[:, 1], 1e-9)
    profile = 0.5 - 0.5 * np.cos(2 * np.pi * (uv[:, 1] - quilt[:, 2]) / period)
    box = kind > 1.5
    width = np.maximum(quilt[:, 0], 1e-9)
    profile[box] *= 0.5 - 0.5 * np.cos(2 * np.pi * uv[box, 0] / width[box])
    plain = (kind < 0.5) | (uv[:, 1] < quilt[:, 2])
    profile[plain] = config.SHELL_UNQUILTED_PUFF
    return profile


def shell_render_data(shell: Shell, product: GarmentSpec) -> dict[str, np.ndarray]:
    loft = product.loft_cm / 100
    uv, quilt = shell.uv, shell.quilt
    phase = np.mod(uv[:, 1] - quilt[:, 2], np.maximum(quilt[:, 1], 1e-9))
    distance = np.minimum(phase, quilt[:, 1] - phase)
    box = quilt[:, 3] > 1.5
    width = np.maximum(quilt[:, 0], 1e-9)
    across = np.mod(uv[:, 0], width)
    distance[box] = np.minimum(distance[box], np.minimum(across, width - across)[box])
    distance[(quilt[:, 3] < 0.5) | (uv[:, 1] < quilt[:, 2])] = 0
    frames = np.zeros((len(shell.initial), 3), dtype=np.int64)
    for corner in range(3):
        frames[shell.faces[:, corner]] = shell.faces[
            :, [corner, (corner + 1) % 3, (corner + 2) % 3]
        ]
    components = np.zeros((len(shell.initial), 3))
    components[:, 2] = loft * chamber_profile(uv, quilt)
    return {"stitch_distance": distance, "frames": frames, "components": components}


def shell_measurements(shell: Shell, product: GarmentSpec) -> dict[str, float]:
    """Re-measured rest tapes (cm). Outer girths add the loft back to the inner shell."""
    loft_girth = 2 * np.pi * product.loft_cm
    rest = shell.rest

    def girth(key: str) -> float:
        return ring_perimeter(rest[shell.paths[key][:-1]]) * 100

    result = {
        "chest": girth("chest") + loft_girth,
        "hem": girth("hem") + loft_girth,
        "neckline": girth("neckline"),
    }
    if "collar_top" in shell.paths:
        result["collar_top"] = girth("collar_top")  # inner (tape-true for sizes with a tape)
    for side in ("L", "R"):
        result[f"bicep_{side}"] = girth(f"bicep_{side}") + loft_girth
        result[f"cuff_{side}"] = girth(f"cuff_{side}")
        grid = shell.sleeve_grids[side]
        centres = rest[grid].mean(1)
        seam_row = int(np.flatnonzero((grid == shell.landmarks[f"seam_{side}"]).any(1))[0])
        result[f"sleeve_{side}"] = (
            float(np.linalg.norm(np.diff(centres[seam_row:], axis=0), axis=1).sum()) * 100
        )
    return result


def shell_tethers(shell: Shell) -> tuple[np.ndarray, np.ndarray]:
    """Long-range attachments: each particle to its nearest shoulder/neck root by rest geodesic.

    Upper bounds only (the solver lets fabric shorten and stack); both endpoints stay dynamic.
    """
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import dijkstra

    edges = trimesh.Trimesh(shell.rest, shell.faces, process=False).edges_unique
    lengths = np.linalg.norm(shell.rest[edges[:, 0]] - shell.rest[edges[:, 1]], axis=1)
    count = len(shell.rest)
    graph = coo_matrix(
        (
            np.r_[lengths, lengths],
            (np.r_[edges[:, 0], edges[:, 1]], np.r_[edges[:, 1], edges[:, 0]]),
        ),
        shape=(count, count),
    ).tocsr()
    stride = config.SHELL_TETHER_ROOT_STRIDE
    ridge = shell.torso_grid[config.SHELL_ROWS_TOP]
    roots = np.unique(
        np.r_[np.array(shell.paths["neckline"][:-1])[::stride], ridge[ridge >= 0][::stride]]
    )
    distances = dijkstra(graph, directed=False, indices=roots)
    choice = np.argmin(distances, axis=0)
    bounds = distances[choice, np.arange(count)]
    if not np.isfinite(bounds).all():
        raise ValueError("Every shell particle must connect to a shoulder root")
    keep = bounds > 0
    pairs = np.c_[roots[choice], np.arange(count)][keep]
    return pairs, bounds[keep]


FEATURE_CODES = {
    "front": {"two_way_zip": 1, "storm_flap": 2},
    "pockets": {"vertical_zip": 1, "angled_welt": 2},
    "cuffs": {"inner_elastic": 1, "hook_and_loop": 2},
    "hem": {"open": 1, "elastic": 2},
    "quilting": {"horizontal": 1, "box": 2},
    "hood": {"attached": 1, "removable": 2},
}


def shell_render_details(shell: Shell, product: GarmentSpec) -> dict[str, float]:
    """Sourced visual facts for the shader. Lengths in metres; kinds as FEATURE_CODES."""
    visual = product.visual
    if visual is None:
        return {}
    details: dict[str, float] = {}
    for name in ("chamber_height", "chamber_width", "yoke_depth", "sleeve_chamber_height"):
        measure = getattr(visual, name)
        if measure is not None:
            details[f"{name}_m"] = measure.value_cm / 100
    for name in ("storm_flap_width", "pocket_top", "pocket_length"):
        measure = getattr(visual, name)
        if measure is not None:
            details[f"{name}_m"] = measure.value_cm / 100
    for name, codes in FEATURE_CODES.items():
        details[f"{name}_kind"] = float(codes[getattr(visual, name).value])
    for side in ("L", "R"):
        grid = shell.sleeve_grids[side]
        uv_end = shell.uv[grid[-1], 1].mean()
        details[f"sleeve_{side}_length_m"] = float(uv_end)
    details["loft_m"] = product.loft_cm / 100
    return details
