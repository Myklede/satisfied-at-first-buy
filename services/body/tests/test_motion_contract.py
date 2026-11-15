"""Cross-check against P3's reference kinematics (packages/vision/src/poseSynth.ts).

The reference vectors are exported by `node scripts/motion-p3-reference.mjs` into
body_service/motion/p3_reference.json (P3 body frame: X forward, Y up, Z subject right).
"""

import json
from pathlib import Path

import numpy as np
import pytest
from body_service.motion.angles import AnatomicalPose
from body_service.motion.presets import MOTIONS
from body_service.motion.rig import build_rig, isb_local, pose_skeleton
from body_service.schemas import FitRequest

REFERENCE = json.loads(
    (Path(__file__).parents[1] / "body_service/motion/p3_reference.json").read_text()
)
SEGMENTS = {
    "trunk": ("hips", "shoulders"),
    "humerus_L": ("upperarm01.L", "lowerarm01.L"),
    "humerus_R": ("upperarm01.R", "lowerarm01.R"),
    "forearm_L": ("lowerarm01.L", "wrist.L"),
    "forearm_R": ("lowerarm01.R", "wrist.R"),
    "thigh_L": ("upperleg01.L", "lowerleg01.L"),
    "thigh_R": ("upperleg01.R", "lowerleg01.R"),
    "shank_L": ("lowerleg01.L", "foot.L"),
    "shank_R": ("lowerleg01.R", "foot.R"),
}
TOLERANCE_DEG = 0.5
SHANK_TOLERANCE_DEG = 2.0


def test_contract_motion_ids():
    assert list(MOTIONS) == [
        "reach_up_both",
        "reach_up_one",
        "reach_forward",
        "sit",
        "bend_tie_shoes",
        "cross_arms",
    ]


@pytest.mark.parametrize("plane, elevation", [(0, 30), (90, 90), (40, 170), (-60, 50), (125, 45)])
def test_isb_humerus_direction_formula(plane, elevation):
    p, e = np.deg2rad(plane), np.deg2rad(elevation)
    expected = [np.sin(e) * np.sin(p), -np.cos(e), np.sin(e) * np.cos(p)]
    assert np.allclose(isb_local(plane, elevation, 37.0) @ [0, -1.0, 0], expected)


@pytest.mark.parametrize("sex, height, weight", [("male", 175, 75), ("female", 158, 52)])
def test_rig_matches_p3_reference_kinematics(fitter, sex, height, weight):
    rig = build_rig(
        fitter.engine, fitter.fit(FitRequest(sex=sex, height_cm=height, weight_kg=weight))
    )
    for case in REFERENCE["cases"]:
        world = pose_skeleton(rig, AnatomicalPose(**case["pose"])).world
        joint = {name: world[rig.bone(name), :3, 3] for name in rig.labels}
        joint["hips"] = 0.5 * (joint["upperleg01.L"] + joint["upperleg01.R"])
        joint["shoulders"] = 0.5 * (joint["upperarm01.L"] + joint["upperarm01.R"])
        basis = np.stack((rig.forward, rig.vertical, rig.right))  # scene -> P3 body frame

        def direction(a: str, b: str, basis=basis, joint=joint) -> np.ndarray:
            d = basis @ (joint[b] - joint[a])
            return d / np.linalg.norm(d)

        for name, (a, b) in SEGMENTS.items():
            mine, ref = direction(a, b), np.array(case["directions"][name])
            if name.startswith(("thigh", "shank")):
                # P3's skeleton has no hip abduction; contract hip/knee angles are sagittal.
                error = np.rad2deg(np.arctan2(mine[0], -mine[1]) - np.arctan2(ref[0], -ref[1]))
            else:
                error = np.rad2deg(np.arccos(np.clip(mine @ ref, -1, 1)))
            # The knee bends in the shank's own rest flexion plane (Anny's slight varus), so the
            # exact 3D knee angle projects to a sagittal angle up to ~1.3 deg off P3's planar leg.
            limit = SHANK_TOLERANCE_DEG if name.startswith("shank") else TOLERANCE_DEG
            assert abs(error) < limit, (case["pose"], name, error)
        # Shoulder line: the rig shrugs the clavicles (scapulohumeral rhythm) and P3's stick
        # skeleton does not, so compare the part P3's thorax frame uses (perpendicular to u).
        u = direction("hips", "shoulders")
        line = direction("upperarm01.L", "upperarm01.R")
        line = line - u * (line @ u)
        ref = np.array(case["directions"]["shoulder_line"])
        ref = ref - u * (ref @ u)
        cosine = line @ ref / np.linalg.norm(line) / np.linalg.norm(ref)
        assert np.rad2deg(np.arccos(np.clip(cosine, -1, 1))) < TOLERANCE_DEG
