"""Grid search for the cross_arms peak pose on public reference bodies (no personal data).

Criteria per candidate, worst case over the bodies:
- forearm/hand penetration into the torso (exact signed distance to the rest torso, which
  does not move in this motion), metres, + = inside;
- minimum distance between left and right forearm+hand vertex samples (stacking);
- how far the left wrist crosses the midline (scene x < 0 means past the midline).
Run: .venv/Scripts/python.exe scripts/motion-cross-arms.py
"""

import itertools
import sys

import numpy as np
import trimesh
from body_service.fit import Fitter
from body_service.model import BodyEngine
from body_service.motion.rig import build_rig, lbs, neutral_pose, pose_skeleton
from body_service.schemas import FitRequest
from scipy.spatial import cKDTree

BODIES = [("male", 175, 75), ("male", 185, 92), ("female", 158, 52)]
MAX_TORSO_PENETRATION_M = 0.01  # soft-tissue contact allowance for resting forearms
MIN_FOREARM_GAP_M = 0.004


def main() -> None:
    engine = BodyEngine()
    fitter = Fitter(engine)
    cases = []
    for sex, height, weight in BODIES:
        body = fitter.fit(FitRequest(sex=sex, height_cm=height, weight_kg=weight))
        rig = build_rig(engine, body)

        def weight_of(name: str, rig=rig) -> np.ndarray:
            return rig.bone_weight(rig.subtree[rig.bone(name)])

        arms = np.maximum(weight_of("clavicle.L"), weight_of("clavicle.R"))
        torso = trimesh.Trimesh(
            rig.vertices, rig.faces[(arms < 0.02)[rig.faces].all(1)], process=False
        )
        left = np.flatnonzero(weight_of("lowerarm01.L") > 0.5)[::3]
        right = np.flatnonzero(weight_of("lowerarm01.R") > 0.5)[::3]
        cases.append((rig, neutral_pose(engine, body, rig), torso, left, right))
    results = []
    grid = itertools.product(
        [110, 120, 130, 135], [35, 45, 55], [-60, -45, -30, -15], [115, 125, 135]
    )
    for plane, elevation, axial, elbow in grid:
        update = {
            "shoulder_L_plane": plane,
            "shoulder_L_elevation": elevation + 10,
            "shoulder_L_axial": axial,
            "elbow_L_flexion": elbow,
            "shoulder_R_plane": plane,
            "shoulder_R_elevation": elevation,
            "shoulder_R_axial": axial,
            "elbow_R_flexion": elbow,
        }
        worst = []
        for rig, neutral, torso, left, right in cases:
            posed = pose_skeleton(rig, neutral.model_copy(update=update))
            v = lbs(rig, posed.skin)
            penetration = trimesh.proximity.signed_distance(torso, v[np.r_[left, right]]).max()
            gap = cKDTree(v[left]).query(v[right])[0].min()
            worst.append((penetration, gap, posed.world[rig.bone("wrist.L"), 0, 3]))
        worst = np.array(worst)
        results.append((update, worst[:, 0].max(), worst[:, 1].min(), worst[:, 2].max()))
        print(plane, elevation, axial, elbow, worst.max(0).round(3), file=sys.stderr)
    ok = [r for r in results if r[1] <= MAX_TORSO_PENETRATION_M and r[2] >= MIN_FOREARM_GAP_M]
    ok.sort(key=lambda r: r[3])
    for update, penetration, gap, wrist in ok[:10]:
        print(update, f"penetration {penetration:.4f} gap {gap:.4f} wristL_x {wrist:.3f}")
    print(f"{len(ok)} of {len(results)} candidates pass")


if __name__ == "__main__":
    main()
