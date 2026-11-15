"""Bake one padded hood to GLB (agent H). Run headless with the portable Blender:

    blender -b --factory-startup --python scripts/blender/hood_build.py -- \
        --style DQ4920-206 --ref .cache/hood --out apps/web/public/assets/hoods [--preview DIR]

Input: ``ref-<style>.json`` from ``hood_reference.py`` (the reference shell's seam, the jacket
and the body near the neck). Output: ``<name>.glb`` with

- the hood down (attached) as the base shape and, for the removable puffer hood, morph targets
  ``peel25``, ``peel50``, ``peel75`` and ``detached`` (positions only; the engine recomputes
  normals after blending);
- UV in material metres (the jacket's weave map tiles over it);
- per-vertex attributes: ``_zone`` (0 shell, 1 lining, 2 binding, 3 velcro, 4 zip tape),
  ``_sigma`` (attach-seam parameter of the vertex's column, 0 = wearer's right corner),
  ``_attach`` (1 on the attach seam row), ``_blend`` (seam-fit weight, 1 at the seam fading
  over the hinge band), ``_quilt`` (quilt line coordinate, lines at integers; -1 none),
  ``_seamd`` (columns to the nearest gusset seam, seams at 0), ``_edge`` (m from the face edge).

Blender is Z-up; the hood is built Y-up (scene frame) and stored as (x, -z, y) so the glTF
exporter's +Y-up conversion gives back the scene frame exactly.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hood_config as cfg  # noqa: E402
import hood_geometry as geo  # noqa: E402


def to_blender(p: np.ndarray) -> np.ndarray:
    return np.stack([p[..., 0], -p[..., 2], p[..., 1]], axis=-1)


def collider(points: list, triangles: list, max_depth: float = 1.0) -> geo.Nearest:
    """Closest point query on a reference surface (scene frame, outward normals).

    ``max_depth``: an open sheet (the jacket) has no inside; a point more than this behind it is
    on its far side (e.g. above the funnel collar's opening), not inside it. Points whose nearest
    feature is an edge seen side-on are beyond that edge, not in contact.
    """
    tree = BVHTree.FromPolygons([Vector(p) for p in points], [tuple(t) for t in triangles])

    def nearest(point: np.ndarray, max_distance: float):
        loc, normal, _, _ = tree.find_nearest(Vector(point.tolist()), max_distance)
        if loc is None:
            return None
        loc, normal = np.array(loc), np.array(normal)
        offset = point - loc
        along = float(np.dot(offset, normal))
        if along < -max_depth:
            return None
        # Nearest point on a sheet's open edge, seen side-on (offset mostly in the sheet's
        # plane): the point is beyond the edge, not inside.
        if np.linalg.norm(offset) > 0.002 and abs(along) < 0.7 * np.linalg.norm(offset):
            return None
        return loc, normal

    return nearest


def cloth_settle(ref: dict, grid: np.ndarray, pin: np.ndarray, params: dict) -> np.ndarray:
    """Let the padded mid-surface settle under gravity with Blender's cloth solver.

    The seam band is pinned (vertex-group weights ``pin``); the jacket's outer surface and the
    body are colliders. Very stiff bending stands in for the padding (the hood keeps its form);
    the collision distance is half the hood's thickness plus the clearance, so the lining never
    meets the jacket. Deterministic: same input, same frames, same result.
    """
    scene = bpy.context.scene
    fine = grid
    # Coarse cage (every SETTLE_STEP-th column/row, ends kept): a padded hood folds only at the
    # scale of its padding, never in 1 cm ripples; the cage's displacement is carried back to the
    # fine grid smoothly (bilinear in grid indices).
    step = cfg.SETTLE_STEP
    ci = np.unique(np.r_[np.arange(0, fine.shape[0], step), fine.shape[0] - 1])
    ri = np.unique(np.r_[np.arange(0, fine.shape[1], step), fine.shape[1] - 1])
    grid = fine[np.ix_(ci, ri)]
    pin = pin[np.ix_(ci, ri)]
    cols, rows = grid.shape[:2]
    faces = [
        (c * rows + r, (c + 1) * rows + r, (c + 1) * rows + r + 1, c * rows + r + 1)
        for c in range(cols - 1)
        for r in range(rows - 1)
    ]
    mesh = bpy.data.meshes.new("settle")
    mesh.from_pydata(to_blender(grid.reshape(-1, 3)).tolist(), [], faces)
    obj = bpy.data.objects.new("settle", mesh)
    scene.collection.objects.link(obj)
    group = obj.vertex_groups.new(name="pin")
    for i, w in enumerate(pin.reshape(-1)):
        if w > 0:
            group.add([i], float(w), "REPLACE")
    colliders = []
    for name, pts, tris in (
        ("jacket", ref["jacket_points"], ref["jacket_triangles"]),
        ("body", ref["body_points"], ref["body_triangles"]),
    ):
        c = make_object(f"collider-{name}", np.asarray(pts), np.asarray(tris))
        c.modifiers.new("collision", "COLLISION")
        c.collision.thickness_outer = 0.002
        c.collision.cloth_friction = 8.0
        colliders.append(c)
    cloth = obj.modifiers.new("cloth", "CLOTH")
    s = cloth.settings
    s.quality = 10
    s.mass = params["settle_mass_kg"] / (cols * rows)  # Blender cloth mass is per vertex
    s.air_damping = 2.0
    s.tension_stiffness = s.compression_stiffness = 60.0
    s.shear_stiffness = 30.0
    s.bending_stiffness = params["settle_bending"]
    s.bending_damping = 2.0
    s.vertex_group_mass = "pin"
    s.pin_stiffness = 5.0
    cs = cloth.collision_settings
    cs.use_collision = True
    cs.distance_min = params["thickness_m"] / 2 + cfg.CLEARANCE_M
    cs.use_self_collision = True
    cs.self_distance_min = params["thickness_m"] * 0.6
    cs.collision_quality = 4
    frames = params["settle_frames"]
    cloth.point_cache.frame_start = 1
    cloth.point_cache.frame_end = frames
    scene.frame_start, scene.frame_end = 1, frames
    for f in range(1, frames + 1):
        scene.frame_set(f)
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    co = np.zeros(len(evaluated.data.vertices) * 3)
    evaluated.data.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    coarse = np.stack([co[:, 0], co[:, 2], -co[:, 1]], axis=-1).reshape(grid.shape)
    for o in [obj, *colliders]:
        bpy.data.objects.remove(o)
    scene.frame_set(1)
    shift = coarse - grid
    # Bilinear in index space, columns then rows.
    by_col = np.stack(
        [
            np.stack(
                [np.interp(np.arange(fine.shape[0]), ci, shift[:, r, k]) for k in range(3)], -1
            )
            for r in range(len(ri))
        ],
        axis=1,
    )
    full = np.stack(
        [
            np.stack(
                [np.interp(np.arange(fine.shape[1]), ri, by_col[c, :, k]) for k in range(3)], -1
            )
            for c in range(fine.shape[0])
        ],
        axis=0,
    )
    return fine + full


def smooth_normal(
    points: np.ndarray, triangles: np.ndarray, normals: np.ndarray, loc: np.ndarray, index: int
) -> np.ndarray:
    """Vertex normals interpolated at ``loc`` (barycentric weights in triangle ``index``)."""
    tri = triangles[index]
    p0, p1, p2 = points[tri]
    v0, v1, v2 = p1 - p0, p2 - p0, loc - p0
    d00, d01, d11 = v0 @ v0, v0 @ v1, v1 @ v1
    d20, d21 = v2 @ v0, v2 @ v1
    den = d00 * d11 - d01 * d01
    w1 = (d11 * d20 - d01 * d21) / den if den else 0.0
    w2 = (d00 * d21 - d01 * d20) / den if den else 0.0
    n = (1 - w1 - w2) * normals[tri[0]] + w1 * normals[tri[1]] + w2 * normals[tri[2]]
    return n / max(np.linalg.norm(n), 1e-12)


def drape_paths(ref: dict) -> geo.Drape:
    """Strips hanging from the zip over the jacket and body (agent H2, the hood-down bag).

    Each strip leaves its zip point ``bag_leave_deg`` off straight down, outward along its
    heading, and is marched in fixed steps: gravity bends it down (``bag_gravity`` per metre),
    and a contact pushes it out along the surface's smooth normal (vertex normals interpolated
    at the closest point) to that strip's contact offset at that step (``need``, from the
    geometry: the hood's own tapered half thickness, then the padding's full offset). Within
    ``bag_rest_reach_m`` beyond that offset a strip settles ``rest`` (per strip) of the way back
    onto the jacket each step: the thin strips at the zip ends rest on the collar (without it
    they shot straight out of its flared top as stiff spikes, H2 round 17). Otherwise a strip
    keeps its direction, so the bag bridges the baffle valleys the way a stiff padded layer does
    (settling it too made the bag follow every baffle, round 18). Deterministic: no solver.
    """
    sources = []
    for pts, tris, max_depth in (
        (ref["jacket_points"], ref["jacket_triangles"], cfg.SHEET_MAX_DEPTH_M),
        (ref["body_points"], ref["body_triangles"], 1.0),
    ):
        points = np.asarray(pts, dtype=float)
        triangles = np.asarray(tris, dtype=np.int64)
        a, b, c = (points[triangles[:, k]] for k in range(3))
        face = np.cross(b - a, c - a)
        normals = np.zeros_like(points)
        for k in range(3):
            np.add.at(normals, triangles[:, k], face)
        normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
        tree = BVHTree.FromPolygons([Vector(p) for p in points], [tuple(t) for t in triangles])
        sources.append((tree, points, triangles, normals, max_depth))

    def contact(q: np.ndarray, need: float, attract: float = 0.0, reach: float = 0.0):
        """Push (vector) that takes q to ``need`` outside every surface it is closer to; with
        ``attract``, a point up to ``reach`` beyond ``need`` off the jacket is drawn that
        fraction of the way back down to it (the layer rests on the jacket under its weight)."""
        push = np.zeros(3)
        need = max(need, 0.002)
        for k, (tree, points, triangles, normals, max_depth) in enumerate(sources):
            loc, _, index, _ = tree.find_nearest(Vector(q.tolist()), need + max(reach, 0.05))
            if loc is None:
                continue
            loc = np.array(loc)
            n = smooth_normal(points, triangles, normals, loc, index)
            offset = q - loc
            along = float(offset @ n)
            if along < -max_depth:
                continue
            # Beyond a sheet's open edge seen side-on (the collar's top edge): not in contact.
            dist = float(np.linalg.norm(offset))
            if dist > 0.002 and abs(along) < 0.7 * dist and along < 0:
                continue
            if along < need:
                push += n * (need - along)
            elif k == 0 and attract > 0 and along < need + reach and dist < 1.2 * along + 1e-3:
                push -= n * (along - need) * attract
        return push

    def drape(
        starts: np.ndarray,
        headings: np.ndarray,
        need: np.ndarray,
        rest: np.ndarray,
        step: float,
        params: dict,
    ) -> tuple[np.ndarray, np.ndarray]:
        leave = np.radians(params["bag_leave_deg"])
        gravity = params["bag_gravity"] * step
        pull = params["bag_heading_pull"] * step
        rest_reach = params["bag_rest_reach_m"]
        count = need.shape[1]
        out = np.zeros((len(starts), count, 3))
        down = np.array([0.0, -1.0, 0.0])
        cx, cz = geo.collar_centre(np.asarray(starts))
        for c, (start, heading) in enumerate(zip(starts, headings, strict=True)):
            pos = np.asarray(start, dtype=float).copy()
            d = down * np.cos(leave) + heading * np.sin(leave)
            out[c, 0] = pos
            for k in range(1, count):
                # The rest of the hood holds each strip to its heading: a pull round the body
                # (the heading's part across the radial direction; none away from the body).
                radial = np.array([pos[0] - cx, 0.0, pos[2] - cz])
                radial /= max(np.linalg.norm(radial), 1e-9)
                d = d + down * gravity + (heading - (heading @ radial) * radial) * pull
                d /= np.linalg.norm(d)
                q = pos + d * step
                for i in range(4):
                    # First pass: the strip also settles onto the jacket it hangs over.
                    push = contact(q, float(need[c, k]), rest[c] if i == 0 else 0.0, rest_reach)
                    if not push.any():
                        break
                    q = q + push
                    q = pos + (q - pos) / np.linalg.norm(q - pos) * step
                d = (q - pos) / np.linalg.norm(q - pos)
                if d[1] > -0.05:  # a hanging strip never climbs
                    d[1] = -0.05
                    d /= np.linalg.norm(d)
                    q = pos + d * step
                pos = q
                out[c, k] = pos
        # The jacket's outward normal under every strip point (orients the outer layer).
        tree, points, triangles, normals, _ = sources[0]
        under = np.zeros_like(out)
        for c in range(out.shape[0]):
            for k in range(out.shape[1]):
                loc, _, index, _ = tree.find_nearest(Vector(out[c, k].tolist()), 0.5)
                if loc is not None:
                    under[c, k] = smooth_normal(points, triangles, normals, np.array(loc), index)
        return out, under

    return drape


def clear_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def make_object(name: str, points: np.ndarray, faces: np.ndarray) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(to_blender(points).tolist(), [], faces.tolist())
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    mesh.shade_smooth()
    return obj


def hood_object(name: str, mesh: geo.Mesh) -> bpy.types.Object:
    obj = make_object(name, mesh.points["down"], mesh.faces)
    me = obj.data
    uv = me.uv_layers.new(name="UVMap")
    loop_vertices = np.zeros(len(me.loops), dtype=np.int64)
    me.loops.foreach_get("vertex_index", loop_vertices)
    uv.data.foreach_set("uv", mesh.uv[loop_vertices].astype(np.float32).ravel())
    for key, values in mesh.attributes.items():
        attribute = me.attributes.new(key, "FLOAT", "POINT")
        attribute.data.foreach_set("value", values.astype(np.float32))
    states = [s for s in mesh.points if s not in ("down", "_up")]
    if states:
        obj.shape_key_add(name="Basis")
        for s in states:
            key = obj.shape_key_add(name=s)
            key.data.foreach_set("co", to_blender(mesh.points[s]).astype(np.float32).ravel())
    material = bpy.data.materials.new(name)
    obj.data.materials.append(material)
    return obj


def export_glb(obj: bpy.types.Object, path: Path) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        export_apply=False,
        export_attributes=True,
        export_morph=True,
        export_morph_normal=False,
        export_normals=True,
        export_texcoords=True,
        export_materials="PLACEHOLDER",
        export_yup=True,
        export_extras=True,
    )
    size = path.stat().st_size
    if size > cfg.MAX_GLB_BYTES:
        raise RuntimeError(f"{path.name} is {size} bytes, over the {cfg.MAX_GLB_BYTES} budget")
    print(f"[hood] wrote {path} ({size / 1e6:.2f} MB)")


def sharp_folds(grid: np.ndarray, min_cos: float = 0.5) -> int:
    """Neighbouring mid-surface quads whose normals differ by more than 60 deg (a crease or a
    ripple; a padded hood has none). The two corner columns (tiny fan quads) are excluded."""
    g = grid[2:-2]
    n = np.cross(np.diff(g, axis=0)[:, :-1], np.diff(g, axis=1)[:-1])
    n /= np.linalg.norm(n, axis=2, keepdims=True) + 1e-12
    return int(
        ((n[1:] * n[:-1]).sum(2) < min_cos).sum() + ((n[:, 1:] * n[:, :-1]).sum(2) < min_cos).sum()
    )


def gates(style: str, ref: dict, hood: geo.Hood, mesh: geo.Mesh, colliders: list) -> dict:
    """Measured checks of every baked state on the reference body (numbers, not assertions).

    - placement (down): centroid behind C7 (z), the hood's top against the head top, and the
      centroid height against C7 (the shell gate's "below C7"; the user's videos show both down
      hoods standing behind the neck up to about ear height, video 35-38 s / 27-32 s);
    - penetration: hood vertices inside the body (closed mesh) deeper than 2 mm, and lining
      vertices behind the jacket sheet deeper than 2 mm, away from the seam band;
    - smoothness: sharp folds of the mid-surface (``sharp_folds``).
    """
    lm = ref["landmarks"]
    c7, top = np.asarray(lm["C7"]), np.asarray(lm["top_of_head"])
    seam_band = mesh.attributes["_blend"] > 0.5
    out: dict = {"style": style, "reference": ref["body"], "size": ref["size"], "states": {}}
    for state, pts in mesh.points.items():
        if state.startswith("_"):
            continue
        inside_body = 0
        behind_jacket = 0
        for i, p in enumerate(pts):
            if seam_band[i]:
                continue
            for k, nearest in enumerate(colliders):
                hit = nearest(p, 0.03)
                if hit is None:
                    continue
                depth = -float(np.dot(p - hit[0], hit[1]))
                if depth > 0.002:
                    if k == 0:
                        behind_jacket += 1
                    else:
                        inside_body += 1
        centroid = pts.mean(axis=0)
        out["states"][state] = {
            "centroid_m": centroid.round(4).tolist(),
            "behind_c7": bool(centroid[2] < c7[2]),
            "centroid_above_c7_m": round(float(centroid[1] - c7[1]), 4),
            "top_minus_head_top_m": round(float(pts[:, 1].max() - top[1]), 4),
            "vertices_inside_body": inside_body,
            "vertices_behind_jacket": behind_jacket,
            "sharp_folds": sharp_folds(hood.states[state]),
            "vertices": int(len(pts)),
        }
    return out


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--style", required=True, choices=sorted(cfg.HOODS))
    parser.add_argument("--ref", default=".cache/hood")
    parser.add_argument("--out", default="apps/web/public/assets/hoods")
    parser.add_argument("--preview", default="")
    parser.add_argument(
        "--gates", default="", help="JSON file to add this hood's measured checks to"
    )
    args = parser.parse_args(argv)
    ref = json.loads((Path(args.ref) / f"ref-{args.style}.json").read_text())
    seam = np.asarray(ref["seam"], dtype=float)
    top = np.asarray(ref["landmarks"]["top_of_head"], dtype=float)
    head_centre = top - np.array([0.0, 0.10, 0.0])
    colliders = [
        collider(ref["jacket_points"], ref["jacket_triangles"], cfg.SHEET_MAX_DEPTH_M),
        collider(ref["body_points"], ref["body_triangles"]),
    ]
    clear_scene()
    hood = geo.build_states(
        args.style,
        seam,
        colliders,
        head_centre,
        settle=lambda g, pin, p: cloth_settle(ref, g, pin, p),
        jacket_loft_m=ref["loft_m"],
        drape=drape_paths(ref),
    )
    mesh = geo.build_mesh(hood, head_centre)
    name = cfg.HOODS[args.style]["name"]
    clear_scene()
    obj = hood_object(f"hood-{name}", mesh)
    obj["hood"] = json.dumps(
        {
            "style": args.style,
            "states": [s for s in mesh.points if not s.startswith("_")],
            "reference": {k: ref["body"][k] for k in ("sex", "height_cm", "weight_kg")}
            | {"size": ref["size"]},
            "reference_asset_key": ref["asset_key"],
            "removable": cfg.HOODS[args.style]["removable"],
        }
    )
    export_glb(obj, Path(args.out).resolve() / f"{name}.glb")
    if args.gates:
        report = gates(args.style, ref, hood, mesh, colliders)
        path = Path(args.gates).resolve()
        data = json.loads(path.read_text()) if path.exists() else {}
        data[args.style] = report
        path.write_text(json.dumps(data, indent=1) + "\n")
        print(f"[hood] gates {json.dumps(report['states'])}")
    if args.preview:
        import hood_preview

        bpy.data.objects.remove(obj)  # the exported object; previews add one per state
        hood_preview.render_all(args.style, ref, mesh, Path(args.preview).resolve())


if __name__ == "__main__":
    main()
