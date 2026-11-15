"""Procedural sewn rest mesh. Rest tapes are paths on this mesh, never fit outputs."""

# All closures below are evaluated synchronously by brentq inside their loop.
# ruff: noqa: B023

from dataclasses import dataclass, field

import numpy as np
import trimesh
from scipy.optimize import brentq

from .. import config
from .models import GarmentSpec


@dataclass
class Pattern:
    mesh: trimesh.Trimesh
    panels: np.ndarray
    elastic: np.ndarray
    stitch: np.ndarray
    welds: np.ndarray
    tapes: dict[str, list[int]]
    landmarks: dict[str, int]
    loft: np.ndarray
    torso_grid: np.ndarray
    sleeve_grids: dict[str, np.ndarray]
    torso_reference: np.ndarray
    render_offsets: np.ndarray
    attachments: np.ndarray = field(default_factory=lambda: np.empty((0, 4), dtype=int))
    attachment_offsets: np.ndarray = field(default_factory=lambda: np.empty((0, 3)))

    def measurements(self, positions: np.ndarray | None = None) -> dict[str, float]:
        # Tape belongs to the rendered outer rest surface. The neutral simulation
        # mesh is the unpuffed fabric base; no measurement is silently relabelled.
        p = self.reference_vertices if positions is None else positions
        return {
            name: float(np.linalg.norm(np.diff(p[path], axis=0), axis=1).sum() * 100)
            for name, path in self.tapes.items()
        }

    @property
    def reference_vertices(self) -> np.ndarray:
        return self.mesh.vertices + self.render_offsets


def perimeter(points: np.ndarray) -> float:
    return float(np.linalg.norm(points - np.roll(points, 1, axis=0), axis=1).sum())


def quilt(distance: np.ndarray, cell: float) -> np.ndarray:
    """C1 cosine chamber; zero at stitch, unit at chamber centre."""
    return (1 - np.cos(2 * np.pi * distance / cell)) * 0.5


