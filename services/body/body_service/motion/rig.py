"""Map an `AnatomicalPose` onto Anny's 104-bone skeleton (scene frame, metres).

Everything is computed in the scene frame of body_service.model.scene_points: X = the
subject's LEFT, Y up, +Z front, feet on Y = 0. Bones carry world 4x4 poses `W_b`; the
skinning transform is `T_b = W_b @ inv(R_b)` with `R_b` the rest world pose, exactly the
quantity Anny's own `get_bone_transforms(..., "world")` returns (checked in the tests).

Mapping summary (see the docstrings below and FORMAT.md for the table):
The conventions are those of prompts/motion-contract.md as implemented by P3's estimator
(packages/vision/src/anatomicalPose.ts): every angle the rig produces is the angle P3's
formulas MEASURE on the rig's own joints (cross-checked in test_motion_contract.py).
- trunk: drive angles are split into pelvic rotation over the hip axis
  (PELVIC_FLEXION_SHARE of flexion) and spine05..spine01 rotations in White & Panjabi
  proportions, then solved so that the measured trunk axis (mid-hip -> mid-shoulder)
  flexion/lateral and shoulder-line-vs-hip-line twist equal the requested values.
- shoulders: ISB Y-X-Y R = Ry(plane) Rx(-elevation) Ry(axial) relative to the posed
  thorax frame from the joints (left side mirrored), applied at upperarm01 after a
  clavicle shrug (scapulohumeral rhythm); the humerus orientation is set exactly.
- elbows: lowerarm01 rotated about the humeral flexion axis to the absolute angle.
- hips: thigh sagittal angle from the vertical (independent of the trunk); knees: 3D
  thigh-shank angle; feet kept flat (implied ankle angle reported).
- support: root translated so the feet are planted (lowest foot vertex on Y = 0, rest
  mid-foot x/z). The downward part is the solved `pelvis_drop_m`.
"""

from dataclasses import dataclass, field

import numpy as np
import torch
import trimesh

from . import config
from .angles import AnatomicalPose, Clamp, clamp_pose

X, Y, Z = np.eye(3)


def axis_angle(axis: np.ndarray, angle: float) -> np.ndarray:
    """Rodrigues rotation matrix; `angle` in radians, right-handed about `axis`."""
    x, y, z = float(axis[0]), float(axis[1]), float(axis[2])
    norm = (x * x + y * y + z * z) ** 0.5
    if norm == 0.0 or angle == 0.0:
        return np.eye(3)
    x, y, z = x / norm, y / norm, z / norm
    c, s = np.cos(angle), np.sin(angle)
    t = 1.0 - c
    return np.array(
        [
            [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
            [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
            [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
        ]
    )


def frame(long_axis: np.ndarray, toward: np.ndarray) -> np.ndarray:
    """Right-handed basis [y, f, k]: y = long axis, f = `toward` made perpendicular."""
    y = long_axis / np.linalg.norm(long_axis)
    f = toward - y * (toward @ y)
    norm = np.linalg.norm(f)
    if norm < 1e-9:
        raise ValueError("Degenerate frame: reference direction is parallel to the long axis")
    f /= norm
    return np.stack((y, f, np.cross(y, f)), axis=1)


@dataclass
class RestRig:
    labels: list[str]
    parents: np.ndarray  # (B,) parent index, -1 for the root
    rest: np.ndarray  # (B, 4, 4) rest world poses, scene frame
    vertices: np.ndarray  # (V, 3) rest vertices, scene frame (== FittedBody.mesh.vertices)
    faces: np.ndarray  # (F, 3)
    weights: np.ndarray  # (V, K) skin weights (rows sum to 1)
    indices: np.ndarray  # (V, K) bone indices
    subtree: list[np.ndarray] = field(default_factory=list)
    humerus: dict[str, tuple[np.ndarray, float]] = field(default_factory=dict)
    foot_vertices: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=int))
    # Bones that pose_skeleton rotates; every other bone inherits its nearest driver
    # ancestor's skinning transform exactly (rigid descendants), so exports send only these.
    drivers: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=int))
    driver_of: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=int))
    # Calibrated reference frame (scene axes): vertical = rest trunk axis (mid-hip ->
    # mid-shoulder), like P3's neutral-stance calibration, so the rest trunk reads 0;
    # right = hip line made perpendicular to it; forward = vertical x right.
    # Shoulder-ridge weight transfer (ridge.py); None = plain LBS (config.SHOULDER_RIDGE off).
    ridge: object | None = None
    vertical: np.ndarray = field(default_factory=lambda: Y.copy())
    forward: np.ndarray = field(default_factory=lambda: Z.copy())
    right: np.ndarray = field(default_factory=lambda: -X.copy())

    def bone(self, label: str) -> int:
        return self.labels.index(label)

    def head(self, label: str, poses: np.ndarray | None = None) -> np.ndarray:
        return (self.rest if poses is None else poses)[self.bone(label), :3, 3]

    def bone_weight(self, bones: list[int] | np.ndarray) -> np.ndarray:
        """Per-vertex total skin weight carried by `bones`."""
        return (self.weights * np.isin(self.indices, bones)).sum(1)


