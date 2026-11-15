"""P32 A. Saved video -> two-view scan. Never opens a camera or prints body values."""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import math
import sys

from body_scan_geometry import (
    CONFIG,
    FRACTIONS,
    aggregate,
    arm_xs,
    ellipse_perimeter,
    front_span,
    median,
    robust_sigma,
)
from camera_study_common import ROOT, person_profile, private_directory, wait_for_cpu

sys.path.insert(0, str(ROOT / ".cache/research/cv"))
import cv2  # noqa: E402
import numpy as np  # noqa: E402

cv2.setNumThreads(1)
CLIPS = {
    "venue-khong-ao": "FB7675-100-parka-trang/video/venue-khong-ao.mp4",
    "cam-tshirt": "FB7675-100-parka-trang/video/cam-tshirt.mp4",
}


def row_runs(row: np.ndarray) -> list[tuple[float, float]]:
    inside = row >= CONFIG["mask_threshold"]
    changes = np.diff(np.pad(inside.astype(np.int8), (1, 1)))
    runs = []
    for left, end in zip(np.where(changes == 1)[0], np.where(changes == -1)[0], strict=True):
        right = end - 1
        edge_left = (
            float(left)
            if left == 0
            else left
            - 0.5
            + (CONFIG["mask_threshold"] - row[left - 1]) / max(1e-9, row[left] - row[left - 1])
        )
        r = (
            float(end)
            if end == len(row)
            else right
            + 0.5
            + (row[right] - CONFIG["mask_threshold"]) / max(1e-9, row[right] - row[end])
        )
        runs.append((float(edge_left), float(r)))
    return runs


