"""`AnatomicalPose` from prompts/motion-contract.md, plus anatomical clamping.

Degrees; 0 = relaxed neutral standing with the arms hanging at the sides. Shoulder
angles follow the ISB recommendation (Wu G et al., "ISB recommendation on definitions of
joint coordinate systems ... Part II: shoulder, elbow, wrist and hand", J Biomech
2005;38:981-992): humerothoracic plane of elevation, elevation and axial rotation (Y-X-Y).
"""

import math

from pydantic import BaseModel, ConfigDict, Field, field_validator

from . import config

SIDES = ("L", "R")
# Wide sanity bound at the API boundary; anatomical clamping happens in `clamp_pose`.
_ANGLE = Field(default=0.0, ge=-360.0, le=360.0)


class AnatomicalPose(BaseModel):
    model_config = ConfigDict(extra="forbid")

    trunk_flexion: float = _ANGLE
    trunk_lateral: float = _ANGLE
    trunk_twist: float = _ANGLE
    shoulder_L_plane: float = _ANGLE
    shoulder_L_elevation: float = _ANGLE
    shoulder_L_axial: float = _ANGLE
    shoulder_R_plane: float = _ANGLE
    shoulder_R_elevation: float = _ANGLE
    shoulder_R_axial: float = _ANGLE
    elbow_L_flexion: float = _ANGLE
    elbow_R_flexion: float = _ANGLE
    hip_L_flexion: float = _ANGLE
    hip_R_flexion: float = _ANGLE
    knee_L_flexion: float = _ANGLE
    knee_R_flexion: float = _ANGLE
    # Contract: P1 solves it so the feet stay on the floor. The rig always solves it and
    # reports the solved value; an input value is accepted for round-tripping only.
    pelvis_drop_m: float = Field(default=0.0, ge=0.0, le=0.6)

    @field_validator("*")
    @classmethod
    def finite(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("pose values must be finite")
        return value

    def mirrored(self) -> "AnatomicalPose":
        """Swap L and R and negate the lateral/twist DOFs (sagittal mirror)."""
        data = self.model_dump()
        out = dict(data)
        for key, value in data.items():
            if "_L_" in key:
                out[key.replace("_L_", "_R_")] = value
            elif "_R_" in key:
                out[key.replace("_R_", "_L_")] = value
        out["trunk_lateral"] = -data["trunk_lateral"]
        out["trunk_twist"] = -data["trunk_twist"]
        return AnatomicalPose(**out)


class Clamp(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dof: str
    requested: float
    applied: float


def limit_key(dof: str) -> str:
    for side in SIDES:
        dof = dof.replace(f"_{side}_", "_")
    return dof


def clamp_pose(pose: AnatomicalPose) -> tuple[AnatomicalPose, list[Clamp]]:
    """Clamp every angle DOF to config.LIMITS_DEG and report each change."""
    data = pose.model_dump()
    clamps = []
    for dof, value in data.items():
        if dof == "pelvis_drop_m":
            continue
        low, high = config.LIMITS_DEG[limit_key(dof)]
        applied = min(max(value, low), high)
        if applied != value:
            clamps.append(Clamp(dof=dof, requested=value, applied=applied))
            data[dof] = applied
    return AnatomicalPose(**data), clamps


def lerp_pose(a: AnatomicalPose, b: AnatomicalPose, t: float) -> AnatomicalPose:
    da, db = a.model_dump(), b.model_dump()
    return AnatomicalPose(**{k: da[k] + (db[k] - da[k]) * t for k in da})
