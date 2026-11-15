"""Padded 3-panel hood geometry (agent H). Pure numpy; collisions come in as a callable.

Construction (one topology for every baked state, so the states are glTF morph targets):

1. **Mid-surface, worn up.** Spherical coordinates about the lateral axis through the hood's two
   front corners (where the face edge meets the neck seam): ``theta`` turns from +Z toward +Y
   (90 deg = up, 180 deg = back), ``psi`` is the latitude toward the wearer's left (+X), so
   every meridian of a side panel converges on its corner. The radius is a rounded-rectangle
   dome: a superellipse in the sagittal plane (the hood's side outline) times a superellipse
   across (flat sides, flat gusset top), pulled in to the corners near the axis.
2. **Panels.** Columns run from the right corner over the back to the left corner. The two
   gusset seams are exact columns (x = -/+ g/2 on every row), so the seam lines are mesh edges.
3. **Neck seam.** Row 0 is the reference shell's seam, blended into the dome over ``HINGE_M``.
4. **States.** Down = the up hood rolled back about the back-neck seam (a bend: the turn grows
   from 0 at the seam and at the front corners to the full angle), squeezed a little, pushed
   clear of the jacket and the body and faired. Detached (puffer) = the up hood without a head,
   its zip edge relaxed into a plane, lifted off. Peel keys blend the two column by column from
   the wearer's right, as Z's hood zip opens.
5. **Thickness.** Outer shell = mid + (T/2 + chamber puff) along the normal; lining = mid - T/2;
   a half-round bound face edge and a closed neck edge join them into one closed padded shell.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

import hood_config as cfg
import numpy as np

# A collision query: point -> (closest point, outward unit normal) or None beyond max distance.
Nearest = Callable[[np.ndarray, float], tuple[np.ndarray, np.ndarray] | None]

ZONE_OUTER, ZONE_LINING, ZONE_BINDING, ZONE_VELCRO, ZONE_ZIP = 0, 1, 2, 3, 4


def smoothstep(e0: float, e1: float, x):
    t = np.clip((np.asarray(x, dtype=float) - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def rot_x(angle: np.ndarray | float) -> np.ndarray:
    """Rotation(s) about +X; positive turns +Y toward +Z. Shape (..., 3, 3)."""
    a = np.asarray(angle, dtype=float)
    c, s = np.cos(a), np.sin(a)
    m = np.zeros(a.shape + (3, 3))
    m[..., 0, 0] = 1
    m[..., 1, 1], m[..., 1, 2] = c, -s
    m[..., 2, 1], m[..., 2, 2] = s, c
    return m


def resample(polyline: np.ndarray, params: np.ndarray) -> np.ndarray:
    """Points at normalised arc-length ``params`` (0..1) along ``polyline``."""
    seg = np.linalg.norm(np.diff(polyline, axis=0), axis=1)
    arc = np.concatenate([[0], np.cumsum(seg)]) / seg.sum()
    return np.stack([np.interp(params, arc, polyline[:, k]) for k in range(3)], axis=-1)


@dataclass
class Hood:
    style: str
    params: dict
    seam: np.ndarray  # reference seam polyline (right corner -> back -> left corner)
    columns: int = 0
    sigma: np.ndarray = field(default_factory=lambda: np.zeros(0))  # per inner column
    gusset: tuple[int, int] = (0, 0)
    states: dict[str, np.ndarray] = field(default_factory=dict)  # name -> mid grid (C, R, 3)
    # The jacket's relief beyond the collider surface (m): loft x (1 - SEAM_LOFT_FRACTION).
    jacket_relief_m: float = 0.0


# ----------------------------------------------------------------------- worn-up mid-surface
def _sagittal_radius(theta: np.ndarray, centre: np.ndarray, semi: np.ndarray, n: float):
    """Distance from the corner axis to the superellipse outline along direction theta."""
    d = np.stack([np.cos(theta), np.sin(theta)], axis=-1)  # (z, y) components
    lo = np.zeros(theta.shape)
    hi = np.full(theta.shape, 1.0)
    for _ in range(50):  # bisection: the axis lies inside the outline (checked by the caller)
        mid = (lo + hi) / 2
        p = d * mid[..., None] - centre
        inside = (np.abs(p[..., 0] / semi[0]) ** n + np.abs(p[..., 1] / semi[1]) ** n) < 1
        lo = np.where(inside, mid, lo)
        hi = np.where(inside, hi, mid)
    return lo


def build_up(style: str, seam: np.ndarray) -> tuple[Hood, np.ndarray, np.ndarray]:
    """Worn-up mid-surface grid (inner columns 1..N-1, rows 0..ROWS) and the corner origin.

    Pattern-true construction. Seen from the side, a hood's side panel is a fan around its
    front corner K: the neck seam leaves K toward the back of the neck, the face edge rises from
    K to the forehead and the gusset seam closes the fan along the hood's side outline. So a row
    is a "spoke" from K (row 0 = the neck seam, the last row = the face edge) and a side-panel
    column is the ring at a fixed fraction t of the way from K to the gusset seam. The side wall
    bulges out to the hood's half-width and rolls in to the gusset seam at x = -/+ g/2; the
    gusset is a band over the outline, x = u g/2, crowned outward by ``GUSSET_CROWN``.
    """
    p = cfg.HOODS[style]
    hood = Hood(style, p, seam)
    side, gus, rows = cfg.SIDE_COLUMNS, cfg.GUSSET_COLUMNS, cfg.ROWS
    n_cols = 2 * side + gus
    hood.columns = n_cols
    corner = (seam[0] + seam[-1]) / 2
    xk = abs(seam[-1][0] - seam[0][0]) / 2
    o = p["outline"]
    centre = np.array(
        [(o["z_back"] + o["z_front"]) / 2 - corner[2], (o["y_top"] + o["y_bottom"]) / 2 - corner[1]]
    )
    semi = np.array([(o["z_front"] - o["z_back"]) / 2, (o["y_top"] - o["y_bottom"]) / 2])
    ns = p["outline_exponent"]
    if (np.abs(centre / semi) ** ns).sum() >= 1:
        raise ValueError(f"{style}: the hood corner lies outside the hood outline")
    a = p["half_width_m"]
    g2 = p["gusset_width_m"] / 2

    # Seam parameter of each inner column: gusset seams where the seam crosses x = -/+ g/2
    # (searched outward from the back centre), side columns evenly in arc length.
    fine = np.linspace(0, 1, 4001)
    s_pts = resample(seam, fine)
    centre_i = int(np.argmin(np.abs(s_pts[:, 0])))
    right = centre_i - int(np.argmax(np.abs(s_pts[centre_i::-1, 0]) >= g2))
    left = centre_i + int(np.argmax(np.abs(s_pts[centre_i:, 0]) >= g2))
    sg_r, sg_l = fine[right], fine[left]
    j = np.arange(1, n_cols)
    sigma = np.where(
        j <= side,
        sg_r * j / side,
        np.where(
            j <= side + gus,
            sg_r + (sg_l - sg_r) * (j - side) / gus,
            sg_l + (1 - sg_l) * (j - side - gus) / side,
        ),
    )
    hood.sigma = sigma
    hood.gusset = (side, side + gus)
    s_col = resample(seam, sigma)

    # Side view (z, y) relative to K. The neck spoke ends at the gusset seam's foot G0.
    g0 = (s_pts[right] + s_pts[left]) / 2
    theta_n = np.arctan2(g0[1] - corner[1], g0[2] - corner[2])
    theta_f = np.radians(p["face_angle_deg"])
    tau = np.linspace(0, 1, rows + 1)
    theta = theta_n + (theta_f - theta_n) * tau
    big_r = _sagittal_radius(theta, centre, semi, ns)
    # The outline passes through G0 exactly; the correction fades over the first third.
    big_r = big_r + (np.hypot(g0[1] - corner[1], g0[2] - corner[2]) - big_r[0]) * (
        1 - smoothstep(0.0, 0.35, tau)
    )
    dirs = np.stack([np.cos(theta), np.sin(theta)], axis=-1)  # (rows+1, 2) as (z, y)

    jj = j.astype(float)
    t_side = np.where(jj <= side, jj / side, np.where(jj >= side + gus, (n_cols - jj) / side, 1.0))
    u_gus = np.clip(-1 + 2 * (jj - side) / gus, -1, 1)
    in_gusset = (jj > side) & (jj < side + gus)
    sign = np.where(jj < side + gus / 2, -1.0, 1.0)
    # Side-panel half-width across t: rises from the corner, wall at a, rolls in to g/2.
    rise = 1 - (1 - np.clip(t_side / cfg.SIDE_RISE_T, 0, 1)) ** 2
    roll = np.clip((t_side - cfg.SIDE_ROLL_T) / (1 - cfg.SIDE_ROLL_T), 0, 1)
    wall = xk + (a - xk) * rise
    x_side = g2 + (wall - g2) * np.sqrt(np.clip(1 - roll**2, 0, 1))
    x_side = np.where(roll > 0, x_side, wall)
    x = np.where(in_gusset, u_gus * g2, sign * x_side)[:, None] * np.ones((1, rows + 1))
    # Toward the face edge the opening is a little narrower than the wall.
    x = x * (1 - p["face_narrowing"] * smoothstep(0.6, 1.0, tau))[None, :]
    radial = np.where(in_gusset, 1.0, t_side)[:, None] * big_r[None, :]
    crown = cfg.GUSSET_CROWN * (1 - u_gus**2)[:, None] * np.where(in_gusset, 1.0, 0.0)[:, None]
    radial = radial + crown * smoothstep(0.0, 0.3, tau)[None, :]
    zy = radial[..., None] * dirs[None, :, :]
    mid = np.stack([x, corner[1] + zy[..., 1], corner[2] + zy[..., 0]], axis=-1)

    # Neck seam: row 0 = the reference seam; the offset fades over the hinge band.
    arc = column_arc(mid)
    fade = 1 - smoothstep(0.0, hinge(hood), arc)
    mid = mid + (s_col - mid[:, 0])[:, None, :] * fade[..., None]
    mid = fair(mid, iterations=10, fixed_rows=(0, rows))
    return hood, mid, corner


def hinge(hood: Hood) -> float:
    """Seam blend band (m of material arc from the neck seam) for this hood."""
    return hood.params.get("hinge_m", cfg.HINGE_M)


def column_arc(grid: np.ndarray) -> np.ndarray:
    """Material arc (m) along each column from the neck seam (row 0)."""
    seg = np.linalg.norm(np.diff(grid, axis=1), axis=2)
    return np.concatenate([np.zeros((grid.shape[0], 1)), np.cumsum(seg, axis=1)], axis=1)


def row_arc(grid: np.ndarray, centre_col: int) -> np.ndarray:
    """Signed material arc (m) across each row from the centre column."""
    seg = np.linalg.norm(np.diff(grid, axis=0), axis=2)
    cum = np.concatenate([np.zeros((1, grid.shape[1])), np.cumsum(seg, axis=0)], axis=0)
    return cum - cum[centre_col][None, :]


def fair(grid: np.ndarray, iterations: int, fixed_rows=(0,), weight=None) -> np.ndarray:
    """Taubin (lambda|mu) smoothing on the grid; fixed rows and the end columns stay put."""
    g = grid.copy()
    free = np.ones(g.shape[:2])
    for r in fixed_rows:
        free[:, r] = 0
    free[0, :] = free[-1, :] = 0
    if weight is not None:
        free = free * weight
    for _ in range(iterations):
        for factor in (0.5, -0.53):
            lap = np.zeros_like(g)
            lap[1:-1, 1:-1] = (g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:]) / 4 - g[
                1:-1, 1:-1
            ]
            lap[1:-1, -1] = (g[:-2, -1] + g[2:, -1]) / 2 - g[1:-1, -1]  # face edge along itself
            g = g + factor * lap * free[..., None]
    return g


def grid_normals(grid: np.ndarray, inside: np.ndarray) -> np.ndarray:
    du = np.gradient(grid, axis=0)
    dv = np.gradient(grid, axis=1)
    n = np.cross(du, dv)
    n /= np.maximum(np.linalg.norm(n, axis=2, keepdims=True), 1e-12)
    flip = np.sign(
        np.sum(n * (grid - inside), axis=2, keepdims=True).sum(axis=(0, 1), keepdims=True)
    )
    return n * flip


# ---------------------------------------------------------------------------------- states
def soft_scale(d: np.ndarray, keep: float, width: float) -> np.ndarray:
    """d below 0 unchanged, above 0 scaled by ``keep``, with a smooth (softplus) knee of
    ``width``: a hard knee would leave a crease line across the hood."""
    x = -d / width
    softplus = np.where(x > 30, x, np.log1p(np.exp(np.minimum(x, 30))))
    return keep * d - (1 - keep) * width * softplus


def rotation(axis: np.ndarray, angle: np.ndarray) -> np.ndarray:
    """Rodrigues rotation matrices about unit ``axis`` (C, 3) by ``angle`` (C, R): (C, R, 3, 3)."""
    k = axis[:, None, :] * np.ones(angle.shape + (1,))
    kx = np.zeros(angle.shape + (3, 3))
    kx[..., 0, 1], kx[..., 0, 2] = -k[..., 2], k[..., 1]
    kx[..., 1, 0], kx[..., 1, 2] = k[..., 2], -k[..., 0]
    kx[..., 2, 0], kx[..., 2, 1] = -k[..., 1], k[..., 0]
    s, c = np.sin(angle)[..., None, None], np.cos(angle)[..., None, None]
    return np.eye(3) + s * kx + (1 - c) * (kx @ kx)


def fold_about_seam(mid: np.ndarray, angle: np.ndarray) -> np.ndarray:
    """Fold every column about the zip tangent at its own seam point, its upward part tipping
    outward (away from the neck)."""
    seam = mid[:, 0]
    tangent = np.gradient(seam, axis=0)
    tangent /= np.linalg.norm(tangent, axis=1, keepdims=True)
    outward = seam - seam.mean(axis=0)
    outward[:, 1] = 0
    outward /= np.maximum(np.linalg.norm(outward, axis=1, keepdims=True), 1e-9)
    up_turn = np.cross(tangent, np.array([0.0, 1.0, 0.0]))  # where +Y goes for a +angle turn
    axis = tangent * np.sign(np.sum(up_turn * outward, axis=1, keepdims=True))
    rot = rotation(axis, angle)
    return seam[:, None, :] + np.einsum("crij,crj->cri", rot, mid - seam[:, None, :])


def bend_back(
    hood: Hood,
    mid: np.ndarray,
    angle_deg: float,
    squeeze: float,
    head_back_z: float | None = None,
    depth_keep: float = 1.0,
    height_keep: float = 1.0,
    top_squeeze: float = 0.0,
) -> np.ndarray:
    """Hood down: roll back about the back-neck seam, then let the front fall back.

    The turn fades to 0 at the seam (hinge band) and right at the front corners, so the attached
    seam and the corners stay. Without a head inside, the hood's front half falls back: every
    point in front of the plane just behind the head (``head_back_z``) keeps only
    ``depth_keep`` of its distance in front of it, so the rim runs back from the front corners
    along the collar sides, and the height above the neck seam is kept by ``height_keep``. The
    worn dome becomes the cushion that stands behind the neck in the videos.
    """
    arc = column_arc(mid)
    w_tau = smoothstep(0.0, hinge(hood), arc)
    ramp = hood.params.get("corner_ramp", (0.015, 0.16))
    w_sigma = smoothstep(ramp[0], ramp[1], np.minimum(hood.sigma, 1 - hood.sigma))[:, None]
    w = w_tau * w_sigma
    pivot = resample(hood.seam, np.array([0.5]))[0]
    rel = mid - pivot
    tau = np.linspace(0, 1, mid.shape[1])[None, :]
    rel[..., 0] *= 1 - squeeze * tau**2 * w_sigma
    # Gravity: away from the seam the hood droops further (its far end rests on the back).
    droop = hood.params.get("down_droop_deg", 0.0)
    if droop:
        span = hood.params["down_droop_arc_m"]
        extra = droop * smoothstep(span[0], span[1], arc) * w_sigma
    else:
        extra = 0.0
    angle = np.radians(angle_deg) * w + np.radians(extra)
    if hood.params.get("hinge_axis") == "seam":
        # Each column folds about its own stretch of the zip (the seam tangent), tipping outward
        # and back the way a collar turns over: the sides fall away from the face instead of
        # rising in front of a single back pivot.
        out = fold_about_seam(mid, angle)
    else:
        rel = np.einsum("crij,crj->cri", rot_x(-angle), rel)
        out = pivot + rel
    if head_back_z is not None:
        # The short corner columns are squeezed most by the collapse (crimps): fade it there.
        cr = hood.params.get("collapse_corner_ramp", 0.0)
        if cr > 0:
            w_tau = w_tau * smoothstep(0.0, cr, np.minimum(hood.sigma, 1 - hood.sigma))[:, None]
        z = out[..., 2]
        z_new = head_back_z + soft_scale(z - head_back_z, depth_keep, cfg.COLLAPSE_SOFT_M)
        out[..., 2] = z + (z_new - z) * w_tau
        y = out[..., 1]
        # Near the zip ends the hood lies along the collar top: less height kept there.
        keep = np.clip(
            height_keep - hood.params.get("down_corner_drop", 0.0) * (1 - w_sigma), 0.15, 1
        )
        y_new = pivot[1] + soft_scale(y - pivot[1], keep, cfg.COLLAPSE_SOFT_M)
        out[..., 1] = y + (y_new - y) * w_tau
        # No head holds the sides apart: they fall in toward the top, and (side_keep) together.
        rise = smoothstep(0.0, 0.14, out[..., 1] - pivot[1])
        side_keep = hood.params.get("down_side_keep", 1.0)
        lateral = (1 - top_squeeze * rise) * (1 - (1 - side_keep) * w_tau)
        out[..., 0] = pivot[0] + (out[..., 0] - pivot[0]) * (1 - (1 - lateral) * w_tau)
    return out


def diffuse(field: np.ndarray, iterations: int) -> np.ndarray:
    """Heat-diffuse a per-vertex field over the grid (zero-flux edges: every row and column,
    the face edge and the corners included, is smoothed)."""
    f = field.copy()
    for _ in range(iterations):
        p = np.pad(f, ((1, 1), (1, 1), (0, 0)), mode="edge")
        f = f + 0.5 * ((p[:-2, 1:-1] + p[2:, 1:-1] + p[1:-1, :-2] + p[1:-1, 2:]) / 4 - f)
    return f


def push_clear(
    hood: Hood, mid: np.ndarray, colliders: list[Nearest], inside: np.ndarray, rounds: int = 24
) -> np.ndarray:
    """Push the mid-surface out of the jacket and the body (clearance + half thickness).

    The clearance grows from zero at the seam (the hood is sewn/zipped on there and its edge is
    thin) to the full value. The push field is diffused over the grid before it is applied, so a
    contact makes a broad smooth dent in the padded shell, never a crumple of single vertices;
    rounds repeat until nothing is inside. The seam row never moves.
    """
    arc = column_arc(mid)
    full = cfg.CLEARANCE_M + hood.params["thickness_m"] / 2 + hood.jacket_relief_m
    need = np.minimum(full, 0.002 + 0.5 * arc)
    weight = smoothstep(0.0, 0.02, arc)
    g = mid.copy()
    for _ in range(rounds):
        push = np.zeros_like(g)
        for c in range(g.shape[0]):
            for r in range(g.shape[1]):
                if weight[c, r] <= 0:
                    continue
                for nearest in colliders:
                    hit = nearest(g[c, r], need[c, r] + 0.05)
                    if hit is None:
                        continue
                    loc, nrm = hit
                    signed = float(np.dot(g[c, r] - loc, nrm))
                    if signed < need[c, r]:
                        push[c, r] += nrm * (need[c, r] - signed)
        if np.linalg.norm(push, axis=2).max() < 2e-4:
            break
        peak = np.linalg.norm(push, axis=2).max()
        push = diffuse(push, cfg.PUSH_DIFFUSE_ITERATIONS)
        # Broad but never weaker than half the deepest contact per round.
        push *= max(1.0, 0.5 * peak / max(np.linalg.norm(push, axis=2).max(), 1e-9))
        g = g + push * weight[..., None]
    return g


def relaxed_bowl(hood: Hood, up: np.ndarray, inside: np.ndarray) -> np.ndarray:
    """The detached hood standing on its zip edge: the zip edge relaxes into its best-fit plane,
    the crown settles a little and the sides fall in (no head), then it takes the down angle
    and is lifted clear of the collar."""
    p = hood.params
    seam_row = up[:, 0]
    c = seam_row.mean(axis=0)
    _, _, vt = np.linalg.svd(seam_row - c)
    normal = vt[2] if vt[2][1] > 0 else -vt[2]
    flat = seam_row - np.outer((seam_row - c) @ normal, normal)
    arc = column_arc(up)
    fade = 1 - smoothstep(0.0, hinge(hood) * 1.5, arc)
    g = up + (flat - seam_row)[:, None, :] * fade[..., None]
    height = (g - c) @ normal
    g = (
        g
        - normal * (p["detached_sag"] * np.clip(height / height.max(), 0, 1) ** 2)[..., None] * 0.15
    )
    # The sides fall in a little without a head (x toward the centre line, more toward the top).
    rise = smoothstep(0.0, 0.2, height)
    g[..., 0] = c[0] + (g[..., 0] - c[0]) * (1 - p["detached_squeeze"] * rise)
    # A detached hood turns as a whole (no hinge): the down lean about the zip edge's centre,
    # then lifted clear of the collar.
    pivot = resample(hood.seam, np.array([0.5]))[0]
    g = pivot + (g - pivot) @ rot_x(-np.radians(p["detached_lean_deg"])).T
    return g + np.asarray(p["detached_lift_m"])


def peel(hood: Hood, down: np.ndarray, bowl: np.ndarray, f: float) -> np.ndarray:
    """Zip opened over the fraction ``f`` from the wearer's right: columns behind the frontier
    have lifted toward the detached bowl, the rest still sit on the collar."""
    width = hood.params["peel_width"]
    front = f * (1 + width)
    lam = smoothstep(front, front - width, hood.sigma)[:, None, None]
    if hood.params.get("attached") != "bag":
        return down + (bowl - down) * lam
    # Bag -> bowl turns the hood over (hanging down -> standing up and back): blending
    # positions would shear it into a flat sheet. Each vertex's offset from its column's seam
    # point rotates instead (direction slerp, length lerp); the seam point moves linearly.
    seam_d, seam_b = down[:, :1], bowl[:, :1]
    a, b = down - seam_d, bowl - seam_b
    la, lb = np.linalg.norm(a, axis=-1, keepdims=True), np.linalg.norm(b, axis=-1, keepdims=True)
    ua, ub = a / np.maximum(la, 1e-9), b / np.maximum(lb, 1e-9)
    cos = np.clip(np.sum(ua * ub, axis=-1, keepdims=True), -1, 1)
    omega = np.arccos(cos)
    sin = np.sin(omega)
    safe = sin > 1e-4
    t = lam
    wa = np.where(safe, np.sin((1 - t) * omega) / np.where(safe, sin, 1), 1 - t)
    wb = np.where(safe, np.sin(t * omega) / np.where(safe, sin, 1), t)
    direction = wa * ua + wb * ub
    direction /= np.maximum(np.linalg.norm(direction, axis=-1, keepdims=True), 1e-9)
    return seam_d + (seam_b - seam_d) * t + direction * (la + (lb - la) * t)


Settle = Callable[[np.ndarray, np.ndarray, dict], np.ndarray]
# A drape query (Blender BVH, hood_build.drape_paths): zip points (C, 3), horizontal headings
# (C, 3), contact offset per strip and step (C, K; m), how much each strip settles onto the
# jacket per step (C,), step (m), the hood's params -> the strips' points (C, K, 3), each strip
# hanging from its zip point over the jacket and body, and the jacket's outward normal under
# each of them (C, K, 3).
Drape = Callable[
    [np.ndarray, np.ndarray, np.ndarray, np.ndarray, float, dict], tuple[np.ndarray, np.ndarray]
]
BAG_STEP_M = 0.004  # drape step along each strip (m)


def side_fraction(hood: Hood) -> np.ndarray:
    """Per inner column: the side panel's fraction t from its zip end (1 on the centre panel)."""
    side, side_gus = hood.gusset
    j = np.arange(1, hood.columns).astype(float)
    return np.where(j <= side, j / side, np.where(j >= side_gus, (hood.columns - j) / side, 1.0))