def measure_frame(prob: np.ndarray, frame: dict) -> dict:
    pts = frame.get("keypoints")
    if not pts or not all(pts[k]["score"] >= CONFIG["min_score"] for k in (5, 6, 11, 12)):
        return {"rejected": "weak pose"}
    h, w = prob.shape
    xy = np.array([[p["x"], p["y"]] for p in pts])
    shoulder, hip = (xy[5] + xy[6]) / 2, (xy[11] + xy[12]) / 2
    _, labels, stats, _ = cv2.connectedComponentsWithStats(
        (prob >= CONFIG["mask_threshold"]).astype(np.uint8), connectivity=4
    )
    label = 0
    for seed in ((shoulder + hip) / 2, shoulder, hip):
        x, y = np.rint(seed).astype(int)
        if 0 <= x < w and 0 <= y < h and labels[y, x]:
            label = int(labels[y, x])
            break
    if not label:
        return {"rejected": "torso seed outside segmentation"}
    left, top, bw, bh, area = stats[label]
    if top <= h * CONFIG["edge_margin"] or top + bh >= h * (1 - CONFIG["edge_margin"]):
        return {"rejected": "head or feet cropped"}
    if not all(
        pts[k]["score"] >= CONFIG["min_score"] and 0 <= pts[k]["x"] < w and 0 <= pts[k]["y"] < h
        for k in (15, 16)
    ):
        return {"rejected": "feet not confirmed by pose"}
    stature = float(bh)
    if not CONFIG["min_fill"] <= stature / h <= CONFIG["max_fill"]:
        return {"rejected": "full-height fill outside kiosk range"}
    if (
        abs(math.degrees(math.atan2(shoulder[0] - hip[0], hip[1] - shoulder[1])))
        > CONFIG["max_lean_deg"]
    ):
        return {"rejected": "leaning"}
    sep = abs(xy[5, 0] - xy[6, 0]) / stature
    phase = "front" if sep >= CONFIG["front_sep"] else "side" if sep <= CONFIG["side_sep"] else None
    if phase is None:
        return {"rejected": "oblique view"}
    if phase == "front":
        if not all(pts[k]["score"] >= CONFIG["min_score"] for k in (7, 8, 9, 10)):
            return {"rejected": "weak arm pose"}
        abduction = [
            math.degrees(math.atan2(abs(xy[e, 0] - xy[s, 0]), xy[e, 1] - xy[s, 1]))
            for s, e in ((5, 7), (6, 8))
        ]
        if not all(
            CONFIG["min_abduction_deg"] <= a <= CONFIG["max_abduction_deg"] for a in abduction
        ):
            return {"rejected": "front arms not separated at kiosk angle"}
    person_prob = np.where(labels == label, prob, 0)
    # Match the kiosk's mask-edge stature convention, rather than just bbox height.
    crown = min(
        (
            edge
            for x in range(left, left + bw)
            for edge, _ in row_runs(person_prob[:, x])
            if top <= edge <= top + 1
        ),
        default=float(top),
    )
    floor = max(
        (
            r
            for x in range(left, left + bw)
            for _, r in row_runs(person_prob[:, x])
            if top + bh - 1 <= r <= top + bh + 1
        ),
        default=float(top + bh),
    )
    stature = floor - crown
    profile = []
    rows = []
    for fraction in FRACTIONS:
        y0 = max(0, math.ceil(floor - (fraction + CONFIG["profile_step"] / 2) * stature - 0.5))
        y1 = min(h, math.ceil(floor - (fraction - CONFIG["profile_step"] / 2) * stature - 0.5))
        spans = []
        for y in range(y0, y1):
            yc = y + 0.5
            t = float(np.clip((yc - shoulder[1]) / max(1e-9, hip[1] - shoulder[1]), 0, 1))
            cx = float(shoulder[0] + t * (hip[0] - shoulder[0]))
            runs = row_runs(person_prob[y])
            if phase == "front":
                arms = arm_xs([tuple(xy[k]) for k in (5, 7, 9)], yc) + arm_xs(
                    [tuple(xy[k]) for k in (6, 8, 10)], yc
                )
                span = front_span(runs, cx, arms)
            else:
                span = min(runs, key=lambda r: max(r[0] - cx, cx - r[1], 0), default=None)
                if (
                    span
                    and max(span[0] - cx, cx - span[1], 0)
                    > CONFIG["side_tolerance_over_height"] * stature
                ):
                    span = None
            if span:
                spans.append((span[1] - span[0]) / stature)
                rows.append({"fraction": fraction, "y": yc, "left": span[0], "right": span[1]})
        profile.append(float(np.mean(spans)) if spans else None)
    return {
        "phase": phase,
        "t_ms": frame["tMs"],
        "index": frame["index"],
        "profile": profile,
        "stature_px": stature,
        "fill": stature / h,
        "shoulder_sep": sep,
        "mask_area": int(area),
        "rows": rows,
    }