def build_rig(engine, body) -> RestRig:
    """Rest skeleton + skin of a fitted body (same construction as pose.display_body)."""
    model = engine.model
    with torch.no_grad():
        coefficients = model.get_phenotype_blendshape_coefficients(
            **body.response.phenotypes, local_changes=body.response.local_changes
        )
        data = model.get_rest_model(coefficients)
    native = data["rest_vertices"][0].numpy().astype(np.float64)
    floor = float(native[:, 2].min())
    # Anny native (X, Z up, -Y front) -> scene (X, Y up, +Z front), feet at Y = 0.
    conversion = np.array([[1, 0, 0, 0], [0, 0, 1, -floor], [0, -1, 0, 0], [0, 0, 0, 1.0]])
    rest = conversion @ data["rest_bone_poses"][0].numpy().astype(np.float64)
    vertices = (np.c_[native, np.ones(len(native))] @ conversion.T)[:, :3]
    if not np.allclose(vertices, body.mesh.vertices, atol=1e-5):
        raise RuntimeError("Rig rest vertices differ from the fitted body mesh")
    labels = list(model.bone_labels)
    parents = np.array(model.bone_parents, dtype=int)
    rig = RestRig(
        labels=labels,
        parents=parents,
        rest=rest,
        vertices=vertices,
        faces=np.asarray(engine.faces, dtype=np.int64),
        weights=model.vertex_bone_weights.numpy().astype(np.float64),
        indices=model.vertex_bone_indices.numpy().astype(np.int64),
    )
    children: list[list[int]] = [[] for _ in labels]
    for i, p in enumerate(parents):
        if p >= 0:
            children[p].append(i)

    def collect(i: int) -> list[int]:
        out = [i]
        for c in children[i]:
            out += collect(c)
        return out

    rig.subtree = [np.array(collect(i)) for i in range(len(labels))]
    for side in ("L", "R"):
        shoulder = rig.head(f"upperarm01.{side}")
        elbow = rig.head(f"lowerarm01.{side}")
        wrist = rig.head(f"wrist.{side}")
        upper, fore = elbow - shoulder, wrist - elbow
        # Rest humerus frame: long axis distal, f = direction the forearm flexes toward.
        rest_frame = frame(upper, fore)
        flexion = float(
            np.arccos(np.clip(upper @ fore / np.linalg.norm(upper) / np.linalg.norm(fore), -1, 1))
        )
        rig.humerus[side] = (rest_frame, flexion)
    feet = np.concatenate([rig.subtree[rig.bone(f"lowerleg02.{s}")] for s in ("L", "R")])
    dominant = rig.indices[np.arange(len(vertices)), rig.weights.argmax(1)]
    # The feet are restored to their rest orientation, so vertices fully weighted to the
    # foot subtrees move rigidly; the lowest of them is the sole contact point.
    foot_bones = np.concatenate([rig.subtree[rig.bone(f"foot.{s}")] for s in ("L", "R")])
    rigid = rig.bone_weight(foot_bones) > 1 - 1e-6
    low = vertices[:, 1] < vertices[:, 1].min() + config.SOLE_BAND_M
    rig.foot_vertices = np.flatnonzero((rigid & low) | (np.isin(dominant, feet) & low))
    driven = ["root", *config.SPINE_BONES] + [
        f"{b}.{s}"
        for b in ("clavicle", "upperarm01", "lowerarm01", "upperleg01", "lowerleg01", "foot")
        for s in ("L", "R")
    ]
    rig.drivers = np.array(sorted(rig.bone(b) for b in driven))
    slot = {int(b): i for i, b in enumerate(rig.drivers)}
    rig.driver_of = np.empty(len(labels), dtype=int)
    for b in range(len(labels)):
        j = b
        while j not in slot:
            j = int(parents[j])
        rig.driver_of[b] = slot[j]
    hip_l, hip_r = rig.head("upperleg01.L"), rig.head("upperleg01.R")
    up = 0.5 * (rig.head("upperarm01.L") + rig.head("upperarm01.R")) - 0.5 * (hip_l + hip_r)
    rig.vertical = up / np.linalg.norm(up)
    right = (hip_r - hip_l) - rig.vertical * ((hip_r - hip_l) @ rig.vertical)
    rig.right = right / np.linalg.norm(right)
    rig.forward = np.cross(rig.vertical, rig.right)
    if config.SHOULDER_RIDGE["enabled"]:
        from .ridge import build_ridge

        rig.ridge = build_ridge(rig)
    return rig


