"""Per-body motion data: rig/skin export, articulated SDF, motion frames and anchors.

Everything is computed in memory from a body already fitted by `Fitter` (looked up by its
body_id; nothing is refitted or persisted) and kept in a small LRU (config.CACHE_SIZE).
"""

from collections import OrderedDict
from dataclasses import dataclass, field
from threading import RLock
from time import perf_counter

import numpy as np

from . import config
from .anchors import BodyAnchors, build_anchors, frame_anchors
from .angles import AnatomicalPose
from .collision import BodyField, build_fields
from .container import encode
from .custom import CustomMotionRequest, custom_frame_times, custom_motion
from .presets import MOTIONS, Motion, frame_times, resolve, sample
from .rig import RestRig, build_rig, neutral_pose, pose_skeleton

FRAME = "metres; scene frame X = subject's left, Y up, +Z front; feet on Y = 0"


@dataclass
class MotionBody:
    rig: RestRig
    neutral: AnatomicalPose
    anchors: BodyAnchors | None = None
    body_field: BodyField | None = None
    frames: dict[str, bytes] = field(default_factory=dict)
    timings_ms: dict[str, float] = field(default_factory=dict)


class MotionService:
    def __init__(self, fitter) -> None:
        self.fitter = fitter
        self.cache: OrderedDict[str, MotionBody] = OrderedDict()
        self.lock = RLock()

    def body(self, body_id: str) -> MotionBody:
        """KeyError if the body is not (or no longer) in the fitter's memory cache."""
        with self.lock:
            fitted = self.fitter.get(body_id)
            if body_id in self.cache:
                self.cache.move_to_end(body_id)
                return self.cache[body_id]
            started = perf_counter()
            rig = build_rig(self.fitter.engine, fitted)
            item = MotionBody(rig, neutral_pose(self.fitter.engine, fitted, rig))
            item.anchors = build_anchors(rig, fitted)
            item.timings_ms["rig_anchors"] = (perf_counter() - started) * 1000
            self.cache[body_id] = item
            while len(self.cache) > config.CACHE_SIZE:
                self.cache.popitem(last=False)
            return item

    # --- exports ---------------------------------------------------------------------------

    def rig_bytes(self, body_id: str) -> bytes:
        item = self.body(body_id)
        rig = item.rig
        meta = {
            "version": config.MOTION_VERSION,
            "frame": FRAME,
            "bones": rig.labels,
            "parents": rig.parents.tolist(),
            "skinning": config.DEFAULT_SKINNING
            if rig.ridge is None
            else f"{config.DEFAULT_SKINNING}-{config.SHOULDER_RIDGE['version']}",
            "neutral_pose": item.neutral.model_dump(),
            "drivers": rig.drivers.tolist(),
            "calibrated_vertical": rig.vertical.tolist(),
        }
        blobs = {
            "rest_world": rig.rest.astype(np.float32),
            "rest_vertices": rig.vertices.astype(np.float32),
            "faces": rig.faces.astype(np.uint32),
            "skin_indices": rig.indices.astype(np.uint16),
            "skin_weights": rig.weights.astype(np.float32),
            "driver_of_bone": rig.driver_of.astype(np.uint8),
        }
        if rig.ridge is not None:
            r = rig.ridge
            meta["ridge"] = {
                "version": config.SHOULDER_RIDGE["version"],
                "ramp_deg": list(config.SHOULDER_RIDGE["ramp_deg"]),
                "upper_driver": [int(x) for x in r.upper_driver],
                "clavicle_driver": [int(x) for x in r.clavicle_driver],
                "humerus_rest": r.humerus_rest.tolist(),
            }
            blobs["ridge_vertices"] = r.vertices.astype(np.uint32)
            blobs["ridge_mask"] = r.mask.astype(np.float32)
            blobs["ridge_upper_weight"] = r.upper_weight.astype(np.float32)
            blobs["ridge_side"] = r.side.astype(np.uint8)
        return encode("rig", meta, blobs)

    def sdf_bytes(self, body_id: str) -> bytes:
        item = self.body(body_id)
        with self.lock:
            if item.body_field is None:
                started = perf_counter()
                item.body_field = build_fields(item.rig)
                item.timings_ms["sdf"] = (perf_counter() - started) * 1000
        segments = []
        blobs = {}
        for f in item.body_field.fields:
            segments.append(
                {
                    "name": f.name,
                    "bone": int(f.bone),
                    "bone_label": item.rig.labels[f.bone],
                    "local_from_rest": f.local_from_rest.tolist(),
                    "origin": f.origin.tolist(),
                    "dims": list(f.values.shape),
                    "spacing": f.spacing,
                    "centre": f.centre.tolist(),
                    "radius": f.radius,
                    "blob": f"sdf.{f.name}",
                }
            )
            blobs[f"sdf.{f.name}"] = f.values.astype(np.float32)
        zone = item.body_field.zone
        blobs["zone_faces"] = zone.faces.astype(np.uint32)
        blobs["zone_border_edges"] = zone.vertices[zone.boundary_edges].astype(np.uint32)
        meta = {
            "version": config.MOTION_VERSION,
            "frame": FRAME,
            "segments": segments,
            "core_weight": config.SEGMENT_CORE_WEIGHT,
        }
        if item.rig.ridge is not None:
            meta["ridge"] = config.SHOULDER_RIDGE["version"]  # ridge skin is in the zone
        return encode("articulated-sdf", meta, blobs)

    def frames_bytes(self, body_id: str, motion_id: str) -> bytes:
        motion = MOTIONS[motion_id]
        item = self.body(body_id)
        with self.lock:
            if motion_id in item.frames:
                return item.frames[motion_id]
            started = perf_counter()
            data = self._encode_frames(item, motion, frame_times(motion))
            item.frames[motion_id] = data
            item.timings_ms[f"frames.{motion_id}"] = (perf_counter() - started) * 1000
            return data

    def custom_frames_bytes(self, body_id: str, request: CustomMotionRequest) -> bytes:
        """A recorded pose sequence through the preset code path (custom.py). Never cached:
        the poses are body data and every recording is new; only the timing is kept."""
        item = self.body(body_id)
        motion = custom_motion(request, item.neutral)
        with self.lock:
            started = perf_counter()
            data = self._encode_frames(item, motion, custom_frame_times(motion))
            item.timings_ms["frames.custom"] = (perf_counter() - started) * 1000
            return data

    def _encode_frames(self, item: MotionBody, motion: Motion, times: list[float]) -> bytes:
        with self.lock:
            keys = resolve(motion, item.neutral)
            state: dict = {}
            skins, poses, extras = [], [], []
            anchors: dict[str, list[np.ndarray]] = {}
            for t in times:
                posed = pose_skeleton(item.rig, sample(keys, t), state)
                skins.append(posed.skin[item.rig.drivers, :3, :])
                poses.append(posed.pose.model_dump())
                extras.append(
                    {
                        "t_s": t,
                        "seated": posed.seated,
                        "root_offset_m": posed.root_offset_m.tolist(),
                        "ankle_deg": posed.ankle_deg,
                        "clamps": [c.model_dump() for c in posed.clamps],
                        "warnings": posed.warnings,
                    }
                )
                for name, value in frame_anchors(
                    item.rig, item.anchors, posed.skin, posed.world
                ).items():
                    anchors.setdefault(name, []).append(value)
            meta = {
                "version": config.MOTION_VERSION,
                "frame": FRAME,
                "motion": motion.model_dump(),
                "fps": config.FPS,
                "frame_count": len(poses),
                "poses": poses,
                "frames": extras,
                "anchor_order": {
                    "points": ["wrist_L", "wrist_R", "elbow_L", "elbow_R"],
                    "joints": ["wrist.L", "wrist.R", "lowerarm01.L", "lowerarm01.R"],
                },
            }
            blobs = {"driver_matrices": np.array(skins, dtype=np.float32)}
            for name, values in anchors.items():
                blobs[f"anchor.{name}"] = np.array(values, dtype=np.float32)
            return encode("motion-frames", meta, blobs)

    def anchors_json(self, body_id: str) -> dict:
        item = self.body(body_id)
        a = item.anchors

        def attach(x) -> dict:
            return {
                "vertices": x.vertices.tolist(),
                "weights": x.weights.tolist(),
                "rest": x.rest.tolist(),
            }

        return {
            "version": config.MOTION_VERSION,
            "frame": FRAME,
            "ring_samples": config.RING_SAMPLES,
            "ring_index": {
                "front_centre": 0,
                "left_side": config.RING_SAMPLES // 4,
                "back_centre": config.RING_SAMPLES // 2,
                "right_side": 3 * config.RING_SAMPLES // 4,
            },
            "rings": {k: attach(v) for k, v in a.rings.items()},
            "tapes": {k: attach(v) for k, v in a.tapes.items()},
            "points": a.points,
            "heights_m": a.heights,
            "exposure_vertices": {k: v.tolist() for k, v in a.exposure.items()},
            "waistband_default": "mid",
        }