def collar_centre(seam: np.ndarray) -> np.ndarray:
    """Centre (x, z) of the circle through the zip seen from above (algebraic least squares)."""
    x, z = seam[:, 0], seam[:, 2]
    a = np.stack([x, z, np.ones_like(x)], axis=1)
    sol, *_ = np.linalg.lstsq(a, -(x**2 + z**2), rcond=None)
    return np.array([-sol[0] / 2, -sol[1] / 2])


def bag_lengths(hood: Hood, up: np.ndarray) -> dict[str, np.ndarray]:
    """Per column, how its material lays out in the bag (m along its strip; module docstring).

    ``out``: inner layer, zip to the crown fold; ``psi``: fold angle (pi = folded right back,
    0 = no fold); ``rim``: where the outer layer ends (the face edge), back up the strip. The
    material is kept: inner + fold + outer = the column's length on the worn hood, so the bag's
    depth follows from the pattern (centre panel: ~19 cm, the shoulder-blade line).
    """
    p = hood.params
    length = column_arc(up)[:, -1]
    t = side_fraction(hood)
    # The fold's radius is the shell's own (tighter, the lining's offset turns inside out:
    # crumpled wings, H2 round 12); the short corner columns are thin (build_mesh's corner
    # padding), so is their fold. From the zip ends in: the strips lie flat (no fold), then
    # their ends curl over (psi 0 -> pi over bag_fold_t, nothing coming back), then the outer
    # layer's return grows (w 0 -> 1 over bag_wing_t) to the full bag, back up to the rim. A
    # partial fold carrying a return stood the return up off the jacket as a knot (rounds 2-9,
    # 16); a full hem on the shortest strips crumpled at the zip end (rounds 13-20).
    fold = smoothstep(p["bag_fold_t"][0], p["bag_fold_t"][1], t)
    w = smoothstep(p["bag_wing_t"][0], p["bag_wing_t"][1], t)
    pad = 0.25 + 0.75 * smoothstep(0.02, cfg.CORNER_PADDING_M, length)
    r = (p["thickness_m"] * pad + p["bag_gap_m"]) / 2
    psi = np.minimum(np.pi * fold, length / r)
    rim0 = p["bag_rim_m"]
    out = np.maximum((length - psi * r + w * rim0) / (1 + w), 0.0)
    rim = out - w * (out - rim0)
    return {"length": length, "t": t, "psi": psi, "out": out, "rim": rim, "radius": r, "w": w}


