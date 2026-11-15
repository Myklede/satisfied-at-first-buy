"""G3 body-grid sweep of the shell look-defect gates (wings, visible inside-out, hem).

Builds the shell for every catalogue size of both jackets on the K3 soak bodies
(scripts/kiosk-soak.mjs inputs, scan skipped) and a female/male x height x weight grid, with the
same cuff stops as ``build_shell_asset``, and writes one row per shell (local, ignored output).

    python scripts/shell_defect_sweep.py .cache/g3/sweep.json [soak|grid|all]
"""

import json
import sys
import time

import numpy as np
import trimesh
from body_service import config
from body_service.fit import Fitter
from body_service.garment.aperture import arm_profile, cuff_collider
from body_service.garment.models import GarmentFitRequest
from body_service.garment.quality import panel_crossings
from body_service.garment.service import GarmentService
from body_service.garment.shell import ShellBodyCache, build_shell, shell_measurements
from body_service.garment.shell_defects import shell_defects
from body_service.model import BodyEngine
from body_service.pose import display_body
from body_service.schemas import FitRequest
from body_service.surface_query import SurfaceQuery

CM_PER_IN, KG_PER_LB = 2.54, 0.45359237  # exact definitions (kiosk units.ts)


def soak_body(cycle: int) -> tuple[float, float, str]:
    if cycle % 2:
        height = (5 * 12 + 5 + cycle % 7) * CM_PER_IN
        weight = (130 + cycle * 3) * KG_PER_LB
    else:
        height, weight = 160.0 + cycle, 55.0 + cycle
    return height, weight, "male" if cycle % 3 else "female"


def bodies(which: str) -> list[tuple[str, float, float, str]]:
    soak = [(f"soak{c:02d}", *soak_body(c)) for c in range(1, 21)]
    grid = [
        (f"{sex[0]}{h}/{w}", float(h), float(w), sex)
        for sex in ("female", "male")
        for h in (150, 172, 195)
        for w in (45, 75, 110)
    ]
    return {"soak": soak, "grid": grid}.get(which, soak + grid)


def main() -> None:
    out, which = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "all"
    fitter = Fitter(BodyEngine())
    garments = GarmentService(fitter)
    rows, started = [], time.time()
    for name, height, weight, sex in bodies(which):
        body = fitter.fit(FitRequest(height_cm=height, weight_kg=weight, sex=sex))
        posed = display_body(fitter.engine, body)
        cache, query = ShellBodyCache(posed), SurfaceQuery(posed.mesh)
        for product in garments.products.values():
            fit = garments.fit(
                GarmentFitRequest(body_id=body.response.body_id, product_id=product.product_id)
            ).response
            layer = fit.layer_cm / 100
            stretch = product.fabric.stretch_max or config.CLOTH_CONFIG["stretchMax"]
            stops = {}
            for side in ("L", "R"):
                collider = cuff_collider(
                    arm_profile(posed.mesh, posed.hand_routes[side]),
                    config.CLOTH_CUFF_INNER_M,
                    layer,
                    stretch,
                )
                upper = float(np.linalg.norm(np.diff(posed.arm_centres[side][:2], axis=0)))
                stop = collider.stop_distance_m
                stops[side] = upper + (stop if stop is not None else collider.distances_m[-1])
            for size in product.sizes:
                row = {"body": name, "h": round(height, 2), "w": round(weight, 2), "sex": sex}
                row.update(style=product.style, size=size)
                shell = build_shell(
                    product, size, fit.sizes[size], body, posed, layer, stops, cache
                )
                report = shell_defects(
                    shell.initial,
                    shell.faces,
                    shell.panels,
                    shell.paths,
                    posed.mesh,
                    shell.elastic,
                    posed.arm_faces,
                    query,
                )
                tape = product.sizes[size]
                cloth = trimesh.Trimesh(shell.initial, shell.faces, process=False)
                row.update(
                    {
                        "pass": report["pass"],
                        "flap_pass": report["flap"]["pass"],
                        "inv_pass": report["inverted"]["pass"],
                        "hem_pass": report["hem"]["pass"],
                        "flap_cm": round(report["flap"]["flap_m"] * 100, 2),
                        "inv_patch_cm2": round(report["inverted"]["largest_patch_m2"] * 1e4, 2),
                        "hem_taut": report["hem"]["taut_gathered_rows"],
                        "chest_err": round(
                            shell_measurements(shell, product)["chest"] - tape.chest.value_cm, 2
                        ),
                        "warn_tight": any("tighter than body" in w for w in shell.warnings),
                        **{f"x_{k}": v for k, v in panel_crossings(cloth, shell.panels).items()},
                    }
                )
                rows.append(row)
                print(name, product.style, size, row["pass"], flush=True)
        with open(out, "w", encoding="utf-8") as handle:
            json.dump(rows, handle)
    print("done", round(time.time() - started), "s", flush=True)


if __name__ == "__main__":
    main()
