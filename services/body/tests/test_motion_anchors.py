import numpy as np
import pytest
from body_service.motion import config
from body_service.motion.anchors import build_anchors, frame_anchors
from body_service.motion.presets import MOTIONS, resolve, sample
from body_service.motion.rig import build_rig, neutral_pose, pose_skeleton
from body_service.schemas import FitRequest


@pytest.fixture(scope="module")
def setup(fitter):
    body = fitter.fit(FitRequest(sex="female", height_cm=170, weight_kg=68))
    rig = build_rig(fitter.engine, body)
    return body, rig, build_anchors(rig, body), neutral_pose(fitter.engine, body, rig)


def test_ring_index_convention_and_heights(setup):
    body, rig, anchors, _ = setup
    n = config.RING_SAMPLES
    for name, ring in anchors.rings.items():
        rest = ring.rest
        centre = rest.mean(0)
        assert np.ptp(rest[:, 1]) < 1e-9, name  # horizontal at rest
        assert rest[0, 2] > centre[2] and rest[n // 2, 2] < centre[2]  # front / back centre
        assert rest[n // 4, 0] > centre[0] > rest[3 * n // 4, 0]  # subject's left = +X
        assert np.allclose(rest.mean(0)[1], anchors.heights[name])
    h = anchors.heights
    assert h["chest"] > h["waistband_high"] > h["waistband_mid"] > h["waistband_low"]
    assert np.isclose(h["waistband_high"], h["waist"]) and np.isclose(h["waistband_low"], h["hip"])
    assert np.isclose(h["waist"], body.geometry.landmarks["waist_level"][1])
    assert np.isclose(h["hip"], body.geometry.landmarks["hip_level"][1])


def test_exposure_masks_are_nested_torso_regions(setup):
    _, rig, anchors, _ = setup
    low, mid, high = (set(anchors.exposure[k].tolist()) for k in ("low", "mid", "high"))
    assert high < mid < low
    y = rig.vertices[list(low), 1]
    assert y.min() >= anchors.heights["waistband_low"] and y.max() <= anchors.heights["chest"]
    z = rig.vertices[list(mid), 2]
    assert (z > 0).any() and (z < 0).any()  # front and back


def test_frame_anchors_follow_the_skin(setup):
    _, rig, anchors, neutral = setup
    rest = frame_anchors(rig, anchors, np.tile(np.eye(4), (len(rig.labels), 1, 1)), rig.rest)
    for name, ring in anchors.rings.items():
        assert np.allclose(rest[f"ring.{name}"], ring.rest, atol=1e-6)
    assert np.allclose(rest["up.waistband_mid"], [0, 1, 0], atol=1e-6)
    assert np.allclose(rest["tape.waist"], anchors.tapes["waist"].rest, atol=1e-6)
    motion = MOTIONS["reach_up_both"]
    posed = pose_skeleton(rig, sample(resolve(motion, neutral), motion.hold.start_s))
    out = frame_anchors(rig, anchors, posed.skin, posed.world)
    wrists = out["points"][:2]
    assert (wrists[:, 1] > rest["points"][:2, 1] + 0.5).all()  # wrists rise with the arms
    assert np.linalg.norm(out["joints"][0] - posed.world[rig.bone("wrist.L"), :3, 3]) == 0
    bend = MOTIONS["bend_tie_shoes"]
    posed = pose_skeleton(rig, sample(resolve(bend, neutral), bend.hold.start_s))
    up = frame_anchors(rig, anchors, posed.skin, posed.world)["up.waistband_mid"]
    assert (up[:, 2] > 0.5).mean() > 0.9  # the torso "vertical" tips forward when bending