def bag_headings(hood: Hood, seam_points: np.ndarray) -> np.ndarray:
    """Horizontal direction each strip heads in: its zip point's azimuth round the collar
    (0 = back) turned toward the back (``bag_heading_turn``), never forward of
    ``bag_heading_max_deg``. (H2 round 15: the zip ends' strips sent back along the collar's
    wall crossed their neighbours and crumpled.)"""
    p = hood.params
    cx, cz = collar_centre(hood.seam)
    phi = np.arctan2(seam_points[:, 0] - cx, -(seam_points[:, 2] - cz))  # 0 = back, + = left
    phi = phi * p["bag_heading_turn"]
    cap = np.radians(p["bag_heading_max_deg"])
    # Soft clamp of |phi| to the cap (smooth min with a 15 deg knee).
    k = np.radians(15.0)
    mag = cap - k * np.log1p(np.exp(np.minimum((cap - np.abs(phi)) / k, 30)))
    mag = np.where((cap - np.abs(phi)) / k > 30, np.abs(phi), mag)
    phi = np.sign(phi) * mag
    return np.stack([np.sin(phi), np.zeros_like(phi), -np.cos(phi)], axis=1)


def _laplacian(g: np.ndarray) -> np.ndarray:
    p = np.pad(g, ((1, 1), (1, 1), (0, 0)), mode="edge")
    lap = (p[:-2, 1:-1] + p[2:, 1:-1] + p[1:-1, :-2] + p[1:-1, 2:]) / 4 - g
    lap[:, 0] = 0  # the zip row never moves
    return lap


