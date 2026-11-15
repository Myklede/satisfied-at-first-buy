"""The six contract motions as keyframed `AnatomicalPose` curves.

Keyframes are PARTIAL poses: a DOF a keyframe does not list takes the body's neutral value,
i.e. its display pose (body_service.pose, on which the garment is draped) measured in
contract angles by rig.measure_pose. Every motion starts and ends exactly at neutral, so
the cloth starts from its settled drape without a jump. (Measured on Anny's rest legs the
neutral reads hips ~8 deg and knees ~7.5 deg, because contract hip angles are taken from
the calibrated vertical; see FORMAT.md.)

Interpolation between consecutive keyframes uses the cubic smoothstep 3t^2 - 2t^3
(ease-in/ease-out, zero velocity at every keyframe, C1 continuous).

Peak angles (justifications; limits from AAOS normal ROM, see config.LIMITS_DEG):
- reach_up_both: elevation 170 in the plane of elevation 40 (the scapular plane, about
  30-45 degrees anterior to the frontal plane; Ludewig et al. 2009 used 40). 170 stays 10
  below the AAOS maximum of 180: an everyday reach, not an end-range stretch. Elbows 10.
- reach_up_one: right arm in the same plane at 175 (the side bend adds reach),
  trunk_lateral -10 (lean to the LEFT, which raises the reaching right shoulder).
- reach_forward: plane 90 (sagittal), elevation 80 (hands just below shoulder height =
  chest height), elbows 25 ("slightly bent"). ISB axial 0 leaves the bent forearms pointing
  medially: the hugging / steering-wheel posture.
- sit: hips 90 and knees 90, trunk_flexion 10 (contract). The descent passes through hips
  and knees 45 with the trunk leaning forward 25 (centre of mass over the feet first).
- bend_tie_shoes: trunk_flexion 90 (contract maximum; 49.5 pelvic + 40.5 spinal drive,
  inside AAOS hip flexion 120 / spine flexion 80), thighs 15 forward and knees 30 (a soft
  knee bend; implied ankle dorsiflexion ~15 inside AAOS 20), arms plane 90 elevation 100
  relative to the bent thorax (pointing down toward the feet), elbows 10.
- cross_arms: humerus forward and across (plane 110) with the elbows at 115 so each hand
  reaches toward the opposite arm; left arm 10 degrees higher (65 vs 55) so the forearms
  stack. ISB axial -30: with the plane rotation already turning the arm ~110 degrees, this
  leaves the bent forearms pointing medially across the chest. Chosen by
  scripts/motion-cross-arms.py over plane 110-135, elevation 35-55 (+10 left), axial
  -60..-15 and elbow 115-135 on three reference bodies (175/75 and 185/92 male, 158/52
  female): only 2 of 144 candidates keep the forearms out of the torso (<= 1 cm) and apart
  (>= 4 mm); this one has 2.7 mm clearance from the torso, 5.7 mm between the forearms and
  the left wrist 5.4 cm past the midline (worst body). Lower elevations put the forearms
  into the chest/abdomen of the heavier body.
"""

from pydantic import BaseModel, ConfigDict, Field, field_validator

from . import config
from .angles import AnatomicalPose, lerp_pose

DOFS = tuple(AnatomicalPose.model_fields)


class Keyframe(BaseModel):
    model_config = ConfigDict(extra="forbid")
    t_s: float = Field(ge=0)
    # Partial pose; unlisted DOFs = the body's neutral (display) pose.
    pose: dict[str, float]

    @field_validator("pose")
    @classmethod
    def known(cls, value: dict[str, float]) -> dict[str, float]:
        unknown = set(value) - set(DOFS)
        if unknown:
            raise ValueError(f"Unknown DOFs {sorted(unknown)}")
        AnatomicalPose(**value)  # range validation
        return value


