# F4T (?f4tex=1): builds the AR jacket's chart textures from the user's own flat-lay photos.
#
#   py scripts/f4t-textures.py [STYLE ...] [--debug]
#
# Input  (local only, gitignored): data/reference-photos/<folder>/hanger/IMG_*.JPG
# Output (local only, gitignored): apps/web/public/local-textures/<STYLE>/{front,back,sleeve}.png
#                                  + meta.json; --debug also writes overlays to .cache/f4t/work/.
# NEVER commit the photos or anything this writes: this file holds numbers only (pixel positions
# read off the photos by agent F4T on gridded views, 2026-11-14).
#
# What a chart texture is (apps/web/src/engine/live/ar/f4tex.ts reads it back):
# - u: lateral, 0.5 = the centre line (front: zip / placket; back: centre back), 0 and 1 = `half`
#   photo pixels either side of it (meta `half` = that in pitches: the chart is a metric
#   rectification, the shader lays it at the shell's own pitch so logos keep their size); for the
#   sleeve 0 = outer line, 1 = underarm line;
# - v: quilting ROW coordinate s, v = (s + 1) / (rows + 1): s = -1 on the shoulder point line
#   (HPS; the armhole for a sleeve), 0 on the first stitch below it, k on the k-th stitch, `rows`
#   at the hem (cuff). The shader computes the same s from the shell's own chart, so each
#   photographed stitch lands in its drawn valley whatever the two pitches are; when the stitch
#   counts differ it repeats (or skips from) the chamber `tile`. `top` = the height of the cell
#   above the first stitch in pitches (that cell is not squeezed: the shell shows as much of it
#   as its own first cell is high).
# - rgb (sRGB-encoded): 0.5 x photo / its own low-pass (flat-fielded: the room's light gradient
#   is gone; wrinkles, stitches, zips and logos stay). Plain fabric = 0.5 grey; the shader
#   multiplies by 2 x the shell albedo;
# - a: coverage (0 where the photo shows no such panel: under a sleeve, off the jacket).
#
# Colour calibration: the white sheet in the calibration photo is the neutral reference
# (reflectance PAPER_REFLECTANCE, the value the product colours were calibrated with:
# body_service.lookdev.colour). apparent = PAPER_REFLECTANCE x fabric / paper, linear, per channel.
# meta.json carries its CHROMA (r/g, b/g), which the web app applies at the product colour's
# luminance: the apparent luminance includes the shell's sheen under the ceiling lights (the
# white parka reads 1.2x the paper), so it is reported, not used.
# The photos are Display P3 (iPhone; ICC primaries checked): converted to linear sRGB here.
# Limit, said plainly: an iPhone JPEG is tone-mapped, not linear near white.
import json
import os
import sys

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PHOTOS = os.path.join(ROOT, 'data', 'reference-photos')
OUT = os.path.join(ROOT, 'apps', 'web', 'public', 'local-textures')
WORK = os.path.join(ROOT, '.cache', 'f4t', 'work')

PAPER_REFLECTANCE = 0.90
# US Letter sheet (the photos' ruler; 21.59 x 27.94 cm), for the px/cm printed in the report.
PAPER_CM = (21.59, 27.94)
# Flat-field: low-pass sigma in units of the row pitch, and how much of it is removed (1 = all).
# 0.12 pitch (parka 1.2 cm, puffer 1.7 cm) and all of it: the photo keeps ONLY what is finer than
# a chamber's own shading (wrinkles, stitch puckers, logos, zips). At 0.35 / 0.9 the chambers'
# photographed light and shade stayed in the panel: lit again by the AR rig it read as a darker,
# greyer rectangle between the drawn sleeves (lead, 23:2x, puffer back). The low-frequency tone of
# a photo panel is now the drawn shell's own, by construction.
FLAT_SIGMA_PITCH = 0.12
FLAT_STRENGTH = 1.0
# Coverage feather at a panel's boundary in the photo (armhole, sleeve edge, hem), in pitches.
FEATHER_PITCH = 0.2
# The flat-lay photos are close, sharp and side-lit: every wrinkle has far more contrast than the
# venue camera shows on the worn jacket. Fabric detail (ratio to the low-pass above DETAIL_KEEP_LO
# .. DETAIL_KEEP_HI) is scaled toward 1 by DETAIL_GAIN; dark features (zips, logos: below
# DETAIL_KEEP_LO) are kept as photographed. Look convention, by eye on the look-job sheets.
DETAIL_GAIN = 0.6
DETAIL_KEEP_LO = 0.25
DETAIL_KEEP_HI = 0.6
# Dark features (black print, zip tape) carry the room's sheen in the photo: the parka's black
# back swoosh reads 0.2-0.3 of the white cloth there and drew as mid grey under the AR light
# (look job 9545a2), where the real one is black (venue-mac-ao). Their ratio is scaled by this.
DARK_GAIN = 0.4
# Stitch snap: search half-range (fraction of the pitch) round each hand-read row position.
SNAP_RANGE = 0.14

