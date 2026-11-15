"""Parity dump for the shoulder-ridge transfer (V3, option b1): the server's skinned body for every
frame of the six presets, with config.SHOULDER_RIDGE off and on, next to the rig.bin and
frames.bin the clients consume. apps/web/src/engine/live/record/tools/ridgeParity.mjs skins the
same frames with rig.ts (the TS skinning the bake and the WASM collider both call) and compares.

Neutral reference body only (male 178 cm / 72 kg), never a person's figures. Output goes to the
gitignored folder given by --out (default .cache/v3/parity):
  python -m body_service.motion.ridge_parity [--out .cache/v3/parity]
With --serve PORT (5770-5774 legacy, 5805-5809 DAY-P) it instead runs the body service on
127.0.0.1:PORT with the switch on, so the cloth experiments (hemExperiments.mjs --api) can bake
on a ridged rig without touching the shared service on 8001.
Use --ridge-off for an isolated baseline service; --with-sdf includes both collision dumps.
--asset-workers 0 uses the existing in-process asset builder for a memory-bounded experiment;
it does not change the shared service or the generated cloth geometry.
"""

import argparse
import json
from pathlib import Path

import numpy as np

from ..fit import Fitter
from ..model import BodyEngine
from ..schemas import FitRequest
from . import config
from .presets import MOTIONS, frame_times, resolve, sample
from .rig import lbs, pose_skeleton
from .service import MotionService

PRESETS = ("reach_up_both", "cross_arms", "sit", "bend_tie_shoes", "reach_forward", "reach_up_one")


def skinned_frames(item, motion_id: str) -> np.ndarray:
    """(F, V, 3) body positions, posed exactly as MotionService._encode_frames poses them."""
    motion = MOTIONS[motion_id]
    keys = resolve(motion, item.neutral)
    state: dict = {}
    out = []
    for t in frame_times(motion):
        posed = pose_skeleton(item.rig, sample(keys, t), state)
        out.append(lbs(item.rig, posed.skin))
    return np.array(out)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=".cache/v3/parity")
    parser.add_argument("--serve", type=int, default=0)
    parser.add_argument("--ridge-off", action="store_true")
    parser.add_argument("--with-sdf", action="store_true")
    parser.add_argument("--asset-workers", type=int, choices=range(5))
    args = parser.parse_args()
    if args.serve:
        if args.serve not in (*range(5770, 5775), *range(5805, 5810)):
            raise SystemExit("--serve takes a port in 5770-5774 or 5805-5809")
        import uvicorn

        config.SHOULDER_RIDGE["enabled"] = not args.ridge_off
        if args.asset_workers is not None:
            from .. import config as app_config

            app_config.ASSET_WORKERS = args.asset_workers
        from ..app import app

        uvicorn.run(app, host="127.0.0.1", port=args.serve, access_log=False)
        return
    out = Path(args.out)
    if out.is_absolute() or ".." in out.parts or out.parts[:2] != (".cache", "v3"):
        raise SystemExit("--out must be a relative path under .cache/v3")
    out.mkdir(parents=True, exist_ok=True)
    fitter = Fitter(BodyEngine())
    body_id = fitter.fit(FitRequest(sex="male", height_cm=178, weight_kg=72)).response.body_id
    summary: dict = {"presets": {}, "ridge_vertices": 0}
    frames: dict[str, bytes] = {}
    enabled = config.SHOULDER_RIDGE["enabled"]
    try:
        for state in ("off", "on"):
            config.SHOULDER_RIDGE["enabled"] = state == "on"
            service = MotionService(fitter)
            item = service.body(body_id)
            (out / f"rig-{state}.bin").write_bytes(service.rig_bytes(body_id))
            if args.with_sdf:
                (out / f"sdf-{state}.bin").write_bytes(service.sdf_bytes(body_id))
            if item.rig.ridge is not None:
                summary["ridge_vertices"] = int(len(item.rig.ridge.vertices))
            for motion_id in PRESETS:
                data = service.frames_bytes(body_id, motion_id)
                if state == "off":
                    frames[motion_id] = data
                    (out / f"frames-{motion_id}.bin").write_bytes(data)
                elif data != frames[motion_id]:
                    raise SystemExit(f"{motion_id}: frames.bin differs with the ridge on")
                pos = skinned_frames(item, motion_id)
                (out / f"pos-{motion_id}-{state}.f32").write_bytes(pos.astype(np.float32).tobytes())
                entry = summary["presets"].setdefault(
                    motion_id, {"frames": int(pos.shape[0]), "vertices": int(pos.shape[1])}
                )
                if state == "on":
                    off = np.fromfile(out / f"pos-{motion_id}-off.f32", dtype=np.float32)
                    d = np.abs(pos.astype(np.float32).ravel() - off).reshape(pos.shape)
                    moved = d.max(axis=(1, 2))
                    entry["frames_changed"] = int((moved > 0).sum())
                    entry["max_change_cm"] = round(float(moved.max()) * 100, 2)
    finally:
        config.SHOULDER_RIDGE["enabled"] = enabled
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