# --- Skinning ------------------------------------------------------------------------------


def skin_transforms(rig: RestRig, world: np.ndarray) -> np.ndarray:
    return world @ np.linalg.inv(rig.rest)


def lbs(rig: RestRig, skin: np.ndarray, ids: np.ndarray | None = None) -> np.ndarray:
    """Linear blend skinning (Anny's 'lbs'); `ids` restricts to a vertex subset."""
    sel = slice(None) if ids is None else ids
    v, w, idx = rig.vertices[sel], rig.weights[sel], rig.indices[sel]
    blend = np.einsum("vk,vkij->vij", w, skin[idx][:, :, :3, :])
    out = np.einsum("vij,vj->vi", blend[:, :, :3], v) + blend[:, :, 3]
    if rig.ridge is not None:
        from .ridge import ridge_correction

        rows, delta = ridge_correction(rig, rig.ridge, skin, ids)
        if len(rows):
            out[rows] += delta
    return out


def dual_quaternions(skin: np.ndarray) -> np.ndarray:
    """(B, 8) unit dual quaternions [real xyzw, dual xyzw] of rigid 4x4 transforms."""
    from scipy.spatial.transform import Rotation

    real = Rotation.from_matrix(skin[:, :3, :3]).as_quat()  # xyzw
    t = skin[:, :3, 3]
    # dual = 0.5 * (t, 0) * real  (Hamilton product)
    x, y, z, w = real.T
    tx, ty, tz = t.T
    dual = 0.5 * np.stack(
        (
            tx * w + ty * z - tz * y,
            -tx * z + ty * w + tz * x,
            tx * y - ty * x + tz * w,
            -tx * x - ty * y - tz * z,
        ),
        axis=1,
    )
    return np.c_[real, dual]