# Hand-read geometry, original photo pixels. rows: [yLeft, yCentre, yRight] of the shoulder point
# line (first), each stitch line, and the hem (last). centre: two points of the centre line;
# zip: True where the centre line is a dark zip tape, which is then TRACED row by row (a laid
# coat's zip is never a straight line; drawn straight down the shell's centre front it must be);
# half: the flat body's half width in px (centre line to the side fold, the mean of both sides).
# cutL / cutR: the visible body's boundary (x as a polyline over y): beyond it the photo shows a
# sleeve or the table, coverage 0.
CONFIG = {
    'FB7675-100': {
        'folder': 'FB7675-100-parka-trang',
        'calib': {
            'img': 'IMG_E8315.JPG',
            'paper': [1500, 1800, 2100, 2600],
            'fabric': [[990, 1840, 1330, 2530], [1495, 2830, 2070, 3220], [2300, 2070, 2645, 2530]],
        },
        'front': {
            'img': 'IMG_E8319.JPG',
            'width': 1024,
            'centre': [[1412, 1300], [1378, 4250]],
            'zip': True,
            # The zip lies 1 cm off the middle of the flat body (385 .. 2300 at the hem).
            'half': 957,
            'tile': 4,
            'rows': [
                [1285, 1285, 1265],
                [1660, 1640, 1640],
                [2080, 2040, 2040],
                [2445, 2395, 2420],
                [2795, 2770, 2785],
                [3160, 3110, 3170],
                [3510, 3480, 3560],
                [3885, 3850, 3930],
                [4235, 4215, 4225],
            ],
            'cutL': [[1225, 1290], [700, 1480], [640, 1560], [680, 1650], [720, 1950], [700, 2450],
                     [650, 2620], [540, 2900], [440, 3250], [385, 3300], [385, 4250]],
            'cutR': [[1885, 1265], [2090, 1400], [2130, 1450], [2100, 1650], [2075, 1950],
                     [2070, 2400], [2110, 2800], [2200, 3100], [2290, 3380], [2300, 3420],
                     [2295, 4250]],
            'seed': [1500, 2450, 1900, 2700],
        },
        'back': {
            'img': 'IMG_E8321.JPG',
            'width': 1024,
            'tile': 3,
            # Centre back: the middle of the body (the hood above lies 2 cm to the left of it).
            'centre': [[1625, 1050], [1640, 4050]],
            'half': 1010,
            'rows': [
                [1050, 1050, 1050],
                [1490, 1470, 1430],
                [1850, 1840, 1820],
                [2215, 2210, 2200],
                [2590, 2590, 2590],
                [2970, 2970, 2970],
                [3330, 3330, 3330],
                [3700, 3700, 3700],
                [4050, 4050, 4050],
            ],
            'cutL': [[1080, 1000], [700, 1230], [750, 1500], [740, 2300], [650, 2600], [625, 3200],
                     [620, 3300], [640, 4050]],
            'cutR': [[2010, 1000], [2540, 1240], [2510, 1630], [2525, 2040], [2575, 2550],
                     [2640, 2930], [2650, 3300], [2640, 4050]],
            'seed': [1300, 2300, 1900, 2500],
        },
        # The sleeve on the photo's left (the wearer's right; no lettering). rows: [xOuter, yOuter,
        # xInner, yInner] of the armhole line, each stitch, and the cuff edge.
        'sleeve': {
            'img': 'IMG_E8319.JPG',
            'width': 384,
            'tile': 1,
            'rows': [[255, 1640, 720, 1730], [222, 1710, 700, 1890], [146, 2103, 690, 2183],
                     [89, 2490, 630, 2562], [35, 2863, 490, 2935], [4, 3280, 405, 3265]],
            'poly': [[255, 1640], [215, 1690], [171, 1895], [139, 2097], [89, 2490], [35, 2882],
                     [4, 3280], [405, 3265], [450, 3035], [506, 2845], [545, 2718], [620, 2566],
                     [658, 2414], [690, 2212], [665, 1958]],
            'seed': [200, 2200, 450, 2400],
        },
    },
    'DQ4920-206': {
        'folder': 'DQ4920-206-puffer-kem',
        'calib': {
            'img': 'IMG_E8302.JPG',
            'paper': [2280, 1930, 3065, 2850],
            'fabric': [[1315, 1795, 1970, 2300], [1315, 2410, 1930, 2800], [3240, 1970, 3720, 2630],
                       [2190, 3130, 2850, 3500]],
        },
        'front': {
            'img': 'IMG_E8300.JPG',
            'width': 1024,
            'tile': 1,
            'centre': [[2143, 1500], [2085, 3800]],
            'half': 1100,
            'rows': [
                [1430, 1430, 1430],
                [1655, 1685, 1765],
                [2255, 2270, 2210],
                [2765, 2805, 2850],
                [3370, 3375, 3340],
                [3790, 3815, 3790],
            ],
            'cutL': [[1620, 1420], [1335, 1480], [1355, 1650], [1365, 2280], [1243, 2513],
                     [1111, 2777], [1050, 2910], [1020, 3790]],
            'cutR': [[2480, 1420], [2990, 1540], [2950, 1650], [2945, 2280], [3069, 2513],
                     [3214, 2777], [3248, 2910], [3215, 3790]],
            'seed': [1500, 1900, 1900, 2150],
        },
        'back': {
            'img': 'IMG_E8306.JPG',
            'width': 1024,
            'tile': 1,
            # Centre back runs through the small swoosh; the jacket lies 2.3 deg off the vertical.
            'centre': [[1930, 1250], [2020, 3490]],
            'half': 1030,
            'rows': [
                [1250, 1250, 1250],
                [1660, 1606, 1633],
                [2163, 2083, 2115],
                [2650, 2584, 2590],
                [3160, 3105, 3080],
                [3490, 3490, 3490],
            ],
            'cutL': [[1560, 1250], [1075, 1370], [1150, 1560], [1210, 2060], [1100, 2680],
                     [1005, 2945], [990, 3490]],
            'cutR': [[2330, 1250], [2785, 1370], [2735, 1660], [2705, 2115], [2785, 2570],
                     [2945, 2945], [3050, 3490]],
            'seed': [1700, 2250, 2200, 2500],
        },
        'sleeve': {
            'img': 'IMG_E8300.JPG',
            'width': 384,
            'tile': 1,
            'rows': [[1300, 1480, 1685, 1927], [975, 1749, 1360, 2196], [626, 2187, 1252, 2598],
                     [385, 2688, 1091, 2912], [197, 3207, 769, 3377], [140, 3680, 599, 3700]],
            'poly': [[1300, 1480], [966, 1740], [626, 2169], [429, 2563], [268, 3010], [170, 3368],
                     [140, 3680], [599, 3700], [644, 3565], [805, 3368], [948, 3100], [1100, 2903],
                     [1111, 2777], [1243, 2513], [1365, 2280], [1355, 1650], [1335, 1480]],
            'seed': [500, 2700, 800, 2900],
        },
    },
}


