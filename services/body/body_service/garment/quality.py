"""Independent mesh-space acceptance checks; no solver distance field is reused."""

import numpy as np
import trimesh

from .. import config
from ..surface_query import SurfaceQuery


def body_penetration(cloth: trimesh.Trimesh, body: trimesh.Trimesh) -> dict:
    points = np.vstack(
        (cloth.vertices, cloth.vertices[cloth.edges_unique].mean(1), cloth.triangles_center)
    )
    closest, distance, faces = SurfaceQuery(body).exact_closest(points)
    signed = np.einsum("ij,ij->i", points - closest, body.face_normals[faces])
    if not body.is_watertight or not body.is_winding_consistent:
        raise ValueError("Penetration audit requires a closed, consistently oriented body")
    # For an exact closest point strictly inside an oriented face, the face's
    # outward normal certifies the side. At a closest edge/vertex that sign can
    # be ambiguous: classify ALL such points by independent ray parity instead.
    bary = trimesh.triangles.points_to_barycentric(body.triangles[faces], closest)
    ambiguous = np.flatnonzero((bary <= config.CLOTH_QUALITY_BARY_EPS).any(1))
    inside = signed < 0
    for start in range(0, len(ambiguous), 2048):
        ids = ambiguous[start : start + 2048]
        inside[ids] = body.contains(points[ids])
    depths = distance[inside]
    return {
        "sample_count": len(points),
        "boundary_ray_samples": len(ambiguous),
        "inside_samples": int(inside.sum()),
        "max_inside_depth_cm": float(depths.max() * 100) if len(depths) else 0,
        "min_signed_gap_cm": float(signed.min() * 100),
    }


def panel_crossings(cloth: trimesh.Trimesh, panels: np.ndarray) -> dict[str, int]:
    """Finite edge/triangle tests in both directions, independent of particle hashes.

    Counts crossings, not penetration volume. Coplanar overlaps are not certified.
    Shared seam endpoints and triangles incident to an edge are excluded.
    """
    pairs = {"sleeve_torso": ((4, 5), (0, 1, 2, 3, 6)), "hood_back": ((7,), (2, 3, 6))}
    result = {}
    for label, (first, second) in pairs.items():
        count = 0
        groups = [
            cloth.faces[np.isin(panels[cloth.faces], group).all(1)] for group in (first, second)
        ]
        for source, target in (groups, groups[::-1]):
            if not len(source) or not len(target):
                continue
            mesh = trimesh.Trimesh(cloth.vertices, target, process=False)
            edges = np.unique(
                np.sort(source[:, [[0, 1], [1, 2], [2, 0]]].reshape(-1, 2), 1), axis=0
            )
            for start in range(0, len(edges), 512):
                batch = edges[start : start + 512]
                origins = cloth.vertices[batch[:, 0]]
                delta = cloth.vertices[batch[:, 1]] - origins
                ends = origins + delta
                bounds = np.c_[np.minimum(origins, ends), np.maximum(origins, ends)]
                candidates = [
                    (r, f)
                    for r, box in enumerate(bounds)
                    for f in mesh.triangles_tree.intersection(box)
                ]
                if not candidates:
                    continue
                rays, faces = np.array(candidates).T
                triangles = mesh.triangles[faces]
                d = delta[rays]
                e1, e2 = triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]
                h = np.cross(d, e2)
                det = np.einsum("ij,ij->i", e1, h)
                scale = (
                    np.linalg.norm(d, axis=1)
                    * np.linalg.norm(e1, axis=1)
                    * np.linalg.norm(e2, axis=1)
                )
                valid = np.abs(det) > config.CLOTH_QUALITY_PARALLEL_EPS * scale
                inverse = np.divide(1.0, det, out=np.zeros_like(det), where=valid)
                offset = origins[rays] - triangles[:, 0]
                u = np.einsum("ij,ij->i", offset, h) * inverse
                q = np.cross(offset, e1)
                v = np.einsum("ij,ij->i", d, q) * inverse
                fraction = np.einsum("ij,ij->i", e2, q) * inverse
                distance = fraction * np.linalg.norm(d, axis=1)
                eps = config.CLOTH_QUALITY_ENDPOINT_EPS_M
                interior = (
                    (distance > eps)
                    & (distance < np.linalg.norm(d, axis=1) - eps)
                    & (u >= 0)
                    & (v >= 0)
                    & (u + v <= 1)
                )
                adjacent = (target[faces, :, None] == batch[rays, None, :]).any((1, 2))
                count += int((valid & interior & ~adjacent).sum())
        result[label] = count
    return result


