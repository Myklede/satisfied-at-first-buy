"""Build clean garment reference images for the Decart V-TON trial page.

    py scripts/decart_refs.py

Input: the user's own flat-lay photos in data/reference-photos/*/hanger/ (gitignored).
Output: apps/web/public/local-textures/decart/<jacket>-<closed|open>.jpg (gitignored, never commit).

Decart's guidance (docs.platform.decart.ai/models/realtime/virtual-try-on): a clean garment shot
on a plain background, >= 512x512, no person wearing it. The jackets lie on a brown wooden board
with grey tiles around it, so the garment is seeded by colour (low saturation + bright), refined
with OpenCV GrabCut, small holes (zippers, logo) are filled, and the result is placed on a plain
grey square.

There is no real photo of the parka half-zipped, so no "half" image is produced: a composite would
be a made-up garment state. The page disables the Half button when that file is missing.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter, ImageOps

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "reference-photos"
OUT = ROOT / "apps" / "web" / "public" / "local-textures" / "decart"
WORK_MAX = 1400  # longest side while segmenting (speed); output is 1024 x 1024
OUT_SIZE = 1024


@dataclass(frozen=True)
class Job:
    out: str
    src: str
    s_max: int  # max HSV saturation (0..255) of garment pixels
    v_min: int  # min HSV value (0..255) of garment pixels
    background: tuple[int, int, int]
    s_min: int = 0  # min saturation: > 0 marks grey tiles (S below it) as sure background
    board_clip: bool = False  # drop columns outside the wooden board (grey tiles beside it)
    keep_core: bool = False  # never mark the garment core as tile (open zipper is grey too)


# Seed thresholds from sampled pixels (white parka: S<=60, V>=120; cream puffer: 20<=S<=85,
# V>=135: the cream is chromatic, the grey tiles are not); GrabCut then refines the edge.
JOBS = [
    Job(
        "parka-closed.jpg",
        "FB7675-100-parka-trang/hanger/IMG_E8319.JPG",
        60,
        120,
        (205, 205, 205),
        board_clip=True,
    ),
    Job(
        "parka-open.jpg",
        "FB7675-100-parka-trang/hanger/IMG_E8317.JPG",
        60,
        120,
        (205, 205, 205),
        board_clip=True,
    ),
    Job(
        "puffer-closed.jpg",
        "DQ4920-206-puffer-kem/hanger/IMG_E8300.JPG",
        85,
        135,
        (235, 235, 235),
        20,
    ),
    # Unzipped and hanging open, hood attached (the user's flat-lay photo IMG_E8312).
    Job(
        "puffer-open.jpg",
        "DQ4920-206-puffer-kem/hanger/IMG_E8312.JPG",
        85,
        135,
        (235, 235, 235),
        20,
        keep_core=True,
    ),
    # Zipped, hood detached (the user's photo 2026-11-15 02:46, puffer-closed-nohood.JPG).
    Job(
        "puffer-closed-nohood.jpg",
        "DQ4920-206-puffer-kem/hanger/puffer-closed-nohood.JPG",
        85,
        135,
        (235, 235, 235),
        20,
    ),
]

# Only these are rebuilt when names are given on the command line (default: all).
ONLY = set(sys.argv[1:])


def largest_component(mask: np.ndarray) -> np.ndarray:
    try:
        from scipy import ndimage  # type: ignore[import-untyped]
    except ImportError:
        return center_component(mask)
    labels, n = ndimage.label(mask)
    if n == 0:
        return mask
    sizes = ndimage.sum(mask, labels, range(1, n + 1))
    return labels == (int(np.argmax(sizes)) + 1)


def center_component(mask: np.ndarray) -> np.ndarray:
    """Without scipy: the connected region that contains the middle of the photo (the jacket lies
    centred on the board), found with a flood fill seeded at the mask pixel nearest the centre."""
    from PIL import ImageDraw

    h, w = mask.shape
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return mask
    i = int(np.argmin((ys - h / 2) ** 2 + (xs - w / 2) ** 2))
    img = Image.fromarray(mask.astype(np.uint8) * 255, "L").copy()  # writable for floodfill
    ImageDraw.floodfill(img, (int(xs[i]), int(ys[i])), 128)
    return np.asarray(img) == 128


def fill_small_holes(mask: np.ndarray, max_frac: float = 0.004) -> np.ndarray:
    """Fill enclosed holes smaller than max_frac of the image (zipper, logo, glare), but keep large
    enclosed background (wood showing between a sleeve and the body)."""
    import cv2  # type: ignore[import-untyped]

    holes = (fill_holes(mask) & ~mask).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(holes, connectivity=4)
    small = np.zeros(n, bool)
    small[1:] = stats[1:, cv2.CC_STAT_AREA] < max_frac * mask.size
    return mask | small[labels]


def fill_holes(mask: np.ndarray) -> np.ndarray:
    try:
        from scipy import ndimage  # type: ignore[import-untyped]

        return ndimage.binary_fill_holes(mask)
    except ImportError:
        pass
    # Fallback: background = what a flood fill from the (padded) border reaches.
    from PIL import ImageDraw

    padded = Image.fromarray(np.pad(mask, 1).astype(np.uint8) * 255, "L").copy()
    ImageDraw.floodfill(padded, (0, 0), 128)
    arr = np.asarray(padded)[1:-1, 1:-1]
    return arr != 128


def refine_grabcut(
    rgb: np.ndarray,
    rough: np.ndarray,
    sat: np.ndarray,
    val: np.ndarray,
    s_min: int,
    keep_core: bool = False,
) -> np.ndarray:
    """OpenCV GrabCut seeded by the colour mask: eroded rough mask = sure garment, saturated wood
    (S > 90) = sure background, the rest is decided by GrabCut's colour models. Skipped (rough mask
    returned) when OpenCV is not installed."""
    try:
        import cv2  # type: ignore[import-untyped]
    except ImportError:
        return rough
    gc = np.full(rough.shape, cv2.GC_PR_BGD, np.uint8)
    gc[rough] = cv2.GC_PR_FGD
    gc[morph(rough, 31, "erode")] = cv2.GC_FGD
    gc[sat > 90] = cv2.GC_BGD  # wood (garments here never reach S 90)
    if s_min > 0:
        # Grey tiles are mid-grey; black velcro tabs (V < 60) and the white label (V > 185) are not.
        tile = (sat < s_min) & (val > 60) & (val < 185)
        if keep_core:
            tile &= ~morph(rough, 61, "erode")
        gc[tile] = cv2.GC_BGD
    bgd = np.zeros((1, 65), np.float64)
    fgd = np.zeros((1, 65), np.float64)
    bgr = np.ascontiguousarray(rgb[..., ::-1])
    cv2.grabCut(bgr, gc, None, bgd, fgd, 5, cv2.GC_INIT_WITH_MASK)
    return (gc == cv2.GC_FGD) | (gc == cv2.GC_PR_FGD)


def morph(mask: np.ndarray, size: int, op: str) -> np.ndarray:
    img = Image.fromarray(mask.astype(np.uint8) * 255, "L").copy()  # writable for floodfill
    f = ImageFilter.MaxFilter(size) if op == "dilate" else ImageFilter.MinFilter(size)
    return np.asarray(img.filter(f)) > 127


def build(job: Job) -> tuple[Path, float]:
    src = SRC / job.src
    img = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
    scale = WORK_MAX / max(img.size)
    if scale < 1:
        img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    hsv = np.asarray(img.convert("HSV"))
    s, v = hsv[..., 1].astype(int), hsv[..., 2].astype(int)
    mask = (s <= job.s_max) & (v >= job.v_min)
    mask = morph(morph(mask, 7, "erode"), 7, "dilate")  # opening: drop specks and thin glare
    mask = morph(morph(mask, 25, "dilate"), 25, "erode")  # closing: bridge zipper / seam gaps
    mask = largest_component(mask)
    mask = fill_holes(mask)
    mask = refine_grabcut(np.asarray(img), mask, s, v, job.s_min, job.keep_core)
    if job.keep_core:
        # Drop every grey tile pixel GrabCut kept, then close narrow gaps again: the open zipper
        # and placket (grey, a few cm wide) come back, the wide tile areas do not.
        mask &= ~((s < job.s_min) & (v > 60) & (v < 185))
        mask = morph(morph(mask, 41, "dilate"), 41, "erode") & ~(s > 90)
    mask = morph(morph(mask, 21, "erode"), 21, "dilate")  # cut thin bridges to board edges/tiles
    if job.board_clip:
        # Grey tiles flank the board left and right and look like shaded white. The board's x-range
        # is where wood (S > 90) shows in > 3 % of the rows; keep a 1 % margin for sleeve overhang.
        wood_cols = np.nonzero((s > 90).mean(axis=0) > 0.03)[0]
        if len(wood_cols) > 0:
            margin = int(0.01 * mask.shape[1])
            mask[:, : max(0, wood_cols[0] - margin)] = False
            mask[:, wood_cols[-1] + 1 + margin :] = False
    mask = largest_component(mask)
    mask = fill_small_holes(mask)
    coverage = float(mask.mean())

    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        raise RuntimeError(f"{job.out}: empty mask")
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    alpha = Image.fromarray(mask.astype(np.uint8) * 255, "L").filter(ImageFilter.GaussianBlur(1.2))
    garment = img.crop((x0, y0, x1, y1))
    alpha = alpha.crop((x0, y0, x1, y1))
    side = int(max(x1 - x0, y1 - y0) * 1.08)
    canvas = Image.new("RGB", (side, side), job.background)
    canvas.paste(garment, ((side - garment.width) // 2, (side - garment.height) // 2), alpha)
    canvas = canvas.resize((OUT_SIZE, OUT_SIZE), Image.LANCZOS)
    OUT.mkdir(parents=True, exist_ok=True)
    out = OUT / job.out
    canvas.save(out, "JPEG", quality=92)
    return out, coverage


def main() -> int:
    for job in JOBS:
        if ONLY and job.out not in ONLY:
            continue
        out, coverage = build(job)
        print(f"{out.relative_to(ROOT)}  garment mask covers {coverage * 100:.1f}% of the photo")
    return 0


if __name__ == "__main__":
    sys.exit(main())
