"""Estimate diffuse colour from an sRGB photo and a neutral paper patch, offline.

python -m body_service.lookdev.colour photo.jpg --paper 10,20,100,80 \
    --region jacket:200,100,100,100 --json

This is a paper-relative estimate, not a calibrated spectrophotometer measurement.
Coordinates refer to the EXIF-oriented image. File access exists only in this CLI.
"""

from __future__ import annotations

import argparse
import io
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray
from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError

from . import config as c

Array = NDArray[np.float64]


def srgb_to_linear(rgb: Array) -> Array:
    """IEC 61966-2-1 transfer: normalised encoded sRGB -> linear light."""
    rgb = np.asarray(rgb, dtype=np.float64)
    if not np.isfinite(rgb).all() or np.any((rgb < 0) | (rgb > 1)):
        raise ValueError("sRGB samples must be finite and in [0, 1]")
    return np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(rgb: Array) -> Array:
    """Display encoding only: clip to sRGB gamut; retain raw linear values elsewhere."""
    rgb = np.clip(np.asarray(rgb, dtype=np.float64), 0, 1)
    return np.where(rgb <= 0.0031308, 12.92 * rgb, 1.055 * rgb ** (1 / 2.4) - 0.055)


def xyz_to_lab(xyz: Array) -> Array:
    """CIELAB under D65 (CIE 15), XYZ uses Y=1."""
    ratio = np.asarray(xyz, dtype=np.float64) / c.D65
    f = np.where(ratio > (6 / 29) ** 3, np.cbrt(ratio), ratio / (3 * (6 / 29) ** 2) + 4 / 29)
    return np.stack(
        (116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])),
        axis=-1,
    )


def delta_e00(lab1: Array, lab2: Array) -> float:
    """CIEDE2000, kL=kC=kH=1; Sharma, Wu & Dalal (2005), eqs. 2–22.

    Reference/test data: https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/
    """
    left, right = np.asarray(lab1, dtype=float), np.asarray(lab2, dtype=float)
    if left.shape != (3,) or right.shape != (3,) or not np.isfinite([left, right]).all():
        raise ValueError("Delta E requires two finite Lab triples")
    l1, a1, b1 = left
    l2, a2, b2 = right
    cb = (math.hypot(a1, b1) + math.hypot(a2, b2)) / 2
    g = 0.5 * (1 - math.sqrt(cb**7 / (cb**7 + 25**7)))
    a1, a2 = (1 + g) * a1, (1 + g) * a2
    c1, c2 = math.hypot(a1, b1), math.hypot(a2, b2)
    h1 = math.degrees(math.atan2(b1, a1)) % 360 if c1 else 0
    h2 = math.degrees(math.atan2(b2, a2)) % 360 if c2 else 0
    dh = h2 - h1
    if c1 * c2 == 0:
        dh = 0
    elif dh > 180:
        dh -= 360
    elif dh < -180:
        dh += 360
    dl, dc = l2 - l1, c2 - c1
    dh = 2 * math.sqrt(c1 * c2) * math.sin(math.radians(dh / 2))
    lb, cb = (l1 + l2) / 2, (c1 + c2) / 2
    hb = h1 + h2
    if c1 * c2:
        hb = hb / 2 if abs(h1 - h2) <= 180 else (hb + (360 if hb < 360 else -360)) / 2
    t = (
        1
        - 0.17 * math.cos(math.radians(hb - 30))
        + 0.24 * math.cos(math.radians(2 * hb))
        + 0.32 * math.cos(math.radians(3 * hb + 6))
        - 0.20 * math.cos(math.radians(4 * hb - 63))
    )
    sl = 1 + 0.015 * (lb - 50) ** 2 / math.sqrt(20 + (lb - 50) ** 2)
    sc, sh = 1 + 0.045 * cb, 1 + 0.015 * cb * t
    rt = (
        -2
        * math.sqrt(cb**7 / (cb**7 + 25**7))
        * math.sin(math.radians(60 * math.exp(-(((hb - 275) / 25) ** 2))))
    )
    return math.sqrt(
        max(0, (dl / sl) ** 2 + (dc / sc) ** 2 + (dh / sh) ** 2 + rt * dc / sc * dh / sh)
    )