def sleeve_enclosure(
    cloth: trimesh.Trimesh,
    panels: np.ndarray,
    body: trimesh.Trimesh,
    arm_faces: np.ndarray,
    route: np.ndarray,
    sleeve_panel: int,
    stations: int = 10,
) -> dict:
    """03c gate: at ``stations`` planes along the arm, the arm section lies inside the sleeve.

    Stations run from mid upper arm (bicep, where the sleeve is a closed ring beyond the
    armhole cap) to the wrist (route end). A station passes when
    every arm section point is inside the sleeve section polygon (even-odd test in-plane).
    """
    sleeve = trimesh.Trimesh(
        cloth.vertices, cloth.faces[(panels[cloth.faces] == sleeve_panel).all(1)], process=False
    )
    arm = trimesh.Trimesh(body.vertices, arm_faces, process=False)
    lengths = np.linalg.norm(np.diff(route, axis=0), axis=1)
    total = lengths.sum()
    results = []
    for t in np.linspace(0.5 * lengths[0] / total, 1.0, stations):
        distance = t * total
        segment = min(int(np.searchsorted(np.cumsum(lengths), distance)), len(lengths) - 1)
        start = np.r_[0.0, np.cumsum(lengths)][segment]
        axis = (route[segment + 1] - route[segment]) / lengths[segment]
        point = route[segment] + axis * (distance - start)
        u = np.cross(axis, [0.0, 0.0, 1.0])
        u /= np.linalg.norm(u)
        v = np.cross(axis, u)
        arm_lines = trimesh.intersections.mesh_plane(arm, axis, point)
        cloth_lines = trimesh.intersections.mesh_plane(sleeve, axis, point)
        if not len(arm_lines) or not len(cloth_lines):
            results.append({"t": float(t), "pass": False, "reason": "no section"})
            continue
        arm_points = arm_lines.reshape(-1, 3)
        arm_points = arm_points[np.linalg.norm(arm_points - point, axis=1) < 0.12]
        segments = cloth_lines.reshape(-1, 2, 3)
        near = np.linalg.norm(segments.mean(1) - point, axis=1) < 0.2
        segments = segments[near]
        inside = np.zeros(len(arm_points), bool)
        if len(segments) and len(arm_points):
            # Even-odd crossing count of a ray from each arm point along +u, in-plane.
            a = np.c_[(segments[:, 0] - point) @ u, (segments[:, 0] - point) @ v]
            b = np.c_[(segments[:, 1] - point) @ u, (segments[:, 1] - point) @ v]
            p = np.c_[(arm_points - point) @ u, (arm_points - point) @ v]
            for k, q in enumerate(p):
                straddle = (a[:, 1] > q[1]) != (b[:, 1] > q[1])
                x = a[:, 0] + (q[1] - a[:, 1]) * (b[:, 0] - a[:, 0]) / np.where(
                    b[:, 1] == a[:, 1], 1e-12, b[:, 1] - a[:, 1]
                )
                inside[k] = int(np.sum(straddle & (x > q[0]))) % 2 == 1
        results.append(
            {
                "t": float(t),
                "pass": bool(len(arm_points) and inside.all()),
                "arm_points": int(len(arm_points)),
                "outside": int((~inside).sum()),
            }
        )
    return {"stations": results, "pass": all(r["pass"] for r in results)}


def hood_rest(cloth: trimesh.Trimesh, panels: np.ndarray, landmarks: dict) -> dict:
    """03c gate: hood centroid behind the neck and below C7; nothing above the head top."""
    hood = cloth.vertices[np.unique(cloth.faces[(panels[cloth.faces] == 7).all(1)])]
    if not len(hood):
        return {"pass": True, "present": False}
    centroid = hood.mean(0)
    c7, top = np.asarray(landmarks["C7"]), np.asarray(landmarks["top_of_head"])
    result = {
        "present": True,
        "centroid_m": centroid.tolist(),
        "behind_neck": bool(centroid[2] < c7[2]),
        "below_c7": bool(centroid[1] < c7[1]),
        "max_y_m": float(hood[:, 1].max()),
        "below_head_top": bool(hood[:, 1].max() < top[1]),
    }
    result["pass"] = result["behind_neck"] and result["below_c7"] and result["below_head_top"]
    return result


