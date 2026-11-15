"""Render every motion's hold pose (front + side) to docs/validation/motion-peaks.png.

Public reference body only. Run: .venv/Scripts/python.exe scripts/motion-render-peaks.py
"""

import os

from body_service.config import ROOT

os.environ["MPLCONFIGDIR"] = str(ROOT / ".cache/matplotlib")

import matplotlib  # noqa: E402

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import trimesh  # noqa: E402
from body_service.fit import Fitter  # noqa: E402
from body_service.model import BodyEngine  # noqa: E402
from body_service.motion.presets import MOTIONS, resolve, sample  # noqa: E402
from body_service.motion.rig import build_rig, lbs, neutral_pose, pose_skeleton  # noqa: E402
from body_service.schemas import FitRequest  # noqa: E402
from matplotlib.collections import PolyCollection  # noqa: E402


def draw(ax, vertices: np.ndarray, faces: np.ndarray, side: bool) -> None:
    axes = (2, 1, 0) if side else (0, 1, 2)
    projected = vertices[:, axes[:2]] * (np.array([-1, 1]) if side else 1)
    depth = vertices[:, axes[2]] * (-1 if side else 1)
    order = np.argsort(depth[faces].mean(1))
    normals = trimesh.Trimesh(vertices, faces, process=False).face_normals
    light = np.clip(0.4 + 0.6 * np.abs(normals @ np.array([0.3, 0.5, 0.81])), 0.2, 1)
    colours = np.array([0.82, 0.68, 0.58])[None] * light[:, None]
    ax.add_collection(PolyCollection(projected[faces][order], facecolors=colours[order]))
    ax.set_xlim(-0.8, 0.8)
    ax.set_ylim(-0.02, 2.15)
    ax.set_aspect("equal")
    ax.axis("off")


def main() -> None:
    engine = BodyEngine()
    body = Fitter(engine).fit(FitRequest(sex="female", height_cm=170, weight_kg=68))
    rig = build_rig(engine, body)
    neutral = neutral_pose(engine, body, rig)
    fig, axes = plt.subplots(
        2, len(MOTIONS) + 1, figsize=(3 * (len(MOTIONS) + 1), 9), facecolor="#151c21"
    )
    poses = [("neutral", neutral)] + [
        (m.id, sample(resolve(m, neutral), m.hold.start_s)) for m in MOTIONS.values()
    ]
    for col, (name, pose) in enumerate(poses):
        posed = pose_skeleton(rig, pose)
        vertices = lbs(rig, posed.skin)
        for row in (0, 1):
            draw(axes[row, col], vertices, rig.faces, side=bool(row))
        axes[0, col].set_title(name, color="w")
    fig.tight_layout()
    fig.savefig(ROOT / "docs/validation/motion-peaks.png", dpi=60)


if __name__ == "__main__":
    main()
