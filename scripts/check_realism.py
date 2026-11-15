"""03c gate table on explicitly exported local cloth assets (personal results stay ignored).

Displayed positions: the settled solver output when the asset relaxes (maxSeconds > 0) and a
matching ``*-settled.json`` exists; otherwise the asset's computed wrap (fallback, no relax).
"""

import json
import os

import numpy as np
import trimesh
from body_service import config
from body_service.garment.quality import (
    body_penetration,
    padded_hood_rest,
    panel_crossings,
    sleeve_enclosure,
)
from body_service.garment.shell_defects import shell_defects


def offsets(asset: dict, positions: np.ndarray) -> dict[str, float]:
    lm = {k: np.asarray(v) for k, v in asset["body_landmarks"].items()}
    shoulder, sleeve = [], []
    for side in ("L", "R"):
        acro, elbow, wrist = lm[f"acromion_{side}"], lm[f"elbow_{side}"], lm[f"wrist_{side}"]
        seam = positions[asset["landmarks"][f"seam_{side}"]]
        cuff = positions[asset["paths"][f"cuff_{side}"][:-1]].mean(0)
        upper = (elbow - acro) / np.linalg.norm(elbow - acro)
        lower = (wrist - elbow) / np.linalg.norm(wrist - elbow)
        shoulder.append(float((seam - acro) @ upper * 100))
        sleeve.append(float((cuff - wrist) @ lower * 100))
    hem = positions[asset["landmarks"]["hem_back"]]
    return {
        "shoulder": float(np.mean(shoulder)),
        "sleeve": float(np.mean(sleeve)),
        "hem_vs_hip": float((hem[1] - lm["hip_level"][1]) * 100),
    }


