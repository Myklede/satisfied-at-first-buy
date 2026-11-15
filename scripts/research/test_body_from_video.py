"""Neutral synthetic fixtures only; no personal values or frames."""

import importlib.util
import math
from pathlib import Path

import pytest
from body_scan_geometry import CONFIG, FRACTIONS, aggregate, arm_xs, ellipse_perimeter, front_span
from camera_study_common import sync_state


def test_ellipse_uses_diameters_and_scale_linearity():
    assert ellipse_perimeter(2, 2) == pytest.approx(2 * math.pi)
    assert ellipse_perimeter(4, 2) == pytest.approx(2 * ellipse_perimeter(2, 1))
    with pytest.raises(ValueError):
        ellipse_perimeter(0, 2)


def test_arm_torso_merger_is_unmeasured_not_cut_to_a_guessed_width():
    assert front_span([(0, 10), (20, 60), (70, 80)], 40, [5, 75]) == (20, 60)
    assert front_span([(0, 80)], 40, [5, 75]) is None
    assert arm_xs([(0, 0), (10, 10), (10, 20)], 5) == [5]


def test_two_view_girths_spread_and_missing_rows_are_explicit():
    front = [{"profile": [0.2 + d] * len(FRACTIONS)} for d in (-0.001, 0, 0.001)]
    side = [{"profile": [0.1 + d] * len(FRACTIONS)} for d in (-0.002, 0, 0.002)]
    a = aggregate(front, side, 170)
    b = aggregate(front, side, 180)
    chest = a["measurements"]["chest_cm"]
    assert chest["value_cm"] == pytest.approx(ellipse_perimeter(0.2, 0.1) * 170)
    assert chest["spread_cm"] > 0
    assert chest["sigma_cm"] > CONFIG["sigma_rel"] * chest["value_cm"]
    assert b["measurements"]["chest_cm"]["value_cm"] / chest["value_cm"] == pytest.approx(180 / 170)
    assert aggregate(front, [], 170)["measurements"] == {}
    for f in front:
        f["profile"] = [None] * len(FRACTIONS)
    assert len(aggregate(front, side, 170)["missing"]) == 3


def test_girths_pick_max_chest_hip_min_waist_in_kiosk_stature_bands():
    p = [0.2 + 0.01 * (i % 3) for i, _ in enumerate(FRACTIONS)]
    rows = [{"profile": p}] * 3
    a = aggregate(rows, rows, 170)["measurements"]
    assert a["chest_cm"]["ratio_to_height"] > a["waist_cm"]["ratio_to_height"]
    assert 0.70 <= a["chest_cm"]["fraction"] <= 0.78
    assert 0.57 <= a["waist_cm"]["fraction"] <= 0.65


def test_native_mask_full_stature_and_crop_rejection():
    spec = importlib.util.spec_from_file_location(
        "body_video", Path(__file__).with_name("body-from-video.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    np = module.np
    prob = np.zeros((400, 200), np.float32)
    prob[55:355, 75:126] = 1
    pts = [{"x": 100, "y": 200, "score": 1} for _ in range(17)]
    for k, x, y in [
        (5, 130, 140),
        (6, 70, 140),
        (7, 145, 180),
        (8, 55, 180),
        (9, 150, 220),
        (10, 50, 220),
        (11, 125, 240),
        (12, 75, 240),
        (15, 115, 345),
        (16, 85, 345),
    ]:
        pts[k] = {"x": x, "y": y, "score": 1}
    f = {"tMs": 0, "index": 0, "keypoints": pts}
    result = module.measure_frame(prob, f)
    assert result["phase"] == "front"
    assert result["stature_px"] == pytest.approx(300)
    assert all(v == pytest.approx(51 / 300) for v in result["profile"])
    prob[355:, 75:126] = 1
    assert module.measure_frame(prob, f)["rejected"] == "head or feet cropped"


def test_studio_holds_resume_only_after_explicit_lead_release():
    held = "2026-11-15 00:52 lead: USER TEST (Decart trial) NOW - FULL HOLD"
    assert sync_state(held)
    assert sync_state(held + "\n2026-11-15 01:00 lead: HOLD lifted FOR SAVING ONLY")
    assert not sync_state(held + "\n2026-11-15 02:14 lead: HOLD lifted. Integration.")
    timing = "2026-11-15 02:20 CX-DAY timing-begin: measurement"
    assert sync_state(timing)
    assert not sync_state(timing + "\n2026-11-15 02:21 CX-DAY timing-end: released")
