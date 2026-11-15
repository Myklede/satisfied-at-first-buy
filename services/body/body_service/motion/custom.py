"""Custom (recorded) motions: "Record a move" (prompt 14).

The client sends a pose sequence captured from the camera, `{fps, poses: [{t, pose}]}`, and
gets back the same `motion-frames` container as a preset (FORMAT.md). The sequence becomes a
`Motion` whose keyframes are the samples, so it runs through exactly the preset code path:
`resolve` (unlisted DOFs = the body's neutral display pose), `sample` (smoothstep between
consecutive samples), `pose_skeleton` (same rig, clamping, trunk solve, pelvis drop and foot
planting) at the preset frame rate `config.FPS`. A request built from a preset's keyframes
therefore yields that preset's frames bit for bit (tests/test_motion_custom.py).

Validation at the boundary (prompt 14): unknown fields and unknown DOFs are rejected, every
number must be finite, every angle must lie inside the rig's anatomical limits
(config.LIMITS_DEG, which contain the motion contract's ranges), times are seconds from the
start of the recording, strictly increasing, at most config.CUSTOM_MAX_DURATION_S.

Privacy: the poses are body data. They are never logged and never cached; the service
computes the frames, returns them and keeps nothing but the timing.
"""

import math
from typing import Annotated

from pydantic import Field, field_validator, model_validator

from ..schemas import Number, StrictModel
from . import config
from .angles import AnatomicalPose, limit_key
from .presets import Hold, Keyframe, Motion

CUSTOM_ID = "custom"
CUSTOM_LABEL = "Recorded move"
DOFS = tuple(AnatomicalPose.model_fields)
MAX_SAMPLES = math.ceil(config.CUSTOM_MAX_DURATION_S * config.CUSTOM_FPS_RANGE[1]) + 1


class CustomSample(StrictModel):
    # Seconds from the start of the recording (the first sample is at 0).
    t: Annotated[Number, Field(ge=0, le=config.CUSTOM_MAX_DURATION_S)]
    # Partial AnatomicalPose (contract degrees; pelvis_drop_m in metres). A DOF the client did
    # not estimate (low confidence) is left out and takes the body's neutral value, exactly as
    # an unlisted DOF in a preset keyframe does. pelvis_drop_m is accepted for round-tripping;
    # the rig always solves it from the foot rule.
    pose: dict[str, Number]

    @field_validator("pose")
    @classmethod
    def inside_limits(cls, value: dict[str, float]) -> dict[str, float]:
        unknown = set(value) - set(DOFS)
        if unknown:
            raise ValueError(f"Unknown DOFs {sorted(unknown)}")
        for dof, x in value.items():
            if dof == "pelvis_drop_m":
                low, high = 0.0, 0.6  # AnatomicalPose's own bound (motion contract)
            else:
                low, high = config.LIMITS_DEG[limit_key(dof)]
            if not low <= x <= high:
                raise ValueError(f"{dof} outside the anatomical limits [{low}, {high}]")
        return value


class CustomMotionRequest(StrictModel):
    # Nominal rate (Hz) the poses were sampled at; bounds the sample count.
    fps: Annotated[Number, Field(ge=config.CUSTOM_FPS_RANGE[0], le=config.CUSTOM_FPS_RANGE[1])]
    poses: Annotated[list[CustomSample], Field(min_length=2, max_length=MAX_SAMPLES)]

    @model_validator(mode="after")
    def timeline(self) -> "CustomMotionRequest":
        times = [p.t for p in self.poses]
        if times[0] != 0:
            raise ValueError("the first pose must be at t = 0 s")
        if any(b <= a for a, b in zip(times, times[1:], strict=False)):
            raise ValueError("pose times must be strictly increasing")
        if len(times) > math.ceil(config.CUSTOM_MAX_DURATION_S * self.fps) + 1:
            raise ValueError("more poses than the declared fps allows")
        return self


def lead_s(pose: dict[str, float], neutral: AnatomicalPose | None) -> float:
    """Length of the transition between the neutral pose and `pose` (0 when `pose` is the
    empty neutral pose): at least CUSTOM_LEAD_S, and long enough that the largest angle change
    moves at most CUSTOM_LEAD_SPEED_DEG_S on average (the presets' validated ramp speed)."""
    if not pose:
        return 0.0
    if neutral is None:
        return config.CUSTOM_LEAD_S
    base = neutral.model_dump()
    change = max((abs(v - base[d]) for d, v in pose.items() if d != "pelvis_drop_m"), default=0.0)
    return max(config.CUSTOM_LEAD_S, change / config.CUSTOM_LEAD_SPEED_DEG_S)


def custom_motion(request: CustomMotionRequest, neutral: AnatomicalPose | None = None) -> Motion:
    """The request as a `Motion`. When the recording does not start (end) at the neutral pose
    (an empty partial pose), a neutral keyframe is added before (after) it, as every preset
    starts and ends at neutral; the transition length is `lead_s` against the body's `neutral`.
    `hold` = the recorded window."""
    lead_in = lead_s(request.poses[0].pose, neutral)
    lead_out = lead_s(request.poses[-1].pose, neutral)
    frames = [Keyframe(t_s=p.t + lead_in, pose=dict(p.pose)) for p in request.poses]
    span = request.poses[-1].t
    if lead_in:
        frames.insert(0, Keyframe(t_s=0.0, pose={}))
    if lead_out:
        frames.append(Keyframe(t_s=lead_in + span + lead_out, pose={}))
    return Motion(
        id=CUSTOM_ID,
        label=CUSTOM_LABEL,
        duration_s=frames[-1].t_s,
        hold=Hold(start_s=lead_in, end_s=lead_in + span),
        keyframes=frames,
    )


def custom_frame_times(motion: Motion, fps: int = config.FPS) -> list[float]:
    """Frame i at i / fps, through the first frame at or after the last keyframe (so the last
    frame is the final pose). Same as presets.frame_times when duration_s is a multiple of
    1/fps, which every preset's is."""
    count = math.ceil(round(motion.duration_s * fps, 6))
    return [i / fps for i in range(count + 1)]
