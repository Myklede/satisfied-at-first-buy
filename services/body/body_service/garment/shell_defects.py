"""Shell look-defect gates (agent G3): shoulder flaps, inverted faces, ragged hems.

They run on the shown garment surface and the posed body only, so the same functions gate a
freshly built ``Shell`` (tests, body-grid sweep) and an exported cloth asset
(``scripts/check_realism.py``). Thresholds live in ``config`` (SHELL_GATE_*).
"""

import numpy as np
import trimesh
from scipy.spatial import ConvexHull

from .. import config
from ..surface_query import SurfaceQuery

TORSO_PANELS = (0, 1, 2, 3)
SLEEVE_PANELS = (4, 5)


def _ring_ids(path: list[int]) -> np.ndarray:
    ids = np.asarray(path, dtype=np.int64)
    return ids[:-1] if len(ids) > 1 and ids[0] == ids[-1] else ids


def shoulder_flap(
    positions: np.ndarray,
    panels: np.ndarray,
    paths: dict[str, list[int]],
    body: trimesh.Trimesh,
    query: SurfaceQuery | None = None,
) -> dict:
    """Fabric standing off the body at the shoulder/sleeve cap beyond the taped rings' ease.

    Region: torso and sleeve vertices above the chest tape ring. Every one of them lies between
    the chest ring and the bicep rings, whose body distance is the tape's ease, so none should
    stand further off the body than the larger of those rings plus SHELL_GATE_FLAP_TOL_M. A
    wing/flap is the excess (metres).
    """
    query = query if query is not None else SurfaceQuery(body)
    chest = _ring_ids(paths["chest"])
    biceps = np.r_[_ring_ids(paths["bicep_L"]), _ring_ids(paths["bicep_R"])]
    chest_y = float(positions[chest, 1].min())
    _, ring_distance, _ = query.closest(positions[np.r_[chest, biceps]])
    envelope = float(ring_distance.max())
    region = np.flatnonzero(
        np.isin(panels, TORSO_PANELS + SLEEVE_PANELS) & (positions[:, 1] > chest_y)
    )
    # Distance outside the convex hull of the body above the chest ring (plane bound): fabric
    # bridging a hollow (front armpit, between the shoulder blades) stays inside the hull and
    # is not a flap; a wing sticks out of it.
    upper = body.vertices[body.vertices[:, 1] > chest_y]
    planes = ConvexHull(upper).equations
    outside = (
        (positions[region] @ planes[:, :3].T + planes[:, 3]).max(1) if len(region) else np.zeros(1)
    )
    far = np.maximum(outside, 0.0)
    worst = int(region[int(np.argmax(far))]) if len(region) else -1
    excess = float(far.max() - envelope)
    return {
        "max_offset_m": float(far.max()),
        "envelope_m": float(envelope),
        "flap_m": excess,
        "worst_vertex": worst,
        "pass": excess <= config.SHELL_GATE_FLAP_TOL_M,
    }


def body_parts(body: trimesh.Trimesh, arm_faces: dict[str, np.ndarray]) -> dict[str, SurfaceQuery]:
    """Surface queries for the torso (body minus arms) and each arm."""
    key = np.array([1, 1 << 20, 1 << 40], dtype=np.int64)
    arms = np.vstack([np.asarray(f).reshape(-1, 3) for f in arm_faces.values()])
    torso = body.faces[~np.isin(np.sort(body.faces, axis=1) @ key, np.sort(arms, axis=1) @ key)]
    parts = {"torso": SurfaceQuery(trimesh.Trimesh(body.vertices, torso, process=False))}
    for side, faces in arm_faces.items():
        mesh = trimesh.Trimesh(body.vertices, np.asarray(faces).reshape(-1, 3), process=False)
        parts[side] = SurfaceQuery(mesh)
    return parts