def srgb_to_linear(img8):
    v = img8.astype(np.float32) / 255.0
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4).astype(np.float32)


def linear_to_srgb8(lin):
    v = np.clip(lin, 0, 1)
    s = np.where(v <= 0.0031308, v * 12.92, 1.055 * v ** (1 / 2.4) - 0.055)
    return np.clip(s * 255 + 0.5, 0, 255).astype(np.uint8)


# Linear Display P3 -> linear sRGB (same D65 white, same transfer curve; Bradford not needed).
P3_TO_SRGB = np.array([
    [1.2249401, -0.2249402, 0.0],
    [-0.0420569, 1.0420571, 0.0],
    [-0.0196376, -0.0786361, 1.0982735],
], dtype=np.float32)


def read_rgb(folder, name):
    path = os.path.join(PHOTOS, folder, 'hanger', name)
    bgr = cv2.imread(path, cv2.IMREAD_COLOR)
    if bgr is None:
        raise SystemExit('missing photo: ' + path)
    return bgr[:, :, ::-1]


def is_display_p3(folder, name):
    with open(os.path.join(PHOTOS, folder, 'hanger', name), 'rb') as f:
        head = f.read(300000)
    return 'Display P3'.encode('utf-16-be') in head


def read_linear(folder, name):
    """The photo in linear sRGB (float32, may exceed [0, 1] slightly), and its 8-bit pixels."""
    rgb = read_rgb(folder, name)
    lin = srgb_to_linear(rgb)
    if is_display_p3(folder, name):
        lin = np.maximum(lin @ P3_TO_SRGB.T, 0).astype(np.float32)
    return lin, rgb


