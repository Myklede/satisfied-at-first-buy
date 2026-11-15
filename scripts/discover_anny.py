"""Inspect the installed, commercial-friendly model; writes no personal data."""

import json
import os
from pathlib import Path
from time import perf_counter

ROOT = Path(__file__).resolve().parents[1]
os.environ["ANNY_CACHE_DIR"] = str(ROOT / ".cache/anny")
os.environ["XDG_CACHE_HOME"] = str(ROOT / ".cache")

import anny  # noqa: E402
import torch  # noqa: E402
import trimesh  # noqa: E402

torch.set_num_threads(2)
start = perf_counter()
print("Loading Anny default model (no SMPL)...", flush=True)
model = anny.Anny(topology="anny", phenotypes="all", local_changes="default", skinning_method="lbs")
print("Loaded", perf_counter() - start, flush=True)
out = model()
print("output:", {k: list(v.shape) for k, v in out.items()})
print("buffers:", {k: list(v.shape) for k, v in model.named_buffers()})
v = out["rest_vertices"][0].detach().numpy()
faces = model.faces.detach().numpy()
if faces.shape[1] == 4:
    faces = trimesh.geometry.triangulate_quads(faces)
mesh = trimesh.Trimesh(v, faces, process=False)
report = {
    "version": anny.__version__,
    "phenotype_labels": model.phenotype_labels,
    "local_change_labels": model.local_change_labels,
    "bone_labels": model.bone_labels,
    "vertices": len(v),
    "faces_original": list(model.faces.shape),
    "faces_triangles": len(faces),
    "bounds": mesh.bounds.tolist(),
    "watertight": bool(mesh.is_watertight),
    "winding_consistent": bool(mesh.is_winding_consistent),
    "components": len(mesh.split(only_watertight=False)),
    "volume": float(mesh.volume),
}
print(json.dumps(report, indent=2), flush=True)
(ROOT / ".cache/discovery.json").write_text(json.dumps(report, indent=2))
(ROOT / "docs/anny-discovery.json").write_text(json.dumps(report, indent=2) + "\n")
torch.save(
    {"vertices": out["vertices"].detach(), "faces": model.faces, "bones": out["rest_bone_heads"]},
    ROOT / ".cache/discovery.pt",
)