def smooth_strips(paths: np.ndarray, iterations: int, core: np.ndarray) -> np.ndarray:
    """Smooth the draped strips the way a stiff padded layer lies: each strip probes the jacket
    on its own, so a seam groove or a baffle valley under one strip leaves a dent between its
    neighbours. First the dents fill (Laplacian steps that only ever move a point outward, away
    from ``core``: the layer bridges, it never sinks), then Taubin (lambda|mu) passes across and
    along the strips take out what is left without shrinking the bag."""
    g = paths.copy()
    for _ in range(4 * iterations):
        du, dv = np.gradient(g, axis=0), np.gradient(g, axis=1)
        n = np.cross(du, dv)
        n /= np.maximum(np.linalg.norm(n, axis=2, keepdims=True), 1e-12)
        n *= np.sign(np.sum(n * (g - core), axis=2, keepdims=True))
        lap = _laplacian(g)
        out = np.maximum(np.sum(lap * n, axis=2, keepdims=True), 0.0)
        g = g + 0.5 * out * n
    for _ in range(iterations):
        for factor in (0.5, -0.53):
            g = g + factor * _laplacian(g)
    return g


def _along(paths: np.ndarray, rho: np.ndarray, step: float) -> np.ndarray:
    """Points at strip arc ``rho`` (C, R) on per-column paths (C, K, 3) sampled every ``step``."""
    k = np.clip(rho / step, 0, paths.shape[1] - 1.000001)
    i = np.floor(k).astype(int)
    f = (k - i)[..., None]
    cols = np.arange(paths.shape[0])[:, None]
    return paths[cols, i] * (1 - f) + paths[cols, i + 1] * f