def dqs(rig: RestRig, skin: np.ndarray, ids: np.ndarray | None = None) -> np.ndarray:
    """Dual-quaternion skinning (Kavan et al. 2007), antipodality fixed per vertex."""
    sel = slice(None) if ids is None else ids
    v, w, idx = rig.vertices[sel], rig.weights[sel], rig.indices[sel]
    dq = dual_quaternions(skin)[idx]  # (V, K, 8)
    pivot = dq[np.arange(len(w)), w.argmax(1), :4]
    sign = np.where(np.einsum("vkq,vq->vk", dq[:, :, :4], pivot) < 0, -1.0, 1.0)
    blend = np.einsum("vk,vkq->vq", w * sign, dq)
    norm = np.linalg.norm(blend[:, :4], axis=1, keepdims=True)
    real, dual = blend[:, :4] / norm, blend[:, 4:] / norm
    q, s = real[:, :3], real[:, 3:]
    qd, sd = dual[:, :3], dual[:, 3:]
    # Translation = 2 * (dual * conj(real)).xyz ; rotation by real.
    t = 2 * (sd * -q + s * qd + np.cross(qd, -q))
    rotated = v + 2 * np.cross(q, np.cross(q, v) + s * v)
    return rotated + t


def skin_vertices(
    rig: RestRig,
    skin: np.ndarray,
    method: str = config.DEFAULT_SKINNING,
    ids: np.ndarray | None = None,
) -> np.ndarray:
    if method == "lbs":
        return lbs(rig, skin, ids)
    if method == "dqs":
        return dqs(rig, skin, ids)
    raise ValueError(f"Unknown skinning method {method!r}")


# --- Posing --------------------------------------------------------------------------------


@dataclass
class PosedSkeleton:
    world: np.ndarray  # (B, 4, 4) posed world bone poses, scene frame
    skin: np.ndarray  # (B, 4, 4) skinning transforms W @ inv(R)
    pose: AnatomicalPose  # clamped input with the solved pelvis_drop_m
    clamps: list[Clamp]
    root_offset_m: np.ndarray  # translation applied for foot planting (x, y, z)
    ankle_deg: dict[str, float]  # implied ankle angle, + = dorsiflexion
    seated: bool
    warnings: list[str]


def _rotate(
    rig: RestRig, posed: np.ndarray, bone: int, rotation: np.ndarray, pivot: np.ndarray
) -> None:
    transform = np.eye(4)
    transform[:3, :3] = rotation
    transform[:3, 3] = pivot - rotation @ pivot
    ids = rig.subtree[bone]
    posed[ids] = transform @ posed[ids]


def _accumulated(rig: RestRig, posed: np.ndarray, bone: int) -> np.ndarray:
    """World rotation applied to `bone` so far (posed @ rest^T)."""
    return posed[bone, :3, :3] @ rig.rest[bone, :3, :3].T


def isb_local(plane: float, elevation: float, axial: float) -> np.ndarray:
    """R = Ry(plane) Rx(-elevation) Ry(axial) in the side-local shoulder frame (degrees in).

    Side-local frame (motion contract; same as P3 anatomicalPose.ts humerusRotate): x =
    thorax forward, y = thorax up, z = lateral (subject's right for the right arm; the LEFT
    arm is mirrored so z points to the subject's left). Neutral humerus: long axis -y, a
    bent forearm points +x. Humerus direction = (sin e sin p, -cos e, sin e cos p).
    """
    return (
        axis_angle(Y, np.deg2rad(plane))
        @ axis_angle(X, -np.deg2rad(elevation))
        @ axis_angle(Y, np.deg2rad(axial))
    )