def calibrate(cfg):
    """Paper-calibrated fabric albedo (linear sRGB) and the photo's px/cm from the sheet."""
    c = cfg['calib']
    lin, _ = read_linear(cfg['folder'], c['img'])
    x0, y0, x1, y1 = c['paper']
    paper = np.median(lin[y0:y1, x0:x1].reshape(-1, 3), axis=0)
    patches = []
    for fx0, fy0, fx1, fy1 in c['fabric']:
        p = lin[fy0:fy1, fx0:fx1].reshape(-1, 3)
        # The 60th percentile: stitch valleys and wrinkle shadows pull the median down.
        patches.append(np.percentile(p, 60, axis=0))
    patches = np.array(patches)
    fabric = np.median(patches, axis=0)
    albedo = PAPER_REFLECTANCE * fabric / paper
    return {
        'albedo': albedo,
        'paper': paper,
        'fabric': fabric,
        'patches': PAPER_REFLECTANCE * patches / paper,
    }


def line_x(line, y):
    (xa, ya), (xb, yb) = line
    return xa + (xb - xa) * (y - ya) / (yb - ya)


def centre_x(chart, y):
    """The centre line's x at photo row y: the traced zip where there is one, else the line."""
    fit = chart.get('centre_fit')
    if fit is None:
        return line_x(chart['centre'], y)
    coef, y0, y1 = fit
    return np.polyval(coef, np.clip(y, y0, y1))


def trace_zip(lum, chart, seed_l, debug):
    """
    The dark zip tape's centre per photo row, as a cubic x(y) (robust: samples off the fit by more
    than 10 px are dropped twice). Looks +-90 px round the hand-read line, between the first and
    the last row. Returns (coefficients, yMin, yMax), or None when no tape is found.
    """
    y_a = int(min(r[1] for r in chart['rows'])), int(max(r[1] for r in chart['rows']))
    ys, xs = [], []
    for y in range(y_a[0], y_a[1], 8):
        x0 = int(round(line_x(chart['centre'], y)))
        band = lum[y:y + 8, x0 - 90:x0 + 91].mean(axis=0)
        dark = np.nonzero(band < 0.3 * seed_l)[0]
        if 8 <= len(dark) <= 90:
            ys.append(y + 4)
            xs.append(x0 - 90 + float(dark.mean()))
    if len(ys) < 20:
        return None
    ys, xs = np.array(ys, dtype=np.float64), np.array(xs, dtype=np.float64)
    ok = np.ones(len(ys), bool)
    for _ in range(2):
        coef = np.polyfit(ys[ok], xs[ok], 3)
        ok = np.abs(np.polyval(coef, ys) - xs) < 10
    coef = np.polyfit(ys[ok], xs[ok], 3)
    if debug:
        off = np.polyval(coef, ys) - np.array([line_x(chart['centre'], y) for y in ys])
        print('   zip traced on %d of %d rows; off the hand-read line by %+.0f .. %+.0f px' % (
            int(ok.sum()), len(ys), off.min(), off.max()))
    return coef, float(ys.min()), float(ys.max())