def down_bag(hood: Hood, up: np.ndarray, drape: Drape) -> np.ndarray:
    """Hood down as a padded bag of its own shape (Puffer3), every column a draped strip.

    Inner layer: the strip hangs from its zip point over the jacket (``drape``: clearance + half
    thickness + jacket relief + margin off the jacket's outer surface). Crown: a padded half-round
    fold of radius (thickness + gap) / 2. Outer layer: back up the strip on top of itself, domed,
    to the face edge (the bag's mouth rim). The short columns at the zip ends fold tighter and
    run back along the collar (``bag_lengths``). Smooth by construction: no projection of the
    worn hood, no tuck, no roll.
    """
    p = hood.params
    lay = bag_lengths(hood, up)
    # Contact offset along each strip: clearance + the hood's own half thickness, tapered like
    # the shell (build_mesh: thin neck edge, thin short corner columns), plus the jacket's relief
    # and the margin, which come in between one and two bag_ramp_m from the zip (sooner, the
    # funnel collar's flared top shoves the strips back, which tips the bag's top up into a lump
    # above the collar).
    reach = float(lay["out"].max()) + 0.02
    rho = np.arange(int(round(reach / BAG_STEP_M)) + 1) * BAG_STEP_M
    taper = (
        cfg.NECK_EDGE_THICKNESS
        + (1 - cfg.NECK_EDGE_THICKNESS) * smoothstep(0.0, cfg.NECK_EDGE_RISE_M, rho)[None, :]
    ) * (0.25 + 0.75 * smoothstep(0.02, cfg.CORNER_PADDING_M, lay["length"]))[:, None]
    ramp = p["bag_ramp_m"]
    need = (
        cfg.CLEARANCE_M
        + p["thickness_m"] / 2 * taper
        + (hood.jacket_relief_m + p["bag_margin_m"]) * smoothstep(ramp, 2 * ramp, rho)[None, :]
        + p["bag_margin_low_m"] * smoothstep(*p["bag_margin_low_span_m"], rho)[None, :]
    )
    seam_points = up[:, 0]
    paths, under = drape(
        seam_points, bag_headings(hood, seam_points), need, np.zeros(len(lay["t"])), BAG_STEP_M, p
    )
    # The short strips at the zip ends all start within a few cm of each other: draped one by
    # one they fan out, fold at different lengths and cross (the crumple at the zip ends, H2
    # rounds 13-21). They hang parallel to the bag's side strip at the end of bag_parallel_t
    # instead (its path moved to their own zip point), blending into their own drape over it.
    # (A separate corner strip pulled straight back cut into the collar once moved to the zip
    # ends and crumpled, round 23.)
    t = lay["t"]
    lo, hi = p["bag_parallel_t"]
    keep = 1 - smoothstep(lo, hi, t)
    for side in (np.arange(hood.gusset[0]), np.arange(hood.gusset[1], len(t))):
        ref = side[np.argmin(np.abs(t[side] - hi))]
        shape = paths[ref] - paths[ref, :1]
        for c in side:
            paths[c] = paths[c] + (paths[c, :1] + shape - paths[c]) * keep[c]
            under[c] = under[c] + (under[ref] - under[c]) * keep[c]
    # Outward = away from the body's core (below the collar, on its axis) while smoothing; the
    # outer layer then lies on the side the jacket faces (by the core alone, it tipped up into
    # the jaw on the collar's front-sides).
    core = np.array([0.0, seam_points[:, 1].mean() - 0.2, collar_centre(hood.seam)[1]])
    paths = smooth_strips(paths, p["bag_smooth"], core)
    du = np.gradient(paths, axis=0)
    dv = np.gradient(paths, axis=1)
    n = np.cross(du, dv)
    n /= np.maximum(np.linalg.norm(n, axis=2, keepdims=True), 1e-12)
    n *= np.sign(np.sum(n * under, axis=2, keepdims=True) + 1e-9)
    n = diffuse(n, 6)
    n /= np.maximum(np.linalg.norm(n, axis=2, keepdims=True), 1e-12)
    tangent = dv / np.maximum(np.linalg.norm(dv, axis=2, keepdims=True), 1e-12)

    arc = column_arc(up)
    u = arc / arc[:, -1:] * lay["length"][:, None]  # material arc (m) of every row
    out, psi, rim, r = (lay[k][:, None] for k in ("out", "psi", "rim", "radius"))
    fold_end = out + psi * r
    inner = u <= out
    in_fold = (u > out) & (u <= fold_end)
    rho = np.where(inner, u, np.where(in_fold, out, out - (u - fold_end)))
    base = _along(paths, rho, BAG_STEP_M)
    nn = _along(n, rho, BAG_STEP_M)
    nn /= np.maximum(np.linalg.norm(nn, axis=2, keepdims=True), 1e-12)
    tt = _along(tangent, rho, BAG_STEP_M)
    # Outer layer dome: 0 at the fold and at the rim, highest midway; fading out on the side
    # panels toward the zip ends (thin corners).
    span = np.maximum(out - rim, 1e-6)
    q = np.clip((rho - rim) / span, 0, 1)
    t = lay["t"][:, None]
    dome = p["bag_dome_m"] * 4 * q * (1 - q) * smoothstep(0.3, 0.7, t)
    ang = np.clip((u - out) / np.maximum(r, 1e-9), 0, psi)
    height = np.where(inner, 0.0, np.where(in_fold, r - r * np.cos(ang), 2 * r + dome))
    slide = np.where(in_fold, r * np.sin(ang), 0.0)
    return base + nn * height[..., None] + tt * slide[..., None]


