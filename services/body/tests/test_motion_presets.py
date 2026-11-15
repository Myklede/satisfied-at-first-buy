import pytest
from body_service.motion import config
from body_service.motion.angles import AnatomicalPose
from body_service.motion.presets import MOTIONS, Keyframe, ease, frame_times, resolve, sample
from pydantic import ValidationError


def test_every_motion_starts_and_ends_neutral_with_a_hold_at_the_peak():
    neutral = AnatomicalPose(shoulder_L_elevation=27, hip_L_flexion=8)
    for motion in MOTIONS.values():
        frames = motion.keyframes
        assert frames[0].t_s == 0 and frames[0].pose == {} and frames[-1].pose == {}
        assert frames[-1].t_s == motion.duration_s
        assert [k.t_s for k in frames] == sorted(k.t_s for k in frames)
        assert 0 < motion.hold.start_s < motion.hold.end_s < motion.duration_s
        keys = resolve(motion, neutral)
        assert sample(keys, motion.hold.start_s) == sample(keys, motion.hold.end_s)
        assert sample(keys, 0.0) == neutral == sample(keys, motion.duration_s)
        assert len(frame_times(motion)) == round(motion.duration_s * config.FPS) + 1


def test_smoothstep_has_zero_velocity_at_keyframes():
    h = 1e-6
    assert ease(0) == 0 and ease(1) == 1
    assert abs((ease(h) - ease(0)) / h) < 1e-5 and abs((ease(1) - ease(1 - h)) / h) < 1e-5


def test_keyframes_reject_unknown_or_out_of_range_dofs():
    with pytest.raises(ValidationError):
        Keyframe(t_s=0, pose={"neck_flexion": 10})
    with pytest.raises(ValidationError):
        Keyframe(t_s=0, pose={"pelvis_drop_m": 2.0})


def test_peaks_are_inside_the_anatomical_limits():
    from body_service.motion.angles import clamp_pose

    for motion in MOTIONS.values():
        for key in motion.keyframes:
            assert clamp_pose(AnatomicalPose(**key.pose))[1] == [], motion.id
