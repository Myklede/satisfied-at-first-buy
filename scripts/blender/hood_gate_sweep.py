"""Run the padded-hood realism gate (quality.padded_hood_rest) on the sweep shells (agent H).

Fixtures: ``hood_sweep_fetch.py <dir> --with-body`` (K3 soak bodies + 150/45 and 195/110 female
and male at every size). Writes ``docs/validation/hood-h-gate-sweep.json``. Run from the repo root:

    .venv/Scripts/python.exe scripts/blender/hood_gate_sweep.py .cache/hood/sweep-body
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import trimesh

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services/body"))
from body_service.garment.quality import padded_hood_rest  # noqa: E402


def main() -> None:
    folder = Path(sys.argv[1] if len(sys.argv) > 1 else ".cache/hood/sweep-body")
    rows = []
    for path in sorted(folder.glob("*.json")):
        asset = json.loads(path.read_text())
        points = np.asarray(asset["initial"], dtype=float).reshape(-1, 3)
        faces = np.asarray(asset["triangles"]).reshape(-1, 3)
        cloth = trimesh.Trimesh(points, faces, process=False)
        body = trimesh.Trimesh(
            np.asarray(asset["body_positions"]).reshape(-1, 3),
            np.asarray(asset["body_triangles"]).reshape(-1, 3),
            process=False,
        )
        result = padded_hood_rest(asset, points, cloth, np.asarray(asset["panels"]), body)
        states = result.get("states", {})
        rows.append(
            {
                "shell": path.stem,
                "pass": result["pass"],
                "raw_scale": result.get("raw_scale"),
                "seam_residual_max_cm": result.get("seam_residual_max_cm"),
                "inside_body": {k: v["vertices_inside_body"] for k, v in states.items()},
                "behind_jacket": {k: v["vertices_behind_jacket"] for k, v in states.items()},
            }
        )
        print(
            path.stem,
            result["pass"],
            rows[-1]["inside_body"],
            rows[-1]["behind_jacket"],
            flush=True,
        )
    summary = {
        "shells": len(rows),
        "passed": sum(r["pass"] for r in rows),
        "rows": rows,
    }
    out = ROOT / "docs/validation/hood-h-gate-sweep.json"
    out.write_text(json.dumps(summary, indent=1) + "\n")
    print(f"{summary['passed']}/{summary['shells']} pass -> {out}")


if __name__ == "__main__":
    main()