def build_states(
    style: str,
    seam: np.ndarray,
    colliders: list[Nearest],
    head_centre: np.ndarray,
    settle: Settle | None = None,
    jacket_loft_m: float = 0.0,
    drape: Drape | None = None,
) -> Hood:
    hood, up, _ = build_up(style, seam)
    hood.jacket_relief_m = jacket_loft_m * (1 - cfg.SEAM_LOFT_FRACTION)
    p = hood.params
    # Plane just behind the head (hood half thickness + clearance behind its back-most point).
    head_back = head_centre[2] - cfg.HEAD_HALF_DEPTH_M - p["thickness_m"] / 2 - cfg.CLEARANCE_M
    bag = p.get("attached") == "bag"
    if bag:
        if drape is None:
            raise NotImplementedError("the hood bag needs the drape query (Blender BVH)")
        down = down_bag(hood, up, drape)
    else:
        down = bend_back(
            hood,
            up,
            p["down_angle_deg"],
            p["down_squeeze"],
            head_back,
            p["down_depth_keep"],
            p["down_height_keep"],
            p["down_top_squeeze"],
        )
    if bag:
        # Smooth by construction and draped clear of the jacket: only a safety pass (it reports
        # how far it had to move anything; a fair would round the fold into the inner layer).
        cleared = push_clear(hood, down, colliders, head_centre, rounds=8)
        moved = float(np.linalg.norm(cleared - down, axis=2).max())
        print(f"[hood] bag clearance pass moved at most {moved * 1000:.1f} mm")
        down = cleared
    else:
        down = push_clear(hood, down, colliders, head_centre)
        down = fair(down, iterations=p.get("down_fair", cfg.FAIR_ITERATIONS), fixed_rows=(0,))
        # The corner strips are squeezed most by the collapse: fair them further.
        span = p.get("corner_fair_span", (0.04, 0.2))
        corner = 1 - smoothstep(span[0], span[1], np.minimum(hood.sigma, 1 - hood.sigma))
        down = fair(
            down,
            iterations=p.get("corner_fair", cfg.CORNER_FAIR_ITERATIONS),
            fixed_rows=(0,),
            weight=corner[:, None] * np.ones(down.shape[:2]),
        )
    if p.get("settle_frames", 0) > 0:
        if settle is None:
            raise NotImplementedError("the cloth settle needs Blender (run through hood_build.py)")
        # Pinned: the seam band (it is sewn on) fading out over the first half of the hinge.
        pin = 1 - smoothstep(0.0, hinge(hood) * 0.5, column_arc(down))
        down = settle(down, pin, p)
        down = fair(down, iterations=6, fixed_rows=(0,))
    hood.states["down"] = down
    if p["removable"]:
        bowl = relaxed_bowl(hood, up, head_centre)
        bowl = push_clear(hood, bowl, colliders, head_centre, rounds=3)
        for f in p["peel_keys"]:
            hood.states[f"peel{int(round(f * 100)):02d}"] = peel(hood, down, bowl, f)
        hood.states["detached"] = bowl
    hood.states["_up"] = up  # construction pose, for previews only (not exported)
    return hood


# ------------------------------------------------------------------------------- the shell
@dataclass
class Mesh:
    points: dict[str, np.ndarray]  # state -> (V, 3)
    faces: np.ndarray  # (F, 3)
    uv: np.ndarray  # (V, 2) material metres
    attributes: dict[str, np.ndarray]  # name -> (V,)


def _puff(hood: Hood, grid: np.ndarray, up: np.ndarray) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """Chamber relief 0..1 (1 = crown) from material distances measured on the up pose, plus
    the per-vertex line coordinates the engine draws stitches with."""
    p = hood.params
    side, side_gus = hood.gusset
    centre_col = (side + side_gus) // 2 - 1  # inner-column index of the centre
    across = row_arc(up, centre_col)
    along = column_arc(up)
    edge = along[:, -1:] - along  # from the face edge
    seam_d = np.minimum(
        np.abs(across - across[side - 1][None, :]), np.abs(across - across[side_gus - 1][None, :])
    )
    d = np.minimum(np.minimum(seam_d, along), edge)
    quilt = np.full(along.shape, -1.0)
    if p["quilt_pitch_m"] > 0:
        # Lines across both panels at constant material arc from the face edge on the gusset,
        # carried round the side panels on the same corner-axis meridian angle.
        frac = edge / np.maximum(edge[:, :1], 1e-9)  # 1 at the neck seam, 0 at the face edge
        centre_len = edge[centre_col, 0]
        quilt = frac * centre_len / p["quilt_pitch_m"]
        line = np.abs(quilt - np.round(quilt)) * p["quilt_pitch_m"]
        line = np.where((quilt > 0.5) & (quilt < centre_len / p["quilt_pitch_m"] - 0.3), line, 1.0)
        d = np.minimum(d, line)
    t = np.clip(d / p["puff_rise_m"], 0, 1)
    shape = 1 - (1 - t) ** 2
    relief = p["puff_valley"] + (1 - p["puff_valley"]) * shape
    col_index = np.arange(1, hood.columns)[:, None] * np.ones(along.shape)
    seam_cols = np.minimum(np.abs(col_index - side), np.abs(col_index - side_gus))
    return relief, {
        "quilt": quilt,
        "seamd": seam_cols,
        "edge": edge,
        "along": along,
        "across": across,
    }


