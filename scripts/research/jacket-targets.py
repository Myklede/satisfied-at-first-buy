"""P26 local colour-mask targets. Launch through py, not the Store alias.

All thresholds are exploratory image heuristics, not tape-fit calibration.
No pixels or body measurements leave .cache/research/jacket-targets.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / ".cache/research/cv"))
import cv2  # noqa: E402
import numpy as np  # noqa: E402

# Native Lab/HSV patch calibration (private colour-probe.py, 2026-11-14):
# cloth L p10>=176, S p90<=57; trousers S p10>=62, skin warm b>=135.
# Margins separate observed colours, not desired geometry. Sweep is not a CI.
CONFIG = {
    "lightness": 165,
    "saturation": 55,
    "max_a": 132,
    "max_b": 134,
    # Parka shadowed white panels have higher blue saturation than the cream
    # puffer. Its darker trousers separate mainly by lightness in reviewed frames.
    "parka_lightness": 155,
    "parka_saturation": 110,
    "lightness_delta": 12,
    "saturation_delta": 15,
    "morphology": 5,
    "score": 0.65,
}
OUT = ROOT / ".cache/research/jacket-targets"
cv2.setNumThreads(1)


def usable(p: dict | None) -> bool:
    return p is not None and p["score"] >= CONFIG["score"]


def segment(im: np.ndarray, frame: dict, delta: int = 0) -> np.ndarray:
    """Colour + connected components inside upper-body/arm anatomical search ROI."""
    pts = frame["keypoints"]
    mask = np.zeros(im.shape[:2], np.uint8)
    if not pts or not all(usable(pts[k]) for k in [5, 6]):
        return mask
    xy = np.array([[p["x"], p["y"]] for p in pts], np.float32)
    sw = float(np.linalg.norm(xy[5] - xy[6]))
    if sw < 10:
        return mask
    # ROI scale must not collapse when projected shoulders overlap in profile.
    # The reported measurement denominator remains the original shoulder span.
    if frame.get("box"):
        sw = max(sw, 0.25 * (frame["box"][3] - frame["box"][1]))
    centre = (xy[5] + xy[6]) / 2
    hips = (xy[11] + xy[12]) / 2
    if not all(usable(pts[k]) for k in [11, 12]):
        hips = centre + [0, sw * 1.3]
    roi = np.zeros(im.shape[:2], np.uint8)
    torso = np.array(
        [
            centre + [-0.8 * sw, -0.4 * sw],
            centre + [0.8 * sw, -0.4 * sw],
            hips + [0.8 * sw, 1.35 * sw],
            hips + [-0.8 * sw, 1.35 * sw],
        ],
        np.int32,
    )
    cv2.fillConvexPoly(roi, torso, 255)
    for a, b in [(5, 7), (7, 9), (6, 8), (8, 10)]:
        if usable(pts[a]) and usable(pts[b]):
            cv2.line(
                roi,
                tuple(xy[a].astype(int)),
                tuple(xy[b].astype(int)),
                255,
                max(3, round(sw * 0.45)),
            )
    if frame.get("box"):
        x0, y0, x1, y1 = map(round, frame["box"])
        bounds = np.zeros_like(roi)
        bounds[max(0, y0) : min(im.shape[0], y1 + 1), max(0, x0) : min(im.shape[1], x1 + 1)] = 255
        roi &= bounds
    lab = cv2.cvtColor(im, cv2.COLOR_BGR2LAB)
    hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV)
    lightness = (
        CONFIG["parka_lightness"]
        if frame.get("jacketKey") == "venue-parka"
        else CONFIG["lightness"]
    )
    saturation = (
        CONFIG["parka_saturation"]
        if frame.get("jacketKey") == "venue-parka"
        else CONFIG["saturation"]
    )
    mask[
        (lab[:, :, 0] >= lightness + delta * CONFIG["lightness_delta"])
        & (hsv[:, :, 1] <= saturation - delta * CONFIG["saturation_delta"])
        & (lab[:, :, 1] <= CONFIG["max_a"])
        & (lab[:, :, 2] <= CONFIG["max_b"])
        & (roi > 0)
    ] = 255
    # Exclude the face centre. Collar-side flaps remain measurable; validate top visually.
    if usable(pts[0]):
        cv2.ellipse(
            mask,
            tuple(xy[0].astype(int)),
            (max(1, round(0.13 * sw)), max(1, round(0.15 * sw))),
            0,
            0,
            360,
            0,
            -1,
        )
    kernel = np.ones((CONFIG["morphology"], CONFIG["morphology"]), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask)
    keep = [i for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] >= sw * sw * 0.015]
    return np.isin(labels, keep).astype(np.uint8) * 255


def measure(mask: np.ndarray, frame: dict, chin: dict | None = None) -> dict:
    pts = frame["keypoints"]
    if not pts or not all(usable(pts[k]) for k in [5, 6]):
        return {"valid": False}
    xy = np.array([[p["x"], p["y"]] for p in pts], np.float32)
    sw = float(np.linalg.norm(xy[5] - xy[6]))
    if sw < 10:
        return {"valid": False}
    shoulder = (xy[5] + xy[6]) / 2
    yy, xx = np.where(mask > 0)
    out: dict = {"valid": len(xx) > 20, "shoulderSpanPx": sw, "maskPixels": len(xx), "cuffs": {}}
    out["projectionStable"] = not frame.get("box") or sw >= 0.12 * (
        frame["box"][3] - frame["box"][1]
    )
    # Human-reviewed endpoints remain separate from the colour-mask estimates.
    # COCO has no chin; this field is never inferred from the nose.
    if chin:
        if "collarTopY" in chin:
            out["manualCollarMinusChinOverShoulder"] = (chin["collarTopY"] - chin["y"]) / sw
            out["manualCollarReadingErrorOverShoulder"] = (
                chin["errorPx"] + chin["collarErrorPx"]
            ) / sw
            if usable(pts[0]):
                out["manualCollarMinusNoseOverShoulder"] = (
                    chin["collarTopY"] - float(xy[0, 1])
                ) / sw
        manual_cuffs = {}
        for side, elbow, wrist in [("left", 7, 9), ("right", 8, 10)]:
            point = chin.get("cuffs", {}).get(side)
            if point and usable(pts[elbow]) and usable(pts[wrist]):
                axis = xy[wrist] - xy[elbow]
                length = float(np.linalg.norm(axis))
                if length > 0:
                    endpoint = np.array([point["x"], point["y"]])
                    manual_cuffs[side] = {
                        "endMinusWristOverShoulder": float((endpoint - xy[wrist]) @ (axis / length))
                        / sw,
                        "readingErrorOverShoulder": point["errorPx"] / sw,
                    }
        out["manualCuffs"] = manual_cuffs
    if not len(xx):
        return out
    pixels = np.stack([xx, yy], axis=1)
    for side, elbow, wrist in [("left", 7, 9), ("right", 8, 10)]:
        if not (usable(pts[elbow]) and usable(pts[wrist])):
            continue
        axis = xy[wrist] - xy[elbow]
        length = float(np.linalg.norm(axis))
        if length < sw * 0.25 or not (
            0 <= xy[wrist, 0] < mask.shape[1] and 0 <= xy[wrist, 1] < mask.shape[0]
        ):
            continue
        axis /= length
        rel = pixels - xy[elbow]
        along, across = rel @ axis, rel @ np.array([-axis[1], axis[0]])
        region = (along > 0.4 * length) & (along < 1.45 * length) & (np.abs(across) < 0.20 * sw)
        if region.sum() < 20:
            continue
        end = float(np.percentile(along[region], 99))
        band = region & (np.abs(along - 0.7 * length) < 0.07 * sw)
        width = (
            float(np.percentile(across[band], 95) - np.percentile(across[band], 5))
            if band.sum() >= 10
            else None
        )
        out["cuffs"][side] = {
            "endMinusWristOverShoulder": (end - length) / sw,
            "sleeveWidthOverForearm": width / length if width is not None else None,
            "end": (xy[elbow] + axis * end).tolist(),
        }
    if usable(pts[0]):
        region = (
            (np.abs(xx - shoulder[0]) < 0.35 * sw)
            & (yy > xy[0, 1] + 0.05 * sw)
            & (yy < shoulder[1] + 0.2 * sw)
        )
        if region.sum() >= 10:
            top = float(np.percentile(yy[region], 1))
            out["collarTopPx"] = top
            out["collarMinusNoseOverShoulder"] = (top - float(xy[0, 1])) / sw
            if chin:
                out["collarMinusChinOverShoulder"] = (top - chin["y"]) / sw
                out["manualChinUncertaintyOverShoulder"] = chin["errorPx"] / sw
    if all(usable(pts[k]) for k in [11, 12]):
        hip = (xy[11] + xy[12]) / 2
        region = (np.abs(xx - hip[0]) < 0.4 * sw) & (yy > shoulder[1]) & (yy < hip[1] + 1.4 * sw)
        if region.sum() >= 20:
            hem = float(np.percentile(yy[region], 99))
            out["hemMinusHipOverShoulder"] = (hem - float(hip[1])) / sw
            out["hemY"] = hem
        rows = {"shoulder": shoulder[1], "chest": 0.6 * shoulder[1] + 0.4 * hip[1]}
        if "hemY" in out:
            rows["hem"] = out["hemY"] - 0.03 * sw
        for name, y in rows.items():
            region = (np.abs(yy - y) < 0.025 * sw) & (np.abs(xx - shoulder[0]) < 0.95 * sw)
            if region.sum() >= 10:
                out[name + "WidthOverShoulder"] = (
                    float(np.percentile(xx[region], 98) - np.percentile(xx[region], 2)) / sw
                )
    return out


def run(key: str) -> None:
    track = json.loads((ROOT / f".cache/research/tracks/{key}.json").read_text())
    frames = track["frames"]
    cap = cv2.VideoCapture(str(ROOT / track["source"]))
    count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    sample_ids = np.linspace(0, len(frames) - 1, 10).round().astype(int)
    samples = {frames[i]["index"] for i in sample_ids}
    selection_path = OUT / "sample-frames.json"
    if selection_path.exists():
        selected = json.loads(selection_path.read_text()).get(key)
        if selected is not None:
            if not selected or any(not isinstance(i, int) or not 0 <= i < count for i in selected):
                raise ValueError("Sample indices must be nonempty native frame indices")
            samples = set(selected)
    chins_path = OUT / "chins.json"
    chins = json.loads(chins_path.read_text()) if chins_path.exists() else {}
    results = []
    pointer = 0
    sample_only = "--samples-only" in sys.argv
    indices = sorted(samples) if sample_only else range(count)
    for i in indices:
        if sample_only:
            cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, im = cap.read()
        if not ok:
            break
        while pointer + 1 < len(frames) and abs(frames[pointer + 1]["index"] - i) <= abs(
            frames[pointer]["index"] - i
        ):
            pointer += 1
        frame = frames[pointer]
        frame["jacketKey"] = key
        if abs(frame["index"] - i) > 1:
            continue
        chin = chins.get(f"{key}:{i}")
        # Full-quality base mask on every decoded frame. The threshold sweep is
        # needed for the selected target/error-bar frames, not three times per video frame.
        masks = (
            [segment(im, frame, delta) for delta in [-1, 0, 1]]
            if i in samples
            else [None, segment(im, frame), None]
        )
        values = [measure(m, frame, chin) if m is not None else None for m in masks]
        results.append(
            {
                "index": i,
                "tMs": cap.get(cv2.CAP_PROP_POS_MSEC),
                "referenceIndex": frame["index"],
                "measure": values[1],
                "sensitivity": [values[0], values[2]] if i in samples else None,
            }
        )
        if i in samples:
            overlay = im.copy()
            overlay[masks[1] > 0] = (
                overlay[masks[1] > 0] * 0.5 + np.array([0, 255, 0]) * 0.5
            ).astype(np.uint8)
            for p in frame["keypoints"] or []:
                if usable(p):
                    cv2.circle(overlay, (round(p["x"]), round(p["y"])), 4, (0, 0, 255), -1)
            for cuff in values[1].get("cuffs", {}).values():
                cv2.circle(overlay, tuple(np.round(cuff["end"]).astype(int)), 6, (255, 0, 255), 2)
            if "collarTopPx" in values[1]:
                cv2.line(
                    overlay,
                    (0, round(values[1]["collarTopPx"])),
                    (im.shape[1], round(values[1]["collarTopPx"])),
                    (255, 255, 0),
                    1,
                )
            cv2.putText(
                overlay,
                f"{key} frame {i} t={cap.get(cv2.CAP_PROP_POS_MSEC) / 1000:.2f}",
                (15, 30),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.8,
                (255, 0, 255),
                2,
            )
            cv2.imwrite(str(OUT / f"{key}-{i}-overlay.png"), overlay)
            cv2.imwrite(str(OUT / f"{key}-{i}-raw.png"), im)
        if i % 300 == 0:
            (OUT / f"{key}.json").write_text(
                json.dumps({"complete": False, "config": CONFIG, "frames": results})
            )
            print(key, i, flush=True)
    cap.release()
    name = f"{key}-samples.json" if sample_only else f"{key}.json"
    (OUT / name).write_text(
        json.dumps(
            {
                "complete": not sample_only and len(results) == count,
                "sampled": sample_only,
                "decodedFrames": len(results),
                "expectedFrames": count,
                "config": CONFIG,
                "frames": results,
            }
        )
    )


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    # Root-relative fixed outputs are gitignored; the Node launcher checks git check-ignore.
    wanted = sys.argv[sys.argv.index("--clip") + 1] if "--clip" in sys.argv else None
    if wanted is not None and wanted not in ["venue-parka", "venue-puffer"]:
        raise ValueError("Unknown fixed jacket key")
    for key in ["venue-parka", "venue-puffer"]:
        if wanted is None or wanted == key:
            run(key)