def thorax_frame(rig: RestRig, posed: np.ndarray) -> np.ndarray:
    """ISB-like thorax frame, columns [forward, up, right] in scene axes, from posed joints.

    Y = mid-hip -> mid-shoulder (hip centres = upperleg01 heads, shoulders = glenohumeral
    centres = upperarm01 heads), Z = shoulder line made perpendicular to Y pointing to the
    subject's right, X = Y x Z (forward). Same construction as P3's estimator.
    """
    hip = 0.5 * (posed[rig.bone("upperleg01.L"), :3, 3] + posed[rig.bone("upperleg01.R"), :3, 3])
    left = posed[rig.bone("upperarm01.L"), :3, 3]
    right = posed[rig.bone("upperarm01.R"), :3, 3]
    up = 0.5 * (left + right) - hip
    up /= np.linalg.norm(up)
    side = (right - left) - up * ((right - left) @ up)
    side /= np.linalg.norm(side)
    return np.stack((np.cross(up, side), up, side), axis=1)


def measure_trunk(rig: RestRig, posed: np.ndarray) -> np.ndarray:
    """(flexion, lateral, twist) in degrees, computed exactly as P3 estimates them.

    Vertical = the rig's calibrated vertical (rest trunk axis, like P3's neutral-stance
    calibration); pelvis heading frame r = hip line made horizontal, f = v x r.
    flexion = atan2(u.f, u.v), lateral = asin(u.r), twist = signed angle from the hip line
    to the shoulder line (both made perpendicular to u) about u.
    """
    v, f, r = rig.vertical, rig.forward, rig.right
    thorax = thorax_frame(rig, posed)
    u, ts = thorax[:, 1], thorax[:, 2]
    hips = posed[rig.bone("upperleg01.R"), :3, 3] - posed[rig.bone("upperleg01.L"), :3, 3]
    hip_line = hips - u * (hips @ u)
    hip_line /= np.linalg.norm(hip_line)
    return np.rad2deg(
        np.array(
            [
                np.arctan2(u @ f, u @ v),
                np.arcsin(np.clip(u @ r, -1, 1)),
                np.arctan2(np.cross(hip_line, ts) @ u, hip_line @ ts),
            ]
        )
    )


def _trunk(rig: RestRig, drive: np.ndarray, elevations: dict[str, float]) -> np.ndarray:
    """Pelvic tilt + distributed spine rotation + clavicle shrug for raw drive angles."""
    posed = rig.rest.copy()
    flexion, lateral, twist = np.deg2rad(drive)
    hips = 0.5 * (rig.head("upperleg01.L") + rig.head("upperleg01.R"))
    # Pelvic part rotates the whole skeleton about the hip axis (axis -r tips v toward f);
    # the legs are re-set absolutely afterwards, so the hip joints never move.
    _rotate(rig, posed, 0, axis_angle(-rig.right, flexion * config.PELVIC_FLEXION_SHARE), hips)
    spinal = flexion * (1 - config.PELVIC_FLEXION_SHARE)
    shares = [
        np.array(rom) / sum(rom)
        for rom in (config.SPINE_FLEXION_ROM, config.SPINE_LATERAL_ROM, config.SPINE_TWIST_ROM)
    ]
    for i, label in enumerate(config.SPINE_BONES):
        b = rig.bone(label)
        local = (
            axis_angle(-rig.right, spinal * shares[0][i])  # + flexion: head forward
            @ axis_angle(rig.forward, lateral * shares[1][i])  # + lean to subject's right
            @ axis_angle(rig.vertical, twist * shares[2][i])  # + shoulders turn left
        )
        a = _accumulated(rig, posed, rig.parents[b])
        _rotate(rig, posed, b, a @ local @ a.T, posed[b, :3, 3].copy())
    # Shoulder girdle shrug about the thorax forward axis (scapulohumeral rhythm).
    a = _accumulated(rig, posed, rig.bone(config.THORAX_BONE))
    for side, sign in (("L", 1.0), ("R", -1.0)):
        lift = config.CLAVICLE_ELEVATION_RATIO * max(
            0.0, elevations[side] - config.GIRDLE_SETTING_PHASE_DEG
        )
        clavicle = rig.bone(f"clavicle.{side}")
        axis = a @ rig.forward
        _rotate(
            rig,
            posed,
            clavicle,
            axis_angle(axis, sign * np.deg2rad(lift)),
            posed[clavicle, :3, 3].copy(),
        )
    return posed