def build_mesh(hood: Hood, head_centre: np.ndarray) -> Mesh:
    p = hood.params
    t_half = p["thickness_m"] / 2
    up = hood.states["_up"]
    relief, lines = _puff(hood, up, up)
    n_cols, rows = up.shape[0], up.shape[1] - 1
    rim, neck = cfg.RIM_SAMPLES, cfg.NECK_SAMPLES
    loop = (rows + 1) * 2 + rim + neck + 1  # outer, rim, lining, neck, duplicate of outer row 0
    states = [s for s in hood.states if not s.startswith("_")] + ["_up"]
    pts: dict[str, np.ndarray] = {}
    for s in states:
        g = hood.states[s]
        n = grid_normals(g, head_centre)
        if s != "_up" and np.mean(np.sum(n * (g - head_centre), axis=2)) < 0:
            n = -n
        # Thin at the neck edge (zip tape / seam allowance), full padding above it.
        taper = cfg.NECK_EDGE_THICKNESS + (1 - cfg.NECK_EDGE_THICKNESS) * smoothstep(
            0.0, cfg.NECK_EDGE_RISE_M, lines["along"]
        )
        # Bound corner tips are thin: padding fades where the column (neck to face edge) is short.
        taper = taper * (
            0.25 + 0.75 * smoothstep(0.02, cfg.CORNER_PADDING_M, lines["along"][:, -1:])
        )
        outer = g + n * ((t_half + p["puff_m"] * (relief - 1)) * taper)[..., None]
        lining = g - n * (t_half * (1 - 0.15 * (1 - relief)) * taper)[..., None]
        e_face = g[:, -1] - g[:, -2]
        e_face /= np.linalg.norm(e_face, axis=1, keepdims=True)
        e_neck = g[:, 0] - g[:, 1]
        e_neck /= np.linalg.norm(e_neck, axis=1, keepdims=True)
        h_face = t_half + p["puff_m"] * (relief[:, -1] - 1)
        phi = np.linspace(0, np.pi, rim + 2)[1:-1]
        rim_pts = (
            g[:, -1, None]
            + n[:, -1, None] * (h_face[:, None, None] * np.cos(phi)[None, :, None])
            + e_face[:, None] * (0.9 * h_face[:, None, None] * np.sin(phi)[None, :, None])
        )
        h_neck = t_half * cfg.NECK_EDGE_THICKNESS
        phi_n = np.linspace(np.pi, 2 * np.pi, neck + 2)[1:-1]
        neck_pts = (
            g[:, 0, None]
            + n[:, 0, None] * (h_neck * np.cos(phi_n - np.pi)[None, :, None] * -1)
            + e_neck[:, None] * (0.5 * h_neck * -np.sin(phi_n)[None, :, None])
        )
        ring = np.concatenate([outer, rim_pts, lining[:, ::-1], neck_pts, outer[:, :1]], axis=1)
        corner_r = hood.seam[0] if s == "_up" else g[0, 0] + (g[0, 0] - g[1, 0]) * 0.0
        corner_l = hood.seam[-1] if s == "_up" else g[-1, 0]
        # Corners: the fans meet at the seam ends, moved with the first/last columns' seam.
        corner_r = _corner(g, hood.states["_up"], hood.seam[0], side=0) if s != "_up" else corner_r
        corner_l = (
            _corner(g, hood.states["_up"], hood.seam[-1], side=-1) if s != "_up" else corner_l
        )
        pts[s] = np.concatenate([corner_r[None], ring.reshape(-1, 3), corner_l[None]])
    faces = []
    base = lambda c: 1 + c * loop  # noqa: E731
    for c in range(n_cols - 1):
        for k in range(loop - 1):
            a, b = base(c) + k, base(c) + k + 1
            d, e = base(c + 1) + k, base(c + 1) + k + 1
            faces += [(a, d, b), (b, d, e)]
    last = 1 + n_cols * loop
    for k in range(loop - 1):
        faces.append((0, base(0) + k, base(0) + k + 1))
        faces.append((last, base(n_cols - 1) + k + 1, base(n_cols - 1) + k))
    faces = np.asarray(faces, dtype=np.int64)
    # Orientation: outward on the outer shell of the up pose.
    up_pts = pts["_up"]
    tri = up_pts[faces]
    fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    outer_faces = (faces[:, 0] - 1) % loop < rows  # faces starting on the outer rows
    if np.sum(np.sum(fn[outer_faces] * (tri[outer_faces, 0] - head_centre), axis=1)) < 0:
        faces = faces[:, ::-1].copy()

    # Attributes per ring position.
    k_idx = np.arange(loop)
    zone = np.where(k_idx <= rows, ZONE_OUTER, ZONE_LINING)
    zone = np.where((k_idx > rows) & (k_idx <= rows + rim), ZONE_BINDING, zone)
    neck_start = 2 * (rows + 1) + rim
    zone = np.where(k_idx >= neck_start, ZONE_ZIP if p["removable"] else ZONE_LINING, zone)
    zone = np.where(k_idx == loop - 1, ZONE_OUTER, zone)
    edge = lines["edge"]
    edge_ring = np.concatenate(
        [
            edge,
            np.zeros((n_cols, rim)),
            edge[:, ::-1],
            np.repeat(edge[:, :1], neck, 1),
            edge[:, :1],
        ],
        axis=1,
    )
    zone_ring = np.broadcast_to(zone, (n_cols, loop)).copy()
    binding = edge_ring < p["binding_m"]
    zone_ring = np.where(binding & (zone_ring != ZONE_ZIP), ZONE_BINDING, zone_ring)

    def ring_of(values: np.ndarray, rim_value: float, neck_value=None) -> np.ndarray:
        nv = values[:, :1] if neck_value is None else np.full((n_cols, 1), neck_value)
        return np.concatenate(
            [
                values,
                np.full((n_cols, rim), rim_value),
                values[:, ::-1],
                np.repeat(nv, neck, 1),
                values[:, :1],
            ],
            axis=1,
        )

    # Seam-fit blend band (engine): wider than the fold hinge, so a graded hood gathers its
    # zip edge onto a smaller collar gently.
    blend = 1 - smoothstep(0.0, p.get("blend_m", hinge(hood)), lines["along"])
    sigma = np.broadcast_to(hood.sigma[:, None], lines["along"].shape)
    attach = np.zeros(lines["along"].shape)
    attach[:, 0] = 1
    across, along = lines["across"], lines["along"]
    v_out = along
    v_rim_end = along[:, -1:] + np.pi * p["thickness_m"] / 2
    uv_v = np.concatenate(
        [
            v_out,
            along[:, -1:] + np.linspace(0, 1, rim + 2)[None, 1:-1] * (v_rim_end - along[:, -1:]),
            v_rim_end + (along[:, -1:] - along)[:, ::-1],
            v_rim_end + along[:, -1:] + np.linspace(0, 0.02, neck)[None, :],
            -np.full((n_cols, 1), 0.0),
        ],
        axis=1,
    )
    uv_u = ring_of(across, 0.0)
    uv_u[:, rows + 1 : rows + 1 + rim] = across[:, -1:]
    attrs_ring = {
        "_zone": zone_ring.astype(float),
        "_sigma": ring_of(sigma, 0.0),
        "_blend": ring_of(blend, 0.0, 1.0),
        "_attach": ring_of(attach, 0.0, 0.0),
        "_quilt": ring_of(lines["quilt"], -1.0),
        "_seamd": ring_of(lines["seamd"], 99.0),
        "_edge": edge_ring,
    }
    attrs_ring["_sigma"][:, rows + 1 : rows + 1 + rim] = sigma[:, :1]
    # The bound face edge follows the seam fit like the face-edge row it joins (it was 0: the
    # corner tips ignored the seam blend and came off the collar on large seam corrections).
    attrs_ring["_blend"][:, rows + 1 : rows + 1 + rim] = blend[:, -1:]
    attrs = {}
    for name, values in attrs_ring.items():
        corner_value = {
            "_sigma": (0.0, 1.0),
            "_blend": (1.0, 1.0),
            "_zone": (ZONE_BINDING,) * 2,
        }.get(name, (0.0, 0.0))
        if name == "_seamd":
            corner_value = (99.0, 99.0)
        attrs[name] = np.concatenate([[corner_value[0]], values.reshape(-1), [corner_value[1]]])
    uv = np.stack([uv_u.reshape(-1), uv_v.reshape(-1)], axis=1)
    uv = np.concatenate([uv[:1] * 0 + [across[0, 0], 0], uv, [[across[-1, 0], 0]]])
    mesh = Mesh(pts, faces, uv, attrs)
    if p.get("tabs"):
        add_tabs(hood, mesh)
    return mesh


