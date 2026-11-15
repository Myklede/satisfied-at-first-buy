"""Offline planar photo ruler; US Letter sheet, EXIF-oriented pixel coordinates.

python -m body_service.lookdev.scale photo.jpg --corners '10,10;210,10;210,270;10,270' \
    --segment 'pitch:250,40,250,140' --plane-error-fraction 0.1

Corner order: top-left, top-right, bottom-right, bottom-left of the sheet as seen
in the photo. Use --landscape when the sheet's long side runs across the image.
The homography measures the sheet's plane, never a curved surface distance.
"""

from __future__ import annotations

import argparse
import json
from itertools import product
from pathlib import Path

import numpy as np
from numpy.typing import NDArray
from scipy.ndimage import binary_fill_holes, label
from scipy.spatial import ConvexHull

from . import config as c
from .colour import read_image

Array = NDArray[np.float64]


def _points(value: Array, count: int | None = None) -> Array:
    points = np.asarray(value, dtype=float)
    if points.ndim != 2 or points.shape[1] != 2 or not np.isfinite(points).all():
        raise ValueError("Expected finite N x 2 points")
    if count is not None and points.shape[0] != count:
        raise ValueError(f"Expected {count} points")
    return points


def sheet_corners_cm(landscape: bool = False) -> Array:
    width, height = c.SHEET_WIDTH_CM, c.SHEET_HEIGHT_CM
    if landscape:
        width, height = height, width
    return np.array([[0, 0], [width, 0], [width, height], [0, height]])


def homography(corners: Array, landscape: bool = False) -> Array:
    """Normalised DLT; refuse crossed, concave or degenerate four-corner inputs."""
    corners = _points(corners, 4)
    edges = np.roll(corners, -1, axis=0) - corners
    cross = edges[:, 0] * np.roll(edges[:, 1], -1) - edges[:, 1] * np.roll(edges[:, 0], -1)
    if not (np.all(cross > 1e-8) or np.all(cross < -1e-8)):
        raise ValueError("Sheet corners must form a strictly convex ordered quadrilateral")

    def normalise(points: Array) -> tuple[Array, Array]:
        centre = points.mean(axis=0)
        scale = np.sqrt(2) / np.mean(np.linalg.norm(points - centre, axis=1))
        matrix = np.array(
            [[scale, 0, -scale * centre[0]], [0, scale, -scale * centre[1]], [0, 0, 1]]
        )
        return transform_points(matrix, points), matrix

    src, source_matrix = normalise(corners)
    dst, target_matrix = normalise(sheet_corners_cm(landscape))
    rows = []
    for (x, y), (u, v) in zip(src, dst, strict=True):
        rows.extend(
            [[-x, -y, -1, 0, 0, 0, u * x, u * y, u], [0, 0, 0, -x, -y, -1, v * x, v * y, v]]
        )
    _, _, vt = np.linalg.svd(rows, full_matrices=True)
    result = np.linalg.solve(target_matrix, vt[-1].reshape(3, 3) @ source_matrix)
    if abs(np.linalg.det(result)) < 1e-12:
        raise ValueError("Degenerate sheet homography")
    return result / result[2, 2]


def transform_points(matrix: Array, points: Array) -> Array:
    points = _points(points)
    mapped = np.c_[points, np.ones(len(points))] @ np.asarray(matrix, dtype=float).T
    if not np.isfinite(mapped).all() or np.any(abs(mapped[:, 2]) < 1e-10):
        raise ValueError("Point maps to the homography horizon")
    return mapped[:, :2] / mapped[:, 2:]


def detect_sheet(image: NDArray[np.uint8]) -> Array:
    """Conservative neutral connected-component proposal, not a silent truth label.

    No OpenCV/dependency. Works for a clean sheet against coloured/dark cloth;
    white-on-white, cast shadows and bent paper generally require --corners.
    """
    if image.ndim != 3 or image.shape[2] != 3 or image.dtype != np.uint8:
        raise ValueError("Automatic sheet proposal requires uint8 RGB")
    stride = max(1, int(np.ceil(max(image.shape[:2]) / c.SHEET_DETECTION_MAX_SIDE)))
    rgb = image[::stride, ::stride].astype(float) / 255
    bright, dark = rgb.max(axis=2), rgb.min(axis=2)
    mask = (dark >= c.SHEET_DETECTION_MIN_CHANNEL) & (bright - dark <= c.SHEET_DETECTION_MAX_CHROMA)
    labels, count = label(binary_fill_holes(mask))
    proposals = []
    for index in range(1, count + 1):
        ys, xs = np.nonzero(labels == index)
        if len(xs) < mask.size * c.SHEET_DETECTION_MIN_AREA_FRACTION:
            continue
        if (
            xs.min() == 0
            or ys.min() == 0
            or xs.max() == mask.shape[1] - 1
            or ys.max() == mask.shape[0] - 1
        ):
            continue
        points = np.c_[xs, ys].astype(float)
        hull = points[ConvexHull(points).vertices]
        # Douglas-style elimination: remove the least area-contributing hull
        # vertex until four remain. Convexity/order are preserved.
        while len(hull) > 4:
            previous, following = np.roll(hull, 1, axis=0), np.roll(hull, -1, axis=0)
            a, b = hull - previous, following - hull
            areas = abs(a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0])
            hull = np.delete(hull, np.argmin(areas), axis=0)
        hull = np.roll(hull, -np.argmin(hull.sum(axis=1)), axis=0)
        if hull[1, 0] < hull[-1, 0]:
            hull = hull[[0, 3, 2, 1]]
        sides = np.linalg.norm(np.roll(hull, -1, axis=0) - hull, axis=1)
        ratio = max(sides.mean(), 1)  # Reject near-lines before forming side ratios.
        if sides.min() < ratio * c.SHEET_DETECTION_MIN_EDGE_RATIO:
            continue
        polygon_area = (
            abs(
                np.dot(hull[:, 0], np.roll(hull[:, 1], 1))
                - np.dot(hull[:, 1], np.roll(hull[:, 0], 1))
            )
            / 2
        )
        rectangularity = len(xs) / max(polygon_area, 1)
        if c.SHEET_DETECTION_FILL_MIN <= rectangularity <= c.SHEET_DETECTION_FILL_MAX:
            proposals.append((len(xs), hull * stride))
    if len(proposals) != 1:
        raise ValueError(f"Found {len(proposals)} ambiguous sheet proposals; supply --corners")
    return proposals[0][1]


