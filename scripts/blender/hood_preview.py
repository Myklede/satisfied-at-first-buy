"""Quick Blender previews of the baked hood on the reference jacket and body (agent H).

Workbench renders (studio light, per-zone colours), one PNG per state and view. These are form
checks only; the look proof is the web sandbox (``docs/validation/hood-h-*.png``).
"""

from __future__ import annotations

import math
from pathlib import Path

import bpy
import hood_geometry as geo
import numpy as np
from mathutils import Vector

VIEWS = {  # azimuth (deg, 0 = from the front, 180 = from the back), elevation (deg), distance
    "back": (180, 8, 1.05),
    "back34": (145, 10, 1.05),
    "side": (90, 4, 1.05),
    "front": (0, 5, 1.05),
}


def _hex(colour: str) -> tuple[float, float, float, float]:
    rgb = [int(colour[i : i + 2], 16) / 255 for i in (1, 3, 5)]
    return (*[c**2.2 for c in rgb], 1.0)


def _material(name: str, rgba) -> bpy.types.Material:
    m = bpy.data.materials.new(name)
    m.diffuse_color = rgba
    return m


def _object(name: str, points: np.ndarray, faces, material) -> bpy.types.Object:
    from hood_build import make_object

    obj = make_object(name, points, np.asarray(faces))
    obj.data.materials.append(material)
    return obj


def render_all(style: str, ref: dict, mesh: geo.Mesh, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_cavity = True
    scene.display.shading.cavity_type = "BOTH"
    scene.display.shading.show_shadows = True
    scene.render.resolution_x, scene.render.resolution_y = 900, 900
    scene.render.film_transparent = False
    world = bpy.data.worlds.new("w")
    scene.world = world
    jacket = _object(
        "jacket",
        np.asarray(ref["jacket_points"]),
        ref["jacket_triangles"],
        _material("j", _hex(ref["colour"])),
    )
    _object(
        "body",
        np.asarray(ref["body_points"]),
        ref["body_triangles"],
        _material("b", (0.55, 0.38, 0.3, 1)),
    )
    jacket.data.materials[0].diffuse_color = tuple(c * 0.92 for c in _hex(ref["colour"])[:3]) + (1,)
    zone_colours = {
        geo.ZONE_OUTER: _hex(ref["colour"]),
        geo.ZONE_LINING: tuple(c * 0.8 for c in _hex(ref["colour"])[:3]) + (1,),
        geo.ZONE_BINDING: (0.02, 0.02, 0.02, 1) if style == "FB7675-100" else _hex(ref["colour"]),
        geo.ZONE_VELCRO: (0.02, 0.02, 0.02, 1),
        geo.ZONE_ZIP: (0.45, 0.46, 0.48, 1),
    }
    mats = [_material(f"z{z}", c) for z, c in zone_colours.items()]
    zone = mesh.attributes["_zone"]
    face_zone = np.round(zone[mesh.faces].max(axis=1)).astype(int)
    target = np.asarray(ref["seam"]).mean(axis=0) + np.array([0, 0.03, -0.05])
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 50
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    for state in [s for s in mesh.points if not s.startswith("_")] + ["_up"]:
        obj = _object(f"hood-{state}", mesh.points[state], mesh.faces, mats[0])
        for m in mats[1:]:
            obj.data.materials.append(m)
        obj.data.polygons.foreach_set("material_index", face_zone)
        for view, (az, el, dist) in VIEWS.items():
            if state == "_up" and view != "side":
                continue
            a, e = math.radians(az), math.radians(el)
            eye = target + dist * np.array(
                [math.sin(a) * math.cos(e), math.sin(e), math.cos(a) * math.cos(e)]
            )
            from hood_build import to_blender

            cam.location = Vector(to_blender(eye).tolist())
            direction = Vector(to_blender(target - eye).tolist())
            cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
            scene.render.filepath = str(out / f"{style}-{state}-{view}.png")
            bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(obj)