def partial_view(prob: np.ndarray, frame: dict, frontal_ratio: float) -> dict | None:
    """Observable image ratios for rejected cropped clips; NEVER service targets."""
    pts = frame.get("keypoints")
    if not pts or not all(pts[k]["score"] >= CONFIG["min_score"] for k in (5, 6, 11, 12)):
        return None
    xy = np.array([[p["x"], p["y"]] for p in pts])
    shoulder, hip = (xy[5] + xy[6]) / 2, (xy[11] + xy[12]) / 2
    torso = float(np.linalg.norm(hip - shoulder))
    if (
        torso <= 0
        or abs(math.degrees(math.atan2(shoulder[0] - hip[0], hip[1] - shoulder[1])))
        > CONFIG["max_lean_deg"]
    ):
        return None
    ratio = abs(xy[5, 0] - xy[6, 0]) / torso / frontal_ratio
    phase = (
        "front"
        if ratio >= CONFIG["partial_front_ratio"] and xy[5, 0] > xy[6, 0]
        else "side"
        if ratio <= CONFIG["partial_side_ratio"]
        else None
    )
    if not phase:
        return None
    h, w = prob.shape
    _, labels = cv2.connectedComponents(
        (prob >= CONFIG["mask_threshold"]).astype(np.uint8), connectivity=4
    )
    centre = (shoulder + hip) / 2
    cx, cy = np.rint(centre).astype(int)
    if not 0 <= cx < w or not 0 <= cy < h or labels[cy, cx] == 0:
        return None
    person = np.where(labels == labels[cy, cx], prob, 0)
    result = {
        "phase": phase,
        "t_ms": frame["tMs"],
        "index": frame["index"],
        "ratios": {},
        "rows": [],
    }
    for name, fraction in CONFIG["partial_rows"].items():
        target = shoulder + fraction * (hip - shoulder)
        spans = []
        radius = max(1, round(CONFIG["partial_row_half_span"] * torso))
        for y in range(round(target[1]) - radius, round(target[1]) + radius + 1):
            if not 0 <= y < h:
                continue
            runs = row_runs(person[y])
            if phase == "front":
                if not all(pts[k]["score"] >= CONFIG["min_score"] for k in (7, 8, 9, 10)):
                    continue
                arms = arm_xs([tuple(xy[k]) for k in (5, 7, 9)], y + 0.5) + arm_xs(
                    [tuple(xy[k]) for k in (6, 8, 10)], y + 0.5
                )
                span = front_span(runs, float(target[0]), arms)
            else:
                span = next((r for r in runs if r[0] <= target[0] <= r[1]), None)
            if span:
                spans.append((span[1] - span[0]) / torso)
                result["rows"].append({"y": y, "left": span[0], "right": span[1]})
        result["ratios"][name] = median(spans)
    return result


def summarize_partial(views: list[dict]) -> dict:
    result = {}
    for name in CONFIG["partial_rows"]:
        front = [
            v["ratios"][name]
            for v in views
            if v["phase"] == "front" and v["ratios"][name] is not None
        ]
        side = [
            v["ratios"][name]
            for v in views
            if v["phase"] == "side" and v["ratios"][name] is not None
        ]
        fw, sd = median(front), median(side)
        result[name] = {
            "front_n": len(front),
            "side_n": len(side),
            "width_over_image_torso": fw,
            "depth_over_image_torso": sd,
            "width_mad_sigma": robust_sigma(front),
            "depth_mad_sigma": robust_sigma(side),
        }
        if fw and sd:
            result[name]["ellipse_over_image_torso"] = ellipse_perimeter(fw, sd)
    return result