def measure_segment(
    corners: Array,
    segment: Array,
    *,
    landscape: bool = False,
    pixel_error: float = 2,
    plane_error_fraction: float | None = None,
) -> dict:
    """Length/angle with deterministic first-order worst-case click sensitivity.

    A supplied plane-error fraction is an operator's bounded sensitivity scenario,
    not a measured confidence interval. None means coplanarity is unestablished:
    no physical centimetre claim is returned.
    """
    corners, segment = _points(corners, 4), _points(segment, 2)
    if not np.isfinite(pixel_error) or not 0 <= pixel_error <= 100:
        raise ValueError("Pixel error must be finite and in [0, 100]")
    if plane_error_fraction is None:
        return {
            "length_cm": None,
            "angle_degrees": None,
            "reason": "not measurable: coplanarity unestablished",
        }
    if not np.isfinite(plane_error_fraction) or not 0 <= plane_error_fraction <= 1:
        raise ValueError("Plane sensitivity must be finite and in [0, 1]")

    def quantities(values: Array) -> Array:
        mapped = transform_points(homography(values[:4], landscape), values[4:])
        dx, dy = mapped[1] - mapped[0]
        return np.array([np.hypot(dx, dy), np.degrees(np.arctan2(dy, dx))])

    values = np.vstack((corners, segment))
    length, angle = quantities(values)
    if length <= 1e-9:
        raise ValueError("Cannot measure a zero-length segment")
    sensitivity = np.zeros(2)
    for row, column in product(range(6), range(2)):
        a, b = values.copy(), values.copy()
        a[row, column] += 0.25
        b[row, column] -= 0.25
        delta = quantities(a) - quantities(b)
        delta[1] = (delta[1] + 180) % 360 - 180
        sensitivity += abs(delta / 0.5) * pixel_error
    return {
        "length_cm": float(length),
        "angle_degrees": float(angle),
        "uncertainty_cm": float(sensitivity[0] + length * plane_error_fraction),
        "angle_pixel_uncertainty_degrees": float(sensitivity[1]),
        "pixel_error_px": pixel_error,
        "plane_error_fraction": plane_error_fraction,
        "uncertainty_kind": "first-order worst-case pixel + operator plane sensitivity; "
        "not confidence interval",
    }


def parse_corners(text: str) -> Array:
    try:
        return _points(np.array([[float(x) for x in p.split(",")] for p in text.split(";")]), 4)
    except ValueError as error:
        raise argparse.ArgumentTypeError("Expected x,y;x,y;x,y;x,y") from error


def parse_segment(text: str) -> tuple[str, Array]:
    try:
        name, coords = text.split(":", 1)
        if not name.strip():
            raise ValueError
        return name, np.array([float(v) for v in coords.split(",")]).reshape(2, 2)
    except ValueError as error:
        raise argparse.ArgumentTypeError("Expected name:x1,y1,x2,y2") from error


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("--corners", type=parse_corners)
    parser.add_argument("--landscape", action="store_true")
    parser.add_argument("--segment", type=parse_segment, action="append", required=True)
    parser.add_argument("--pixel-error", type=float, default=2)
    parser.add_argument("--plane-error-fraction", type=float)
    args = parser.parse_args(argv)
    try:
        image, notes = read_image(args.image)
        corners = args.corners if args.corners is not None else detect_sheet(image)
        homography(corners, args.landscape)
        if (
            (corners < 0).any()
            or (corners[:, 0] >= image.shape[1]).any()
            or (corners[:, 1] >= image.shape[0]).any()
        ):
            raise ValueError("Sheet corners must be inside the EXIF-oriented image")
        if len(dict(args.segment)) != len(args.segment):
            raise ValueError("Segment names must be unique")
        result = {
            name: measure_segment(
                corners,
                points,
                landscape=args.landscape,
                pixel_error=args.pixel_error,
                plane_error_fraction=args.plane_error_fraction,
            )
            for name, points in args.segment
        }
    except (ValueError, OSError) as error:
        parser.error(str(error))
    print(
        json.dumps(
            {
                "sheet": "US Letter 21.59 x 27.94 cm",
                "corners_px": corners.tolist(),
                "corner_method": "manual"
                if args.corners is not None
                else "automatic proposal: visually verify",
                "measurements": result,
                "image_notes": notes,
            },
            indent=2,
            allow_nan=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
