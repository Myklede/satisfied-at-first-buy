"""P2 fixture: P1's motion exports and Python reference values for the TypeScript port.

Public reference body only (172 cm / 65 kg male, the realism reference). Writes to
.cache/motion-fit/ (gitignored, never committed):
- rig.bin, sdf.bin, anchors.json, frames-<motion>.bin: the exact bytes the API serves;
- ref-lbs-<motion>.bin: float32 (V, 3) LBS of every vertex at the motion's mid-hold frame
  (rig.lbs, Anny's skinning);
- ref-distance.json: sample points near the posed skin with P1's reference distances
  (collision.articulated_distance for the rigid cores, collision.zone_distance for the
  skinned joint zone, and their minimum = collision.body_distance).

Run: .venv/Scripts/python.exe scripts/motion-fit-fixture.py
The TypeScript tests in apps/web/src/engine/motion/*.test.ts compare against these files
and skip (with a message) when the fixture has not been generated.
"""

import json

import numpy as np
from body_service import config as body_config
from body_service.fit import Fitter
from body_service.model import BodyEngine
from body_service.motion.collision import articulated_distance, outer_faces, zone_distance
from body_service.motion.container import decode
from body_service.motion.presets import MOTIONS
from body_service.motion.rig import lbs
from body_service.motion.service import MotionService
from body_service.schemas import FitRequest

REFERENCE = FitRequest(height_cm=172, weight_kg=65, sex="male")
CHECK_MOTIONS = ("reach_up_both", "cross_arms", "sit")
SAMPLES_PER_MOTION = 1500


def main() -> None:
    out = body_config.ROOT / ".cache/motion-fit"
    out.mkdir(parents=True, exist_ok=True)
    fitter = Fitter(BodyEngine())
    body = fitter.fit(REFERENCE)
    body_id = body.response.body_id
    service = MotionService(fitter)
    (out / "rig.bin").write_bytes(service.rig_bytes(body_id))
    (out / "sdf.bin").write_bytes(service.sdf_bytes(body_id))
    (out / "anchors.json").write_text(json.dumps(service.anchors_json(body_id)))
    for motion in MOTIONS:
        (out / f"frames-{motion}.bin").write_bytes(service.frames_bytes(body_id, motion))
    item = service.body(body_id)
    rig, field = item.rig, item.body_field
    assert field is not None
    faces = outer_faces(rig)
    rng = np.random.default_rng(11)
    cases = []
    for motion in CHECK_MOTIONS:
        header, blobs = decode((out / f"frames-{motion}.bin").read_bytes())
        hold = header["motion"]["hold"]
        frame = int(round(0.5 * (hold["start_s"] + hold["end_s"]) * header["fps"]))
        drivers = blobs["driver_matrices"][frame].astype(np.float64)  # (18, 3, 4)
        skin = np.tile(np.eye(4), (len(rig.labels), 1, 1))
        skin[:, :3, :] = drivers[rig.driver_of]
        world = skin @ rig.rest
        posed = lbs(rig, skin)
        (out / f"ref-lbs-{motion}.bin").write_bytes(posed.astype("<f4").tobytes())
        # Vertex normals of the posed outer surface (area weighted).
        tri = posed[faces]
        face_normals = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        normals = np.zeros_like(posed)
        for c in range(3):
            np.add.at(normals, faces[:, c], face_normals)
        normals /= np.linalg.norm(normals, axis=1, keepdims=True) + 1e-12
        ids = rng.choice(np.unique(faces), SAMPLES_PER_MOTION)
        offsets = rng.uniform(-0.005, 0.03, SAMPLES_PER_MOTION)
        points = posed[ids] + normals[ids] * offsets[:, None]
        rigid, _ = articulated_distance(field.fields, world, points)
        zone = zone_distance(rig, field.zone, skin, points)
        cases.append(
            {
                "motion": motion,
                "frame": frame,
                "points": points.tolist(),
                "offset_m": offsets.tolist(),
                "rigid": [float(x) if np.isfinite(x) else None for x in rigid],
                "zone": [float(x) if np.isfinite(x) else None for x in zone],
                "distance": [float(x) for x in np.minimum(rigid, zone)],
            }
        )
        print(motion, "frame", frame, "samples", len(points), flush=True)
    (out / "ref-distance.json").write_text(json.dumps({"body_id": body_id, "cases": cases}))
    print("wrote", out)


if __name__ == "__main__":
    main()