def extract(clip: str) -> dict:
    out = private_directory("body")
    source = ROOT / "data/reference-photos" / CLIPS[clip]
    reference = json.loads((ROOT / ".cache/research/tracks" / (clip + ".json")).read_text())
    if (
        not reference["complete"]
        or hashlib.sha256(source.read_bytes()).hexdigest() != reference["sourceSha256"]
    ):
        raise ValueError("Missing/stale dense RTMO reference")
    samples = []
    last = -math.inf
    for f in reference["frames"]:
        if f["tMs"] - last >= CONFIG["sample_ms"]:
            samples.append(f)
            last = f["tMs"]
    net = cv2.dnn.readNetFromONNX(str(ROOT / CONFIG["seg_model"]))
    cap = cv2.VideoCapture(str(source), cv2.CAP_FFMPEG, [cv2.CAP_PROP_N_THREADS, 1])
    if not cap.isOpened():
        raise RuntimeError("Saved input video could not be opened")
    rejected: collections.Counter = collections.Counter()
    accepted = []
    previews = []
    partial = []
    ratios = []
    for f in reference["frames"]:
        p = f.get("keypoints")
        if p and all(p[k]["score"] >= CONFIG["min_score"] for k in (5, 6, 11, 12)):
            shoulder = np.mean([[p[k]["x"], p[k]["y"]] for k in (5, 6)], axis=0)
            hip = np.mean([[p[k]["x"], p[k]["y"]] for k in (11, 12)], axis=0)
            ratios.append(
                abs(p[5]["x"] - p[6]["x"]) / max(1e-9, float(np.linalg.norm(shoulder - hip)))
            )
    frontal_ratio = float(np.percentile(ratios, 95)) if ratios else 1
    decoded = -1
    try:
        for f in samples:
            wait_for_cpu()
            # Sequential grabs preserve VFR frame identity; no camera device index.
            while decoded < f["index"]:
                if not cap.grab():
                    raise RuntimeError("Video ended before reference frame")
                decoded += 1
            ok, im = cap.retrieve()
            if not ok or abs(cap.get(cv2.CAP_PROP_POS_MSEC) - f["tMs"]) > 2:
                raise RuntimeError("Decoded source frame does not match reference PTS")
            size = CONFIG["seg_size"]
            net.setInput(
                cv2.dnn.blobFromImage(
                    im, 1 / 127.5, (size, size), (127.5, 127.5, 127.5), swapRB=True
                )
            )
            pred = net.forward()
            if pred.shape != (1, 2, size, size):
                raise RuntimeError("Unexpected PP-HumanSeg tensor layout")
            prob = cv2.resize(
                pred[0, 1], (im.shape[1], im.shape[0]), interpolation=cv2.INTER_LINEAR
            )
            measured = measure_frame(prob, f)
            relative = partial_view(prob, f, frontal_ratio)
            if relative:
                partial.append(relative)
            if "rejected" in measured:
                rejected[measured["rejected"]] += 1
            else:
                accepted.append(measured)
            # A small, explicitly authorized local audit sheet includes rejected views.
            if len(previews) < 24 and (len(accepted) == 0 or "rejected" not in measured):
                preview = im.copy()
                tint = np.zeros_like(preview)
                tint[:, :, 1] = (prob * 255).astype(np.uint8)
                preview = cv2.addWeighted(preview, 0.75, tint, 0.25, 0)
                for row in (relative or measured).get("rows", [])[::4]:
                    cv2.line(
                        preview,
                        (round(row["left"]), round(row["y"])),
                        (round(row["right"]), round(row["y"])),
                        (0, 0, 255),
                        2,
                    )
                cv2.putText(
                    preview,
                    f"{f['tMs'] / 1000:.2f}s "
                    + measured.get("phase", measured.get("rejected", "")),
                    (10, 26),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.6,
                    (0, 0, 255),
                    2,
                )
                previews.append(cv2.resize(preview, (480, round(480 * im.shape[0] / im.shape[1]))))
    finally:
        cap.release()
    profile = person_profile()
    result = aggregate(
        [f for f in accepted if f["phase"] == "front"],
        [f for f in accepted if f["phase"] == "side"],
        profile["height_cm"],
    )
    payload = {
        "schema": "satisfy.offline-body-scan/1",
        "clip": clip,
        "source_sha256": reference["sourceSha256"],
        "config": CONFIG,
        "accepted": accepted,
        "rejected": dict(rejected),
        "result": result,
        "partial_views": partial,
        "partial_summary": summarize_partial(partial),
    }
    (out / (clip + ".json")).write_text(json.dumps(payload, indent=2), encoding="utf-8")
    if previews:
        blank = np.zeros_like(previews[0])
        while len(previews) % 4:
            previews.append(blank)
        cv2.imwrite(
            str(out / (clip + "-audit.jpg")),
            np.vstack([np.hstack(previews[i : i + 4]) for i in range(0, len(previews), 4)]),
        )
    print(
        json.dumps(
            {
                "clip": clip,
                "front": result["front_frames"],
                "side": result["side_frames"],
                "measured_names": list(result["measurements"]),
                "rejected": dict(rejected),
            }
        ),
        flush=True,
    )
    return payload


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clip", choices=list(CLIPS), default="venue-khong-ao")
    args = parser.parse_args()
    wait_for_cpu()
    extract(args.clip)
