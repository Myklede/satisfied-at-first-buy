"""Accuracy of the articulated (per-segment) body distance field. Public reference bodies only.

Distance = body_distance: min(rigid core segment fields, exact skinned joint-zone distance).
1. Rest pose, away from joints (> AWAY_M from every major joint centre, head excluded):
   articulated distance vs the existing whole-body field (garment/sdf.py body_sdf) and vs
   the exact signed distance to the rest mesh.
2. Posed frames (motion peaks), near the shoulder / elbow / hip / knee (skin within
   NEAR_M of the posed joint centre, offset along the normal by -0.5..+3 cm): articulated
   distance vs the exact signed distance to the posed LBS mesh.
Prints a Markdown table. Run: .venv/Scripts/python.exe scripts/motion-sdf-accuracy.py
"""

import numpy as np
import trimesh
from body_service.fit import Fitter
from body_service.garment.sdf import body_sdf
from body_service.model import BodyEngine
from body_service.motion.collision import (
    SegmentField,
    body_distance,
    build_fields,
    trilinear,
)
from body_service.motion.presets import MOTIONS, resolve, sample
from body_service.motion.rig import build_rig, lbs, neutral_pose, pose_skeleton
from body_service.schemas import FitRequest

BODIES = [("male", 175, 75), ("female", 158, 52), ("male", 185, 92)]
AWAY_M = 0.12
NEAR_M = 0.08
SAMPLES = 3000
JOINTS = {
    "shoulder": ("upperarm01", ["reach_up_both", "cross_arms", "reach_forward"]),
    "elbow": ("lowerarm01", ["cross_arms", "reach_forward"]),
    "hip": ("upperleg01", ["sit", "bend_tie_shoes"]),
    "knee": ("lowerleg01", ["sit", "bend_tie_shoes"]),
}


def stats(error: np.ndarray) -> str:
    e = np.abs(error) * 1000
    return f"{np.median(e):.2f} | {np.percentile(e, 95):.2f} | {e.max():.1f}"


def shell(mesh: trimesh.Trimesh, ids: np.ndarray, rng) -> np.ndarray:
    pick = rng.choice(ids, SAMPLES)
    offset = rng.uniform(-0.005, 0.03, (SAMPLES, 1))
    return mesh.vertices[pick] + mesh.vertex_normals[pick] * offset


def main() -> None:
    engine = BodyEngine()
    fitter = Fitter(engine)
    rng = np.random.default_rng(7)
    print("| body | case | n | median mm | p95 mm | max mm |")
    print("| --- | --- | --- | --- | --- | --- |")
    for sex, height, weight in BODIES:
        body = fitter.fit(FitRequest(sex=sex, height_cm=height, weight_kg=weight))
        rig = build_rig(engine, body)
        neutral = neutral_pose(engine, body, rig)
        fields = build_fields(rig)
        label = f"{sex} {height}/{weight}"
        mesh = body.mesh
        joints = np.array(
            [rig.head(f"{j}.{s}") for j, _ in JOINTS.values() for s in "LR"] + [rig.head("neck01")]
        )
        far = np.linalg.norm(mesh.vertices[:, None] - joints[None], axis=2).min(1) > AWAY_M
        far &= mesh.vertices[:, 1] < rig.head("neck01")[1]
        points = shell(mesh, np.flatnonzero(far), rng)
        exact = -trimesh.proximity.signed_distance(mesh, points)
        identity = np.tile(np.eye(4), (len(rig.labels), 1, 1))
        articulated = body_distance(rig, fields, rig.rest, identity, points)
        values, origin, spacing = body_sdf(mesh)
        whole = SegmentField(
            "body", 0, np.eye(4), origin, spacing, values, np.zeros(3), 0.0, np.zeros(0, dtype=int)
        )
        reference = trilinear(whole, points)
        print(
            f"| {label} | rest, away from joints: vs garment/sdf.py | {SAMPLES} | "
            f"{stats(articulated - reference)} |"
        )
        print(
            f"| {label} | rest, away from joints: vs exact | {SAMPLES} | "
            f"{stats(articulated - exact)} |"
        )
        print(
            f"| {label} | (garment/sdf.py itself vs exact) | {SAMPLES} | "
            f"{stats(reference - exact)} |"
        )
        for joint, (bone, motions) in JOINTS.items():
            errors, outside = [], []
            for motion_id in motions:
                motion = MOTIONS[motion_id]
                posed = pose_skeleton(rig, sample(resolve(motion, neutral), motion.hold.start_s))
                posed_mesh = trimesh.Trimesh(lbs(rig, posed.skin), rig.faces, process=False)
                for side in "LR":
                    centre = posed.world[rig.bone(f"{bone}.{side}"), :3, 3]
                    near = np.linalg.norm(posed_mesh.vertices - centre, axis=1) < NEAR_M
                    p = shell(posed_mesh, np.flatnonzero(near), rng)[: SAMPLES // 4]
                    truth = -trimesh.proximity.signed_distance(posed_mesh, p)
                    d = body_distance(rig, fields, posed.world, posed.skin, p)
                    errors.append(d - truth)
                    outside.append((d - truth)[truth > 0])
            errors, outside = np.concatenate(errors), np.concatenate(outside)
            print(
                f"| {label} | posed {joint} ({', '.join(motions)}), all | {len(errors)} | "
                f"{stats(errors)} |"
            )
            print(
                f"| {label} | posed {joint}, outside skin only | {len(outside)} | "
                f"{stats(outside)} |"
            )


if __name__ == "__main__":
    main()
