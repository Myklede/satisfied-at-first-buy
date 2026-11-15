"""Independent fixed-image arm motion onset, not a moving RTMO search tube."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / ".cache/research/cv"))
import cv2  # noqa: E402
import numpy as np  # noqa: E402

cv2.setNumThreads(1)
BASE = ROOT / ".cache/research/live1"
SOURCE = ROOT / "data/reference-photos/FB7675-100-parka-trang/video/live"
# Event search ranges surround the automatically detected arm-motion runs.
# They are reviewed against the raw sheets; first 0.6 s is the baseline.
WINDOWS = {"live-parka": [(22.6, 25.5), (30.3, 33.5)], "live-puffer": [(11.5, 14.5), (22.3, 25.3)]}


def onset(times: np.ndarray, values: np.ndarray, start: float, fraction: float) -> float | None:
    before = values[times < start + 600]
    if len(before) < 5:
        return None
    baseline = float(np.median(before))
    mad = float(np.median(np.abs(before - baseline)))
    threshold = baseline + max(3 * mad, fraction * max(0, float(values.max()) - baseline), 1e-6)
    chosen = np.where((times >= start + 600) & (values > threshold))[0]
    for i in chosen:
        if i + 1 < len(values) and values[i + 1] > threshold:
            return float(times[i])
    return None


def run(key: str, ident: str) -> None:
    frames = json.loads((ROOT / f".cache/research/tracks/{key}.json").read_text())["frames"]
    alignment = json.loads((BASE / f"{key}-alignment.json").read_text())["alignment"]
    offset = alignment["offsetMs"]
    cap = cv2.VideoCapture(str(SOURCE / f"ar-live-20261114-{ident}-ar.webm"))
    times, activities = [], []
    previous = None
    try:
        while True:
            ok, image = cap.read()
            if not ok:
                break
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(float)
            diff = np.abs(gray - previous) if previous is not None else np.zeros_like(gray)
            h, w = gray.shape
            activities.append(
                [
                    float(diff[int(h * 0.1) : int(h * 0.75), int(w * a) : int(w * b)].mean())
                    for a, b in [(0.56, 0.84), (0.16, 0.43)]
                ]
            )
            times.append(cap.get(cv2.CAP_PROP_POS_MSEC) - offset)
            previous = gray
    finally:
        cap.release()
    results = []
    at = np.array(times)
    for start, end in WINDOWS[key]:
        for side, shoulder, elbow, wrist, column in [("left", 5, 7, 9, 0), ("right", 6, 8, 10, 1)]:
            rt, speed = [], []
            for a, b in zip(frames, frames[1:], strict=False):
                if not start * 1000 <= b["tMs"] <= end * 1000:
                    continue
                if not a["keypoints"] or not b["keypoints"]:
                    continue
                if any(
                    f["keypoints"][k]["score"] < 0.65
                    for f in [a, b]
                    for k in [shoulder, elbow, wrist]
                ):
                    continue
                velocity = []
                for k in [elbow, wrist]:
                    vectors = [
                        np.array(
                            [f["keypoints"][k][c] - f["keypoints"][shoulder][c] for c in ["x", "y"]]
                        )
                        for f in [a, b]
                    ]
                    velocity.append(
                        float(np.linalg.norm(vectors[1] - vectors[0]) / (b["tMs"] - a["tMs"]))
                    )
                rt.append(b["tMs"])
                speed.append(float(np.mean(velocity)))
            select = (at >= start * 1000) & (at <= end * 1000)
            lags = []
            for fraction in [0.15, 0.2, 0.3]:
                raw_on = (
                    onset(np.array(rt), np.array(speed), start * 1000, fraction) if speed else None
                )
                ar_on = onset(
                    at[select], np.array(activities)[select, column], start * 1000, fraction
                )
                bounds = None
                if raw_on is not None and ar_on is not None:
                    rprev = max(t for t in rt if t < raw_on)
                    aprev = max(t for t in at[select] if t < ar_on)
                    bounds = [
                        aprev - raw_on + offset - alignment["nearPeakMs"][1],
                        ar_on - rprev + offset - alignment["nearPeakMs"][0],
                    ]
                lags.append(
                    {
                        "thresholdFraction": fraction,
                        "rawOnsetMs": raw_on,
                        "arOnsetMs": ar_on,
                        "lagMs": ar_on - raw_on
                        if ar_on is not None and raw_on is not None
                        else None,
                        "samplingAndAlignmentRangeMs": bounds,
                    }
                )
            results.append({"startS": start, "endS": end, "side": side, "thresholdSweep": lags})
    (BASE / f"{key}-onset.json").write_text(
        json.dumps(
            {
                "events": results,
                "caveat": (
                    "fixed image ROI activity vs shoulder-relative wrist/elbow speed; "
                    "background/other-arm motion can confound; not certified joint latency"
                ),
            }
        )
    )
    print(key, json.dumps(results), flush=True)


if __name__ == "__main__":
    for key, ident in [("live-parka", "181149"), ("live-puffer", "181352")]:
        run(key, ident)