def solve_trunk(
    rig: RestRig, target: np.ndarray, elevations: dict[str, float], state: dict | None = None
) -> tuple[np.ndarray, np.ndarray]:
    """Drive angles whose MEASURED trunk angles equal `target` (quasi-Newton).

    `state` (optional, mutable) carries the previous frame's drive and Jacobian along a
    motion: the solve then warm-starts and usually needs a single correction.
    """
    state = {} if state is None else state
    if "drive" in state:
        drive = state["drive"] + (target - state["target"])
    else:
        drive = target.astype(float).copy()
    posed = _trunk(rig, drive, elevations)
    measured = measure_trunk(rig, posed)
    error = target - measured
    jacobian = state.get("jacobian")
    if jacobian is None and np.abs(error).max() >= config.TRUNK_SOLVE_TOLERANCE_DEG:
        jacobian = np.empty((3, 3))
        for k in range(3):
            step = np.zeros(3)
            step[k] = 1.0
            jacobian[:, k] = measure_trunk(rig, _trunk(rig, drive + step, elevations)) - measured
    for _ in range(config.TRUNK_SOLVE_ITERATIONS):
        if np.abs(error).max() < config.TRUNK_SOLVE_TOLERANCE_DEG:
            break
        drive = drive + np.linalg.solve(jacobian, error)
        posed = _trunk(rig, drive, elevations)
        error = target - measure_trunk(rig, posed)
    if np.abs(error).max() >= config.TRUNK_SOLVE_TOLERANCE_DEG:
        raise RuntimeError(f"Trunk solve did not converge: residual {error} deg")
    state.update(drive=drive, target=target.astype(float), jacobian=jacobian)
    return posed, drive


def sagittal_angle(rig: RestRig, vector: np.ndarray) -> float:
    """Sagittal angle from the vertical, + forward (P3: atan2(t.f, -t.v)), degrees."""
    return float(np.rad2deg(np.arctan2(vector @ rig.forward, -(vector @ rig.vertical))))