def poly_x(poly, y):
    ys = np.array([p[1] for p in poly], dtype=np.float32)
    xs = np.array([p[0] for p in poly], dtype=np.float32)
    return np.interp(y, ys, xs)


def snap_rows(lum, chart, debug):
    """
    Refines each hand-read stitch row: at lateral fractions across the visible body, the darkest
    thin line within +-SNAP_RANGE pitch of the hand-read position (high-passed luminance), then a
    quadratic through the finds per side (robust: finds off the fit by > 30 % of the range are
    dropped). Returns per row the polyline samples (t, y). First (shoulder) and last (hem) rows
    are not stitches: kept as read.
    """
    rows = chart['rows']
    pitch = float(np.median(np.diff([r[1] for r in rows[1:-1]])))
    half = max(8, int(SNAP_RANGE * pitch))
    ts = np.concatenate([np.linspace(-0.95, -0.06, 16), np.linspace(0.06, 0.95, 16)])
    out = []
    for k, (yl, yc, yr) in enumerate(rows):
        guess = np.where(ts < 0, yc + (yl - yc) * -ts, yc + (yr - yc) * ts)
        if k == 0 or k == len(rows) - 1 or chart.get('nosnap'):
            out.append((ts, guess))
            continue
        found = np.full(len(ts), np.nan)
        for j, t in enumerate(ts):
            y = guess[j]
            x = centre_x(chart, y) + t * chart['half']
            # Only where the body is visible (not under a sleeve).
            if t < 0 and x < poly_x(chart['cutL'], y) + 20:
                continue
            if t > 0 and x > poly_x(chart['cutR'], y) - 20:
                continue
            xi, yi = int(round(x)), int(round(y))
            strip = lum[yi - half - 20:yi + half + 21, xi - 14:xi + 15]
            if strip.shape[0] < 2 * half + 41 or strip.shape[1] < 29:
                continue
            profile = strip.mean(axis=1)
            smooth = cv2.blur(profile.reshape(-1, 1), (1, 41)).ravel()
            hp = (profile - smooth)[20:-20]
            hp = cv2.GaussianBlur(hp.reshape(-1, 1), (1, 5), 0).ravel()
            i = int(np.argmin(hp))
            # A real line: clearly darker than its surroundings and not at the search border.
            if 2 < i < len(hp) - 3 and hp[i] < -0.004 * max(smooth.mean(), 1e-3) / 0.5:
                found[j] = yi - half + i
        fitted = guess.copy()
        for side in (ts < 0, ts > 0):
            ok = side & np.isfinite(found)
            for _ in range(2):
                if ok.sum() < 5:
                    break
                coef = np.polyfit(ts[ok], found[ok], 2)
                resid = np.abs(np.polyval(coef, ts) - found)
                ok = ok & (resid < 0.3 * half)
            if ok.sum() >= 5:
                coef = np.polyfit(ts[ok], found[ok], 2)
                fitted[side] = np.polyval(coef, ts[side])
        if debug:
            print('   row %d: snapped %2d / %d samples, shift centre %+.0f px' % (
                k, int(np.isfinite(found).sum()), len(ts), float(np.nanmedian(fitted - guess))))
        out.append((ts, fitted))
    return out, pitch


