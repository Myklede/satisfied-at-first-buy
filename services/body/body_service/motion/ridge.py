"""Shoulder-ridge weight transfer (V3, the collar study; lead-approved option b1).

Linear blend skinning collapses the top of the shoulder when the arm is raised: the trapezius
ridge skin between the neck and the acromion is partly weighted to the upper arm, so it swings
about the glenohumeral joint (inward and down) with the humerus. Measured at the hold of
reach_up_both (user body): the ridge 9-21 cm from the midline drops 1.4-3.6 cm while the
glenohumeral joint rises 4.3 cm; a jacket's yoke resting there cannot rise, and the back
panel tears away under the bunched yoke (docs/STATUS-tryon-physics.md).

Rule (one place; the TS skinning in apps/web/src/engine/motion/rig.ts implements the same
from the data this module exports in rig.bin, so no client recomputes the mask):
  - static mask m_v in [0, max_share] for skin around the top of each glenohumeral joint that
    carries upper-arm weight: a smoothstep ramp in the height relative to the joint, times one
    minus a smoothstep ramp in the lateral distance past it (config.SHOULDER_RIDGE);
  - per-frame factor r_s from the driver transforms only: the humerus direction relative to
    the clavicle driver, e = angle to the rest-frame down axis, r = smoothstep((e - 90) / 90);
  - p' = p_lbs + m_v * r_s * w_U(v) * (T_clavicle - T_upperarm) [v, 1]: exactly the LBS of
    the same vertex with that share of its upper-arm weight moved to the clavicle.
At rest and while the arm is below 90 degrees r = 0: skinning is unchanged bit for bit.
"""

from dataclasses import dataclass

import numpy as np

from . import config

SIDES = ("L", "R")


def smoothstep(x: np.ndarray | float) -> np.ndarray | float:
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


@dataclass
class RidgeTransfer:
    vertices: np.ndarray  # (M,) vertex ids with a nonzero mask
    mask: np.ndarray  # (M,) m_v in (0, 1]
    upper_weight: np.ndarray  # (M,) w_U(v): weight on that side's upper-arm driver
    side: np.ndarray  # (M,) 0 = L, 1 = R
    upper_bone: tuple[int, int]
    clavicle_bone: tuple[int, int]
    upper_driver: tuple[int, int]  # slots in rig.drivers
    clavicle_driver: tuple[int, int]
    humerus_rest: np.ndarray  # (2, 3) unit rest humerus directions (shoulder -> elbow)


def build_ridge(rig) -> RidgeTransfer:
    cfg = config.SHOULDER_RIDGE
    slot = {int(b): i for i, b in enumerate(rig.drivers)}
    verts, masks, weights, sides = [], [], [], []
    upper_bone, clav_bone, upper_drv, clav_drv, humerus = [], [], [], [], []
    for s, side in enumerate(SIDES):
        upper = rig.bone(f"upperarm01.{side}")
        clav = rig.bone(f"clavicle.{side}")
        upper_bone.append(upper)
        clav_bone.append(clav)
        upper_drv.append(slot[upper])
        clav_drv.append(slot[clav])
        joint = rig.head(f"upperarm01.{side}")
        h = rig.head(f"lowerarm01.{side}") - joint
        humerus.append(h / np.linalg.norm(h))
        on_upper = rig.driver_of[rig.indices] == slot[upper]  # (V, K)
        w_upper = (rig.weights * on_upper).sum(1)
        height = rig.vertices[:, 1] - joint[1]
        lateral = np.abs(rig.vertices[:, 0]) - abs(joint[0])
        mask = (
            cfg["max_share"]
            * smoothstep((height - cfg["height_from_m"]) / cfg["height_ramp_m"])
            * (1 - smoothstep((lateral - cfg["lateral_from_m"]) / cfg["lateral_ramp_m"]))
        )
        same_side = np.sign(rig.vertices[:, 0]) == np.sign(joint[0])
        keep = np.flatnonzero((mask > 0) & (w_upper > 0) & same_side)
        verts.append(keep)
        masks.append(mask[keep])
        weights.append(w_upper[keep])
        sides.append(np.full(len(keep), s))
    return RidgeTransfer(
        vertices=np.concatenate(verts),
        mask=np.concatenate(masks),
        upper_weight=np.concatenate(weights),
        side=np.concatenate(sides),
        upper_bone=(upper_bone[0], upper_bone[1]),
        clavicle_bone=(clav_bone[0], clav_bone[1]),
        upper_driver=(upper_drv[0], upper_drv[1]),
        clavicle_driver=(clav_drv[0], clav_drv[1]),
        humerus_rest=np.array(humerus),
    )


def ridge_factor(
    rot_upper: np.ndarray, rot_clavicle: np.ndarray, humerus_rest: np.ndarray
) -> float:
    """r = smoothstep((e - lo) / (hi - lo)), e = elevation of the humerus relative to the
    clavicle driver, measured from the rest-frame down axis (degrees)."""
    lo, hi = config.SHOULDER_RIDGE["ramp_deg"]
    h = rot_clavicle.T @ (rot_upper @ humerus_rest)
    e = np.degrees(np.arccos(np.clip(-h[1] / np.linalg.norm(h), -1.0, 1.0)))
    return float(smoothstep((e - lo) / (hi - lo)))


def ridge_correction(
    rig, ridge: RidgeTransfer, skin: np.ndarray, ids: np.ndarray | None
) -> tuple[np.ndarray, np.ndarray]:
    """(rows of the output, displacements) to add to lbs() for the vertex selection `ids`."""
    factors = [
        ridge_factor(
            skin[ridge.upper_bone[s], :3, :3],
            skin[ridge.clavicle_bone[s], :3, :3],
            ridge.humerus_rest[s],
        )
        for s in range(2)
    ]
    if factors[0] == 0.0 and factors[1] == 0.0:
        return np.zeros(0, dtype=int), np.zeros((0, 3))
    if ids is None:
        rows = ridge.vertices
        sel = np.arange(len(ridge.vertices))
    else:
        position = {int(v): i for i, v in enumerate(ids)}
        sel = np.array([j for j, v in enumerate(ridge.vertices) if int(v) in position], dtype=int)
        rows = np.array([position[int(ridge.vertices[j])] for j in sel], dtype=int)
    if not len(sel):
        return rows, np.zeros((0, 3))
    side = ridge.side[sel]
    t = ridge.mask[sel] * ridge.upper_weight[sel] * np.array(factors)[side]
    v = np.c_[rig.vertices[ridge.vertices[sel]], np.ones(len(sel))]
    upper = skin[np.array(ridge.upper_bone)[side]][:, :3, :]
    clav = skin[np.array(ridge.clavicle_bone)[side]][:, :3, :]
    delta = np.einsum("vij,vj->vi", clav - upper, v)
    return rows, delta * t[:, None]