# --- Padded hood (agent H) ------------------------------------------------------------------
# The kiosk draws a baked padded hood (apps/web/public/assets/hoods, scripts/blender/hood_*.py)
# instead of the shell's hood panel 7. This gate fits that GLB onto the validated shell with the
# same rule as the web engine (apps/web/src/engine/hood/hoodFit.ts) and measures every baked
# state against this body and jacket. It replaces "hood centroid below C7": the user's videos
# show both hoods, when down, standing behind the neck up to about ear height (parka 35-38 s,
# puffer 27-32 s), so a true down hood's centroid is above C7 (lead approval, 2026-11-13).
HOOD_GLB = {1: "parka.glb", 2: "puffer.glb"}  # render_details.hood_kind -> baked asset
HOOD_SEAM_LOFT_FRACTION = 0.5  # hoodConfig.ts seamLoftFraction / hood_config.SEAM_LOFT_FRACTION
HOOD_SCALE_BOUNDS = (0.85, 1.2)  # hoodConfig.ts minScale / maxScale (grading bounds)
HOOD_PEEL_WIDTH = 0.35  # hoodConfig.ts peelWidth (zip frontier width)
HOOD_KEY_POSITIONS = {"peel25": 0.25, "peel50": 0.5, "peel75": 0.75, "detached": 1.0}
HOOD_DEPTH_TOLERANCE_M = 0.002  # a vertex counts as inside / behind beyond this depth
HOOD_SHEET_MAX_DEPTH_M = 0.02  # the jacket is an open sheet (hood_config.SHEET_MAX_DEPTH_M)
HOOD_TOP_ABOVE_HEAD_MAX_M = 0.06  # the down hood's top at most this far above the head top


def _read_glb(path) -> tuple[dict, dict[str, np.ndarray], dict[str, np.ndarray]]:
    """Plain GLB reader for the baked hood: node extras, vertex attributes and morph targets."""
    import json
    import struct

    data = path.read_bytes()
    json_length = struct.unpack("<I", data[12:16])[0]
    doc = json.loads(data[20 : 20 + json_length])
    binary = data[20 + json_length + 8 :]
    sizes = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}

    def read(view_index: int, offset: int, dtype: str, count: int) -> np.ndarray:
        view = doc["bufferViews"][view_index]
        start = view.get("byteOffset", 0) + offset
        return np.frombuffer(binary, dtype=dtype, count=count, offset=start)

    def accessor(index: int) -> np.ndarray:
        acc = doc["accessors"][index]
        if acc["componentType"] != 5126:
            raise ValueError("hood GLB: expected float accessors")
        width = sizes[acc["type"]]
        if "bufferView" in acc:
            values = read(acc["bufferView"], acc.get("byteOffset", 0), "<f4", acc["count"] * width)
            values = values.reshape(acc["count"], width).astype(float)
        else:
            values = np.zeros((acc["count"], width))
        sparse = acc.get("sparse")
        if sparse:  # morph targets: only the moved vertices are stored
            kinds = {5121: "<u1", 5123: "<u2", 5125: "<u4"}
            idx = sparse["indices"]
            ids = read(
                idx["bufferView"],
                idx.get("byteOffset", 0),
                kinds[idx["componentType"]],
                sparse["count"],
            )
            val = sparse["values"]
            moved = read(
                val["bufferView"], val.get("byteOffset", 0), "<f4", sparse["count"] * width
            )
            values[ids.astype(int)] = moved.reshape(-1, width)
        return values

    primitive = doc["meshes"][0]["primitives"][0]
    attributes = {k: accessor(v) for k, v in primitive["attributes"].items()}
    names = doc["meshes"][0].get("extras", {}).get("targetNames", [])
    targets = {
        n: accessor(t["POSITION"]) for n, t in zip(names, primitive.get("targets", []), strict=True)
    }
    extras = [n["extras"]["hood"] for n in doc["nodes"] if "hood" in n.get("extras", {})]
    return json.loads(extras[0]), attributes, targets


