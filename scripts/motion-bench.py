"""Per-body motion precompute time and payload sizes (public reference bodies).

Run: .venv/Scripts/python.exe scripts/motion-bench.py
"""

from time import perf_counter

from body_service.fit import Fitter
from body_service.model import BodyEngine
from body_service.motion.presets import MOTIONS
from body_service.motion.service import MotionService
from body_service.schemas import FitRequest

BODIES = [("male", 175, 75), ("female", 158, 52), ("male", 185, 92)]


def main() -> None:
    engine = BodyEngine()
    fitter = Fitter(engine)
    print(
        "| body | rig+neutral+anchors s | 6 motions s | SDF s | total s | rig KB | SDF MB | "
        "frames KB (all 6) |"
    )
    print("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for sex, height, weight in BODIES:
        body_id = fitter.fit(
            FitRequest(sex=sex, height_cm=height, weight_kg=weight)
        ).response.body_id
        service = MotionService(fitter)
        t0 = perf_counter()
        service.body(body_id)
        t1 = perf_counter()
        frames = sum(len(service.frames_bytes(body_id, m)) for m in MOTIONS)
        t2 = perf_counter()
        sdf = len(service.sdf_bytes(body_id))
        t3 = perf_counter()
        rig = len(service.rig_bytes(body_id))
        print(
            f"| {sex} {height}/{weight} | {t1 - t0:.2f} | {t2 - t1:.2f} | {t3 - t2:.2f} | "
            f"{t3 - t0:.2f} | {rig / 1e3:.0f} | {sdf / 1e6:.1f} | {frames / 1e3:.0f} |"
        )


if __name__ == "__main__":
    main()