class Hold(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start_s: float = Field(ge=0)
    end_s: float = Field(ge=0)


class Motion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    label: str
    duration_s: float = Field(gt=0)
    hold: Hold
    keyframes: list[Keyframe]


def _both(prefix: str, value: float) -> dict[str, float]:
    return {prefix.replace("{s}", s): value for s in ("L", "R")}


def _motion(
    id_: str,
    label: str,
    peak: list[tuple[float, dict[str, float]]],
    hold: tuple[float, float],
    duration: float,
) -> Motion:
    frames = [Keyframe(t_s=0.0, pose={})]
    frames += [Keyframe(t_s=t, pose=p) for t, p in peak]
    frames.append(Keyframe(t_s=duration, pose={}))
    return Motion(
        id=id_,
        label=label,
        duration_s=duration,
        hold=Hold(start_s=hold[0], end_s=hold[1]),
        keyframes=frames,
    )


# Cross-arms peak (see module docstring). Chosen by scripts/motion-cross-arms.py, which
# grid-searches plane / elevation / axial / elbow on three reference bodies for minimal
# forearm-torso penetration, no forearm-forearm overlap and the wrists past the midline.
CROSS_ARMS = {
    "shoulder_L_plane": 110.0,
    "shoulder_L_elevation": 65.0,
    "shoulder_L_axial": -30.0,
    "elbow_L_flexion": 115.0,
    "shoulder_R_plane": 110.0,
    "shoulder_R_elevation": 55.0,
    "shoulder_R_axial": -30.0,
    "elbow_R_flexion": 115.0,
}


def _build() -> dict[str, Motion]:
    up = {
        **_both("shoulder_{s}_plane", 40),
        **_both("shoulder_{s}_elevation", 170),
        **_both("shoulder_{s}_axial", 0),
        **_both("elbow_{s}_flexion", 10),
    }
    one = {
        "shoulder_R_plane": 40,
        "shoulder_R_elevation": 175,
        "shoulder_R_axial": 0,
        "elbow_R_flexion": 8,
        "trunk_lateral": -10,
    }
    forward = {
        **_both("shoulder_{s}_plane", 90),
        **_both("shoulder_{s}_elevation", 80),
        **_both("shoulder_{s}_axial", 0),
        **_both("elbow_{s}_flexion", 25),
    }
    descend = {"trunk_flexion": 25, **_both("hip_{s}_flexion", 45), **_both("knee_{s}_flexion", 45)}
    seated = {"trunk_flexion": 10, **_both("hip_{s}_flexion", 90), **_both("knee_{s}_flexion", 90)}
    bend = {
        "trunk_flexion": 90,
        **_both("hip_{s}_flexion", 15),
        **_both("knee_{s}_flexion", 30),
        **_both("shoulder_{s}_plane", 90),
        **_both("shoulder_{s}_elevation", 100),
        **_both("shoulder_{s}_axial", 0),
        **_both("elbow_{s}_flexion", 10),
    }
    motions = [
        _motion(
            "reach_up_both", "Reach up with both arms", [(1.3, up), (2.5, up)], (1.3, 2.5), 3.8
        ),
        _motion(
            "reach_up_one",
            "Reach a high shelf (right arm)",
            [(1.3, one), (2.5, one)],
            (1.3, 2.5),
            3.8,
        ),
        _motion(
            "reach_forward",
            "Reach forward (driving / hug)",
            [(1.1, forward), (2.3, forward)],
            (1.1, 2.3),
            3.4,
        ),
        _motion(
            "sit",
            "Sit on a chair",
            [(0.9, descend), (1.8, seated), (3.0, seated), (3.9, descend)],
            (1.8, 3.0),
            4.8,
        ),
        _motion("bend_tie_shoes", "Bend to tie shoes", [(1.6, bend), (2.8, bend)], (1.6, 2.8), 4.4),
        _motion(
            "cross_arms", "Cross arms", [(1.2, CROSS_ARMS), (2.4, CROSS_ARMS)], (1.2, 2.4), 3.6
        ),
    ]
    return {m.id: m for m in motions}


MOTIONS: dict[str, Motion] = _build()


def ease(t: float) -> float:
    return t * t * (3 - 2 * t)


def resolve(motion: Motion, neutral: AnatomicalPose) -> list[tuple[float, AnatomicalPose]]:
    """Full keyframe poses for one body: neutral updated with each keyframe's DOFs."""
    return [(k.t_s, neutral.model_copy(update=k.pose)) for k in motion.keyframes]


def sample(keys: list[tuple[float, AnatomicalPose]], t_s: float) -> AnatomicalPose:
    if t_s <= keys[0][0]:
        return keys[0][1]
    for (ta, a), (tb, b) in zip(keys, keys[1:], strict=False):
        if t_s <= tb:
            return lerp_pose(a, b, ease((t_s - ta) / (tb - ta)))
    return keys[-1][1]


def frame_times(motion: Motion, fps: int = config.FPS) -> list[float]:
    count = int(round(motion.duration_s * fps))
    return [i / fps for i in range(count + 1)]
