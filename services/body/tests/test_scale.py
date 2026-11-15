"""Synthetic homographies only: no local photos are included in the repository."""

import json

import numpy as np
import pytest
from body_service.lookdev.scale import (
    detect_sheet,
    homography,
    main,
    measure_segment,
    sheet_corners_cm,
    transform_points,
)
from PIL import Image, ImageDraw


@pytest.mark.parametrize("landscape", [False, True])
@pytest.mark.parametrize("perspective", [0, 0.003, -0.002])
def test_recovers_metric_distance_and_angle_under_perspective(landscape, perspective):
    forward = np.array([[14, 2, 210], [-1, 12, 40], [perspective, 0.001, 1.0]])
    corners = transform_points(forward, sheet_corners_cm(landscape))
    inverse = homography(corners, landscape)
    np.testing.assert_allclose(
        transform_points(inverse, corners), sheet_corners_cm(landscape), atol=1e-10
    )
    segment = transform_points(forward, np.array([[4, 5], [7, 9]]))
    result = measure_segment(
        corners, segment, landscape=landscape, pixel_error=0, plane_error_fraction=0
    )
    assert result["length_cm"] == pytest.approx(5)
    assert result["angle_degrees"] == pytest.approx(np.degrees(np.arctan2(4, 3)))
    assert result["uncertainty_cm"] == 0


def test_pixel_and_off_plane_sensitivity_are_explicit_and_grow():
    corners = np.array([[10.0, 10], [225.9, 10], [225.9, 289.4], [10, 289.4]])
    segment = np.array([[30.0, 40], [130, 40]])
    unknown = measure_segment(corners, segment)
    assert unknown["length_cm"] is None
    assert "coplanarity" in unknown["reason"]
    a = measure_segment(corners, segment, plane_error_fraction=0)
    b = measure_segment(corners, segment, pixel_error=4, plane_error_fraction=0.1)
    assert a["length_cm"] == pytest.approx(10)
    assert b["uncertainty_cm"] > 2 * a["uncertainty_cm"]
    assert b["uncertainty_cm"] >= 1
    # Perturbing a click by its bound should stay within the conservative sum.
    for point in range(2):
        shifted = segment.copy()
        shifted[point, 0] += 2
        changed = measure_segment(corners, shifted, plane_error_fraction=0)
        assert abs(changed["length_cm"] - a["length_cm"]) <= a["uncertainty_cm"]


@pytest.mark.parametrize(
    "bad",
    [
        np.zeros((4, 2)),
        np.ones((3, 2)),
        [[0, 0], [10, 10], [0, 10], [10, 0]],
        [[0, 0], [10, 0], [5, 1], [0, 10]],
        [[0, 0], [10, 0], [10, float("nan")], [0, 10]],
    ],
)
def test_bad_corner_sets_are_rejected(bad):
    with pytest.raises(ValueError):
        homography(np.array(bad))


def test_detector_finds_synthetic_sheet_and_refuses_ambiguous_sheets():
    image = Image.new("RGB", (400, 400), "#705038")
    draw = ImageDraw.Draw(image)
    polygon = [(70, 50), (280, 70), (270, 340), (50, 320)]
    draw.polygon(polygon, fill="#dddddd")
    corners = detect_sheet(np.asarray(image))
    np.testing.assert_allclose(corners, polygon, atol=2)
    draw.rectangle((310, 30, 395, 130), fill="white")
    with pytest.raises(ValueError, match="ambiguous"):
        detect_sheet(np.asarray(image))
    with pytest.raises(ValueError):
        detect_sheet(np.zeros((10, 10), dtype=np.uint8))


def test_cli_manual_override_and_missing_plane(tmp_path, capsys):
    path = tmp_path / "synthetic.png"
    Image.new("RGB", (400, 400), "white").save(path)
    args = [
        str(path),
        "--corners",
        "10,10;210,10;210,270;10,270",
        "--segment",
        "pitch:30,40,130,40",
    ]
    assert main(args) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["measurements"]["pitch"]["length_cm"] is None
    assert main([*args, "--plane-error-fraction", "0"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["corner_method"] == "manual"
    assert result["measurements"]["pitch"]["length_cm"] == pytest.approx(10.795)
    with pytest.raises(SystemExit):
        main([*args, "--plane-error-fraction", "-1"])