@dataclass(frozen=True)
class Rect:
    x: int
    y: int
    width: int
    height: int

    def crop(self, image: NDArray) -> NDArray:
        """Reject invalid/out-of-bounds ROIs rather than silently changing the sample."""
        if (
            self.x < 0
            or self.y < 0
            or self.width <= 0
            or self.height <= 0
            or self.x + self.width > image.shape[1]
            or self.y + self.height > image.shape[0]
        ):
            raise ValueError("Rectangle must have positive size and lie entirely within the image")
        return image[self.y : self.y + self.height, self.x : self.x + self.width]


def parse_rect(text: str) -> Rect:
    try:
        values = [int(value.strip()) for value in text.split(",")]
        if len(values) != 4:
            raise ValueError
        rect = Rect(*values)
        if rect.x < 0 or rect.y < 0 or rect.width <= 0 or rect.height <= 0:
            raise ValueError
        return rect
    except ValueError as error:
        raise argparse.ArgumentTypeError(
            "Expected nonnegative x,y and positive w,h: x,y,w,h"
        ) from error


def parse_region(text: str) -> tuple[str, Rect]:
    name, sep, coords = text.partition(":")
    if not sep or not name.strip():
        raise argparse.ArgumentTypeError("Expected name:x,y,w,h")
    return name.strip(), parse_rect(coords)


def _samples(encoded: NDArray, *, paper: bool) -> tuple[Array, dict[str, Any]]:
    if encoded.ndim != 3 or encoded.shape[-1] != 3 or not encoded.size:
        raise ValueError("Expected a nonempty H x W x 3 sRGB array")
    encoded = encoded.astype(np.float64) / 255 if encoded.dtype == np.uint8 else encoded
    linear = srgb_to_linear(encoded).reshape(-1, 3)
    pixels = encoded.reshape(-1, 3)
    clipped = np.any((pixels <= c.CLIP_LOW) | (pixels >= c.CLIP_HIGH), axis=1)
    warnings = []
    if len(linear) < c.MIN_PIXELS:
        warnings.append("too_small")
    if clipped.any():
        warnings.append("clipped")
    valid = linear[~clipped]
    if not len(valid):
        raise ValueError("Region has no unclipped pixels; choose a new region or exposure")
    if np.median(valid @ c.RGB_TO_XYZ[1]) < c.DARK_LINEAR_Y:
        warnings.append("too_dark")
    rejected = 0
    if paper:
        med = np.median(valid, axis=0)
        mad = np.maximum(c.MAD_FLOOR, c.MAD_NORMAL_SCALE * np.median(abs(valid - med), axis=0))
        keep = np.all(abs(valid - med) <= c.MAD_SIGMAS * mad, axis=1)
        rejected = int((~keep).sum())
        valid = valid[keep]
        if rejected:
            warnings.append("paper_outliers_removed")
        if len(valid) < c.MIN_PIXELS or "too_dark" in warnings:
            raise ValueError(
                "Paper region is too small or too dark after rejection; cannot calibrate"
            )
    return valid, {
        "pixels": len(linear),
        "used_pixels": len(valid),
        "clipped_pixels": int(clipped.sum()),
        "outlier_pixels": rejected,
        "warnings": warnings,
    }


def _stats(values: Array) -> dict[str, list[float]]:
    q1, med, q3 = np.quantile(values, [0.25, 0.5, 0.75], axis=0)
    return {"median": med.tolist(), "q1": q1.tolist(), "q3": q3.tolist(), "iqr": (q3 - q1).tolist()}


