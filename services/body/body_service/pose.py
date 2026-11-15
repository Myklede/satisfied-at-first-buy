"""Anny skeletal display pose. Measurements remain on the untouched rest mesh."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import numpy as np
import trimesh
from scipy.spatial.transform import Rotation

from . import config
from .fit import FittedBody
from .surface_query import SurfaceQuery

if TYPE_CHECKING:
    from .model import BodyEngine

# torch is imported inside display_body only (P2 proposal 5): asset workers unpickle DisplayBody
# and import this module, but never pose a body.


def forearm_alignment(upper: np.ndarray, current: np.ndarray, angle_deg: float) -> np.ndarray:
    """Set absolute elbow flexion; Anny's rest elbow is already flexed."""
    upper = upper / np.linalg.norm(upper)
    current = current / np.linalg.norm(current)
    bend_axis = np.cross(upper, [0.0, 0, 1.0])
    bend_axis /= np.linalg.norm(bend_axis)
    desired = Rotation.from_rotvec(bend_axis * np.deg2rad(angle_deg)).apply(upper)
    cross = np.cross(current, desired)
    sine = np.linalg.norm(cross)
    cosine = np.clip(current @ desired, -1, 1)
    if sine <= config.SECTION_EPS:
        if cosine < 0:
            raise ValueError("Antiparallel forearm has no unique minimum-twist alignment")
        return np.zeros(3)
    return cross / sine * np.arctan2(sine, cosine)


@dataclass
class DisplayBody:
    mesh: trimesh.Trimesh
    landmarks: dict[str, np.ndarray]
    transforms: np.ndarray
    weights: np.ndarray
    indices: np.ndarray
    arm_centres: dict[str, np.ndarray] = field(default_factory=dict)
    hand_routes: dict[str, np.ndarray] = field(default_factory=dict)
    arm_faces: dict[str, np.ndarray] = field(default_factory=dict)

    def skin_points(self, points: np.ndarray, rest: trimesh.Trimesh) -> np.ndarray:
        closest, _, triangles = SurfaceQuery(rest).exact_closest(points)
        bary = trimesh.triangles.points_to_barycentric(rest.triangles[triangles], closest)
        # Blend the same skinning transforms as the adjacent body surface. Off-skin
        # offsets rotate with that blend rather than being dropped onto the skin.
        result = np.zeros_like(points)
        homogeneous = np.c_[points, np.ones(len(points))]
        for corner in range(3):
            vi = rest.faces[triangles, corner]
            for slot in range(self.indices.shape[1]):
                w = bary[:, corner] * self.weights[vi, slot]
                result += (self.transforms[self.indices[vi, slot]] @ homogeneous[:, :, None])[
                    :, :3, 0
                ] * w[:, None]
        return result


def display_body(engine: BodyEngine, body: FittedBody) -> DisplayBody:
    import torch

    model = engine.model
    with torch.no_grad():
        coeff = model.get_phenotype_blendshape_coefficients(
            **body.response.phenotypes, local_changes=body.response.local_changes
        )
        data = model.get_rest_model(coeff)
    native_rest = data["rest_vertices"][0].numpy()
    floor = float(native_rest[:, 2].min())
    conversion = np.array(
        [[1, 0, 0, 0], [0, 0, 1, -floor], [0, -1, 0, 0], [0, 0, 0, 1]], dtype=float
    )
    inverse = np.linalg.inv(conversion)
    rest_poses = data["rest_bone_poses"][0].numpy()
    posed = conversion @ rest_poses
    labels = model.bone_labels

    def descendants(root):
        ids = []
        for i in range(len(labels)):
            j = i
            while j >= 0:
                if j == root:
                    ids.append(i)
                    break
                j = int(model.bone_parents[j])
        return ids

    def rotate(root, axis, angle):
        pivot = posed[root, :3, 3].copy()
        rotation = Rotation.from_rotvec(np.array(axis) * angle).as_matrix()
        transform = np.eye(4)
        transform[:3, :3] = rotation
        transform[:3, 3] = pivot - rotation @ pivot
        ids = descendants(root)
        posed[ids] = transform @ posed[ids]

    for side in ("L", "R"):
        upper = labels.index(f"upperarm01.{side}")
        lower = labels.index(f"lowerarm01.{side}")
        wrist = labels.index(f"wrist.{side}")
        vector = posed[lower, :3, 3] - posed[upper, :3, 3]
        current = np.arctan2(abs(vector[0]), -vector[1])
        delta = current - np.deg2rad(config.DISPLAY_ARM_ANGLE_DEG)
        rotate(upper, [0, 0, 1], (-1 if side == "L" else 1) * delta)
        vector = forearm_alignment(
            posed[lower, :3, 3] - posed[upper, :3, 3],
            posed[wrist, :3, 3] - posed[lower, :3, 3],
            config.DISPLAY_ELBOW_BEND_DEG,
        )
        angle = float(np.linalg.norm(vector))
        if angle > config.SECTION_EPS:
            rotate(lower, vector / angle, angle)
    world_native = inverse @ posed
    with torch.no_grad():
        transforms, _ = model.get_bone_transforms(
            torch.tensor(world_native[None], dtype=torch.float32),
            data["rest_bone_poses"],
            pose_parameterization="world",
        )
        native = model.get_skinned_vertices(data["rest_vertices"], transforms)[0].numpy()
    vertices = np.c_[native, np.ones(len(native))] @ conversion.T
    mesh = trimesh.Trimesh(vertices[:, :3], engine.faces, process=False)
    skin = DisplayBody(
        mesh,
        {},
        conversion @ transforms[0].numpy() @ inverse,
        model.vertex_bone_weights.numpy(),
        model.vertex_bone_indices.numpy(),
    )
    keys = list(body.geometry.landmarks)
    transformed = skin.skin_points(np.array([body.geometry.landmarks[k] for k in keys]), body.mesh)
    skin.landmarks = dict(zip(keys, transformed, strict=True))
    for side in ("L", "R"):
        upper = labels.index(f"upperarm01.{side}")
        lower = labels.index(f"lowerarm01.{side}")
        wrist = posed[labels.index(f"wrist.{side}"), :3, 3]
        arm_weight = (skin.weights * np.isin(skin.indices, descendants(upper))).sum(1)
        skin.arm_faces[side] = engine.faces[
            arm_weight[engine.faces].mean(1) >= config.WRAP_ARM_WEIGHT_THRESHOLD
        ]
        skin.arm_centres[side] = np.array([posed[upper, :3, 3], posed[lower, :3, 3], wrist])
        skin.hand_routes[side] = np.array(
            [
                posed[lower, :3, 3],
                wrist,
                posed[labels.index(f"finger3-1.{side}"), :3, 3],
                posed[labels.index(f"finger3-3.{side}"), :3, 3],
            ]
        )
    return skin