def _align(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Minimal rotation taking direction a to direction b."""
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    axis = np.cross(a, b)
    return axis_angle(axis, float(np.arctan2(np.linalg.norm(axis), a @ b)))


def measure_pose(rig: RestRig, world: np.ndarray) -> AnatomicalPose:
    """Inverse map: contract angles measured on posed bone poses with P3's formulas.

    Unclamped. pelvis_drop_m = rest hip height - current hip height.
    """
    head = {n: world[rig.bone(n), :3, 3] for n in rig.labels}
    out: dict[str, float] = {}
    out["trunk_flexion"], out["trunk_lateral"], out["trunk_twist"] = (
        float(a) for a in measure_trunk(rig, world)
    )
    thorax = thorax_frame(rig, world)
    for side, z_sign in (("L", -1.0), ("R", 1.0)):
        local = thorax * np.array([1.0, 1.0, z_sign])
        d = local.T @ (head[f"lowerarm01.{side}"] - head[f"upperarm01.{side}"])
        w = local.T @ (head[f"wrist.{side}"] - head[f"lowerarm01.{side}"])
        d /= np.linalg.norm(d)
        w /= np.linalg.norm(w)
        elevation = float(np.rad2deg(np.arccos(np.clip(-d[1], -1, 1))))
        plane = float(np.rad2deg(np.arctan2(d[0], d[2])))
        unplaned = (axis_angle(Y, np.deg2rad(plane)) @ axis_angle(X, -np.deg2rad(elevation))).T @ w
        out[f"shoulder_{side}_plane"] = plane
        out[f"shoulder_{side}_elevation"] = elevation
        out[f"shoulder_{side}_axial"] = float(np.rad2deg(np.arctan2(-unplaned[2], unplaned[0])))
        out[f"elbow_{side}_flexion"] = float(np.rad2deg(np.arccos(np.clip(d @ w, -1, 1))))
        thigh = head[f"lowerleg01.{side}"] - head[f"upperleg01.{side}"]
        shank = head[f"foot.{side}"] - head[f"lowerleg01.{side}"]
        out[f"hip_{side}_flexion"] = sagittal_angle(rig, thigh)
        cosine = thigh @ shank / np.linalg.norm(thigh) / np.linalg.norm(shank)
        out[f"knee_{side}_flexion"] = float(np.rad2deg(np.arccos(np.clip(cosine, -1, 1))))
    hips = 0.5 * (head["upperleg01.L"] + head["upperleg01.R"])
    rest_hips = 0.5 * (rig.head("upperleg01.L") + rig.head("upperleg01.R"))
    out["pelvis_drop_m"] = float(max(0.0, rest_hips[1] - hips[1]))
    return AnatomicalPose(**out)


def neutral_pose(engine, body, rig: RestRig) -> AnatomicalPose:
    """The body's display pose (body_service.pose, on which the garment is draped),
    measured in contract angles. Motions start/end here so the cloth starts settled."""
    from ..pose import display_body  # read-only reuse; display pose owned by agent C

    display = display_body(engine, body)
    return measure_pose(rig, display.transforms @ rig.rest)


def pose_skeleton(
    rig: RestRig, pose: AnatomicalPose, solver_state: dict | None = None
) -> PosedSkeleton:
    pose, clamps = clamp_pose(pose)
    p = pose.model_dump()
    warnings: list[str] = []
    elevations = {s: p[f"shoulder_{s}_elevation"] for s in ("L", "R")}

    # 1-2. Trunk (pelvis + spine + shoulder girdle), solved to the measured contract angles.
    target = np.array([p["trunk_flexion"], p["trunk_lateral"], p["trunk_twist"]])
    posed, _ = solve_trunk(rig, target, elevations, solver_state)

    # 3. Legs: thigh sagittal angle from the vertical = hip_flexion (independent of the
    # trunk); 3D thigh-shank angle = knee_flexion; feet kept flat (implied ankle angle).
    ankle = {}
    for side in ("L", "R"):
        thigh = rig.bone(f"upperleg01.{side}")
        knee = rig.bone(f"lowerleg01.{side}")
        foot = rig.bone(f"foot.{side}")
        rest_thigh = rig.head(f"lowerleg01.{side}") - rig.head(f"upperleg01.{side}")
        # Rotation about the right axis changes the sagittal angle by exactly its angle and
        # keeps the rest thigh's small abduction.
        turn = axis_angle(
            rig.right, np.deg2rad(p[f"hip_{side}_flexion"] - sagittal_angle(rig, rest_thigh))
        )
        _rotate(
            rig,
            posed,
            thigh,
            turn @ _accumulated(rig, posed, thigh).T,
            posed[thigh, :3, 3].copy(),
        )
        t = posed[knee, :3, 3] - posed[thigh, :3, 3]
        current = posed[foot, :3, 3] - posed[knee, :3, 3]
        # Bend within the shank's own flexion plane (keeps the rest knee's small varus /
        # valgus); the 3D thigh-shank angle becomes exactly knee_flexion.
        axis = np.cross(t, current)  # + rotation turns the shank away from the thigh axis
        if np.linalg.norm(axis) < 1e-9 * np.linalg.norm(current) * np.linalg.norm(t):
            axis = -(rig.right - t * (rig.right @ t) / (t @ t))  # straight knee: bend backward
        cosine = current @ t / np.linalg.norm(current) / np.linalg.norm(t)
        bend = np.deg2rad(p[f"knee_{side}_flexion"]) - np.arccos(np.clip(cosine, -1, 1))
        _rotate(rig, posed, knee, axis_angle(axis, bend), posed[knee, :3, 3].copy())
        correction = _accumulated(rig, posed, foot).T
        _rotate(rig, posed, foot, correction, posed[foot, :3, 3].copy())
        # Implied ankle angle (+ dorsiflexion): how far the flattening tipped the shank-fixed
        # vertical forward.
        tipped = correction.T @ rig.vertical
        ankle[side] = float(np.rad2deg(np.arctan2(tipped @ rig.forward, tipped @ rig.vertical)))
        low, high = config.ANKLE_LIMITS_DEG
        if not low <= ankle[side] <= high:
            warnings.append(f"ankle_{side} {ankle[side]:.1f} deg outside AAOS range")

    # 4. Arms: ISB Y-X-Y relative to the posed thorax frame, left side mirrored.
    thorax = thorax_frame(rig, posed)
    for side, z_sign in (("L", -1.0), ("R", 1.0)):
        local = thorax * np.array([1.0, 1.0, z_sign])  # columns: forward, up, lateral
        rotation = isb_local(
            p[f"shoulder_{side}_plane"],
            p[f"shoulder_{side}_elevation"],
            p[f"shoulder_{side}_axial"],
        )
        desired = frame(local @ rotation @ -Y, local @ rotation @ X)
        upper = rig.bone(f"upperarm01.{side}")
        rest_frame, rest_flexion = rig.humerus[side]
        current = _accumulated(rig, posed, upper) @ rest_frame
        _rotate(rig, posed, upper, desired @ current.T, posed[upper, :3, 3].copy())
        lower = rig.bone(f"lowerarm01.{side}")
        bend = np.deg2rad(p[f"elbow_{side}_flexion"]) - rest_flexion
        _rotate(rig, posed, lower, axis_angle(desired[:, 2], bend), posed[lower, :3, 3].copy())

    # 5. Support: plant the feet (lowest foot vertex on the floor, rest mid-foot x/z).
    # pelvis_drop_m = standing hip height - current hip height: the hip joints move only by
    # this translation (the pelvic rotation is about the hip axis).
    skin = skin_transforms(rig, posed)
    sole = lbs(rig, skin, rig.foot_vertices)
    mid_rest = 0.5 * (rig.head("foot.L") + rig.head("foot.R"))
    mid_now = 0.5 * (posed[rig.bone("foot.L"), :3, 3] + posed[rig.bone("foot.R"), :3, 3])
    offset = np.array([mid_rest[0] - mid_now[0], -sole[:, 1].min(), mid_rest[2] - mid_now[2]])
    posed[:, :3, 3] += offset
    skin = skin_transforms(rig, posed)
    seated = min(p["hip_L_flexion"], p["hip_R_flexion"]) >= config.SEAT_HIP_FLEXION_MIN_DEG
    solved = pose.model_copy(update={"pelvis_drop_m": float(max(0.0, -offset[1]))})
    if offset[1] > config.FLOAT_WARNING_M:
        warnings.append(f"root raised {offset[1]:.4f} m to keep the feet on the floor")
    return PosedSkeleton(posed, skin, solved, clamps, offset, ankle, seated, warnings)


def posed_mesh(
    rig: RestRig, posed: PosedSkeleton, method: str = config.DEFAULT_SKINNING
) -> trimesh.Trimesh:
    return trimesh.Trimesh(skin_vertices(rig, posed.skin, method), rig.faces, process=False)


def joint_positions(rig: RestRig, posed: PosedSkeleton) -> dict[str, np.ndarray]:
    names = ["upperarm01", "lowerarm01", "wrist", "upperleg01", "lowerleg01", "foot"]
    out = {f"{n}.{s}": posed.world[rig.bone(f"{n}.{s}"), :3, 3] for n in names for s in "LR"}
    for n in ("root", "spine01", "neck01", "head"):
        out[n] = posed.world[rig.bone(n), :3, 3]
    return out