def estimate_colours(
    image: NDArray, paper: Rect, regions: dict[str, Rect], *, reference_kind: str = "paper"
) -> dict[str, Any]:
    """Estimate one or more paper-relative diffuse reflectances; no IO/network.

    Image contains uint8 or normalised float *encoded* sRGB. Same illumination/exposure on sheet
    and cloth, neutral diffuse paper and a colour-managed sRGB input are required.
    Garment texture/shadow spread is retained, not erased by outlier rejection.
    """
    if image.ndim != 3 or image.shape[-1] != 3 or not regions:
        raise ValueError("Expected an RGB image and at least one garment region")
    if reference_kind not in ("paper", "neutral"):
        raise ValueError("Reference kind must be paper or neutral")
    reflectance, bounds = (
        (c.PAPER_REFLECTANCE, c.PAPER_REFLECTANCE_RANGE)
        if reference_kind == "paper"
        else (c.NEUTRAL_REFLECTANCE, c.NEUTRAL_REFLECTANCE_RANGE)
    )
    paper_pixels, paper_info = _samples(paper.crop(image), paper=True)
    paper_linear = np.median(paper_pixels, axis=0)
    paper_xyz = c.RGB_TO_XYZ @ paper_linear
    source_white = paper_xyz / paper_xyz[1]
    source_cones = c.BRADFORD @ source_white
    if np.any(source_cones <= 0):
        raise ValueError("Paper white has nonphysical Bradford cone responses")
    adaptation = np.linalg.solve(
        c.BRADFORD, np.diag((c.BRADFORD @ c.D65) / source_cones) @ c.BRADFORD
    )
    # Row vectors: linear RGB -> XYZ -> Bradford -> exposure/reflectance scaling.
    transform = adaptation @ c.RGB_TO_XYZ * (reflectance / paper_xyz[1])
    xyz_to_rgb = np.linalg.inv(c.RGB_TO_XYZ)
    results = {}
    for name, rect in regions.items():
        pixels, info = _samples(rect.crop(image), paper=False)
        xyz = pixels @ transform.T
        rgb = xyz @ xyz_to_rgb.T
        rgb_stats, lab_stats = _stats(rgb), _stats(xyz_to_lab(xyz))
        median = np.array(rgb_stats["median"])
        lab = xyz_to_lab(c.RGB_TO_XYZ @ median)
        if np.any((rgb < 0) | (rgb > 1)):
            info["warnings"].append("outside_srgb_gamut_hex_clipped")
        endpoints = [median * rho / reflectance for rho in bounds]
        labs = [xyz_to_lab(c.RGB_TO_XYZ @ endpoint) for endpoint in endpoints]
        encoded = np.floor(linear_to_srgb(median) * 255 + 0.5).astype(int)
        results[name] = {
            **info,
            "linear_rgb": rgb_stats,
            "srgb_hex": "#" + "".join(f"{v:02x}" for v in encoded),
            "lab_d65": lab_stats,
            f"{reference_kind}_uncertainty": {
                "linear_rgb_endpoints": [value.tolist() for value in endpoints],
                "lab_d65_endpoints": [value.tolist() for value in labs],
                "max_delta_e00_from_nominal": max(delta_e00(lab, value) for value in labs),
            },
        }
    return {
        "schema_version": 1,
        "method": f"linear sRGB / Bradford to D65 / {reference_kind}",
        "reference_kind": reference_kind,
        reference_kind: {
            **paper_info,
            "linear_rgb_median": paper_linear.tolist(),
            "source_white_xyz_y1": source_white.tolist(),
            "assumed_reflectance": reflectance,
            "reflectance_range": list(bounds),
            "reflectance_is_measured": False,
        },
        "limitations": [
            "Paper-relative diffuse albedo estimate; not a calibrated measurement.",
            "Requires equal illumination on paper and cloth, no flash/specular highlights.",
            "Camera tone mapping, mixed lighting, paper tint/brighteners "
            "and shadows are not corrected.",
            "Reflectance interval is reference-only sensitivity, not total uncertainty.",
            *(
                ["Neutral backdrop reflectance is unknown; albedo is relative to an assumption."]
                if reference_kind == "neutral"
                else []
            ),
        ],
        "regions": results,
    }