def _read_glb_triangles(path) -> np.ndarray:
    """Triangle vertex indices (F, 3) of the baked hood's only primitive."""
    import json
    import struct

    data = path.read_bytes()
    json_length = struct.unpack("<I", data[12:16])[0]
    doc = json.loads(data[20 : 20 + json_length])
    binary = data[20 + json_length + 8 :]
    acc = doc["accessors"][doc["meshes"][0]["primitives"][0]["indices"]]
    view = doc["bufferViews"][acc["bufferView"]]
    dtype = {5121: "<u1", 5123: "<u2", 5125: "<u4"}[acc["componentType"]]
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    return np.frombuffer(binary, dtype=dtype, count=acc["count"], offset=start).reshape(-1, 3)


def _area_centroid(points: np.ndarray, triangles: np.ndarray) -> np.ndarray:
    """Area-weighted centroid of a surface: where the hood's fabric is, independent of how
    densely each part is meshed (the vertex mean is pulled toward dense small parts)."""
    tri = points[triangles]
    area = 0.5 * np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1)
    return (tri.mean(axis=1) * area[:, None]).sum(axis=0) / max(float(area.sum()), 1e-12)


def _hood_seam(asset: dict, rest: np.ndarray, panels: np.ndarray, faces: np.ndarray) -> list[int]:
    """Shell attach seam, right front first (hoodFit.ts shellSeamIds)."""
    zip_path = asset["paths"].get("hood_zip")
    if zip_path and len(zip_path) > 1:
        seam = list(zip_path)
        return seam[::-1] if rest[seam[0], 0] > rest[seam[-1], 0] else seam
    hood = panels[faces] == 7
    mixed = faces[hood.any(1) & ~hood.all(1)]
    joint = np.unique(mixed[panels[mixed] != 7])
    neck = np.asarray(asset["paths"]["neckline"])
    centre = rest[neck].mean(0)

    def angle(i: int) -> float:
        return float(np.degrees(np.arctan2(rest[i, 0] - centre[0], rest[i, 2] - centre[2])))

    corner = min(abs(angle(int(i))) for i in joint)
    kept = [int(i) for i in neck if abs(angle(int(i))) >= corner]
    return sorted(kept, key=lambda i: -angle(i) if angle(i) < 0 else 360 - angle(i))


def _resample(line: np.ndarray, params: np.ndarray) -> np.ndarray:
    seg = np.linalg.norm(np.diff(line, axis=0), axis=1)
    arc = np.concatenate([[0], np.cumsum(seg)]) / max(seg.sum(), 1e-12)
    return np.stack([np.interp(params, arc, line[:, k]) for k in range(3)], -1)


