"""Pure two-view scan geometry, independently ported from scanGeometry.ts.

No vision-package imports. The optional shoulder/arm measurements are omitted:
COCO joint centres are not the kiosk's silhouette acromion landmarks.
"""

from __future__ import annotations

import math
import statistics

# Sources: packages/vision/src/{scanGeometry,scan,calibration}.ts, read 2026-11-15.
# Orientation/full-height gates and silhouette bands are the kiosk heuristics;
# additional lean/row-support gates are explicit research choices, not calibration.
CONFIG = {
    "bands": {
        "chest_cm": (0.70, 0.78, "max"),
        "waist_cm": (0.57, 0.65, "min"),
        "hip_cm": (0.46, 0.56, "max"),
    },
    "profile_lo": 0.44,
    "profile_hi": 0.80,
    "profile_step": 0.005,
    "mask_threshold": 0.5,
    "min_score": 0.65,
    "min_fill": 0.60,
    "max_fill": 0.95,
    "edge_margin": 0.005,
    "front_sep": 0.12,
    "side_sep": 0.06,
    "max_lean_deg": 8,
    "min_abduction_deg": 15,
    "max_abduction_deg": 55,
    "side_tolerance_over_height": 0.02,
    "min_frame_share": 0.5,
    "min_frames": 3,
    "mad_to_sigma": 1.4826,
    "sigma_rel": 0.08,
    "sigma_min_cm": 0.1,
    "sample_ms": 500,
    "seg_size": 192,
    # Native PP-HumanSeg model: RGB, [-1,1], 192 square input. The mask is
    # interpolated back to source pixels; interpolation adds no spatial evidence.
    "seg_model": ".cache/research/seg/pphumanseg/pphumanseg_2023mar.onnx",
    # Partial-view diagnostics ONLY: torso landmark fractions, not the service's
    # stature bands; cannot be converted into body girths using stated height.
    "partial_rows": {"chest_cm": 0.35, "waist_cm": 0.80, "hip_cm": 1.0},
    "partial_front_ratio": 0.85,
    "partial_side_ratio": 0.30,
    "partial_row_half_span": 0.01,
}
FRACTIONS = [
    CONFIG["profile_lo"] + i * CONFIG["profile_step"]
    for i in range(
        round((CONFIG["profile_hi"] - CONFIG["profile_lo"]) / CONFIG["profile_step"]) + 1
    )
]


def median(values: list[float | None]) -> float | None:
    finite = [v for v in values if v is not None and math.isfinite(v)]
    return statistics.median(finite) if finite else None


def robust_sigma(values: list[float | None]) -> float:
    centre = median(values)
    return (
        0.0
        if centre is None
        else CONFIG["mad_to_sigma"]
        * (median([abs(v - centre) for v in values if v is not None and math.isfinite(v)]) or 0)
    )


def ellipse_perimeter(width: float, depth: float) -> float:
    """Full diameters in, circumference out; Ramanujan first approximation."""
    if not all(math.isfinite(v) and v > 0 for v in (width, depth)):
        raise ValueError("Ellipse diameters must be finite and positive")
    a, b = width / 2, depth / 2
    return math.pi * (3 * (a + b) - math.sqrt((3 * a + b) * (a + 3 * b)))


def front_span(
    runs: list[tuple[float, float]], centre: float, arms: list[float]
) -> tuple[float, float] | None:
    kept = []
    for left, right in runs:
        has_centre = left <= centre <= right
        if any(left <= x <= right for x in arms):
            if has_centre:
                return None  # arm and torso merged: never cut an invented boundary
            continue
        mid = (left + right) / 2
        if not has_centre and any(
            (x - centre) * (mid - centre) > 0 and abs(mid - x) < abs(mid - centre) for x in arms
        ):
            continue
        kept.append((left, right))
    if not kept:
        return None
    left, right = min(p[0] for p in kept), max(p[1] for p in kept)
    return (left, right) if left < centre < right else None


def arm_xs(points: list[tuple[float, float]], y: float) -> list[float]:
    found = []
    for a, b in zip(points, points[1:], strict=False):
        if min(a[1], b[1]) <= y <= max(a[1], b[1]) and b[1] != a[1]:
            found.append(a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]))
    if found:
        return found
    return [
        min(points, key=lambda p: p[1])[0]
        if y < min(p[1] for p in points)
        else max(points, key=lambda p: p[1])[0]
    ]


def aggregate(front: list[dict], side: list[dict], height_cm: float) -> dict:
    """Normalized profiles -> native API measurements, with correlated-frame spread."""
    out: dict = {
        "measurements": {},
        "missing": {},
        "front_frames": len(front),
        "side_frames": len(side),
    }
    if min(len(front), len(side)) < CONFIG["min_frames"]:
        out["missing"]["all"] = "Need at least three usable full-height front and side frames"
        return out

    def profile(frames: list[dict]) -> list[float | None]:
        return [
            median([f["profile"][i] for f in frames])
            if sum(f["profile"][i] is not None for f in frames)
            >= len(frames) * CONFIG["min_frame_share"]
            else None
            for i in range(len(FRACTIONS))
        ]

    fw, sd = profile(front), profile(side)

    def extreme(
        width: list, depth: list, lo: float, hi: float, pick: str
    ) -> tuple[float, float] | None:
        valid = [
            (ellipse_perimeter(w, d), f)
            for f, w, d in zip(FRACTIONS, width, depth, strict=True)
            if lo - 1e-9 <= f <= hi + 1e-9 and w is not None and d is not None
        ]
        return (max(valid) if pick == "max" else min(valid)) if valid else None

    for name, (lo, hi, pick) in CONFIG["bands"].items():
        best = extreme(fw, sd, lo, hi, pick)
        if best is None:
            out["missing"][name] = "No shared torso row: cropped body, mask failure, or merged arms"
            continue
        a = [extreme(f["profile"], sd, lo, hi, pick) for f in front]
        b = [extreme(fw, s["profile"], lo, hi, pick) for s in side]
        spread = math.hypot(
            robust_sigma([v[0] if v else None for v in a]),
            robust_sigma([v[0] if v else None for v in b]),
        )
        value = best[0] * height_cm
        out["measurements"][name] = {
            "value_cm": value,
            "spread_cm": spread * height_cm,
            "ratio_to_height": best[0],
            "spread_ratio": spread,
            "sigma_cm": max(
                CONFIG["sigma_min_cm"], math.hypot(CONFIG["sigma_rel"] * value, spread * height_cm)
            ),
            "fraction": best[1],
            "frames_front": sum(v is not None for v in a),
            "frames_side": sum(v is not None for v in b),
            "method": (
                "uncalibrated PP-HumanSeg/RTMO two-view silhouette; Ramanujan ellipse; "
                "MAD repeatability plus 8% model prior"
            ),
        }
    return out
