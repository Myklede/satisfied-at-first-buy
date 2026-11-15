"""Metric anchors carried by skinning: wrists, waist/hip lines, waistbands, exposure zone.

Static part (once per body, rest pose): surface attachments (3 vertex ids + barycentric
weights) and vertex masks. Per-frame part: the attachments skinned with the frame's
transforms, so P2 can measure hem-to-waistband gaps, wrist exposure and uncovered skin.

Ring convention (all rings): RING_SAMPLES points from horizontal rays cast at rest from the
torso section centre; index 0 = front centre (+Z), N/4 = subject's LEFT side (+X),
N/2 = back centre, 3N/4 = subject's RIGHT side. Waistband points carry a per-frame `up`
vector: the rest +Y axis carried by the blended skin rotation at that point (the local
torso "vertical" for gap measurements when the trunk bends).

Lines (docs/MEASUREMENTS.md): waist line = exact waist tape (minimum torso girth plane),
hip line = exact hip tape (maximum hip girth plane); their rings sit at the tapes' mean
heights. Waistband (motion contract): low = hip line, mid = halfway, high = waist line.
Exposure zone (per waistband level): torso skin vertices (limb weight below
EXPOSURE_LIMB_WEIGHT_MAX) between the waistband height and the chest line height at rest,
front and back.
"""

from dataclasses import dataclass

import numpy as np
import trimesh

from . import config
from .rig import RestRig


@dataclass
class Attachment:
    vertices: np.ndarray  # (N, 3) vertex ids
    weights: np.ndarray  # (N, 3) barycentric weights
    rest: np.ndarray  # (N, 3) rest points


@dataclass
class BodyAnchors:
    rings: dict[str, Attachment]  # waist, hip, chest, waistband_low/mid/high
    tapes: dict[str, Attachment]  # exact waist / hip measurement tapes (edge points)
    points: dict[str, int]  # wrist_L/R, elbow_L/R surface landmark vertex ids
    exposure: dict[str, np.ndarray]  # waistband level -> torso vertex ids in the zone
    heights: dict[str, float]  # rest heights (m) of waist, hip, chest, waistband_* lines
    seat_vertices: np.ndarray  # posterior thigh/buttock vertices for the implied seat


def _ring(mesh: trimesh.Trimesh, centre: np.ndarray, count: int) -> Attachment:
    angles = 2 * np.pi * np.arange(count) / count
    directions = np.c_[np.sin(angles), np.zeros(count), np.cos(angles)]
    origins = np.repeat(centre[None], count, axis=0)
    locations, rays, faces = mesh.ray.intersects_location(origins, directions)
    hits = np.full((count, 3), np.nan)
    face_of = np.full(count, -1)
    best = np.full(count, np.inf)
    for point, ray, face in zip(locations, rays, faces, strict=True):
        distance = np.linalg.norm(point - centre)
        if distance < best[ray]:
            best[ray], hits[ray], face_of[ray] = distance, point, face
    if (face_of < 0).any():
        raise ValueError("Ring ray missed the torso; centre is not inside the body")
    vertices = mesh.faces[face_of]
    weights = trimesh.triangles.points_to_barycentric(mesh.triangles[face_of], hits)
    return Attachment(vertices, weights, hits)


def _tape(tape) -> Attachment:
    vertices = np.c_[tape.edges, tape.edges[:, :1]]
    weights = np.c_[1 - tape.fractions, tape.fractions, np.zeros(len(tape.fractions))]
    return Attachment(vertices, weights, tape.points.copy())