def flat_field(lin, fabric_mask, sigma):
    """photo / (masked low-pass ^ strength x mean ^ (1 - strength)), per channel."""
    k = 8
    small = cv2.resize(lin, None, fx=1 / k, fy=1 / k, interpolation=cv2.INTER_AREA)
    m = cv2.resize(fabric_mask.astype(np.float32), None, fx=1 / k, fy=1 / k,
                   interpolation=cv2.INTER_AREA)
    s = max(1.0, sigma / k)
    num = cv2.GaussianBlur(small * m[:, :, None], (0, 0), s)
    den = cv2.GaussianBlur(m, (0, 0), s)
    low = num / np.maximum(den, 1e-3)[:, :, None]
    mean = (small * m[:, :, None]).reshape(-1, 3).sum(axis=0) / max(float(m.sum()), 1.0)
    low = np.where(den[:, :, None] > 0.02, low, mean[None, None, :])
    eff = np.power(np.maximum(low, 1e-4), FLAT_STRENGTH) * np.power(mean, 1 - FLAT_STRENGTH)
    eff = cv2.resize(eff, (lin.shape[1], lin.shape[0]), interpolation=cv2.INTER_LINEAR)
    ratio = lin / np.maximum(eff, 1e-4)
    # Fabric detail toward 1 by DETAIL_GAIN and ACHROMATIC (luminance only: a wrinkle's shadow in
    # the photo is bluer than the cloth, which greyed the panel); dark features as photographed.
    level = ratio @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    w = np.clip((level - DETAIL_KEEP_LO) / (DETAIL_KEEP_HI - DETAIL_KEEP_LO), 0, 1)
    w = (w * w * (3 - 2 * w))[:, :, None]
    return DARK_GAIN * ratio * (1 - w) + (1 + DETAIL_GAIN * (level[:, :, None] - 1)) * w


def fabric_mask(lin, lum, inside, seed_box):
    """Plain fabric inside a panel: not a dark feature (zip, logo, deep shadow)."""
    sx0, sy0, sx1, sy1 = seed_box
    seed_l = float(np.median(lum[sy0:sy1, sx0:sx1]))
    return inside & (lum > 0.4 * seed_l)


def write_chart(style, name, out, alpha, debug, rgb=None, overlay=None):
    rgba = np.dstack([linear_to_srgb8(out), np.clip(alpha * 255 + 0.5, 0, 255).astype(np.uint8)])
    os.makedirs(os.path.join(OUT, style), exist_ok=True)
    cv2.imwrite(os.path.join(OUT, style, name + '.png'), cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA))
    if debug:
        os.makedirs(WORK, exist_ok=True)
        if overlay is not None:
            k = 1400 / max(overlay.shape[:2])
            cv2.imwrite(os.path.join(WORK, '%s-%s-overlay.jpg' % (style, name)),
                        cv2.resize(overlay, None, fx=k, fy=k, interpolation=cv2.INTER_AREA))
        card = np.full(rgba.shape[:2] + (3,), 90, np.uint8)
        a = rgba[:, :, 3:4].astype(np.float32) / 255
        view = (rgba[:, :, :3][:, :, ::-1] * a + card * (1 - a)).astype(np.uint8)
        cv2.imwrite(os.path.join(WORK, '%s-%s-tex.jpg' % (style, name)), view)
    return name + '.png'


