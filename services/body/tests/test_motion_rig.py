import numpy as np
import pytest
import torch
from body_service.motion import config
from body_service.motion.angles import AnatomicalPose, clamp_pose
from body_service.motion.presets import MOTIONS, frame_times, resolve, sample
from body_service.motion.rig import (
    build_rig,
    dqs,
    lbs,
    measure_pose,
    measure_trunk,
    neutral_pose,
    pose_skeleton,
)
from body_service.pose import display_body
from body_service.schemas import FitRequest

JOINTS = ["upperarm01", "lowerarm01", "wrist", "upperleg01", "lowerleg01", "foot"]


@pytest.fixture(scope="module")
def setup(fitter):
    body = fitter.fit(FitRequest(sex="male", height_cm=175, weight_kg=75))
    rig = build_rig(fitter.engine, body)
    return fitter.engine, body, rig, neutral_pose(fitter.engine, body, rig)


def head(rig, posed, name):
    return posed.world[rig.bone(name), :3, 3]


def test_neutral_reproduces_the_display_pose(setup):
    engine, body, rig, neutral = setup
    display = display_body(engine, body)
    posed = pose_skeleton(rig, neutral)
    error = np.linalg.norm(lbs(rig, posed.skin) - display.mesh.vertices, axis=1)
    arms = np.maximum(*(rig.bone_weight(rig.subtree[rig.bone(f"clavicle.{s}")]) for s in "LR"))
    # Trunk and legs: exact. Arms: the display pose bends the elbow by a minimal rotation that
    # is not a pure hinge, which an anatomical (ISB + hinge elbow) pose cannot reproduce.
    assert error[arms == 0].max() < 1e-4
    assert error.max() < 0.01
    assert abs(neutral.trunk_flexion) < 1e-6 and abs(neutral.trunk_twist) < 1e-6


def test_lbs_matches_anny_skinning(setup):
    engine, body, rig, neutral = setup
    posed = pose_skeleton(
        rig,
        neutral.model_copy(
            update={"trunk_flexion": 40, "hip_L_flexion": 30, "shoulder_R_elevation": 150}
        ),
    )
    model = engine.model
    with torch.no_grad():
        coeff = model.get_phenotype_blendshape_coefficients(
            **body.response.phenotypes, local_changes=body.response.local_changes
        )
        data = model.get_rest_model(coeff)
        native = data["rest_vertices"][0].numpy()
        floor = float(native[:, 2].min())
        conversion = np.array([[1, 0, 0, 0], [0, 0, 1, -floor], [0, -1, 0, 0], [0, 0, 0, 1.0]])
        world = np.linalg.inv(conversion) @ posed.world
        transforms, _ = model.get_bone_transforms(
            torch.tensor(world[None], dtype=torch.float32),
            data["rest_bone_poses"],
            pose_parameterization="world",
        )
        anny = model.get_skinned_vertices(data["rest_vertices"], transforms)[0].numpy()
    anny = (np.c_[anny, np.ones(len(anny))] @ conversion.T)[:, :3]
    # Plain LBS against Anny's own: the shoulder-ridge transfer (ridge.py, active above 90
    # degrees of elevation) is a deliberate correction on top and has its own tests.
    ridge, rig.ridge = rig.ridge, None
    try:
        assert np.abs(anny - lbs(rig, posed.skin)).max() < 2e-4  # float32 Anny vs float64 here
    finally:
        rig.ridge = ridge


def test_full_elevation_puts_the_wrist_above_the_head(setup):
    _, _, rig, neutral = setup
    for side in "LR":
        posed = pose_skeleton(
            rig,
            neutral.model_copy(
                update={f"shoulder_{side}_elevation": 180, f"elbow_{side}_flexion": 0}
            ),
        )
        crown = lbs(rig, posed.skin)[:, 1][rig.bone_weight(rig.subtree[rig.bone("head")]) > 0.5]
        assert head(rig, posed, f"wrist.{side}")[1] > crown.max()


@pytest.mark.parametrize("plane, expected", [(90, "forward"), (0, "sideways")])
def test_plane_of_elevation_direction(setup, plane, expected):
    _, _, rig, neutral = setup
    for side, lateral in (("L", 1.0), ("R", -1.0)):
        posed = pose_skeleton(
            rig,
            neutral.model_copy(
                update={f"shoulder_{side}_plane": plane, f"shoulder_{side}_elevation": 90}
            ),
        )
        d = head(rig, posed, f"lowerarm01.{side}") - head(rig, posed, f"upperarm01.{side}")
        d /= np.linalg.norm(d)
        target = rig.forward if expected == "forward" else np.array([lateral, 0.0, 0.0])
        # Thorax frame of the neutral trunk = the calibrated vertical; within 0.5 degrees.
        assert d @ target > np.cos(np.deg2rad(0.5))