def _corner(grid: np.ndarray, up: np.ndarray, seam_end: np.ndarray, side: int) -> np.ndarray:
    """A corner moves like its neighbouring column's seam point."""
    return seam_end + (grid[side, 0] - up[side, 0])


def add_tabs(hood: Hood, mesh: Mesh) -> None:
    """Front corner tabs (puffer): rounded padded flaps hanging from each corner along the
    face edge's continuation, black velcro on the inner face of the tip."""
    p = hood.params
    length, width, thick = p["tab_length_m"], p["tab_width_m"], p["tab_thickness_m"]
    nu, nv = 14, 18  # around (rounded section) x along
    states = list(mesh.points)
    pieces = []
    # The left corner is the shell's last vertex: index it before the first tab is appended.
    last = len(mesh.points[states[0]]) - 1
    for side, corner_index in ((0, 0), (1, last)):
        new_pts = {}
        for s in states:
            g = hood.states[s]
            corner = mesh.points[s][corner_index]
            # The tab continues the zip line past its end, curving round the collar top toward
            # the front (it fastens there), lying on the collar: a spine on the circle through
            # the corner about the neck row's centre, in that row's plane.
            inner = 4 if side == 0 else -5
            centre = g[:, 0].mean(axis=0)
            tangent = corner - g[inner, 0]
            tangent /= np.linalg.norm(tangent)
            radial = corner - centre
            normal_plane = np.cross(radial, tangent)
            normal_plane /= np.linalg.norm(normal_plane)
            radius = np.linalg.norm(radial)
            along = -0.015 + np.linspace(0, 1, nv) * length
            angle = along / radius
            r_hat = radial / radius
            t_hat = np.cross(normal_plane, r_hat)
            if np.dot(t_hat, tangent) < 0:
                t_hat = -t_hat
            spine = centre + radius * (
                np.cos(angle)[:, None] * r_hat + np.sin(angle)[:, None] * t_hat
            )
            spine = spine - normal_plane * 0.006 * (along / length)[:, None]  # hangs a little
            t_dir = -np.sin(angle)[:, None] * r_hat + np.cos(angle)[:, None] * t_hat
            out_dir = (
                np.cos(angle)[:, None] * r_hat + np.sin(angle)[:, None] * t_hat
            )  # off the collar
            # Hood down too (agent H2): the zip ends stay on the collar, so the tabs lie on the
            # collar's front-top as fastened (Puffer1: two strips on the collar's front edges).
            across = np.cross(out_dir, t_dir)
            a = np.linspace(0, 2 * np.pi, nu, endpoint=False)
            b = np.linspace(0, 1, nv)
            sec = np.stack([np.cos(a), np.sin(a)], 1)
            sx = np.sign(sec[:, 0]) * np.abs(sec[:, 0]) ** 0.4 * width / 2
            sy = np.sign(sec[:, 1]) * np.abs(sec[:, 1]) ** 0.6 * thick / 2
            taper = np.sqrt(np.clip(1 - ((b - 0.5) / 0.5) ** 8, 0.0, 1.0))  # rounded ends
            pts = (
                spine[:, None, :]
                + out_dir[:, None, :] * (thick / 2 + sy[None, :, None] * taper[:, None, None])
                + across[:, None, :] * (sx[None, :, None] * (0.25 + 0.75 * taper[:, None, None]))
            )
            new_pts[s] = pts.reshape(-1, 3)
        base = len(mesh.points[states[0]])
        faces = []
        for i in range(nv - 1):
            for k in range(nu):
                a0, a1 = base + i * nu + k, base + i * nu + (k + 1) % nu
                b0, b1 = base + (i + 1) * nu + k, base + (i + 1) * nu + (k + 1) % nu
                faces += [(a0, a1, b0), (a1, b1, b0)]
        faces = np.asarray(faces)
        # Orient outward (away from the tab's own axis).
        cen = new_pts["_up"].reshape(nv, nu, 3).mean(axis=1)
        tri = np.concatenate([mesh.points["_up"], new_pts["_up"]])[faces]
        fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        ring_of_face = (faces[:, 0] - base) // nu
        if np.sum(np.sum(fn * (tri[:, 0] - cen[ring_of_face]), axis=1)) < 0:
            faces = faces[:, ::-1]
        for s in states:
            mesh.points[s] = np.concatenate([mesh.points[s], new_pts[s]])
        mesh.faces = np.concatenate([mesh.faces, faces])
        sec_inner = (sec[:, 1] < -0.3)[None, :] & (b[:, None] > 0.6)  # faces the collar
        zone = np.where(sec_inner, ZONE_VELCRO, ZONE_OUTER).reshape(-1).astype(float)
        count = nv * nu
        values = {
            "_zone": zone,
            "_sigma": np.full(count, float(side)),
            "_blend": np.ones(count),
            "_attach": np.zeros(count),
            "_quilt": np.full(count, -1.0),
            "_seamd": np.full(count, 99.0),
            "_edge": np.full(count, 1.0),
        }
        for k, v in values.items():
            mesh.attributes[k] = np.concatenate([mesh.attributes[k], v])
        uv = np.stack(np.meshgrid(a * width / (2 * np.pi), b * length), -1).reshape(-1, 2)
        mesh.uv = np.concatenate([mesh.uv, uv])
        pieces.append(count)