def build_anchors(rig: RestRig, body) -> BodyAnchors:
    geometry = body.geometry
    mesh = trimesh.Trimesh(rig.vertices, rig.faces, process=False)
    tapes = {name: geometry.tapes[name] for name in ("waist", "hip", "chest")}
    centres = {name: np.r_[t.points.mean(0)] for name, t in tapes.items()}
    rings = {name: _ring(mesh, centres[name], config.RING_SAMPLES) for name in tapes}
    heights = {name: float(c[1]) for name, c in centres.items()}
    for level, t in config.WAISTBAND_FRACTIONS.items():
        centre = (1 - t) * centres["waist"] + t * centres["hip"]
        rings[f"waistband_{level}"] = _ring(mesh, centre, config.RING_SAMPLES)
        heights[f"waistband_{level}"] = float(centre[1])
    limbs = np.concatenate(
        [rig.subtree[rig.bone(f"{b}.{s}")] for b in ("clavicle", "upperleg01") for s in "LR"]
    )
    torso = rig.bone_weight(limbs) < config.EXPOSURE_LIMB_WEIGHT_MAX
    y = rig.vertices[:, 1]
    exposure = {
        level: np.flatnonzero(
            torso & (y >= heights[f"waistband_{level}"]) & (y <= heights["chest"])
        )
        for level in config.WAISTBAND_FRACTIONS
    }
    thighs = np.concatenate([rig.subtree[rig.bone(f"upperleg01.{s}")] for s in "LR"])
    knee_height = min(rig.head(f"lowerleg01.{s}")[1] for s in "LR")
    seat = (rig.bone_weight(thighs) + rig.bone_weight([0])) > 0.5
    seat &= (y > knee_height) & (y < heights["hip"])
    return BodyAnchors(
        rings=rings,
        tapes={name: _tape(tapes[name]) for name in ("waist", "hip")},
        points={k: int(geometry.indices[k]) for k in ("wrist_L", "wrist_R", "elbow_L", "elbow_R")},
        exposure=exposure,
        heights=heights,
        seat_vertices=np.flatnonzero(seat),
    )


def skin_attachment(
    rig: RestRig, skin: np.ndarray, attachment: Attachment
) -> tuple[np.ndarray, np.ndarray]:
    """Posed points (LBS, like the body) and the carried rest +Y direction."""
    ids = attachment.vertices.ravel()
    w = rig.weights[ids]
    blend = np.einsum("vk,vkij->vij", w, skin[rig.indices[ids]][:, :, :3, :])
    points = np.einsum("vij,vj->vi", blend[:, :, :3], rig.vertices[ids]) + blend[:, :, 3]
    up = blend[:, :, 1]  # rotation-part column for rest +Y
    n = len(attachment.vertices)
    bary = attachment.weights[:, :, None]
    points = (points.reshape(n, 3, 3) * bary).sum(1)
    up = (up.reshape(n, 3, 3) * bary).sum(1)
    return points, up / np.linalg.norm(up, axis=1, keepdims=True)


def frame_anchors(
    rig: RestRig, anchors: BodyAnchors, skin: np.ndarray, world: np.ndarray
) -> dict[str, np.ndarray]:
    out: dict[str, np.ndarray] = {}
    for name, ring in anchors.rings.items():
        out[f"ring.{name}"], up = skin_attachment(rig, skin, ring)
        if name.startswith("waistband"):
            out[f"up.{name}"] = up
    for name, tape in anchors.tapes.items():
        out[f"tape.{name}"], _ = skin_attachment(rig, skin, tape)
    ids = np.array(list(anchors.points.values()))
    single = Attachment(
        np.c_[ids, ids, ids], np.tile([1.0, 0, 0], (len(ids), 1)), rig.vertices[ids]
    )
    out["points"], _ = skin_attachment(
        rig, skin, single
    )  # order: wrist_L, wrist_R, elbow_L, elbow_R
    out["joints"] = np.array(
        [world[rig.bone(f"{n}.{s}"), :3, 3] for n in ("wrist", "lowerarm01") for s in "LR"]
    )
    seat = Attachment(
        np.repeat(anchors.seat_vertices[:, None], 3, 1),
        np.tile([1.0, 0, 0], (len(anchors.seat_vertices), 1)),
        rig.vertices[anchors.seat_vertices],
    )
    out["seat_height"] = np.array([skin_attachment(rig, skin, seat)[0][:, 1].min()])
    return out
