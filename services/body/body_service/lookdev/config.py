"""Colour constants and explicitly uncalibrated photo-quality thresholds.

These belong to the offline tool only; no garment/render defaults are changed.
"""

import numpy as np

# IEC 61966-2-1 sRGB, CIE 1931 2-degree XYZ, Y=1. Rounded published matrix;
# https://www.color.org/srgb.pdf. White is its row sum to preserve neutral RGB.
RGB_TO_XYZ = np.array(
    [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ],
    dtype=np.float64,
)
D65 = RGB_TO_XYZ @ np.ones(3)
# Bradford cone-response matrix, CIE 159:2004 chromatic adaptation transform.
BRADFORD = np.array(
    [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]],
    dtype=np.float64,
)
# Prompt 07 A supplies this assumed diffuse reflectance range for ordinary copy
# paper. NOT a measurement/certification of the user's sheet (brighteners,
# paper stock and lighting may exceed this range). Report both endpoints.
PAPER_REFLECTANCE_RANGE = (0.88, 0.92)
PAPER_REFLECTANCE = sum(PAPER_REFLECTANCE_RANGE) / 2
# Prompt 09 A2: user's reference sheet is US Letter, not A4. Exact US customary
# dimensions converted at 2.54 cm/in; this is nominal paper size, not tape truth.
SHEET_WIDTH_CM = 21.59
SHEET_HEIGHT_CM = 27.94
# Prompt 07 A2: Nike studio backdrop is about encoded #e7e7e7 (~0.799 linear).
# Its physical reflectance/exposure is unknown. 0.80 nominal and 0.65–0.90 are
# a deliberately broad look-dev sensitivity assumption, NOT a measured interval.
NEUTRAL_REFLECTANCE = 0.80
NEUTRAL_REFLECTANCE_RANGE = (0.65, 0.90)

# Uncalibrated acquisition safeguards, not claimed physical accuracy bounds.
# Leave one 8-bit code away from each rail; any channel at a rail is excluded.
CLIP_LOW = 1 / 255
CLIP_HIGH = 254 / 255
MIN_PIXELS = 64  # Below an 8x8 patch, texture/noise estimates are weak.
DARK_LINEAR_Y = 0.01  # Under 1% relative linear luminance: noise-sensitive.
MAD_SIGMAS = 3.5  # Conservative robust rejection on the neutral paper only.
MAD_NORMAL_SCALE = 1.4826  # Gaussian-consistent median absolute deviation.
MAD_FLOOR = 0.002  # Avoid rejecting a flat patch because of quantisation.
MAX_IMAGE_PIXELS = 40_000_000  # Bound RAM; CLI estimates ROIs, not full float images.

# Automatic sheet proposals only; deliberately conservative and uncalibrated.
# Manual corners are required for ambiguous white-on-white/creased-paper scenes.
SHEET_DETECTION_MAX_SIDE = 1000  # Bound candidate detector's memory, not measurement resolution.
SHEET_DETECTION_MIN_CHANNEL = 0.45  # Reject dark backgrounds; encoded sRGB.
SHEET_DETECTION_MAX_CHROMA = 0.10  # Neutral white paper vs coloured cloth, encoded max-min.
SHEET_DETECTION_MIN_AREA_FRACTION = 0.04  # A ruler target must occupy enough image area.
SHEET_DETECTION_MIN_EDGE_RATIO = 0.25  # Reject thin highlight slivers.
SHEET_DETECTION_FILL_MIN = 0.85  # Reject irregular connected cloth/highlight masks.
SHEET_DETECTION_FILL_MAX = 1.15  # Pixel rasterisation tolerance around a four-corner hull.