def build_sleeve(style, cfg, debug):
    """The sleeve chart: u = outer line .. underarm line, v = rows from the armhole to the cuff."""
    chart = cfg['sleeve']
    lin, rgb = read_linear(cfg['folder'], chart['img'])
    h, w = rgb.shape[:2]
    lum = lin @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    rows = np.array(chart['rows'], dtype=np.float32)
    mids = (rows[:, :2] + rows[:, 2:]) / 2
    steps = np.linalg.norm(np.diff(mids, axis=0), axis=1)
    pitch = float(np.median(steps[1:-1])) if len(steps) > 2 else float(np.median(steps))
    n_rows = len(rows)
    inside = np.zeros((h, w), np.uint8)
    cv2.fillPoly(inside, [np.array(chart['poly'], np.int32)], 1)
    inside = inside.astype(bool)
    fabric = fabric_mask(lin, lum, inside, chart['seed'])
    tex_lin = 0.5 * flat_field(lin, fabric, FLAT_SIGMA_PITCH * pitch)
    cover = cv2.GaussianBlur(inside.astype(np.float32), (0, 0), max(2.0, pitch * FEATHER_PITCH))
    cover = np.clip((cover - 0.5) * 2, 0, 1)
    tw = int(chart['width'])
    width_px = float(np.median(np.linalg.norm(rows[:, 2:] - rows[:, :2], axis=1)))
    th = int(round(tw * (pitch * (n_rows - 1)) / width_px))
    u = ((np.arange(tw, dtype=np.float32) + 0.5) / tw)[None, :]
    row_x = rows[:, 0:1] + u * (rows[:, 2:3] - rows[:, 0:1])
    row_y = rows[:, 1:2] + u * (rows[:, 3:4] - rows[:, 1:2])
    sv = (np.arange(th, dtype=np.float32) + 0.5) / th * (n_rows - 1)
    k0 = np.clip(np.floor(sv).astype(int), 0, n_rows - 2)
    f = (sv - k0)[:, None]
    map_x = (row_x[k0] * (1 - f) + row_x[k0 + 1] * f).astype(np.float32)
    map_y = (row_y[k0] * (1 - f) + row_y[k0 + 1] * f).astype(np.float32)
    foot = max(width_px / tw, 1.0)
    src = cv2.GaussianBlur(tex_lin, (0, 0), 0.5 * foot) if foot > 1.2 else tex_lin
    out = cv2.remap(src, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    alpha = cv2.remap(cover, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    out = out * alpha[:, :, None] + 0.5 * (1 - alpha[:, :, None])
    overlay = None
    if debug:
        overlay = rgb[:, :, ::-1].copy()
        for k in range(n_rows):
            cv2.line(overlay, (int(rows[k, 0]), int(rows[k, 1])), (int(rows[k, 2]), int(rows[k, 3])),
                     (0, 0, 255) if k in (0, n_rows - 1) else (0, 255, 0), 3)
        cv2.polylines(overlay, [np.array(chart['poly'], np.int32)], True, (255, 0, 255), 3)
    file = write_chart(style, 'sleeve', out, alpha, debug, rgb, overlay)
    top = float(steps[0] / pitch)
    print('  sleeve: %dx%d, %d stitches, photo pitch %.0f px, top cell %.2f, cuff cell %.2f pitch' % (
        tw, th, n_rows - 2, pitch, top, steps[-1] / pitch))
    return {'file': file, 'rows': n_rows - 2, 'tile': int(chart['tile']), 'top': round(max(top, 0.05), 3)}


def build_torso(style, name, cfg, debug):
    chart = dict(cfg[name])
    lin, rgb = read_linear(cfg['folder'], chart['img'])
    h, w = rgb.shape[:2]
    lum = lin @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    if chart.get('zip'):
        sx0, sy0, sx1, sy1 = chart['seed']
        chart['centre_fit'] = trace_zip(lum, chart, float(np.median(lum[sy0:sy1, sx0:sx1])), debug)
    rows, pitch = snap_rows(lum, chart, debug)
    n_rows = len(rows)
    s_end = float(n_rows - 2)  # rows: s = -1, 0, 1, ..., the last one is the hem

    # Plain fabric: inside the visible body, of the seed patch's chroma, not a dark detail.
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    inside = (xx > poly_x(chart['cutL'], yy)) & (xx < poly_x(chart['cutR'], yy))
    inside &= (yy > min(r[1] for r in chart['rows'])) & (yy < max(max(r) for r in chart['rows']))
    fabric = fabric_mask(lin, lum, inside, chart['seed'])
    # Detail round 1 (plain fabric), stored x 0.5: up to 2x brighter than the fabric fits in 8 bits.
    tex_lin = 0.5 * flat_field(lin, fabric, FLAT_SIGMA_PITCH * pitch)

    # Coverage in photo space, feathered inward (FEATHER_PITCH).
    cover = cv2.GaussianBlur(inside.astype(np.float32), (0, 0), max(2.0, pitch * FEATHER_PITCH))
    cover = np.clip((cover - 0.5) * 2, 0, 1)

    # Chart -> photo map.
    tw = int(chart['width'])
    body_w = 2.0 * chart['half']
    th = int(round(tw * (pitch * (s_end + 1)) / body_w))
    t = (np.arange(tw, dtype=np.float32) + 0.5) / tw * 2 - 1
    row_x = np.zeros((n_rows, tw), np.float32)
    row_y = np.zeros((n_rows, tw), np.float32)
    for k, (ts, ys) in enumerate(rows):
        y = np.interp(t, ts, ys).astype(np.float32)  # clamps beyond the outermost samples
        row_x[k] = centre_x(chart, y) + t * chart['half']
        row_y[k] = y
    s = (np.arange(th, dtype=np.float32) + 0.5) / th * (s_end + 1) - 1
    k0 = np.clip(np.floor(s).astype(int) + 1, 0, n_rows - 2)
    f = (s + 1 - k0)[:, None]
    map_x = (row_x[k0] * (1 - f) + row_x[k0 + 1] * f).astype(np.float32)
    map_y = (row_y[k0] * (1 - f) + row_y[k0 + 1] * f).astype(np.float32)
    # Minification: blur the source to the texel footprint first (remap is a point lookup).
    foot = max(body_w / tw, 1.0)
    src = cv2.GaussianBlur(tex_lin, (0, 0), 0.5 * foot) if foot > 1.2 else tex_lin
    out = cv2.remap(src, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    alpha = cv2.remap(cover, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    out = out * alpha[:, :, None] + 0.5 * (1 - alpha[:, :, None])
    overlay = None
    if debug:
        overlay = rgb[:, :, ::-1].copy()
        for k in range(n_rows):
            pts = np.stack([row_x[k], row_y[k]], axis=1).astype(np.int32)
            cv2.polylines(overlay, [pts], False, (0, 0, 255) if k in (0, n_rows - 1) else (0, 255, 0), 3)
        for key in ('cutL', 'cutR'):
            cv2.polylines(overlay, [np.array(chart[key], np.int32)], False, (255, 0, 255), 3)
        yy_line = np.arange(int(chart['rows'][0][1]), int(max(chart['rows'][-1])), 20)
        for off in (-chart['half'], 0, chart['half']):
            pts = np.stack([centre_x(chart, yy_line) + off, yy_line], axis=1).astype(np.int32)
            cv2.polylines(overlay, [pts], False, (255, 128, 0), 2)
    file = write_chart(style, name, out, alpha, debug, rgb, overlay)
    centre_rows = [float(np.interp(0.0, ts, ys)) for ts, ys in rows]
    top = (centre_rows[1] - centre_rows[0]) / pitch
    print('  %s: %dx%d, %d stitches, photo pitch %.0f px, top cell %.2f, hem cell %.2f pitch' % (
        name, tw, th, n_rows - 2, pitch, top, (centre_rows[-1] - centre_rows[-2]) / pitch))
    return {'file': file, 'rows': n_rows - 2, 'tile': int(chart['tile']), 'top': round(max(top, 0.05), 3),
            'half': round(chart['half'] / pitch, 4)}


def build(style, debug):
    cfg = CONFIG[style]
    cal = calibrate(cfg)
    albedo = cal['albedo']
    chroma = [float(albedo[0] / albedo[1]), float(albedo[2] / albedo[1])]
    lum = float(albedo @ np.array([0.2126, 0.7152, 0.0722]))
    print('%s: apparent reflectance vs paper %.2f: Y %.3f, chroma r/g %.3f b/g %.3f; patches (Y, r/g, b/g) %s' % (
        style, PAPER_REFLECTANCE, lum, chroma[0], chroma[1],
        [[round(float(p @ np.array([0.2126, 0.7152, 0.0722])), 3), round(float(p[0] / p[1]), 3),
          round(float(p[2] / p[1]), 3)] for p in cal['patches']]))
    meta = {
        'version': 1,
        'style': style,
        'chroma': [round(chroma[0], 4), round(chroma[1], 4)],
        'apparentY': round(lum, 4),
    }
    os.makedirs(os.path.join(OUT, style), exist_ok=True)
    for name in ('front', 'back'):
        if name in cfg:
            meta[name] = build_torso(style, name, cfg, debug)
    if 'sleeve' in cfg:
        meta['sleeve'] = build_sleeve(style, cfg, debug)
    with open(os.path.join(OUT, style, 'meta.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, indent=1)
    print('  wrote', os.path.join(OUT, style, 'meta.json'))


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    for style_name in args or list(CONFIG):
        build(style_name, '--debug' in sys.argv)