def test_left_and_right_mappings_are_mirror_images(setup):
    _, _, rig, neutral = setup
    pose = neutral.model_copy(
        update={
            "shoulder_L_plane": 60,
            "shoulder_L_elevation": 120,
            "shoulder_L_axial": 30,
            "elbow_L_flexion": 70,
            "hip_L_flexion": 40,
            "knee_L_flexion": 60,
            "trunk_lateral": 12,
            "trunk_twist": 20,
            "trunk_flexion": 25,
        }
    )
    a = pose_skeleton(rig, pose)
    b = pose_skeleton(rig, pose.mirrored())
    for name in JOINTS:
        left = head(rig, a, f"{name}.L")
        right = head(rig, b, f"{name}.R")
        assert np.linalg.norm(left * [-1, 1, 1] - right) < 1e-3, name


def test_contract_angles_round_trip_through_the_rig(setup):
    _, _, rig, neutral = setup
    pose = AnatomicalPose(
        trunk_flexion=35,
        trunk_lateral=-12,
        trunk_twist=25,
        shoulder_L_plane=60,
        shoulder_L_elevation=120,
        shoulder_L_axial=30,
        elbow_L_flexion=70,
        shoulder_R_plane=-40,
        shoulder_R_elevation=50,
        shoulder_R_axial=-20,
        elbow_R_flexion=20,
        hip_L_flexion=40,
        knee_L_flexion=60,
        hip_R_flexion=-10,
        knee_R_flexion=5,
    )
    posed = pose_skeleton(rig, pose)
    measured = measure_pose(rig, posed.world).model_dump()
    for dof, value in pose.model_dump().items():
        if dof != "pelvis_drop_m":
            assert abs(measured[dof] - value) < 0.05, dof
    assert abs(measured["pelvis_drop_m"] - posed.pose.pelvis_drop_m) < 1e-6
    assert (
        np.abs(measure_trunk(rig, posed.world) - [35, -12, 25]).max()
        < config.TRUNK_SOLVE_TOLERANCE_DEG
    )


def test_clamping_is_reported(setup):
    pose, clamps = clamp_pose(AnatomicalPose(knee_L_flexion=170, shoulder_R_plane=150))
    assert pose.knee_L_flexion == 140 and pose.shoulder_R_plane == 135
    assert {c.dof for c in clamps} == {"knee_L_flexion", "shoulder_R_plane"}
    _, _, rig, _ = setup
    assert pose_skeleton(rig, AnatomicalPose(elbow_L_flexion=200)).clamps[0].applied == 150


def test_feet_are_planted_and_seat_is_at_knee_height(setup):
    _, _, rig, neutral = setup
    motion = MOTIONS["sit"]
    posed = pose_skeleton(rig, sample(resolve(motion, neutral), motion.hold.start_s))
    vertices = lbs(rig, posed.skin)
    assert abs(vertices[rig.foot_vertices, 1].min()) < 1e-6
    hips = 0.5 * (head(rig, posed, "upperleg01.L") + head(rig, posed, "upperleg01.R"))
    rest_hips = 0.5 * (rig.head("upperleg01.L") + rig.head("upperleg01.R"))
    assert abs(posed.pose.pelvis_drop_m - (rest_hips[1] - hips[1])) < 1e-9
    assert posed.seated
    knee = rig.head("lowerleg01.L")[1]
    thighs = rig.bone_weight(rig.subtree[rig.bone("upperleg01.L")]) > 0.5
    seat = vertices[thighs & (rig.vertices[:, 1] > knee), 1].min()
    # Thigh underside on an implied seat between popliteal level and knee-joint height.
    assert knee - 0.12 < seat < knee


def test_driver_transforms_cover_every_bone(setup):
    _, _, rig, neutral = setup
    posed = pose_skeleton(rig, sample(resolve(MOTIONS["bend_tie_shoes"], neutral), 1.6))
    assert np.abs(posed.skin - posed.skin[rig.drivers][rig.driver_of]).max() < 1e-9


def test_joint_positions_are_continuous_along_every_motion(setup):
    _, _, rig, neutral = setup
    for motion in MOTIONS.values():
        keys = resolve(motion, neutral)
        state: dict = {}
        joints = []
        for t in frame_times(motion):
            posed = pose_skeleton(rig, sample(keys, t), state)
            joints.append(posed.world[:, :3, 3])
        joints = np.array(joints)
        assert np.isfinite(joints).all()
        step = joints[1:] - joints[:-1]
        # 30 fps. Fingertips peak near 2.4 m/s (8 cm/frame) in the overhead reaches; a
        # discontinuity would show up as a jump in the per-frame step (acceleration).
        assert np.linalg.norm(step, axis=2).max() < 0.1, motion.id
        assert np.linalg.norm(step[1:] - step[:-1], axis=2).max() < 0.01, motion.id


def test_dual_quaternion_skinning_is_exact_for_rigid_motion(setup):
    _, _, rig, _ = setup
    rotation = np.array([[0.0, -1, 0], [1, 0, 0], [0, 0, 1]])
    skin = np.tile(np.eye(4), (len(rig.labels), 1, 1))
    skin[:, :3, :3] = rotation
    skin[:, :3, 3] = [0.1, -0.2, 0.3]
    expected = rig.vertices @ rotation.T + [0.1, -0.2, 0.3]
    assert np.abs(dqs(rig, skin) - expected).max() < 1e-9
    assert np.abs(lbs(rig, skin) - expected).max() < 1e-6  # Anny weights sum to 1 +- 1e-7