def build_pattern(product: GarmentSpec, name: str, *, quilted: bool = True) -> Pattern:
    if product.visual is None:
        raise ValueError("Sourced visual specification is required")
    v = product.visual
    size = product.sizes[name]
    tape = {
        key: getattr(size, key).value_cm / 100
        for key in ("shoulder", "chest", "hem", "length_hps", "sleeve", "bicep")
    }
    n, rows, sleeve_rows = config.CLOTH_TORSO_N, config.CLOTH_TORSO_ROWS, config.CLOTH_SLEEVE_ROWS
    theta = np.arange(n) * 2 * np.pi / n
    front, back = n // 4, 3 * n // 4
    loft = product.loft_cm / 100
    neck_radius = config.CLOTH_NECK_INNER_RADIUS_M + (loft if quilted else 0)
    vertices, panels, elastic, stitch, lofts, faces, welds = [], [], [], [], [], [], []
    render_offsets = []
    tapes, landmarks, sleeve_grids = {}, {}, {}

    def append(points, panel, gather=0, seam=0, thickness=0, displacement=None):
        ids = list(range(len(vertices), len(vertices) + len(points)))
        vertices.extend(points)
        panels.extend(np.broadcast_to(panel, len(ids)))
        elastic.extend(np.broadcast_to(gather, len(ids)))
        stitch.extend(np.broadcast_to(seam, len(ids)))
        lofts.extend(np.broadcast_to(thickness, len(ids)))
        render_offsets.extend(
            np.zeros((len(ids), 3))
            if displacement is None
            else np.broadcast_to(displacement, (len(ids), 3))
        )
        return ids

    def bridge(a, b, closed=True):
        for i in range(len(a) if closed else len(a) - 1):
            j = (i + 1) % len(a)
            faces.extend(((a[i], b[i], b[j]), (a[i], b[j], a[j])))

    # Elliptical torso sections. The shoulder row is straight seam-to-seam tape.
    # Lower ring perimeters match outer laid-flat x2 tapes; no body inflation here.
    shoulder_depth = config.CLOTH_SHOULDER_DROP_M
    cap_depth = shoulder_depth + tape["bicep"] / np.pi * config.CLOTH_CAP_HEIGHT_FACTOR
    chest_depth = cap_depth + config.CLOTH_CHEST_BELOW_CAP_M
    yoke_depth = config.CLOTH_YOKE_DEPTH_M

    def torso(height):
        result, profiles, displacements = [], [], []
        for r in range(rows):
            y = -float(
                np.interp(
                    r,
                    [
                        0,
                        config.CLOTH_SHOULDER_ROW,
                        config.CLOTH_CAP_BOTTOM,
                        config.CLOTH_CHEST_ROW,
                        rows - 1,
                    ],
                    [0, shoulder_depth, cap_depth, chest_depth, height],
                )
            )
            if r <= config.CLOTH_SHOULDER_ROW:
                a = r / config.CLOTH_SHOULDER_ROW
                rx = neck_radius * (1 - a) + tape["shoulder"] / 2 * a
                rz = neck_radius * (1 - a) + yoke_depth * a
                ring = np.c_[rx * np.cos(theta), np.full(n, y), rz * np.sin(theta)]
                profile = np.zeros(n)
                puff = (
                    np.zeros((n, 3))
                    if quilted
                    else np.c_[np.cos(theta), np.zeros(n), np.sin(theta)] * loft * (1 - a)
                )
            else:
                u = max(0, (r - config.CLOTH_CHEST_ROW) / (rows - 1 - config.CLOTH_CHEST_ROW))
                target = tape["chest"] * (1 - u) + tape["hem"] * u
                depth = max(0, -y - v.yoke_depth.value_cm / 100)
                profile = quilt(np.array(depth), v.chamber_height.value_cm / 100) * np.ones(n)
                reference = (
                    quilt(
                        np.array(max(0, chest_depth - v.yoke_depth.value_cm / 100)),
                        v.chamber_height.value_cm / 100,
                    )
                    * np.ones(n)
                    * (1 - u)
                )
                if v.quilting.value == "box":
                    arc = np.abs(np.arctan2(np.cos(theta), np.sin(theta))) * target / (2 * np.pi)
                    profile *= quilt(arc, v.chamber_width.value_cm / 100)
                    reference *= quilt(arc, v.chamber_width.value_cm / 100)
                # Seam centre-front and back HPS tape stay at zero loft.
                profile[[front, back]] = 0
                reference[[front, back]] = 0
                if r >= rows - 2:
                    profile[:] = 0
                direction = np.c_[np.cos(theta), np.zeros(n), np.sin(theta)]
                raw = direction * np.array([1, 0, config.CLOTH_TORSO_ASPECT])
                radial = direction * (loft * profile[:, None])
                calibration = direction * (loft * reference[:, None])
                scale = brentq(lambda s: perimeter(raw * s + calibration) - target, 0.001, 1)
                ring = raw * scale + (radial if quilted else 0)
                puff = radial.copy()
                ring[:, 1] = y
                # Smooth sleeve-cap shoulder transition above the chest tape.
                if r < config.CLOTH_CHEST_ROW:
                    u = (r - config.CLOTH_SHOULDER_ROW) / (
                        config.CLOTH_CHEST_ROW - config.CLOTH_SHOULDER_ROW
                    )
                    upper = np.c_[
                        tape["shoulder"] / 2 * np.cos(theta),
                        np.full(n, y),
                        yoke_depth * np.sin(theta),
                    ]
                    ring = upper * (1 - u) + ring * u
                    profile *= u
                    puff *= u
            result.extend(ring)
            profiles.extend(profile)
            displacements.extend(np.zeros_like(puff) if quilted else puff)
        return np.array(result), np.array(profiles), np.array(displacements)

    # Solve actual back HPS seam length, including taper, to measured tape.
    def back_length(height):
        p, _, delta = torso(height)
        p = p + delta
        return np.linalg.norm(np.diff(p[back::n], axis=0), axis=1).sum()

    height = brentq(lambda h: back_length(h) - tape["length_hps"], chest_depth + 0.01, 2)
    points, profile, displacement = torso(height)
    gather = np.repeat(np.arange(rows) >= rows - 2, n) * float(product.hem_elastic)
    panel = np.tile(np.where(np.sin(theta) < 0, 2, np.where(np.cos(theta) > 0, 0, 1)), rows)
    panel[: (config.CLOTH_SHOULDER_ROW + 1) * n] = 3
    append(points, panel, gather, 1 - profile, profile * loft, displacement)
    span, top, bottom = (
        config.CLOTH_ARMHOLE_HALF_SPAN,
        config.CLOTH_CAP_TOP,
        config.CLOTH_CAP_BOTTOM,
    )
    cuts = {((centre + i) % n) for centre in (0, n // 2) for i in range(-span, span)}
    for r in range(rows - 1):
        for i in range(n):
            if top <= r < bottom and i in cuts:
                continue
            j = (i + 1) % n
            faces.extend(
                (
                    (r * n + i, (r + 1) * n + i, (r + 1) * n + j),
                    (r * n + i, (r + 1) * n + j, r * n + j),
                )
            )
    tapes["chest"] = [config.CLOTH_CHEST_ROW * n + i for i in range(n)] + [
        config.CLOTH_CHEST_ROW * n
    ]
    tapes["hem"] = [(rows - 1) * n + i for i in range(n)] + [(rows - 1) * n]
    tapes["length_hps"] = list(range(back, rows * n, n))
    tapes["neckline"] = list(range(n)) + [0]
    # Seam-to-seam straight tape is explicitly distinct from body shoulder arc.
    tapes["shoulder"] = [config.CLOTH_SHOULDER_ROW * n, config.CLOTH_SHOULDER_ROW * n + n // 2]
    landmarks["hem_back"] = (rows - 1) * n + back
    for side, centre in (("L", 0), ("R", n // 2)):
        sign = 1 if side == "L" else -1
        boundary = [top * n + (centre + sign * i) % n for i in range(-span, span)]
        boundary += [r * n + (centre + sign * span) % n for r in range(top, bottom)]
        boundary += [bottom * n + (centre + sign * i) % n for i in range(span, -span, -1)]
        boundary += [r * n + (centre - sign * span) % n for r in range(bottom, top, -1)]
        cap = np.array(vertices)[boundary]
        cap_reference = cap + np.array(render_offsets)[boundary]
        tapes[f"cap_{side}"] = boundary + [boundary[0]]
        count = len(boundary)
        # Circular rings from measured bicep to inferred cuff. Cuff tape not supplied:
        # use public reference wrist + explicit allowance, reported as an assumption.
        a = np.arange(count) * 2 * np.pi / count
        base = cap.mean(0)
        # Match ring angle to the cap polygon's first radial direction.
        a += np.arctan2(cap[0, 2] - base[2], cap[0, 1] - base[1])
        direction = np.c_[np.zeros(count), np.cos(a), np.sin(a)]
        radius = tape["bicep"] / (2 * count * np.sin(np.pi / count))
        cuff_radius = config.CLOTH_CUFF_INNER_M / (2 * count * np.sin(np.pi / count))
        start = span  # top seam at the measured shoulder endpoint, on the cap boundary
        reference = np.ones(count)
        reference[start] = 0
        radius = brentq(
            lambda radius: (
                perimeter(direction * (radius + loft * reference[:, None])) - tape["bicep"]
            ),
            0.001,
            0.2,
        )
        longitudinal = [boundary[start]]

        def sleeves(length, render=False):
            render = render or quilted
            cap_shape = cap_reference if render else cap
            rings = []
            for r in range(1, sleeve_rows + 1):
                t = r / sleeve_rows
                taper = max(
                    0,
                    (t - config.CLOTH_BICEP_ROW / sleeve_rows)
                    / (1 - config.CLOTH_BICEP_ROW / sleeve_rows),
                )
                rad = radius * (1 - taper) + cuff_radius * taper
                ring = base + direction * rad
                # Advance from the actual outer shoulder seam. Starting at the
                # rim centroid put the first sleeve ring behind that seam and
                # created near-zero cap edges (large artificial strain on wrap).
                ring[:, 0] = cap[start, 0] + sign * length * t
                if r < config.CLOTH_CAP_BLEND_ROWS:
                    f = r / config.CLOTH_CAP_BLEND_ROWS
                    ring = cap_shape * (1 - f) + ring * f
                    # Axial spacing must not be multiplied by the radial cap
                    # blend as well: that made the first row quadratic/tiny.
                    ring[:, 0] = cap_shape[:, 0] * (1 - f) + cap[start, 0] * f + sign * length * t
                cell = v.sleeve_chamber_height.value_cm / 100
                p = float(
                    quilt(
                        np.array(length * (t - config.CLOTH_BICEP_ROW / sleeve_rows) + cell / 2),
                        cell,
                    )
                )
                # Longitudinal outer sleeve seam is an actual zero-loft stitch path.
                local_profile = np.full(count, p)
                local_profile[start] = 0
                if r < config.CLOTH_CAP_BLEND_ROWS:
                    local_profile *= r / config.CLOTH_CAP_BLEND_ROWS
                if r >= sleeve_rows - 1:
                    local_profile[:] = 0  # compressed cuff seam/adjuster band, not a full chamber
                if render:
                    ring += direction * (loft * local_profile[:, None])
                rings.append(ring)
            return np.array(rings)

        length = brentq(
            lambda length: (
                np.linalg.norm(
                    np.diff(
                        np.vstack((cap_reference[start], sleeves(length, True)[:, start])), axis=0
                    ),
                    axis=1,
                ).sum()
                - tape["sleeve"]
            ),
            0.05,
            1.5,
        )
        rings = sleeves(length)
        reference_rings = sleeves(length, True)
        previous = boundary
        sleeve_grid = []
        for r, ring in enumerate(rings, 1):
            cell = v.sleeve_chamber_height.value_cm / 100
            local = np.full(
                count,
                float(
                    quilt(
                        np.array(
                            length * (r / sleeve_rows - config.CLOTH_BICEP_ROW / sleeve_rows)
                            + cell / 2
                        ),
                        cell,
                    )
                ),
            )
            local[start] = 0
            local *= min(1, r / config.CLOTH_CAP_BLEND_ROWS)
            if r >= sleeve_rows - 1:
                local[:] = 0  # compressed cuff band; opening remains explicitly inferred
            ids = append(
                ring,
                4 if side == "L" else 5,
                float(r >= sleeve_rows - 1),
                1 - local,
                loft * local,
                reference_rings[r - 1] - ring,
            )
            sleeve_grid.append(ids)
            bridge(previous, ids)
            if r == config.CLOTH_BICEP_ROW:
                tapes[f"bicep_{side}"] = ids + [ids[0]]
                if side == "L":
                    tapes["bicep"] = ids + [ids[0]]
            longitudinal.append(ids[start])
            previous = ids
        tapes[f"sleeve_{side}"] = longitudinal
        tapes[f"cuff_{side}"] = previous + [previous[0]]
        landmarks[f"seam_{side}"] = boundary[start]
        landmarks[f"cuff_{side}"] = previous[start]
        sleeve_grids[side] = np.array(sleeve_grid)
    # Collar/stand, independent panel welded to neckline, open at centre-front.
    collar = []
    for row in range(config.CLOTH_COLLAR_ROWS):
        ring = np.array(vertices[:n]) + [
            0,
            config.GARMENT_COLLAR_HEIGHT_M * row / (config.CLOTH_COLLAR_ROWS - 1),
            0,
        ]
        ids = append(ring, 6, 0, 1, loft * 0.3, np.array(render_offsets[:n]))
        if row == 0:
            welds.extend(zip(ids, range(n), strict=True))
        if collar:
            bridge(collar, ids)
        collar = ids
    # Hood: open-face ellipsoid panels, anchored only at rear neckline. The rest
    # hood starts upright; gravity and collisions determine its down-back drape.
    hood = []
    hood_root_targets = []
    torso_reference = np.array(vertices[: rows * n]).reshape(rows, n, 3)
    opening_left, opening_right = [], []
    for r in range(config.CLOTH_HOOD_ROWS):
        t = r / config.CLOTH_HOOD_ROWS
        angles = np.linspace(np.pi, 2 * np.pi, config.CLOTH_HOOD_N)
        cap = np.sqrt(max(0, np.sin(np.pi * t)))
        width = min(
            config.CLOTH_HOOD_WIDTH_M,
            neck_radius * (1 - t) + (config.CLOTH_HOOD_WIDTH_M - neck_radius * 0.5) * cap,
        )
        depth = min(
            config.CLOTH_HOOD_DEPTH_M,
            neck_radius * (1 - t) + (config.CLOTH_HOOD_DEPTH_M - neck_radius * 0.5) * cap,
        )
        ring = np.c_[
            np.cos(angles) * width,
            np.full(len(angles), config.CLOTH_HOOD_HEIGHT_M * t),
            np.sin(angles) * depth,
        ]
        radial = ring * np.array([1, 0, 1])
        radial /= np.maximum(np.linalg.norm(radial, axis=1)[:, None], 1e-12)
        profile = (
            quilt(np.array(config.CLOTH_HOOD_HEIGHT_M * t), config.CLOTH_HOOD_CHAMBER_M)
            * np.sin(angles) ** 2
        )
        puff = radial * (loft * profile[:, None])
        if quilted:
            ring += puff
        if not quilted:
            from .back_surface import back_surface

            ring[:, 1] = config.GARMENT_COLLAR_HEIGHT_M - config.CLOTH_HOOD_HEIGHT_M * t
            additional = max(0.0, depth - neck_radius * (1 - t))
            clearance = (2 * loft + config.GARMENT_SURFACE_MARGIN_M) * min(
                1.0, r / config.CLOTH_COLLAR_ROWS
            )
            ring[:, 2] = (
                back_surface(torso_reference, ring[:, :2]) + np.sin(angles) * additional - clearance
            )
        ids = append(
            ring, 7, 0, 1 - profile, loft * profile, np.zeros_like(puff) if quilted else puff
        )
        opening_left.append(ids[0])
        opening_right.append(ids[-1])
        if r == 0:
            rear = [(n // 2 + i) % n for i in range(n // 2 + 1)]
            for j, index in enumerate(ids):
                target = rear[round(j * (len(rear) - 1) / (len(ids) - 1))]
                hood_root_targets.append(round(j * (len(rear) - 1) / (len(ids) - 1)))
                if not quilted:
                    target = collar[target]
                vertices[index] = np.array(vertices[target]).copy()
                render_offsets[index] = np.array(render_offsets[target]).copy()
                welds.append((index, target))
        if hood:
            if r == 1 and not quilted:
                rear = [collar[(n // 2 + i) % n] for i in range(n // 2 + 1)]
                for j in range(len(ids) - 1):
                    faces.append((hood[j], ids[j], ids[j + 1]))
                    chain = (
                        [hood[j]]
                        + rear[hood_root_targets[j] + 1 : hood_root_targets[j + 1]]
                        + [hood[j + 1]]
                    )
                    faces.extend(
                        (a, ids[j + 1], b) for a, b in zip(chain[:-1], chain[1:], strict=True)
                    )
            else:
                bridge(hood, ids, False)
        hood = ids
    crown_point = np.array([0.0, config.CLOTH_HOOD_HEIGHT_M, 0.0])
    if not quilted:
        crown_point[1] = config.GARMENT_COLLAR_HEIGHT_M - config.CLOTH_HOOD_HEIGHT_M
        crown_point[2] = (
            back_surface(torso_reference, crown_point[None, :2])[0]
            - 2 * loft
            - config.GARMENT_SURFACE_MARGIN_M
        )
    crown = append([crown_point], 7, 0, 1, 0)[0]
    for a, b in zip(hood[:-1], hood[1:], strict=True):
        faces.append((a, crown, b))
    opening = opening_left + [crown] + opening_right[::-1]

    # Product-specific relief strips. Each is sewn to nearby panel vertices;
    # unmeasured hardware dimensions are rendering assumptions in config.
    def strip(path, width, panel):
        pairs = []
        for index in path:
            point = np.array(vertices[index]) + [0, 0, config.CLOTH_HARDWARE_RELIEF_M]
            ids = append(
                [point + [-width / 2, 0, 0], point + [width / 2, 0, 0]],
                panel,
                0,
                1,
                0,
                np.array(render_offsets[index]),
            )
            welds.extend((i, index) for i in ids)
            if pairs:
                bridge(pairs, ids, False)
            pairs = ids

    def hardware_box(index, half_width, half_height, panel):
        point = np.array(vertices[index]) + [0, 0, config.CLOTH_HARDWARE_RELIEF_M]
        box = trimesh.creation.box(
            extents=[2 * half_width, 2 * half_height, config.CLOTH_HARDWARE_RELIEF_M]
        )
        ids = append(box.vertices + point, panel, 0, 1, 0, np.array(render_offsets[index]))
        faces.extend(np.array(ids)[box.faces].tolist())
        welds.extend((i, index) for i in ids)

    strip(list(range(front, rows * n, n)), config.CLOTH_ZIP_WIDTH_M, 8)
    hardware_box(front + n, config.CLOTH_PULL_WIDTH_M / 2, config.CLOTH_PULL_LENGTH_M / 2, 8)
    if v.front.value == "two_way_zip":
        hardware_box(
            front + (rows - 2) * n, config.CLOTH_PULL_WIDTH_M / 2, config.CLOTH_PULL_LENGTH_M / 2, 8
        )
    if v.storm_flap_width:
        strip(list(range(front, rows * n, n)), v.storm_flap_width.value_cm / 100, 9)
    if v.hood.value == "removable":
        strip(list(range(n // 2, n)), config.CLOTH_ZIP_WIDTH_M, 8)
    for side in (-1, 1):
        r0 = round(
            (v.pocket_top.value_cm / 100 if v.pocket_top else height * 0.55) / height * (rows - 1)
        )
        length = v.pocket_length.value_cm / 100 if v.pocket_length else config.CLOTH_POCKET_LENGTH_M
        path = []
        for step in range(config.CLOTH_POCKET_ROWS):
            r = min(
                rows - 1,
                r0 + round(step * length / height * (rows - 1) / (config.CLOTH_POCKET_ROWS - 1)),
            )
            slant = (
                (r - r0) // config.CLOTH_POCKET_SLANT_ROWS
                if v.pockets.value == "angled_welt"
                else 0
            )
            index = (front - side * (config.CLOTH_POCKET_ANGLE_SAMPLES + slant)) % n
            path.append(r * n + index)
        strip(path, config.CLOTH_POCKET_WELT_M, 10)
    for side, sign in (("L", 1), ("R", -1)):
        cuff_ids = tapes[f"cuff_{side}"][:-1]
        if v.cuffs.value == "hook_and_loop":
            strip(cuff_ids[: len(cuff_ids) // 3], config.CLOTH_ADJUSTER_WIDTH_M, 12)
        else:
            ring = np.array(vertices)[cuff_ids]
            centre = ring.mean(0)
            direction = ring - centre
            direction[:, 0] = 0
            direction /= np.maximum(np.linalg.norm(direction, axis=1)[:, None], 1e-12)
            inner = centre + direction * config.CLOTH_CUFF_INNER_M / (2 * np.pi)
            inner[:, 0] -= sign * config.GARMENT_BAND_HEIGHT_M
            ids = append(inner, 13, 1, 1, 0)
            bridge(cuff_ids, ids)
            tapes[f"cuff_inner_{side}"] = ids + [ids[0]]
    if v.hood.value == "attached":
        # Drawcord follows the actual face-opening cloth edge; sewn offsets,
        # sliders and bill are geometry, never a texture or trademark.
        previous = []
        for index in opening:
            point = np.array(vertices[index]) + [0, 0, config.CLOTH_HARDWARE_RELIEF_M]
            theta = np.arange(config.CLOTH_CORD_N) * 2 * np.pi / config.CLOTH_CORD_N
            ring = (
                point
                + config.CLOTH_CORD_RADIUS_M
                * np.c_[np.cos(theta), np.sin(theta), np.zeros(len(theta))]
            )
            ids = append(ring, 11, 0, 1, 0, np.array(render_offsets[index]))
            welds.extend((i, index) for i in ids)
            if previous:
                bridge(previous, ids)
            previous = ids
        for index in (opening[0], opening[-1]):
            hardware_box(
                index, config.CLOTH_TOGGLE_WIDTH_M / 2, config.CLOTH_TOGGLE_LENGTH_M / 2, 11
            )
        previous = []
        for offset in (0, config.CLOTH_BILL_DEPTH_M):
            points = []
            anchors = []
            for x in np.linspace(
                -config.CLOTH_BILL_HALF_WIDTH_M, config.CLOTH_BILL_HALF_WIDTH_M, config.CLOTH_BILL_N
            ):
                y = (
                    config.CLOTH_HOOD_HEIGHT_M
                    - config.CLOTH_BILL_ARCH_M * (x / config.CLOTH_BILL_HALF_WIDTH_M) ** 2
                )
                point = np.array([x, y, offset])
                if not quilted:
                    point = crown_point + [
                        x,
                        config.CLOTH_BILL_ARCH_M * (x / config.CLOTH_BILL_HALF_WIDTH_M) ** 2,
                        -offset,
                    ]
                anchors.append(
                    min(opening, key=lambda i: np.linalg.norm(np.array(vertices[i]) - point))
                )
                points.append(point)
            ids = append(points, 9, 0, 1, 0, np.array(render_offsets)[anchors])
            if not previous:
                welds.extend(zip(ids, anchors, strict=True))
            if previous:
                bridge(previous, ids, False)
            previous = ids
    used = np.unique(np.asarray(faces).ravel())
    remap = np.full(len(vertices), -1, dtype=int)
    remap[used] = np.arange(len(used))
    tapes = {key: remap[path].tolist() for key, path in tapes.items()}
    landmarks = {key: int(remap[index]) for key, index in landmarks.items()}
    if any(min(path) < 0 for path in tapes.values()):
        raise ValueError("Measurement path must lie on the actual sewn mesh")
    mesh = trimesh.Trimesh(np.array(vertices)[used], remap[np.array(faces)], process=False)
    # Wind outward, preserving exact vertex indexing for solver paths.
    trimesh.repair.fix_winding(mesh)
    pattern = Pattern(
        mesh,
        np.array(panels)[used],
        np.array(elastic)[used],
        np.array(stitch)[used],
        remap[np.array(welds, dtype=int)],
        tapes,
        landmarks,
        np.array(lofts)[used],
        remap[np.arange(rows * n).reshape(rows, n)],
        {side: remap[grid] for side, grid in sleeve_grids.items()},
        torso_reference,
        np.array(render_offsets)[used],
    )
    if not quilted:
        from .seams import connect_cloth

        pattern = connect_cloth(pattern)
    # Winding consistency alone does not choose the outside of an open jacket.
    # Torso +Z/front and radial XZ establish the physical exterior. Hardware is
    # independent; the legacy welded collar/hood are independent components too.
    physical = (pattern.panels <= (7 if not quilted else 5)) | (pattern.panels == 13)
    mask = physical[pattern.mesh.faces].all(1)
    torso = np.isin(pattern.panels[pattern.mesh.faces], [0, 1, 2]).all(1)
    centre = pattern.mesh.triangles_center[torso].copy()
    centre[:, 1] = 0
    if np.median(np.einsum("ij,ij->i", pattern.mesh.face_normals[torso], centre)) < 0:
        pattern.mesh.faces[mask] = pattern.mesh.faces[mask][:, [0, 2, 1]]
    return pattern