def _smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def padded_hood_rest(
    asset: dict,
    positions: np.ndarray,
    cloth: trimesh.Trimesh,
    panels: np.ndarray,
    body: trimesh.Trimesh,
) -> dict:
    """Agent H's padded hood fitted on this shell: placement and penetration of every state."""
    kind = int((asset.get("render_details") or {}).get("hood_kind", 0))
    if kind not in HOOD_GLB:
        return {"pass": True, "present": False}
    glb = config.ROOT / "apps/web/public/assets/hoods" / HOOD_GLB[kind]
    info, attrs, targets = _read_glb(glb)
    hood_triangles = _read_glb_triangles(glb)
    base = attrs["POSITION"]
    sigma, blend, attach = attrs["_SIGMA"][:, 0], attrs["_BLEND"][:, 0], attrs["_ATTACH"][:, 0]
    faces = np.asarray(cloth.faces)
    rest = np.asarray(asset["initial"], dtype=float).reshape(-1, 3)
    seam_ids = _hood_seam(asset, rest, panels, faces)
    normals = np.asarray(cloth.vertex_normals)
    lift = asset["maximum_loft_m"] * HOOD_SEAM_LOFT_FRACTION
    line = positions[seam_ids] + normals[seam_ids] * lift
    on_seam = attach > 0.5
    columns = np.unique(np.round(sigma[on_seam], 5))
    hood_seam = np.array([base[on_seam & (np.round(sigma, 5) == s)].mean(0) for s in columns])
    target = _resample(line, columns)
    # Umeyama similarity, scale clamped to the grading bounds (hoodFit.ts fitSimilarity).
    ca, cb = hood_seam.mean(0), target.mean(0)
    a, b = hood_seam - ca, target - cb
    u, s, vt = np.linalg.svd(b.T @ a)
    d = np.sign(np.linalg.det(u) * np.linalg.det(vt))
    rot = u @ np.diag([1, 1, d]) @ vt
    raw_scale = float((s[0] + s[1] + d * s[2]) / (a**2).sum())
    scale = float(np.clip(raw_scale, *HOOD_SCALE_BOUNDS))
    shift = cb - scale * rot @ ca
    residual = target - (scale * hood_seam @ rot.T + shift)
    res_v = np.stack([np.interp(sigma, columns, residual[:, k]) for k in range(3)], -1)
    # The jacket drawn with the padded hood: every shell triangle not touching panel 7.
    jacket = trimesh.Trimesh(positions, faces[~(panels[faces] == 7).any(1)], process=False)
    lm = {k: np.asarray(v) for k, v in asset["body_landmarks"].items()}
    states = {"down": base, **{n: base + t for n, t in targets.items()}}
    result: dict = {
        "present": True,
        "style": info["style"],
        "raw_scale": round(raw_scale, 4),
        "scale": round(scale, 4),
        "seam_residual_max_cm": round(float(np.linalg.norm(residual, axis=1).max() * 100), 2),
        "states": {},
    }
    away = blend <= 0.5  # outside the seam band (sewn / zipped on there)
    for name, shape in states.items():
        progress = HOOD_KEY_POSITIONS.get(name, 0.0)
        front = progress * (1 + HOOD_PEEL_WIDTH)
        lifted = _smoothstep(front, front - HOOD_PEEL_WIDTH, sigma) if progress else 0 * sigma
        pts = scale * shape @ rot.T + shift + res_v * (blend * (1 - lifted))[:, None]
        closest, _, face = SurfaceQuery(body).exact_closest(pts)
        signed = np.einsum("ij,ij->i", pts - closest, body.face_normals[face])
        inside = signed < -HOOD_DEPTH_TOLERANCE_M
        if inside.any():  # nearest points on edges/vertices: ray parity decides
            inside[inside] = body.contains(pts[inside])
        jc, _, jf = trimesh.proximity.closest_point(jacket, pts)
        offset = pts - jc
        along = np.einsum("ij,ij->i", offset, jacket.face_normals[jf])
        dist = np.linalg.norm(offset, axis=1)
        face_on = (dist <= 0.002) | (np.abs(along) >= 0.7 * dist)  # not beyond an open edge
        behind = (along < -HOOD_DEPTH_TOLERANCE_M) & (along > -HOOD_SHEET_MAX_DEPTH_M) & face_on
        # Area-weighted (agent H2): the vertex mean of H2's down bag sat up to 1 cm in front of
        # C7 on large backs because the zip ends' short columns and the velcro tabs (3.8 % of
        # the area) are meshed densely at the collar's front-sides; the fabric's centroid was
        # 1.9-2.8 cm behind C7 there (docs/STATUS.md, H2).
        centroid = _area_centroid(pts, hood_triangles)
        result["states"][name] = {
            "centroid_m": centroid.round(4).tolist(),
            "behind_c7": bool(centroid[2] < lm["C7"][2]),
            "top_minus_head_top_m": round(float(pts[:, 1].max() - lm["top_of_head"][1]), 4),
            "vertices_inside_body": int((inside & away).sum()),
            "vertices_behind_jacket": int((behind & away).sum()),
        }
    down = result["states"]["down"]
    result["pass"] = bool(
        down["behind_c7"]
        and down["top_minus_head_top_m"] <= HOOD_TOP_ABOVE_HEAD_MAX_M
        and all(
            st["vertices_inside_body"] == 0 and st["vertices_behind_jacket"] == 0
            for st in result["states"].values()
        )
    )
    return result
