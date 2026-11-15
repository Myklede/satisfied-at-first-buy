"""Shoulder-ridge weight transfer (motion/ridge.py): exact at rest and below 90 degrees, lifts
the ridge at full elevation, and leaves the motion frames (drivers, anchors) untouched."""

import numpy as np
import pytest
from body_service.motion import config
from body_service.motion.collision import build_fields
from body_service.motion.container import decode
from body_service.motion.presets import MOTIONS, frame_times, resolve, sample
from body_service.motion.ridge import build_ridge, ridge_factor
from body_service.motion.rig import lbs, pose_skeleton
from body_service.motion.service import MotionService
from body_service.schemas import FitRequest


@pytest.fixture(scope="module")
def body(fitter):
    body_id = fitter.fit(FitRequest(sex="male", height_cm=178, weight_kg=72)).response.body_id
    service = MotionService(fitter)
    item = service.body(body_id)
    return service, body_id, item


def posed_at(item, motion_id: str, t: float):
    keys = resolve(MOTIONS[motion_id], item.neutral)
    return pose_skeleton(item.rig, sample(keys, t), {})


def test_mask_covers_the_shoulder_top_only(body):
    _, _, item = body
    rig = item.rig
    ridge = build_ridge(rig)
    cfg = config.SHOULDER_RIDGE
    assert len(ridge.vertices) > 50
    assert ((ridge.mask > 0) & (ridge.mask <= cfg["max_share"])).all()
    assert (ridge.upper_weight > 0).all()
    for s, side in enumerate(("L", "R")):
        joint = rig.head(f"upperarm01.{side}")
        mine = ridge.vertices[ridge.side == s]
        assert (rig.vertices[mine, 1] > joint[1] + cfg["height_from_m"]).all()
        lateral = np.abs(rig.vertices[mine, 0]) - abs(joint[0])
        assert (lateral < cfg["lateral_from_m"] + cfg["lateral_ramp_m"]).all()
        assert (np.sign(rig.vertices[mine, 0]) == np.sign(joint[0])).all()
    assert abs((ridge.side == 0).sum() - (ridge.side == 1).sum()) <= 0.1 * len(ridge.vertices)


@pytest.mark.parametrize("motion_id", tuple(MOTIONS))
def test_exact_at_rest_and_below_90_degrees(body, motion_id):
    _, _, item = body
    rig = item.rig
    ridge = build_ridge(rig)
    motion = MOTIONS[motion_id]
    keys = resolve(motion, item.neutral)
    state: dict = {}
    checked = 0
    try:
        for t in frame_times(motion):
            posed = pose_skeleton(rig, sample(keys, t), state)
            factors = [
                ridge_factor(
                    posed.skin[ridge.upper_bone[s], :3, :3],
                    posed.skin[ridge.clavicle_bone[s], :3, :3],
                    ridge.humerus_rest[s],
                )
                for s in range(2)
            ]
            if any(factors):
                continue
            rig.ridge = None
            plain = lbs(rig, posed.skin)
            rig.ridge = ridge
            ridged = lbs(rig, posed.skin)
            assert np.array_equal(plain, ridged), (motion_id, t)  # bit for bit
            checked += 1
        assert checked > 0  # Every preset includes its neutral lead-in and lead-out.
    finally:
        rig.ridge = None


def slice_rise(rig, before: np.ndarray, after: np.ndarray, cm: float) -> list[float]:
    """Rise (m) of the shoulder top per side: the 5 highest rest vertices in a 3 cm lateral
    slice `cm` from the midline (ridgeSlices.mjs measures the same)."""
    joints = [rig.head("upperarm01.L"), rig.head("upperarm01.R")]
    mid = (joints[0][0] + joints[1][0]) / 2
    out = []
    for joint in joints:
        lateral = (rig.vertices[:, 0] - mid) * np.sign(joint[0] - mid)
        sel = np.flatnonzero(
            (lateral >= (cm - 1.5) / 100)
            & (lateral < (cm + 1.5) / 100)
            & (rig.vertices[:, 1] <= joint[1] + 0.15)
        )
        top = sel[np.argsort(-rig.vertices[sel, 1])[:5]]
        out.append(float((after - before)[top, 1].mean()))
    return out


def test_lifts_the_ridge_at_full_elevation(body):
    _, _, item = body
    rig = item.rig
    try:
        ridge = build_ridge(rig)
        hold = posed_at(item, "reach_up_both", 1.9)
        rest = posed_at(item, "reach_up_both", 0.0)
        assert (
            ridge_factor(
                hold.skin[ridge.upper_bone[0], :3, :3],
                hold.skin[ridge.clavicle_bone[0], :3, :3],
                ridge.humerus_rest[0],
            )
            > 0.8
        )
        rig.ridge = None
        before, plain = lbs(rig, rest.skin), lbs(rig, hold.skin)
        rig.ridge = ridge
        ridged = lbs(rig, hold.skin)
        for cm in (12, 15, 18):  # plain LBS collapses the ridge (> 1 cm drop)
            assert max(slice_rise(rig, before, plain, cm)) < -0.01, cm
        for cm in (9, 12, 15, 18, 21):  # the transfer: 0 to +3 cm (lead's target), 5 mm slack
            assert all(-0.005 <= x <= 0.035 for x in slice_rise(rig, before, ridged, cm)), cm
    finally:
        rig.ridge = None


@pytest.mark.parametrize("motion_id", tuple(MOTIONS))
def test_frames_are_unchanged_and_the_rig_declares_the_mode(fitter, monkeypatch, motion_id):
    body_id = fitter.fit(FitRequest(sex="female", height_cm=165, weight_kg=60)).response.body_id
    monkeypatch.setitem(config.SHOULDER_RIDGE, "enabled", False)
    off = MotionService(fitter)
    frames_off = off.frames_bytes(body_id, motion_id)
    rig_off, _ = decode(off.rig_bytes(body_id))
    monkeypatch.setitem(config.SHOULDER_RIDGE, "enabled", True)
    on = MotionService(fitter)
    assert on.frames_bytes(body_id, motion_id) == frames_off
    meta, blobs = decode(on.rig_bytes(body_id))
    assert rig_off["skinning"] == "lbs" and meta["skinning"] == "lbs-ridge1"
    assert meta["ridge"]["ramp_deg"] == [90.0, 180.0]
    assert len(blobs["ridge_vertices"]) == len(blobs["ridge_mask"]) > 50
    assert len(frame_times(MOTIONS[motion_id])) > 0


def test_ridge_skin_is_in_the_exact_zone(body):
    """The collider must follow the transferred skin: no ridge vertex stays in a rigid core."""
    _, _, item = body
    rig = item.rig
    try:
        rig.ridge = build_ridge(rig)
        field = build_fields(rig)
        assert np.isin(rig.ridge.vertices, field.zone.vertices).all()
        for segment in field.fields:
            assert not np.isin(segment.vertex_ids, rig.ridge.vertices).any(), segment.name
    finally:
        rig.ridge = None