def main() -> None:
    rows = []
    failed = False
    directory = config.ROOT / ".cache/realism"
    for path in sorted(directory.glob("*.json")):
        name = path.name
        if not name.startswith(("reference-", "personal-")) or any(
            tag in name for tag in ("-analytic", "-settled", "-probe", "browser-")
        ):
            continue
        asset = json.loads(path.read_text())
        if "initial" not in asset:
            continue
        settled_path = path.with_name(name.replace(".json", "-settled.json"))
        # REALISM_USE_SETTLED=1 gates the relaxed state (settle-realism.mjs with
        # REALISM_RELAX_SECONDS) while the live asset still ships the static shell.
        relaxes = (
            asset["config"]["maxSeconds"] > 0
            or settled_path.exists()
            and bool(os.environ.get("REALISM_USE_SETTLED"))
        )
        positions = np.array(asset["initial"]).reshape(-1, 3)
        state = "wrapped_no_relax"
        if relaxes:
            if not settled_path.exists():
                raise SystemExit(f"Missing settle for {name}; run node scripts/settle-realism.mjs")
            settled = json.loads(settled_path.read_text())
            if settled.get("assetKey") != asset["key"]:
                raise SystemExit(f"Stale settle: {settled_path.name}")
            positions = np.array(settled["positions"]).reshape(-1, 3)
            state = f"relaxed_{settled['simulatedSeconds']:.2f}s"
        faces = np.array(asset["triangles"]).reshape(-1, 3)
        panels = np.array(asset["panels"])
        rest = np.array(asset["rest"]).reshape(-1, 3)
        elastic = np.array(asset["elastic"]) > 0.5
        cloth = trimesh.Trimesh(positions, faces, process=False)
        body = trimesh.Trimesh(
            np.array(asset["body_positions"]).reshape(-1, 3),
            np.array(asset["body_triangles"]).reshape(-1, 3),
            process=False,
        )
        edges = cloth.edges_unique
        ratio = np.linalg.norm(positions[edges[:, 0]] - positions[edges[:, 1]], axis=1) / (
            np.linalg.norm(rest[edges[:, 0]] - rest[edges[:, 1]], axis=1)
        )
        elastic_edge = elastic[edges].all(1)
        stretch_max = asset["config"].get("elasticStretchMax", asset["config"]["stretchMax"])
        report = {
            "filename": name,
            "state": state,
            "particles": len(positions),
            "max_edge_ratio": float(ratio[~elastic_edge].max()),
            "min_edge_ratio": float(ratio.min()),
            "elastic_max_ratio": float(ratio[elastic_edge].max()) if elastic_edge.any() else None,
        }
        report["strain_pass"] = report["max_edge_ratio"] <= 1.10 and (
            report["elastic_max_ratio"] is None or report["elastic_max_ratio"] <= stretch_max
        )
        report["crossings"] = panel_crossings(cloth, panels)
        report["crossings_pass"] = not any(report["crossings"].values())
        report["body"] = body_penetration(cloth, body)
        report["body_pass"] = report["body"]["inside_samples"] == 0
        report["enclosure"] = {
            side: sleeve_enclosure(
                cloth,
                panels,
                body,
                np.array(asset["body_arm_faces"][side]).reshape(-1, 3),
                np.array(asset["body_arm_routes"][side]),
                4 if side == "L" else 5,
            )
            for side in ("L", "R")
        }
        report["enclosure_pass"] = all(v["pass"] for v in report["enclosure"].values())
        # The kiosk draws agent H's padded hood instead of panel 7: gate that hood on this shell.
        report["hood"] = padded_hood_rest(asset, positions, cloth, panels, body)
        # G3 look gates: shoulder wings, inverted (inside-showing) faces, frayed hem.
        defects = shell_defects(
            positions,
            faces,
            panels,
            asset["paths"],
            body,
            elastic.astype(float),
            {side: np.array(f).reshape(-1, 3) for side, f in asset["body_arm_faces"].items()},
        )
        report["defects"] = {
            "flap_cm": round(defects["flap"]["flap_m"] * 100, 2),
            "inverted_faces": defects["inverted"]["count"],
            "hem_height_mm": round(defects["hem"]["height_m"] * 1000, 2),
            "hem_dent_mm": round(defects["hem"]["dent_m"] * 1000, 2),
            "hem_taut_gathered_rows": defects["hem"]["taut_gathered_rows"],
        }
        report["defects_pass"] = defects["pass"]
        report["convergence"] = (
            "not applicable: fallback shows the computed wrap, no relaxation"
            if not relaxes
            else f"energy {settled['energy']:.2e} at {settled['simulatedSeconds']:.2f}s"
        )
        report["convergence_pass"] = (
            None if not relaxes else settled["energy"] < asset["config"]["kineticEpsilon"]
        )
        analytic_path = path.with_name(name.replace(".json", "-analytic.json"))
        if analytic_path.exists():
            analytic = json.loads(analytic_path.read_text())
            size = asset["key"].split(":")[1]
            zones = analytic["sizes"][size]["zones"]
            shown = offsets(asset, positions)
            report["analytic_vs_shown_cm"] = {
                "shoulder": [zones["shoulder"]["value_cm"], shown["shoulder"]],
                "sleeve": [zones["sleeve"]["value_cm"], shown["sleeve"]],
                "hem_vs_hip": [zones["hem"]["position_vs_hip_cm"], shown["hem_vs_hip"]],
            }
            report["analytic_pass"] = all(
                abs(a - b) <= 2.0
                for key, (a, b) in report["analytic_vs_shown_cm"].items()
                if key != "sleeve" and a is not None
            )
        report["pass"] = (
            all(
                report[k]
                for k in (
                    "strain_pass",
                    "crossings_pass",
                    "body_pass",
                    "enclosure_pass",
                    "defects_pass",
                    "analytic_pass",
                )
                if k in report
            )
            and report["hood"]["pass"]
        )
        failed |= not report["pass"]
        rows.append(report)
        print(
            name,
            {
                k: report[k]
                for k in report
                if k.endswith("pass") or k in ("max_edge_ratio", "analytic_vs_shown_cm", "defects")
            },
            flush=True,
        )
    (directory / "quality.json").write_text(json.dumps(rows, indent=2) + "\n")
    public = [row for row in rows if row["filename"].startswith("reference-")]
    (config.ROOT / "docs/validation/realism-quality.json").write_text(
        json.dumps(public, indent=2) + "\n"
    )
    if failed:
        raise SystemExit("FAIL: realism acceptance gates; see .cache/realism/quality.json")


if __name__ == "__main__":
    main()