def inverted_mask(
    positions: np.ndarray,
    faces: np.ndarray,
    panels: np.ndarray,
    parts: dict[str, SurfaceQuery],
) -> np.ndarray:
    """Per-face flag: torso/sleeve face turned toward the body part it covers (see
    ``inverted_faces``)."""
    face_panel = panels[faces]
    groups = {
        "torso": np.isin(face_panel, TORSO_PANELS).all(1),
        "L": (face_panel == SLEEVE_PANELS[0]).all(1),
        "R": (face_panel == SLEEVE_PANELS[1]).all(1),
    }
    result = np.zeros(len(faces), bool)
    for name, mask in groups.items():
        rows = np.flatnonzero(mask)
        if not len(rows):
            continue
        tri = positions[faces[rows]]
        centre = tri.mean(1)
        normal = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        normal /= np.maximum(np.linalg.norm(normal, axis=1, keepdims=True), 1e-15)
        closest, distance, _ = parts[name].closest(centre)
        away = (centre - closest) / np.maximum(distance[:, None], 1e-12)
        cos = np.einsum("ij,ij->i", normal, away)
        result[rows] = (cos < -config.SHELL_GATE_INVERTED_COS) & (
            distance > config.SHELL_GATE_INVERTED_MIN_GAP_M
        )
    return result


def inverted_faces(
    positions: np.ndarray,
    faces: np.ndarray,
    panels: np.ndarray,
    body: trimesh.Trimesh,
    arm_faces: dict[str, np.ndarray],
) -> dict:
    """Garment faces turned toward the body part they cover (their inside shows: dark patches,
    folded-back flaps).

    A torso panel encloses the torso and a sleeve its arm, so each face's normal points along
    (centroid - closest point on that part): torso faces against the body minus the arms, left
    and right sleeve faces against their own arm (the whole body would make the sleeve
    underside, which faces the torso, look inverted). Faces whose normal is more than
    SHELL_GATE_INVERTED_COS against that direction are counted, on torso and sleeve panels
    only (collar/hood rims are rolled edges with a legitimate inner lip). Faces within
    SHELL_GATE_INVERTED_MIN_GAP_M of the part are skipped: the direction is ill-defined there.
    The gate is on what a judge can see: the largest patch of inverted faces whose inside is
    visible from an orbiting camera (``_inside_seen``) must stay under
    SHELL_GATE_INVERTED_PATCH_M2. Creases crushed between arm and torso stay hidden.
    """
    rows = np.flatnonzero(inverted_mask(positions, faces, panels, body_parts(body, arm_faces)))
    tri = positions[faces[rows]]
    cross = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    area = np.linalg.norm(cross, axis=1) / 2
    seen = _inside_seen(positions, faces, body, rows, cross)
    largest = 0.0
    if seen.any():
        # Patches: seen inside-out faces joined by shared edges.
        sub = trimesh.Trimesh(positions, faces[rows[seen]], process=False)
        for patch in trimesh.graph.connected_components(
            sub.face_adjacency, nodes=np.arange(int(seen.sum()))
        ):
            largest = max(largest, float(area[seen][patch].sum()))
    return {
        "count": int(len(rows)),
        "area_m2": float(area.sum()),
        "seen_count": int(seen.sum()),
        "largest_patch_m2": largest,
        "faces": rows[seen][:20].tolist(),
        "pass": largest <= config.SHELL_GATE_INVERTED_PATCH_M2,
    }


def _inside_seen(
    positions: np.ndarray,
    faces: np.ndarray,
    body: trimesh.Trimesh,
    rows: np.ndarray,
    cross: np.ndarray,
) -> np.ndarray:
    """Which of the faces ``rows`` show their inside to a kiosk camera.

    Cameras orbit the standing figure (turntable): SHELL_GATE_VIEW_COUNT azimuths at each
    SHELL_GATE_VIEW_ELEVATIONS_DEG. A face shows its inside to a camera whose direction lies
    on the back side of the face normal, if a ray from the face centroid toward that camera
    hits neither the garment nor the body (an inverted fold tucked in the armpit is hidden).
    """
    if not len(rows):
        return np.zeros(0, bool)
    scene = trimesh.Trimesh(
        np.vstack((positions, body.vertices)),
        np.vstack((faces, body.faces + len(positions))),
        process=False,
    )
    normal = cross / np.maximum(np.linalg.norm(cross, axis=1, keepdims=True), 1e-15)
    centre = positions[faces[rows]].mean(1)
    seen = np.zeros(len(rows), bool)
    azimuth = np.arange(config.SHELL_GATE_VIEW_COUNT) * 2 * np.pi / config.SHELL_GATE_VIEW_COUNT
    for elevation in np.deg2rad(config.SHELL_GATE_VIEW_ELEVATIONS_DEG):
        for a in azimuth:
            view = np.array(
                [np.sin(a) * np.cos(elevation), np.sin(elevation), np.cos(a) * np.cos(elevation)]
            )
            back = (normal @ view < 0) & ~seen
            if not back.any():
                continue
            ids = np.flatnonzero(back)
            origins = centre[ids] + view * 1e-4
            hit = scene.ray.intersects_any(origins, np.tile(view, (len(ids), 1)))
            seen[ids[~hit]] = True
    return seen