def read_image(path: Path) -> tuple[NDArray[np.uint8], list[str]]:
    """Honour EXIF orientation and embedded ICC; refuse ambiguous/non-photo modes."""
    with Image.open(path) as source:
        if source.width * source.height > c.MAX_IMAGE_PIXELS:
            raise ValueError(f"Image exceeds {c.MAX_IMAGE_PIXELS} pixels; resize locally first")
        image = ImageOps.exif_transpose(source)
        if image.mode not in ("RGB", "RGBA", "L", "LA", "CMYK"):
            raise ValueError(f"Unsupported image mode {image.mode}; export an sRGB JPEG/PNG")
        if "A" in image.mode and image.getchannel("A").getextrema() != (255, 255):
            raise ValueError("Transparent image: export an opaque photograph first")
        profile = source.info.get("icc_profile")
        notes = []
        if profile:
            image = ImageCms.profileToProfile(
                image,
                ImageCms.ImageCmsProfile(io.BytesIO(profile)),
                ImageCms.createProfile("sRGB"),
                outputMode="RGB",
            )
            notes.append("embedded_icc_converted_to_srgb")
        elif image.mode == "CMYK":
            raise ValueError("CMYK without an ICC profile cannot be interpreted as sRGB")
        else:
            image = image.convert("RGB")
            notes.append("no_icc_profile_assumed_srgb")
        return np.array(image, dtype=np.uint8), notes


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    reference = parser.add_mutually_exclusive_group(required=True)
    reference.add_argument("--paper", type=parse_rect)
    reference.add_argument(
        "--neutral", type=parse_rect, help="Neutral region of UNKNOWN reflectance"
    )
    parser.add_argument("--region", required=True, action="append", type=parse_region)
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON only")
    args = parser.parse_args(argv)
    if len(dict(args.region)) != len(args.region):
        parser.error("Region names must be unique")
    try:
        image, notes = read_image(args.image)
        # Convert cropped ROIs in _samples; avoid a full-resolution float64 copy.
        # estimate_colours also accepts a float array for synthetic/reference tests.
        kind = "paper" if args.paper is not None else "neutral"
        result = estimate_colours(
            image,
            args.paper if args.paper is not None else args.neutral,
            dict(args.region),
            reference_kind=kind,
        )
        result["image"] = {
            "width": image.shape[1],
            "height": image.shape[0],
            "coordinates": "EXIF-oriented pixels",
            "notes": notes,
        }
    except (ValueError, OSError, UnidentifiedImageError, ImageCms.PyCMSError) as error:
        parser.error(str(error))
    if args.json:
        print(json.dumps(result, indent=2, allow_nan=False))
    else:
        ref = result[kind]
        print(
            f"{kind}-relative colour estimate (D65); assumed reflectance "
            f"{ref['assumed_reflectance']}, range {ref['reflectance_range']}."
        )
        for name, region in result["regions"].items():
            print(f"{name}: {region['srgb_hex']} | linear RGB {region['linear_rgb']['median']}")
            print(f"  Lab median {region['lab_d65']['median']}; IQR {region['lab_d65']['iqr']}")
            print(
                f"  linear RGB IQR {region['linear_rgb']['iqr']}; {kind}-only dE00 "
                f"<= {region[f'{kind}_uncertainty']['max_delta_e00_from_nominal']:.3f}"
            )
            print(f"  warnings: {', '.join(region['warnings']) or 'none'}")
        print(f"{kind} warnings: " + (", ".join(ref["warnings"]) or "none"))
        print("Image: " + ", ".join(notes))
        for limitation in result["limitations"]:
            print(limitation)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
