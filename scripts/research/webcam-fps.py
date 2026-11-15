"""P27 bounded, local OpenCV camera probe. No frames are persisted.

Run only through webcam-fps.mjs after checking the user is not testing.
Device index is explicit: do not accidentally open the ZED/virtual camera.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / ".cache/research/cv"))
import cv2  # noqa: E402
import numpy as np  # noqa: E402

cv2.setNumThreads(1)
# These are requested driver properties, never assumed to have been accepted.
# DSHOW exposure is log2(seconds): -5 = 1/32 s, -6 = 1/64 s.
# 0.75/0.25 are common OpenCV auto/manual encodings; readbacks are always saved.
MODES = [(640, 480), (960, 540), (1280, 720), (1920, 1080)]


def settings(cap: cv2.VideoCapture) -> dict:
    return {
        name: cap.get(prop)
        for name, prop in {
            "width": cv2.CAP_PROP_FRAME_WIDTH,
            "height": cv2.CAP_PROP_FRAME_HEIGHT,
            "fps": cv2.CAP_PROP_FPS,
            "fourcc": cv2.CAP_PROP_FOURCC,
            "autoExposure": cv2.CAP_PROP_AUTO_EXPOSURE,
            "exposure": cv2.CAP_PROP_EXPOSURE,
            "gain": cv2.CAP_PROP_GAIN,
        }.items()
    }


def probe(args: argparse.Namespace) -> None:
    backend = {"MSMF": cv2.CAP_MSMF, "DSHOW": cv2.CAP_DSHOW}[args.backend]
    jobs = (
        [(w, h, fmt, None) for w, h in MODES for fmt in ["MJPG", "YUY2", "NV12"]]
        if args.batch == "formats"
        else [(1280, 720, "MJPG", value) for value in ["auto", "manual-5", "manual-6"]]
    )
    out = ROOT / f".cache/research/webcam/{args.backend}-{args.batch}.json"
    rows: list[dict] = []
    if not cv2.videoio_registry.hasBackend(backend):
        report = {
            "backend": args.backend,
            "index": args.index,
            "rows": [],
            "error": "Backend unavailable in this OpenCV build; no capture attempted",
        }
        out.write_text(json.dumps(report))
        print(json.dumps(report), flush=True)
        return
    began = time.monotonic()
    for width, height, fmt, exposure in jobs:
        if time.monotonic() - began > 145:
            break  # leave margin for release and parent 175 s watchdog
        row = {"requested": [width, height, fmt, 30], "exposureRequest": exposure}
        out.write_text(
            json.dumps({"backend": args.backend, "index": args.index, "rows": rows, "pending": row})
        )
        print("ATTEMPT " + json.dumps(row), flush=True)
        cap = cv2.VideoCapture()
        original = None
        open_watchdog = threading.Timer(25, lambda: os._exit(125))
        open_watchdog.daemon = True
        try:
            open_watchdog.start()
            if not cap.open(args.index, backend):
                row["error"] = "open failed (unsupported, busy or unavailable)"
                continue
            open_watchdog.cancel()
            original = settings(cap)
            row["setAccepted"] = {
                "fourcc": cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*fmt)),
                "width": cap.set(cv2.CAP_PROP_FRAME_WIDTH, width),
                "height": cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height),
                "fps": cap.set(cv2.CAP_PROP_FPS, 30),
            }
            if exposure is not None:
                row["setAccepted"]["autoExposure"] = cap.set(
                    cv2.CAP_PROP_AUTO_EXPOSURE, 0.75 if exposure == "auto" else 0.25
                )
                if exposure != "auto":
                    row["setAccepted"]["exposure"] = cap.set(
                        cv2.CAP_PROP_EXPOSURE, -5 if exposure == "manual-5" else -6
                    )
            row["before"] = settings(cap)
            warm = time.monotonic()
            while time.monotonic() - warm < 0.5:
                if not cap.grab():
                    raise RuntimeError("warmup grab failed")
            times, brightness = [], []
            start = time.monotonic()
            while time.monotonic() - start < 5:
                ok, image = cap.read()
                if not ok:
                    raise RuntimeError("read failed")
                times.append(time.monotonic())
                brightness.append(float(cv2.mean(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY))[0]))
            row.update(
                frames=len(times),
                deliveredFps=(len(times) - 1) / (times[-1] - times[0]) if len(times) > 1 else None,
                meanGray=float(np.mean(brightness)),
                gapP95Ms=float(np.percentile(np.diff(times), 95) * 1000)
                if len(times) > 1
                else None,
                actualShape=list(image.shape),
                after=settings(cap),
            )
        except Exception as error:
            row["error"] = str(error)
        finally:
            open_watchdog.cancel()
            if original is not None and exposure is not None:
                row["restoreAccepted"] = {
                    "exposure": cap.set(cv2.CAP_PROP_EXPOSURE, original["exposure"]),
                    "autoExposure": cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, original["autoExposure"]),
                }
            cap.release()
            rows.append(row)
            out.write_text(json.dumps({"backend": args.backend, "index": args.index, "rows": rows}))
            print(json.dumps(row), flush=True)


if __name__ == "__main__":
    raise SystemExit("User stopped all camera probing, including Camo; offline files only")
    # A blocked driver read must not strand the device behind py's launcher.
    # Process teardown releases the Windows handle even if finally cannot run.
    watchdog = threading.Timer(170, lambda: os._exit(124))
    watchdog.daemon = True
    watchdog.start()
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", choices=["MSMF", "DSHOW"], required=True)
    parser.add_argument("--batch", choices=["formats", "exposure"], required=True)
    parser.add_argument("--index", type=int, required=True)
    try:
        probe(parser.parse_args())
    finally:
        watchdog.cancel()
