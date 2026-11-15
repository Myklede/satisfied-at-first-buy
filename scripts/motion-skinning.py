"""LBS vs dual-quaternion skinning on the motion peaks (public reference body, no personal data).

Writes docs/validation/motion-skinning-<motion>.png (rows: LBS, DQS; columns: front, side,
shoulder close-up front, shoulder close-up side) and prints the metrics as JSON:
- whole-body volume ratio posed / rest (closed mesh, signed tetrahedra);
- joint "cone volume" ratio: volume swept from the joint centre to the skin faces of the
  blend zone around the shoulder (upperarm01) and elbow (lowerarm01) joints;
- LBS-DQS vertex displacement (mean / max, mm).
Run: .venv/Scripts/python.exe scripts/motion-skinning.py
"""

import json
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
from body_service.motion.rig import (  # noqa: E402
    build_rig,
    dqs,
    lbs,
    neutral_pose,
    pose_skeleton,
)
from body_service.schemas import FitRequest  # noqa: E402

BODY = ("male", 175, 75)
BLEND_ZONE = (0.05, 0.95)  # vertices whose joint-subtree weight is neither ~0 nor ~1


def cone_volume(vertices: np.ndarray, faces: np.ndarray, centre: np.ndarray) -> float:
    a, b, c = (vertices[faces[:, k]] - centre for k in range(3))
    return float(abs(np.einsum("ij,ij->i", np.cross(a, b), c).sum()) / 6)


def draw(ax, vertices, faces, view, limits):
    axes = {"front": (0, 1, 2), "side": (2, 1, 0)}[view]
    projected = vertices[:, axes[:2]]
    depth = vertices[:, axes[2]]
    if view == "side":
        projected = projected * np.array([-1, 1])  # look at the subject's left side
        depth = -depth
    order = np.argsort(depth[faces].mean(1))
    mesh = trimesh.Trimesh(vertices, faces, process=False)
    light = np.clip(0.4 + 0.6 * np.abs(mesh.face_normals @ np.array([0.3, 0.5, 0.81])), 0.2, 1)
    colours = np.array([0.82, 0.68, 0.58])[None] * light[:, None]
    from matplotlib.collections import PolyCollection

    ax.add_collection(
        PolyCollection(projected[faces][order], facecolors=colours[order], edgecolors="none")
    )
    ax.set_xlim(*limits[0])
    ax.set_ylim(*limits[1])
    ax.set_aspect("equal")
    ax.axis("off")
    ax.set_facecolor("#151c21")


def main() -> None:
    engine = BodyEngine()
    body = Fitter(engine).fit(FitRequest(sex=BODY[0], height_cm=BODY[1], weight_kg=BODY[2]))
    rig = build_rig(engine, body)
    neutral = neutral_pose(engine, body, rig)
    rest_volume = trimesh.Trimesh(rig.vertices, rig.faces, process=False).volume
    report = {}
    for motion_id in ("reach_up_both", "cross_arms"):
        motion = MOTIONS[motion_id]
        posed = pose_skeleton(rig, sample(resolve(motion, neutral), motion.hold.start_s))
        variants = {"lbs": lbs(rig, posed.skin), "dqs": dqs(rig, posed.skin)}
        variants["blend50"] = 0.5 * (variants["lbs"] + variants["dqs"])
        metrics: dict[str, dict] = {}
        for name, v in variants.items():
            entry = {
                "volume_ratio": trimesh.Trimesh(v, rig.faces, process=False).volume / rest_volume
            }
            for joint in ("upperarm01", "lowerarm01"):
                for side in ("L", "R"):
                    bone = rig.bone(f"{joint}.{side}")
                    w = rig.bone_weight(rig.subtree[bone])
                    zone = (w > BLEND_ZONE[0]) & (w < BLEND_ZONE[1])
                    faces = rig.faces[zone[rig.faces].all(1)]
                    rest = cone_volume(rig.vertices, faces, rig.rest[bone, :3, 3])
                    now = cone_volume(v, faces, posed.world[bone, :3, 3])
                    entry[f"{joint}.{side}_cone_ratio"] = now / rest
            metrics[name] = entry
        diff = np.linalg.norm(variants["lbs"] - variants["dqs"], axis=1) * 1000
        metrics["lbs_vs_dqs_mm"] = {"mean": float(diff.mean()), "max": float(diff.max())}
        report[motion_id] = metrics
        shoulder = posed.world[rig.bone("upperarm01.L"), :3, 3]
        span = 0.16
        views = [
            ("front", ((-0.75, 0.75), (-0.02, 2.15))),
            ("side", ((-0.75, 0.75), (-0.02, 2.15))),
            (
                "front",
                (
                    (shoulder[0] - span, shoulder[0] + span),
                    (shoulder[1] - span, shoulder[1] + span),
                ),
            ),
            (
                "side",
                (
                    (-shoulder[2] - span, -shoulder[2] + span),
                    (shoulder[1] - span, shoulder[1] + span),
                ),
            ),
        ]
        fig, axes = plt.subplots(2, 4, figsize=(16, 10), facecolor="#151c21")
        for row, name in enumerate(("lbs", "dqs")):
            for col, (view, limits) in enumerate(views):
                draw(axes[row, col], variants[name], rig.faces, view, limits)
                axes[row, col].set_title(f"{motion_id} {name.upper()} {view}", color="w")
        fig.tight_layout()
        fig.savefig(ROOT / f"docs/validation/motion-skinning-{motion_id}.png", dpi=70)
        plt.close(fig)
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