def hem_ragged(
    positions: np.ndarray,
    panels: np.ndarray,
    elastic: np.ndarray,
    paths: dict[str, list[int]],
) -> dict:
    """Hem outline and elastic gathers.

    ``height_m``: vertical spread of the hem ring (a straight hem is level in the display pose).
    ``dent_m``: deepest hem vertex lying inside the chord of its two ring neighbours (seen
    from above). The hem ring is an offset of a convex body section, so its outline is convex;
    a jagged or zig-zag outline has dents. ``taut_gathered_rows``: torso rows drawn as elastic
    gathers although worn within SHELL_HEM_GATHER_MIN of the body fabric (chest ring) length:
    a stretched-out casing has no excess fabric to gather, and gathers drawn on it read as a
    frayed fringe. All three must stay within their limits.
    """
    ring = positions[_ring_ids(paths["hem"])]
    height = float(np.ptp(ring[:, 1]))
    flat = ring[:, [0, 2]]
    before, after = np.roll(flat, 1, axis=0), np.roll(flat, -1, axis=0)
    chord = after - before
    # Signed distance of each vertex outside its neighbours' chord (orientation from the area).
    area = float(np.sum(flat[:, 0] * after[:, 1] - after[:, 0] * flat[:, 1]))
    inward = np.sign(area) * (
        chord[:, 0] * (flat - before)[:, 1] - chord[:, 1] * (flat - before)[:, 0]
    )
    dent = float(max(0.0, (inward / np.maximum(np.linalg.norm(chord, axis=1), 1e-12)).max()))
    fabric = _perimeter(positions[_ring_ids(paths["chest"])])
    gathered = np.isin(panels, TORSO_PANELS) & (elastic > 0.5)
    taut = []
    for level in np.unique(np.round(positions[gathered, 1], 5)):
        row = positions[gathered & (np.abs(positions[:, 1] - level) < 5e-5)]
        if len(row) >= 3:
            worn = _perimeter(row)
            if worn > fabric * (1 - config.SHELL_HEM_GATHER_MIN) + 1e-6:
                taut.append(round(worn / fabric, 4))
    return {
        "height_m": height,
        "dent_m": dent,
        "taut_gathered_rows": taut,
        "pass": height <= config.SHELL_GATE_HEM_HEIGHT_M
        and dent <= config.SHELL_GATE_HEM_DENT_M
        and not taut,
    }


def _perimeter(points: np.ndarray) -> float:
    """Closed-ring perimeter with the points ordered by angle about their centroid."""
    rel = points[:, [0, 2]] - points[:, [0, 2]].mean(0)
    ordered = points[np.argsort(np.arctan2(rel[:, 1], rel[:, 0]))]
    return float(np.linalg.norm(ordered - np.roll(ordered, 1, axis=0), axis=1).sum())


def shell_defects(
    positions: np.ndarray,
    faces: np.ndarray,
    panels: np.ndarray,
    paths: dict[str, list[int]],
    body: trimesh.Trimesh,
    elastic: np.ndarray,
    arm_faces: dict[str, np.ndarray],
    query: SurfaceQuery | None = None,
) -> dict:
    query = query if query is not None else SurfaceQuery(body)
    report = {
        "flap": shoulder_flap(positions, panels, paths, body, query),
        "inverted": inverted_faces(positions, faces, panels, body, arm_faces),
        "hem": hem_ragged(positions, panels, elastic, paths),
    }
    report["pass"] = all(v["pass"] for v in report.values())
    return report
