"""P27 offline VFR alignment and exploratory jacket measurements, pixels local only."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / ".cache/research/cv"))
import cv2  # noqa: E402
import numpy as np  # noqa: E402

cv2.setNumThreads(1)
OUT = ROOT / ".cache/research/live1"
SOURCE = ROOT / "data/reference-photos/FB7675-100-parka-trang/video/live"
IDS = {"live-parka": "181149", "live-puffer": "181352"}
# Research thresholds, source-pixel heuristics, NOT calibrated acceptance gates.
CFG = {
    "score": 0.65,
    "difference": 20,
    "min_component": 35,
    "skin_distance": 24,
    "hand_min_pixels": 15,
    "brightness_min": 85,
    "saturation_max": 145,
}


def save(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, allow_nan=False))


def signals(path: Path) -> dict:
    cap = cv2.VideoCapture(str(path))
    times, motion, bands = [], [], []
    previous = None
    previous_native = None
    identical = 0
    resolution = None
    try:
        while True:
            ok, im = cap.read()
            if not ok:
                break
            t = cap.get(cv2.CAP_PROP_POS_MSEC)
            resolution = [im.shape[1], im.shape[0]]
            if previous_native is not None and np.array_equal(im, previous_native):
                identical += 1
            previous_native = im
            gray = cv2.resize(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY), (160, 90)).astype(float)
            diff = np.abs(gray - previous) if previous is not None else np.zeros_like(gray)
            times.append(t)
            motion.append(float(diff.mean()))
            # Camera-visible bands exclude most of the rendered jacket. They
            # can still be occluded in close-ups; agreement is checked below.
            bands.append(
                [
                    float(diff[:12].mean()),
                    float(diff[80:].mean()),
                    float(diff[:, :20].mean()),
                    float(diff[:, 140:].mean()),
                ]
            )
            previous = gray
    finally:
        cap.release()
    if len(times) < 2 or not np.all(np.diff(times) > 0):
        raise ValueError("Missing/non-monotonic container PTS: never replace VFR with frame/fps")
    return {
        "tMs": times,
        "motion": motion,
        "bands": bands,
        "frames": len(times),
        "resolution": resolution,
        "pixelIdenticalAdjacentFrames": identical,
    }


def camera_file() -> None:
    """The Camo input is an existing file. Never open a live device here."""
    source = ROOT / "data/reference-photos/FB7675-100-parka-trang/video/camo/camo-test-1.mp4"
    data = signals(source)
    gap = np.diff(data["tMs"])
    report = {
        **data,
        "cameraFileOnly": True,
        "arPairAvailable": False,
        "durationMs": data["tMs"][-1] - data["tMs"][0],
        "deliveredFileFps": (data["frames"] - 1) * 1000 / (data["tMs"][-1] - data["tMs"][0]),
        "gapMedianMs": float(np.median(gap)),
        "gapP95Ms": float(np.percentile(gap, 95)),
        "gapMaxMs": float(max(gap)),
    }
    save(OUT / "camo-1-input.json", report)
    selected = set(np.linspace(0, data["frames"] - 1, 20).round().astype(int))
    reference_path = ROOT / ".cache/research/tracks/camo-1.json"
    reference = json.loads(reference_path.read_text()) if reference_path.exists() else None
    reference_frames = reference["frames"] if reference and reference["complete"] else None
    cap = cv2.VideoCapture(str(source))
    tiles = []
    reference_tiles = []
    index = 0
    try:
        while True:
            ok, im = cap.read()
            if not ok:
                break
            if index in selected:
                tile = cv2.resize(im, (384, 216))  # whole frame; branding is retained
                cv2.putText(
                    tile,
                    f"{index} {data['tMs'][index] / 1000:.3f}s",
                    (5, 15),
                    0,
                    0.4,
                    (0, 0, 255),
                    1,
                )
                tiles.append(tile)
                if reference_frames:
                    overlay = im.copy()
                    for point in reference_frames[index]["keypoints"] or []:
                        x, y = round(point["x"]), round(point["y"])
                        # Keep the vendor logo untouched even in annotation sheets.
                        if point["score"] >= CFG["score"] and not (
                            1130 <= x <= 1240 and 575 <= y <= 700
                        ):
                            cv2.circle(overlay, (x, y), 7, (0, 0, 255), 2)
                    reference_tiles.append(cv2.resize(overlay, (384, 216)))
            index += 1
    finally:
        cap.release()
    cv2.imwrite(
        str(OUT / "camo-1-sheet.jpg"),
        np.vstack([np.hstack(tiles[k : k + 4]) for k in range(0, 20, 4)]),
    )
    if reference_tiles:
        cv2.imwrite(
            str(OUT / "camo-1-reference-sheet.jpg"),
            np.vstack([np.hstack(reference_tiles[k : k + 4]) for k in range(0, 20, 4)]),
        )
    print(
        "camo-1 FILE",
        json.dumps({k: v for k, v in report.items() if k not in ["tMs", "motion", "bands"]}),
        flush=True,
    )


def correlation(a: np.ndarray, b: np.ndarray) -> float | None:
    if len(a) < 12:
        return None
    a, b = a - a.mean(), b - b.mean()
    norm = float(np.linalg.norm(a) * np.linalg.norm(b))
    return float(a @ b / norm) if norm > 1e-9 else None


def align(raw: dict, ar: dict) -> dict:
    rt, at = np.array(raw["tMs"]), np.array(ar["tMs"])
    grid = np.arange(max(rt[0], at[0]) + 550, min(rt[-1], at[-1]) - 550, 20)
    rb, ab = np.array(raw["bands"]), np.array(ar["bands"])
    candidates = []
    for offset in range(-500, 501, 5):
        scores = []
        for j in range(4):
            value = correlation(
                np.interp(grid, rt, rb[:, j]), np.interp(grid + offset, at, ab[:, j])
            )
            scores.append(value)
        finite = [s for s in scores if s is not None]
        candidates.append(
            {
                "offsetMs": offset,
                "score": float(np.median(finite)) if finite else -1,
                "bands": scores,
            }
        )
    best = max(candidates, key=lambda s: s["score"])
    near = [c["offsetMs"] for c in candidates if c["score"] >= best["score"] - 0.02]
    return {
        **best,
        "nearPeakMs": [min(near), max(near)],
        "meaning": "AR PTS = raw PTS + offset; not physical tracking latency",
        "method": "median cross-correlation of four camera-band frame-difference signals",
        "gridStepMs": 5,
        "cameraPeriodMs": float(np.median(np.diff(rt))),
    }


def good(p: dict | None) -> bool:
    return p is not None and p["score"] >= CFG["score"]


def mask_and_metrics(raw: np.ndarray, ar: np.ndarray, frame: dict) -> tuple[np.ndarray, dict]:
    h, w = ar.shape[:2]
    mask = np.zeros((h, w), np.uint8)
    pts = frame["keypoints"]
    if not pts or not all(good(pts[k]) for k in [5, 6]):
        return mask, {"scorable": False}
    xy = np.array([[p["x"], p["y"]] for p in pts], float)
    sw = float(np.linalg.norm(xy[5] - xy[6]))
    if sw < 15:
        return mask, {"scorable": False}
    centre = (xy[5] + xy[6]) / 2
    hip = (xy[11] + xy[12]) / 2 if all(good(pts[k]) for k in [11, 12]) else centre + [0, sw * 1.5]
    roi = np.zeros_like(mask)
    cv2.rectangle(
        roi,
        tuple(np.round(centre - [sw * 0.9, sw * 0.7]).astype(int)),
        tuple(np.round(hip + [sw * 0.9, sw * 0.8]).astype(int)),
        255,
        -1,
    )
    for a, b in [(5, 7), (7, 9), (6, 8), (8, 10)]:
        if good(pts[a]) and good(pts[b]):
            cv2.line(
                roi,
                tuple(np.round(xy[a]).astype(int)),
                tuple(np.round(xy[b]).astype(int)),
                255,
                max(3, round(sw * 0.5)),
            )
    hsv = cv2.cvtColor(ar, cv2.COLOR_BGR2HSV)
    difference = np.max(cv2.absdiff(raw, ar), axis=2)
    mask[
        (difference > CFG["difference"])
        & (hsv[:, :, 1] < CFG["saturation_max"])
        & (hsv[:, :, 2] > CFG["brightness_min"])
        & (roi > 0)
    ] = 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask)
    keep = [k for k in range(1, n) if stats[k, cv2.CC_STAT_AREA] >= CFG["min_component"]]
    mask = np.isin(labels, keep).astype(np.uint8) * 255
    yy, xx = np.where(mask > 0)
    result: dict = {
        "scorable": True,
        "maskPixels": len(xx),
        "shoulderSpanPx": sw,
        "cuffs": {},
        "bodyProxy": {},
        "collarMinusNoseOverShoulder": None,
    }
    pixels = np.stack([xx, yy], axis=1)
    raw_lab = cv2.cvtColor(raw, cv2.COLOR_BGR2LAB)
    skin_colour = None
    if good(pts[0]):
        nx, ny = np.round(xy[0]).astype(int)
        patch = raw_lab[max(0, ny - 5) : min(h, ny + 6), max(0, nx - 5) : min(w, nx + 6), 1:]
        if patch.size:
            skin_colour = np.median(patch.reshape(-1, 2), axis=0)
    for side, elbow, wrist in [("left", 7, 9), ("right", 8, 10)]:
        if not all(good(pts[k]) for k in [elbow, wrist]):
            continue
        vector = xy[wrist] - xy[elbow]
        length = float(np.linalg.norm(vector))
        if length < 25 or not (0 <= xy[wrist, 0] < w and 0 <= xy[wrist, 1] < h):
            continue
        axis = vector / length
        normal = np.array([-axis[1], axis[0]])
        rel = pixels - xy[elbow]
        along, across = rel @ axis, rel @ normal
        region = (along > 0.5 * length) & (along < 1.5 * length) & (np.abs(across) < 0.22 * length)
        if region.sum() < 15:
            continue
        end = float(np.percentile(along[region], 98))
        endpoint = xy[elbow] + axis * end
        cuff = {
            "offsetOverForearm": (end - length) / length,
            "endpoint": endpoint.tolist(),
            "handVisibleProxy": None,
            "rawSkinPixels": 0,
        }
        tip = pixels[region & (along >= end - 0.07 * length)]
        cuff["renderedEndpoint"] = np.median(tip, axis=0).tolist() if len(tip) else None
        if skin_colour is not None:
            ry, rx = np.indices((h, w))
            ux = (rx - xy[wrist, 0]) * axis[0] + (ry - xy[wrist, 1]) * axis[1]
            vx = (rx - xy[wrist, 0]) * normal[0] + (ry - xy[wrist, 1]) * normal[1]
            hand = (ux > 0) & (ux < 0.5 * length) & (np.abs(vx) < 0.22 * length)
            skin = (
                np.linalg.norm(raw_lab[:, :, 1:].astype(float) - skin_colour, axis=2)
                < CFG["skin_distance"]
            )
            selected = hand & skin
            raw_count = int(selected.sum())
            cuff["rawSkinPixels"] = raw_count
            if raw_count >= CFG["hand_min_pixels"]:
                # A pixel-preservation proxy, not a hand-segmentation classifier.
                kept = selected & (difference < CFG["difference"]) & (ux > end - length)
                cuff["handPreservedFraction"] = float(kept.sum() / raw_count)
                cuff["handVisibleProxy"] = bool(kept.sum() >= CFG["hand_min_pixels"])
        result["cuffs"][side] = cuff
    # Signed envelope distances relative to RTMO joint boxes, NOT actual cloth/body boundaries.
    for name, y, left, right in [
        ("shoulder", centre[1], min(xy[5, 0], xy[6, 0]), max(xy[5, 0], xy[6, 0])),
        (
            "torso",
            centre[1] * 0.6 + hip[1] * 0.4,
            min(xy[5, 0], xy[6, 0]) * 0.6 + min(xy[11, 0], xy[12, 0]) * 0.4,
            max(xy[5, 0], xy[6, 0]) * 0.6 + max(xy[11, 0], xy[12, 0]) * 0.4,
        ),
    ]:
        band = xx[np.abs(yy - y) < max(2, 0.025 * sw)]
        if len(band) > 10:
            result["bodyProxy"][name] = {
                "leftOvershootPx": float(left - np.percentile(band, 2)),
                "rightOvershootPx": float(np.percentile(band, 98) - right),
            }
    for side, shoulder, elbow in [("left", 5, 7), ("right", 6, 8)]:
        if good(pts[elbow]):
            axis = xy[elbow] - xy[shoulder]
            length = float(np.linalg.norm(axis))
            if length > 25:
                axis /= length
                rel = pixels - (xy[shoulder] + xy[elbow]) / 2
                along = rel @ axis
                across = rel @ np.array([-axis[1], axis[0]])
                cross = across[np.abs(along) < max(2, 0.03 * sw)]
                if len(cross) > 10:
                    result["bodyProxy"][side + "UpperArm"] = {
                        "widthPx": float(np.percentile(cross, 95) - np.percentile(cross, 5)),
                        "jointTubeWidthPx": 0.3 * sw,
                    }
    if good(pts[0]):
        region = (
            (np.abs(xx - centre[0]) < 0.35 * sw) & (yy > xy[0, 1] - 0.4 * sw) & (yy < centre[1])
        )
        if region.sum() > 10:
            top = float(np.percentile(yy[region], 2))
            result["collarTopY"] = top
            result["collarMinusNoseOverShoulder"] = (top - xy[0, 1]) / sw
    return mask, result


def run(key: str, alignment_only: bool) -> None:
    ident = IDS[key]
    base = SOURCE / f"ar-live-20261114-{ident}"
    apath = OUT / f"{key}-alignment.json"
    if not apath.exists():
        raw_signal = signals(Path(str(base) + "-raw.webm"))
        ar_signal = signals(Path(str(base) + "-ar.webm"))
        save(apath, {"raw": raw_signal, "ar": ar_signal, "alignment": align(raw_signal, ar_signal)})
    data = json.loads(apath.read_text())
    print(key, "ALIGN", json.dumps(data["alignment"]), flush=True)
    if alignment_only:
        return
    tracks = json.loads((ROOT / f".cache/research/tracks/{key}.json").read_text())
    if not tracks["complete"]:
        raise RuntimeError("Wait for complete RTMO reference track")
    frames = tracks["frames"]
    offset = data["alignment"]["offsetMs"]
    arcap, rawcap = (
        cv2.VideoCapture(str(base) + "-ar.webm"),
        cv2.VideoCapture(str(base) + "-raw.webm"),
    )
    raw_times = np.array(data["raw"]["tMs"])
    rows, samples = [], []
    raw_index, raw_image = -1, None
    try:
        while True:
            ok, ar = arcap.read()
            if not ok:
                break
            at = arcap.get(cv2.CAP_PROP_POS_MSEC)
            target = at - offset
            i = int(np.argmin(np.abs(raw_times - target)))
            while raw_index < i:
                ok, raw_image = rawcap.read()
                raw_index += 1
                if not ok:
                    raise RuntimeError("Raw decoder ended before timestamp match")
            raw = cv2.resize(raw_image, (ar.shape[1], ar.shape[0]))
            frame = frames[i]
            # References use native raw width960, AR width959; match exactly once.
            scale = ar.shape[1] / raw_image.shape[1]
            mapped = {
                **frame,
                "keypoints": [{**p, "x": p["x"] * scale} for p in frame["keypoints"]]
                if frame["keypoints"]
                else None,
            }
            mask, metrics = mask_and_metrics(raw, ar, mapped)
            row = {
                "arIndex": len(rows),
                "arMs": at,
                "rawIndex": i,
                "rawMs": raw_times[i].item(),
                "matchErrorMs": float(raw_times[i] - target),
                **metrics,
            }
            rows.append(row)
            if len(rows) % 30 == 1:
                tile = np.hstack([raw, ar])
                tile = cv2.resize(tile, (640, 180))
                cv2.putText(
                    tile,
                    f"raw {row['rawMs'] / 1000:.3f}s | AR {at / 1000:.3f}s",
                    (5, 17),
                    0,
                    0.45,
                    (0, 0, 255),
                    1,
                )
                samples.append(tile)
            if len(rows) % 150 == 0:
                print(key, "MASK", len(rows), flush=True)
        for k in range(0, len(samples), 12):
            subset = samples[k : k + 12]
            while len(subset) % 2:
                subset.append(np.zeros_like(subset[0]))
            sheet = np.vstack([np.hstack(subset[j : j + 2]) for j in range(0, len(subset), 2)])
            cv2.imwrite(str(OUT / f"{key}-sheet-{k // 12}.jpg"), sheet)
        save(
            OUT / f"{key}-metrics.json",
            {
                "config": CFG,
                "alignment": data["alignment"],
                "frames": rows,
                "caveat": (
                    "colour+difference estimates; hand preservation and body joint tubes "
                    "are proxies, not ground truth"
                ),
            },
        )
    finally:
        arcap.release()
        rawcap.release()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--align-only", action="store_true")
    parser.add_argument("--clip", choices=[*IDS, "camo-1"], required=True)
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    if args.clip == "camo-1":
        camera_file()
    else:
        run(args.clip, args.align_only)
