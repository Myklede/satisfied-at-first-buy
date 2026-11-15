"""Fixtures for the padded-hood fit sweep (agent H): shells on many bodies, from the local service.

Bodies: the 20 K3 kiosk-soak bodies (the formula of scripts/shell_defect_sweep.py
``soak_body``), each with the recommended size of both jackets, plus the extremes 150 cm / 45 kg
and 195 cm / 110 kg, female and male, at every catalogue size. Writes compact JSON (topology,
rest positions, the seam paths) to ``.cache/hood/sweep/`` (gitignored); the web test
``apps/web/src/engine/hood/hoodSweep.test.ts`` fits the baked hoods on every one.

    .cache/tools/blender/x/blender-5.3.0-windows-x64/5.3/python/bin/python.exe -I \
        scripts/blender/hood_sweep_fetch.py
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

API = "http://127.0.0.1:8001"
CM_PER_IN, KG_PER_LB = 2.54, 0.45359237  # exact definitions (kiosk units.ts)
STYLES = ("FB7675-100", "DQ4920-206")


def _post(path: str, payload: dict) -> dict:
    request = urllib.request.Request(
        API + path, data=json.dumps(payload).encode(), headers={"content-type": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=900) as response:
        return json.load(response)


def _get(path: str):
    with urllib.request.urlopen(API + path, timeout=900) as response:
        return json.load(response)


def soak_body(cycle: int) -> tuple[float, float, str]:
    """Same as scripts/shell_defect_sweep.py soak_body (K3 kiosk-soak inputs)."""
    if cycle % 2:
        height = (5 * 12 + 5 + cycle % 7) * CM_PER_IN
        weight = (130 + cycle * 3) * KG_PER_LB
    else:
        height, weight = 160.0 + cycle, 55.0 + cycle
    return height, weight, "male" if cycle % 3 else "female"


def bodies() -> list[tuple[str, float, float, str, bool]]:
    """(name, height, weight, sex, every size)."""
    soak = [(f"soak{c:02d}", *soak_body(c), False) for c in range(1, 21)]
    extreme = [
        (f"{sex[0]}{h}-{w}", float(h), float(w), sex, True)
        for sex in ("female", "male")
        for h, w in ((150, 45), (195, 110))
    ]
    return soak + extreme


def main() -> None:
    """argv: [out dir] [--with-body] [--styles A,B]. With the body (mesh + landmarks) the
    fixtures also serve the Python padded-hood gate sweep (hood_gate_sweep.py)."""
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    with_body = "--with-body" in sys.argv
    styles = STYLES
    if "--styles" in sys.argv:
        styles = tuple(sys.argv[sys.argv.index("--styles") + 1].split(","))
        args = [a for a in args if a != ",".join(styles)]
    out = Path(args[0] if args else ".cache/hood/sweep")
    out.mkdir(parents=True, exist_ok=True)
    density = _get("/body/capabilities")["default_density_kg_m3"]
    layer = _get("/garment/options")["layer_presets_cm"]["t-shirt"]
    products = {p["style"]: p["product_id"] for p in _get("/products")}
    for name, height, weight, sex, every in bodies():
        body = _post(
            "/body/fit",
            {
                "sex": sex,
                "height_cm": round(height, 2),
                "weight_kg": round(weight, 2),
                "shape_reference": "neutral",
                "density_kg_m3": density,
                "known_measurements": {},
            },
        )
        for style in styles:
            fit = _post(
                "/fit/garment",
                {
                    "body_id": body["body_id"],
                    "product_id": products[style],
                    "layer_cm": layer,
                    "preference": "regular",
                },
            )
            sizes = (
                list(fit["sizes"])
                if every
                else [fit["recommended_size"] or next(iter(fit["sizes"]))]
            )
            for size in sizes:
                path = out / f"{name}-{style}-{size}.json"
                if path.exists():
                    continue
                asset = _get(f"/fit/{fit['fit_id']}/{size}/cloth")
                keep = {
                    k: asset[k]
                    for k in (
                        "key",
                        "panels",
                        "triangles",
                        "initial",
                        "maximum_loft_m",
                        "colour",
                        "finish",
                    )
                }
                keep["paths"] = {
                    k: v for k, v in asset["paths"].items() if k in ("hood_zip", "neckline")
                }
                keep["render_details"] = {
                    "hood_kind": (asset.get("render_details") or {}).get("hood_kind", 0)
                }
                keep["body"] = {"name": name, "sex": sex, "height_cm": height, "weight_kg": weight}
                keep["size"] = size
                if with_body:
                    for k in ("body_positions", "body_triangles", "body_landmarks"):
                        keep[k] = asset[k]
                path.write_text(json.dumps(keep))
                print(f"{path.name}", flush=True)


if __name__ == "__main__":
    main()
