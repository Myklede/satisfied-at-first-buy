"""Reference shell data for the hood bake (agent H).

Fetches one reference body and both jackets from the local body service (127.0.0.1 only) and
writes, per jacket, what the Blender hood build needs to sit the hood on that shell:

- the shell's hood attach seam (ordered from the wearer's right round the back to the left),
  on the *displayed* surface (the shader pushes the collar out along its normal, see
  ``SEAM_LOFT_FRACTION`` in ``hood_config.py``);
- the body (head, neck, shoulders, back) and the jacket's outer surface near the neck, as
  collision references so the baked rest shapes never cross them.

Run with Blender's bundled Python (numpy, no project dependencies):

    .cache/tools/blender/x/blender-5.3.0-windows-x64/5.3/python/bin/python.exe -I \
        scripts/blender/hood_reference.py --out .cache/hood

The body service must already be running (``npm run dev`` or the sandbox); nothing is started.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hood_config as cfg  # noqa: E402

API = "http://127.0.0.1:8001"
PANEL_HOOD = 7  # shell.py panel ids (docs/requests/Z-to-L2.md, seam.ts PANEL)


def _post(path: str, payload: dict) -> dict:
    request = urllib.request.Request(
        API + path,
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=900) as response:
        return json.load(response)


def _get(path: str):
    with urllib.request.urlopen(API + path, timeout=900) as response:
        return json.load(response)


def vertex_normals(points: np.ndarray, triangles: np.ndarray) -> np.ndarray:
    a, b, c = (points[triangles[:, k]] for k in range(3))
    face = np.cross(b - a, c - a)  # area weighted
    normals = np.zeros_like(points)
    for k in range(3):
        np.add.at(normals, triangles[:, k], face)
    length = np.linalg.norm(normals, axis=1, keepdims=True)
    return normals / np.maximum(length, 1e-12)


def seam_of(asset: dict, points: np.ndarray, triangles: np.ndarray) -> list[int]:
    """Shell attach seam, right front first (same rule as apps/web/src/engine/hood/hoodFit.ts).

    Removable hood (puffer): L2's ``paths.hood_zip``. Sewn-in hood (parka): the real jacket has
    no stand collar (spec), so the hood is sewn into the neckline and covers shell.py's 6.5 cm
    collar band: ``paths.neckline`` from the front-most angle at which the hood panel joins the
    collar, round the back. No edge walk: the collar row under the hood has gaps on some bodies.
    """
    panels = np.asarray(asset["panels"])
    if "hood_zip" in asset["paths"]:
        seam = list(asset["paths"]["hood_zip"])
        return seam[::-1] if points[seam[0], 0] > points[seam[-1], 0] else seam
    hood = panels[triangles] == PANEL_HOOD
    mixed = triangles[hood.any(1) & ~hood.all(1)]
    joint = np.unique([int(v) for v in mixed.ravel() if panels[v] != PANEL_HOOD])
    if not len(joint):
        raise RuntimeError("this jacket has no hood joined to the collar")
    neck = np.asarray(asset["paths"]["neckline"])
    centre = points[neck].mean(axis=0)

    def angle(i: int) -> float:  # deg from the front, negative on the wearer's right (-X)
        return float(np.degrees(np.arctan2(points[i, 0] - centre[0], points[i, 2] - centre[2])))

    corner = min(abs(angle(int(i))) for i in joint)
    kept = [int(i) for i in neck if abs(angle(int(i))) >= corner]
    return sorted(kept, key=lambda i: -angle(i) if angle(i) < 0 else 360 - angle(i))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=".cache/hood")
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    ref = cfg.REFERENCE_BODY
    body = _post(
        "/body/fit",
        {
            "sex": ref["sex"],
            "height_cm": ref["height_cm"],
            "weight_kg": ref["weight_kg"],
            "shape_reference": "neutral",
            "density_kg_m3": _get("/body/capabilities")["default_density_kg_m3"],
            "known_measurements": {},
        },
    )
    layer = _get("/garment/options")["layer_presets_cm"][ref["layer"]]
    products = {p["style"]: p["product_id"] for p in _get("/products")}
    for style in cfg.HOODS:
        fit = _post(
            "/fit/garment",
            {
                "body_id": body["body_id"],
                "product_id": products[style],
                "layer_cm": layer,
                "preference": "regular",
            },
        )
        size = ref["size"] if ref["size"] in fit["sizes"] else fit["recommended_size"]
        asset = _get(f"/fit/{fit['fit_id']}/{size}/cloth")
        points = np.asarray(asset["initial"], dtype=float).reshape(-1, 3)
        triangles = np.asarray(asset["triangles"], dtype=np.int64).reshape(-1, 3)
        panels = np.asarray(asset["panels"])
        normals = vertex_normals(points, triangles)
        loft = float(asset["maximum_loft_m"])
        seam = seam_of(asset, points, triangles)
        seam_points = points[seam] + normals[seam] * loft * cfg.SEAM_LOFT_FRACTION
        if seam_points[0, 0] > seam_points[-1, 0]:  # wearer's right (-X) first
            seam = seam[::-1]
            seam_points = seam_points[::-1]
        # Jacket outer (displayed) surface near the neck, without the shell's own hood.
        keep = ~(panels[triangles] == PANEL_HOOD).any(1)
        keep &= points[triangles][:, :, 1].min(1) > cfg.REFERENCE_CROP_Y_M
        # Same surface as the seam (half the loft); the rest of the relief is added to the
        # hood's clearance away from the seam (hood_geometry.push_clear).
        outer = points + normals * loft * cfg.SEAM_LOFT_FRACTION
        jacket_tris = triangles[keep]
        used, remap = np.unique(jacket_tris, return_inverse=True)
        body_points = np.asarray(asset["body_positions"], dtype=float).reshape(-1, 3)
        body_tris = np.asarray(asset["body_triangles"], dtype=np.int64).reshape(-1, 3)
        body_keep = body_points[body_tris][:, :, 1].min(1) > cfg.REFERENCE_CROP_Y_M
        body_used, body_remap = np.unique(body_tris[body_keep], return_inverse=True)
        record = {
            "style": style,
            "size": size,
            "body": ref,
            "asset_key": asset["key"],
            "loft_m": loft,
            "colour": asset["colour"],
            "finish": asset["finish"],
            "seam_ids": [int(i) for i in seam],
            "seam": seam_points.round(6).tolist(),
            "landmarks": asset["body_landmarks"],
            "jacket_points": outer[used].round(6).tolist(),
            "jacket_triangles": remap.reshape(-1, 3).tolist(),
            "body_points": body_points[body_used].round(6).tolist(),
            "body_triangles": body_remap.reshape(-1, 3).tolist(),
        }
        path = out / f"ref-{style}.json"
        path.write_text(json.dumps(record))
        length = float(np.linalg.norm(np.diff(seam_points, axis=0), axis=1).sum())
        print(f"{style} {size}: seam {len(seam)} vertices, {length * 100:.1f} cm -> {path}")


if __name__ == "__main__":
    main()
