"""F5 judge: per-frame visual metrics from a native AR recording versus its raw camera recording.

Run with `py` (never `python` on this machine):
  py scripts/ar-judge-frames.py --ar <ar.webm> --raw <raw.webm> --out <metrics.json>
     [--windows '<json list of {name,t0,t1}>'] [--sheet <masks.jpg>]

Everything stays local; the inputs and the sheet are private pixels under .cache/.

Definitions (also in docs/STATUS-ar-eval.md "## Final push"):
- Alignment: ar.webm and raw.webm are separate MediaRecorder streams with independent clocks.
  Each AR frame is paired with the raw frame (within +-300 ms of the global offset) that minimises
  the changed area after colour mapping. A per-channel tone LUT (raw -> AR camera) is fitted from
  the joint histogram, excluding jacket pixels on the second pass.
- Jacket mask J: max-channel |AR - LUT(raw)| > JACKET_DIFF after a 5x5 median, opened 3x3,
  components < MIN_BLOB px dropped. J is what the AR adds or changes over the camera.
- Person mask P: torchvision DeepLabV3-MobileNetV3 (COCO/VOC "person") on the matched raw frame,
  independent of the product's own segmenter.
- jacketPresent = |J and P| / |P| per frame (person present when |P| >= 1.5 % of the frame).
  A dropout frame is a person-present frame with jacketPresent < DROPOUT_PRESENT.
- Flicker = single-frame blips: pixels where J(t) differs from both J(t-1) and J(t+1) while
  J(t-1) == J(t+1), over distinct AR frames, as % of the jacket area at t. Steady motion moves
  an edge monotonically and is not counted; shards and holes that appear for one frame are.
- Edge width: 10-90 % rise of the difference profile |AR - LUT(raw)| (proportional to alpha
  where the jacket and the background are locally uniform) along the boundary normal of J,
  sampled at 0.25 px, only where the plateaus are flat and the contrast is >= EDGE_MIN_CONTRAST.
  Reported in recording px and scaled to 1280-px camera units (x 1280 / recording width).
- Cadence: gaps between AR recording timestamps, and between distinct-content AR frames
  (mean |dAR| >= 0.35 grey levels), median / p95 / max ms. The raw stream's own cadence is
  reported as the recorder floor.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import cv2
import numpy as np

# Operator thresholds for the judge (grey levels on 8-bit frames). Calibrated 2026-11-14 on
# the venue-khong-ao recordings: post-LUT background residual p95 is well under 15 levels,
# while the parka/puffer differ from the dark hoodie and slats by > 60 levels.
JACKET_DIFF = 28
MIN_BLOB = 40
DROPOUT_PRESENT = 0.15
PERSON_MIN_FRAC = 0.015
DISTINCT_MEAN = 0.35
EDGE_MIN_CONTRAST = 60.0
MATCH_WINDOW_MS = 300.0


def decode(path: str, size: tuple[int, int] | None, store_full: bool, flip: bool = False):
    cap = cv2.VideoCapture(path)
    times, small, full = [], [], []
    while True:
        ok = cap.grab()
        if not ok:
            break
        t = cap.get(cv2.CAP_PROP_POS_MSEC)
        ok, f = cap.retrieve()
        if not ok:
            break
        if size and (f.shape[1], f.shape[0]) != size:
            f = cv2.resize(f, size, interpolation=cv2.INTER_AREA)
        if flip:
            f = cv2.flip(f, 1)
        times.append(t)
        small.append(cv2.resize(f, (f.shape[1] // 2, f.shape[0] // 2), interpolation=cv2.INTER_AREA))
        if store_full:
            full.append(cv2.imencode(".jpg", f, [cv2.IMWRITE_JPEG_QUALITY, 97])[1])
    return np.array(times), small, full


def fit_lut(pairs, masks=None):
    """Per-channel median AR value for each raw value (joint histogram), monotone-smoothed."""
    lut = np.zeros((3, 256), np.float32)
    for ch in range(3):
        hist = np.zeros(256 * 256, np.int64)
        for k, (a, r) in enumerate(pairs):
            keep = np.ones(a.shape[:2], bool) if masks is None else ~masks[k]
            idx = r[..., ch][keep].astype(np.int64) * 256 + a[..., ch][keep].astype(np.int64)
            hist += np.bincount(idx, minlength=256 * 256)
        h = hist.reshape(256, 256)
        cnt = h.sum(1)
        cum = np.cumsum(h, 1)
        med = np.array([np.searchsorted(cum[v], cnt[v] / 2) for v in range(256)], np.float32)
        ok = cnt > 200
        x = np.arange(256)
        if ok.sum() <= 8:
            lut[ch] = x
            continue
        # count-weighted isotonic fit (pool adjacent violators): a few sparse, jacket-dominated
        # bins cannot lock the whole curve (a running max did, on cam-still).
        xs, ys, ws = list(x[ok]), list(med[ok].astype(np.float64)), list(cnt[ok].astype(np.float64))
        blocks = []
        for xi, yi, wi in zip(xs, ys, ws):
            blocks.append([yi, wi, [xi]])
            while len(blocks) > 1 and blocks[-2][0] > blocks[-1][0]:
                y2, w2, x2 = blocks.pop()
                y1, w1, x1 = blocks.pop()
                blocks.append([(y1 * w1 + y2 * w2) / (w1 + w2), w1 + w2, x1 + x2])
        fx = [xi for b_ in blocks for xi in b_[2]]
        fy = [b_[0] for b_ in blocks for _ in b_[2]]
        lut[ch] = np.interp(x, fx, fy)
    return lut


def apply_lut(img, lut):
    """raw BGR uint8 -> AR-camera tone, via an 8-bit LUT per channel (rounding <= 0.5 level)."""
    l8 = np.clip(np.round(lut), 0, 255).astype(np.uint8)
    return cv2.merge([cv2.LUT(img[..., c], l8[c]) for c in range(3)])


def changed_frac(a_small, r_mapped):
    d = cv2.absdiff(a_small, r_mapped).max(2)
    return float((d > JACKET_DIFF).mean())


class PersonSeg:
    def __init__(self):
        os.environ.setdefault(
            "TORCH_HOME", os.path.join(os.path.dirname(__file__), "..", ".cache", "torch")
        )
        import torch
        from torchvision.models.segmentation import (
            DeepLabV3_MobileNet_V3_Large_Weights as W,
            deeplabv3_mobilenet_v3_large,
        )

        torch.set_num_threads(4)
        self.torch = torch
        self.model = deeplabv3_mobilenet_v3_large(weights=W.COCO_WITH_VOC_LABELS_V1).eval()
        self.person = W.COCO_WITH_VOC_LABELS_V1.meta["categories"].index("person")
        self.mean = np.array([0.485, 0.456, 0.406], np.float32)
        self.std = np.array([0.229, 0.224, 0.225], np.float32)

    def __call__(self, bgr_small):
        x = (cv2.cvtColor(bgr_small, cv2.COLOR_BGR2RGB).astype(np.float32) / 255 - self.mean) / self.std
        t = self.torch.from_numpy(x.transpose(2, 0, 1)[None].copy())
        with self.torch.no_grad():
            out = self.model(t)["out"][0]
        return (out.argmax(0) == self.person).numpy()


def jacket_mask(d):
    m = cv2.medianBlur(np.clip(d, 0, 255).astype(np.uint8), 5) > JACKET_DIFF
    m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    keep = np.zeros(n, bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= MIN_BLOB
    return keep[lab]


def edge_widths(d, J, rng, max_points=120):
    cnts, _ = cv2.findContours(J.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    big = [c[:, 0, :] for c in cnts if len(c) > 30]
    if not big:
        return []
    pts = np.concatenate(big, 0)
    pts = pts[rng.choice(len(pts), min(max_points * 4, len(pts)), replace=False)]
    sm = cv2.GaussianBlur(d, (0, 0), 1.5)
    gx = cv2.Sobel(sm, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(sm, cv2.CV_32F, 0, 1, ksize=3)
    s = np.arange(-5, 5.001, 0.25, dtype=np.float32)
    out = []
    H, W = d.shape
    for x, y in pts:
        g = np.array([gx[y, x], gy[y, x]], np.float32)
        n = np.linalg.norm(g)
        if n < 1e-3:
            continue
        g /= n  # points toward higher difference = into the jacket
        xs = (x - s * g[0]).astype(np.float32)  # s > 0 = outside, s < 0 = inside
        ys = (y - s * g[1]).astype(np.float32)
        if xs.min() < 0 or ys.min() < 0 or xs.max() > W - 1 or ys.max() > H - 1:
            continue
        prof = cv2.remap(d, xs[None], ys[None], cv2.INTER_LINEAR)[0]
        inner, outer = np.median(prof[s <= -3.5]), np.median(prof[s >= 3.5])
        c = inner - outer
        if c < EDGE_MIN_CONTRAST:
            continue
        if prof[s <= -3].std() > 0.2 * c or prof[s >= 3].std() > 0.2 * c:
            continue
        y_ = (prof - outer) / c
        # walk from outside (s=+5) inwards
        rev_s, rev_y = s[::-1], y_[::-1]

        def cross(level):
            i = np.argmax(rev_y >= level)
            if rev_y[i] < level or i == 0:
                return None
            f = (level - rev_y[i - 1]) / max(1e-6, rev_y[i] - rev_y[i - 1])
            return rev_s[i - 1] + f * (rev_s[i] - rev_s[i - 1])

        a, b = cross(0.1), cross(0.9)
        if a is None or b is None:
            continue
        out.append(float(a - b))
        if len(out) >= max_points:
            break
    return out


def stats(v):
    v = [x for x in v if x is not None and np.isfinite(x)]
    if not v:
        return None
    a = np.array(v, np.float64)
    return {
        "n": int(a.size),
        "median": round(float(np.median(a)), 3),
        "p95": round(float(np.percentile(a, 95)), 3),
        "max": round(float(a.max()), 3),
        "min": round(float(a.min()), 3),
        "mean": round(float(a.mean()), 3),
    }


def canvas_mode(declared, border_median):
    """CX-DAY HIGH (ar-judge-frames.py:333): overlay mode is never inferred from the pixels (a dark
    border or a bright person could fool it); it must be declared from the capture provenance.
    Returns (overlay, note). A black border on a declared composite only produces a warning."""
    if declared == "overlay":
        return True, None
    note = (
        f"WARNING: composite canvas declared but the AR border is near black (median {border_median:.1f}); "
        "check the capture manifest"
        if border_median < 12
        else None
    )
    return False, note


SEE_THROUGH_LUM = 70  # camera luminance of the clothing under the jacket (the user's dark hoodie)
INTERIOR_LUM = 80  # rendered sleeve interior / hollow tube: dark AR pixels inside the jacket
_K7 = np.ones((7, 7), np.uint8)


def hole_px(J, P, R_gray, min_hole=30):
    """See-through: pixels of holes fully enclosed by the jacket, on the person, where the CAMERA
    shows dark clothing (not skin: the face inside the collar and real hands are legitimate)."""
    cnts, hier = cv2.findContours(J.astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hier is None:
        return 0
    holes = np.zeros(J.shape, np.uint8)
    for k, h in enumerate(hier[0]):
        if h[3] >= 0 and cv2.contourArea(cnts[k]) >= min_hole:  # child contour = hole
            cv2.drawContours(holes, cnts, k, 1, -1)
    st = ((holes > 0) & P & ~J & (R_gray < SEE_THROUGH_LUM)).astype(np.uint8)
    # a black zip or pocket slit over a dark hoodie matches the camera and looks like a thin
    # "hole": only blobs at least 7 px thick count as see-through
    return int(cv2.morphologyEx(st, cv2.MORPH_OPEN, _K7).sum())


def uncovered_px(J, P, R_gray, head):
    """Real dark clothing visible outside the jacket (a sleeve that does not cover the raised
    arm, a torso gap): person & not jacket & dark camera, head excluded, 7 px thick. None without
    a pose (the head cannot be excluded)."""
    if head is None:
        return None
    m = (P & ~J & (R_gray < SEE_THROUGH_LUM)).astype(np.uint8)
    cv2.circle(m, (int(head[0]), int(head[1])), int(head[2]), 0, -1)
    return int(cv2.morphologyEx(m, cv2.MORPH_OPEN, _K7).sum())


def interior_px(J, A_gray, wrists):
    """Visible sleeve interior: dark rendered regions inside the jacket at least 7 px thick
    (zips, pocket slits and cuff bands are thinner and are removed by the 7x7 opening), counted
    only within 30 px of a wrist/hand point (a cuff opening), so dark logos (the back swoosh)
    never count. None when no pose landmarks are available (live clips)."""
    if wrists is None:
        return None
    dark = cv2.morphologyEx((J & (A_gray < INTERIOR_LUM)).astype(np.uint8), cv2.MORPH_OPEN, _K7)
    near = np.zeros(J.shape, np.uint8)
    for x, y in wrists:
        cv2.circle(near, (int(x), int(y)), 30, 1, -1)
    return int((dark & near).sum())


# U5 zero-tolerance glitch thresholds (recording px at the 794 analysis width)
GLITCH_BLIP_PCT = 3.0  # single-frame shard/hole blips, % of jacket area
GLITCH_HOLE_PX = 150  # see-through hole on the person inside the jacket
GLITCH_JUMP_PX = 6.0
GLITCH_INTERIOR_PX = 120  # visible sleeve interior blob
GLITCH_UNCOVERED_PX = 300  # real dark clothing outside the jacket (head excluded)
STARTUP_S = 1.5  # recorder start + first tracked frames: listed separately, not in the count  # one-frame centroid excursion while the neighbours agree within 3 px


# WOBBLE (lead 22:05, the user's "jelly"): non-rigid motion of the drawn jacket between
# consecutive distinct frames = RMS residual of tracked jacket points after the best similarity
# transform (rotation + uniform scale + translation). The same on the raw camera's person torso is
# the real body's own non-rigid motion (control); excess = jacket - body.
WOBBLE_MAX_RESID = 10.0  # px: larger residuals are tracking failures, not deformation


def nonrigid(p0, p1):
    """(rms residual px, relative scale change %) of p0->p1 after a similarity fit; None if < 12 pts."""
    if p0 is None or len(p0) < 12:
        return None
    M, _ = cv2.estimateAffinePartial2D(p0, p1, method=cv2.RANSAC, ransacReprojThreshold=3.0)
    if M is None:
        return None
    pred = p0 @ M[:, :2].T + M[:, 2]
    r = np.linalg.norm(p1 - pred, axis=1)
    r = r[r <= WOBBLE_MAX_RESID]
    if len(r) < 12:
        return None
    scale = float(np.hypot(M[0, 0], M[1, 0]))
    return float(np.sqrt(np.mean(r ** 2))), abs(scale - 1) * 100


def track(g0, g1, mask):
    """Forward-backward checked LK tracks of corners inside mask; returns (p0, p1) float32 Nx2."""
    pts = cv2.goodFeaturesToTrack(g0, maxCorners=300, qualityLevel=0.01, minDistance=5, mask=mask)
    if pts is None:
        return None, None
    p1, st, _ = cv2.calcOpticalFlowPyrLK(g0, g1, pts, None, winSize=(15, 15), maxLevel=3)
    pb, st2, _ = cv2.calcOpticalFlowPyrLK(g1, g0, p1, None, winSize=(15, 15), maxLevel=3)
    ok = (st[:, 0] == 1) & (st2[:, 0] == 1) & (np.linalg.norm((pb - pts)[:, 0], axis=1) < 1.0)
    return pts[ok, 0].astype(np.float32), p1[ok, 0].astype(np.float32)


def zipper_bend(A_gray, Jfilled, tor):
    """Jelly on the parka: RMS distance (px) of the drawn black centre zip from its best straight
    line, inside the closed jacket within +-15 % of the shoulder span around the torso centre.
    A rigid jacket keeps the zip straight; the user's "jelly" bends it into an S. None when < 40
    zip pixels (no dark zip: puffer, back view)."""
    span = abs(int(tor[0][0]) - int(tor[1][0]))
    if span < 20:
        return None
    sy = int(min(tor[0][1], tor[1][1]))
    hy = int(max(tor[2][1], tor[3][1]))
    cx_top = (tor[0][0] + tor[1][0]) / 2
    cx_bot = (tor[2][0] + tor[3][0]) / 2
    ys, xs = [], []
    for y in range(max(0, sy), min(A_gray.shape[0], hy)):
        c = cx_top + (cx_bot - cx_top) * (y - sy) / max(1, hy - sy)
        x0, x1 = int(max(0, c - 0.15 * span)), int(min(A_gray.shape[1], c + 0.15 * span))
        row = (A_gray[y, x0:x1] < 70) & Jfilled[y, x0:x1]
        idx = np.nonzero(row)[0]
        if len(idx):
            ys.append(y)
            xs.append(x0 + float(np.median(idx)))
    if len(ys) < 40:
        return None
    ys, xs = np.array(ys, float), np.array(xs, float)
    keep = np.ones(len(ys), bool)
    for _ in range(2):
        a, b = np.polyfit(ys[keep], xs[keep], 1)
        r = np.abs(xs - (a * ys + b))
        keep = r < 6
        if keep.sum() < 30:
            return None
    a, b = np.polyfit(ys[keep], xs[keep], 1)
    return float(np.sqrt(np.mean((xs[keep] - (a * ys[keep] + b)) ** 2)))


def run_width(J, row, cx):
    """Width of the contiguous jacket run on `row` that contains column cx (the torso), so an arm
    swinging past the row is not counted; None when cx is not on the jacket."""
    if not (0 <= row < J.shape[0] and 0 <= cx < J.shape[1]) or not J[row, cx]:
        return None
    line = J[row]
    l = cx
    while l > 0 and line[l - 1]:
        l -= 1
    r = cx
    while r < len(line) - 1 and line[r + 1]:
        r += 1
    return int(r - l + 1)


def highpass_rms(ts, vals, half_window_s=0.17):
    """RMS of vals minus a centred moving average over +-half_window_s (passes roughly > 3 Hz)."""
    ts, vals = np.asarray(ts, float), np.asarray(vals, float)
    out = []
    for k in range(len(ts)):
        m = np.abs(ts - ts[k]) <= half_window_s
        if m.sum() >= 3:
            out.append(vals[k] - vals[m].mean())
    return float(np.sqrt(np.mean(np.square(out)))) if out else None


def glitch_list(frames, ref_strength):
    d = [f for f in frames if f["distinct"]]
    out = []
    for k, f in enumerate(d):
        types, score = [], 0.0
        if f["jacketPresent"] is not None:
            if f["jacketPresent"] < DROPOUT_PRESENT:
                types.append("missing")
                score = max(score, 100.0)
            elif ref_strength and (f.get("jacketStrength") or 0) < 0.5 * ref_strength:
                types.append("faded")
                score = max(score, 60.0)
        if (f.get("flickerPct") or 0) >= GLITCH_BLIP_PCT and (f["jacketPresent"] or 0) >= DROPOUT_PRESENT:
            types.append("blip")
            score = max(score, f["flickerPct"])
        if (f.get("holePx") or 0) >= GLITCH_HOLE_PX:
            types.append("see-through")
            score = max(score, f["holePx"] / 50)
        if (f.get("uncoveredPx") or 0) >= GLITCH_UNCOVERED_PX:
            types.append("uncovered")
            score = max(score, f["uncoveredPx"] / 50)
        if (f.get("interiorPx") or 0) >= GLITCH_INTERIOR_PX:
            types.append("interior")
            score = max(score, f["interiorPx"] / 50)
        if 0 < k < len(d) - 1 and all(x.get("cx") is not None for x in (d[k - 1], f, d[k + 1])):
            a, b = d[k - 1], d[k + 1]
            dev = np.hypot(f["cx"] - (a["cx"] + b["cx"]) / 2, f["cy"] - (a["cy"] + b["cy"]) / 2)
            if dev > GLITCH_JUMP_PX and np.hypot(a["cx"] - b["cx"], a["cy"] - b["cy"]) < 3:
                types.append("jump")
                score = max(score, float(dev) * 5)
        if types:
            out.append({"i": f["i"], "t": f["t"], "types": types, "score": round(score, 2), "startup": bool(f["t"] < STARTUP_S)})
    return out


def cadence(rows):
    """Gaps only between frames that are consecutive in the recording (frame index i, i+1), so a
    union of disjoint windows never yields a cross-window 'gap'."""
    g, gd = [], []
    last_distinct = None
    for k, f in enumerate(rows):
        contiguous = k > 0 and f["i"] == rows[k - 1]["i"] + 1
        if contiguous:
            g.append((f["t"] - rows[k - 1]["t"]) * 1000)
        else:
            last_distinct = None
        if f["distinct"]:
            if last_distinct is not None:
                gd.append((f["t"] - last_distinct["t"]) * 1000)
            last_distinct = f
    return {"recordedGapMs": stats(g), "distinctGapMs": stats(gd)}


def summaries(frames, windows, size):
    """All per-window and aggregate summaries from the per-frame rows (also used by --resummarize)."""
    still_ref = [f["jacketStrength"] for f in frames if f.get("jacketStrength") is not None]
    ref_strength = float(np.median(still_ref)) if still_ref else None

    def summary(rows):
        pres = [f for f in rows if f["jacketPresent"] is not None]
        # Relative fade-change (D1 ghost evidence, not an opacity measure): drawn but its median
        # AR-vs-camera difference < 0.5 x the clip median.
        faded = [
            f
            for f in pres
            if f["jacketPresent"] >= DROPOUT_PRESENT
            and ref_strength
            and (f.get("jacketStrength") or 0) < 0.5 * ref_strength
        ]
        jp = [f["jacketPresent"] for f in pres]
        drop = [f for f in pres if f["jacketPresent"] < DROPOUT_PRESENT]
        absent = [f for f in rows if f["jacketPresent"] is None]
        ew = [f.get("edgeW") for f in rows if f.get("edgeW") is not None]
        # flicker is graded where a jacket is actually drawn (dropout frames are their own row)
        fl = [
            f.get("flickerPct")
            for f in rows
            if f.get("flickerPct") is not None and (f["jacketPresent"] or 0) >= DROPOUT_PRESENT
        ]
        scale = 1280 / size[0]
        hs = sum(f.get("handsSeen", 0) for f in rows)
        hh = sum(f.get("handsHidden", 0) for f in rows)
        return {
            "handsSeen": hs,
            "handsVisiblePct": round(100 * (hs - hh) / hs, 2) if hs else None,
            "frames": len(rows),
            "personFrames": len(pres),
            "jacketPresent": stats(jp),
            "dropoutFrames": len(drop),
            "dropoutPct": round(100 * len(drop) / len(pres), 2) if pres else None,
            "fadedFrames": len(faded),
            "notSolidPct": round(100 * (len(drop) + len(faded)) / len(pres), 2) if pres else None,
            "ghostFramesNoPerson": sum(1 for f in absent if f["jacketFrac"] > 0.005),
            "flickerPct": stats(fl),
            "edgeWidthPx": stats(ew),
            "edgeWidthPx1280": {k: (round(v * scale, 3) if k != "n" else v) for k, v in stats(ew).items()}
            if ew
            else None,
            **cadence(rows),
        }

    win = lambda t0, t1: [f for f in frames if t0 <= f["t"] < t1]  # noqa: E731

    def wobble(rows):
        w = [f["wobblePx"] for f in rows if f.get("wobblePx") is not None]
        b = [f["bodyWobblePx"] for f in rows if f.get("bodyWobblePx") is not None]
        sc = [f["scaleStepPct"] for f in rows if f.get("scaleStepPct") is not None]
        ex = [f["wobblePx"] - f["bodyWobblePx"] for f in rows
              if f.get("wobblePx") is not None and f.get("bodyWobblePx") is not None]
        zb = [f["zipBendPx"] for f in rows if f.get("zipBendPx") is not None]
        d = [f for f in rows if f.get("chestW") is not None]
        h = [f for f in rows if f.get("hemW") is not None]
        return {
            "frames": len(rows),
            "jacketNonRigidPx": stats(w),
            "bodyNonRigidPx": stats(b),
            "excessNonRigidPx": stats(ex),
            "scaleStepPct": stats(sc),
            "zipBendPx": stats(zb),
            "chestShimmerPx": highpass_rms([f["t"] for f in d], [f["chestW"] for f in d]) if len(d) >= 5 else None,
            "hemShimmerPx": highpass_rms([f["t"] for f in h], [f["hemW"] for f in h]) if len(h) >= 5 else None,
        }

    by_motion = {c: wobble([f for f in frames if f.get("motion") == c]) for c in ("still", "arms", "turn", "other")}
    return {
        "wobble": {"all": wobble([f for f in frames if f["distinct"]]), "byMotion": by_motion},
        "all": summary(frames),
        # union of the named judge windows except "empty" and the extra "x-*" diagnostic windows:
        # comparable across full and --until runs and across judge versions
        "judged": summary(
            [f for f in frames if any(w["t0"] <= f["t"] < w["t1"] for w in windows if w["name"] != "empty" and not w["name"].startswith("x-"))]
        )
        if windows
        else None,
        "windows": {w["name"]: {"t0": w["t0"], "t1": w["t1"], **summary(win(w["t0"], w["t1"]))} for w in windows},
    }


def resummarize(path):
    with open(path) as fh:
        m = json.load(fh)
    windows = [{"name": k, "t0": w["t0"], "t1": w["t1"]} for k, w in m["windows"].items()]
    m.update(summaries(m["frames"], windows, tuple(m["size"])))
    with open(path, "w") as fh:
        json.dump(m, fh)
    print(json.dumps({"resummarized": path, "judged": m["judged"]["distinctGapMs"] if m.get("judged") else None}))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ar", required=True)
    ap.add_argument("--raw", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--windows", default="[]")
    ap.add_argument("--sheet", default=None)
    ap.add_argument("--edge-every", type=int, default=3)
    ap.add_argument("--max-t", type=float, default=1e9, help="debug: stop after this AR time (s)")
    ap.add_argument("--landmarks", default=None, help="ar-eval checkpoint.json (source-px pose landmarks)")
    ap.add_argument("--analysis-width", type=int, default=794, help="0 = native recording size")
    ap.add_argument(
        "--canvas",
        choices=["composite", "overlay"],
        default="composite",
        help="capture provenance: composite = the AR canvas contains the camera (lab, judge); overlay = a transparent jacket-only canvas (only when the recording manifest says so)",
    )
    a = ap.parse_args()
    windows = json.loads(a.windows)

    cap = cv2.VideoCapture(a.ar)
    native = (int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))
    cap.release()
    # Comparable pixel metrics across canvas sizes (f4res/arfull change the AR canvas): analyse at
    # ANALYSIS_WIDTH (the 794 px lab canvas of every baseline), INTER_AREA like a browser downscale.
    size = native if a.analysis_width <= 0 or native[0] <= a.analysis_width else (
        a.analysis_width,
        int(round(native[1] * a.analysis_width / native[0])),
    )
    import time as _t0
    t0 = _t0.time()
    at, a_small, a_full = decode(a.ar, size if size != native else None, True)
    rt, r_small, r_full = decode(a.raw, size, True)
    if len(at) < 10 or len(rt) < 10:
        raise SystemExit("recordings too short")
    print(f"decoded ar {len(at)} raw {len(rt)} size {size} in {_t0.time() - t0:.0f}s", flush=True)

    # 0. Live kiosk recordings (?rec=1): the AR canvas may be a transparent overlay (black where
    #    no jacket) and/or mirrored relative to the camera stream. Detect both from the data.
    border = np.concatenate([np.concatenate([f[:6].reshape(-1, 3), f[-6:].reshape(-1, 3)]) for f in a_small[:: max(1, len(a_small) // 30)]])
    overlay, canvas_note = canvas_mode(a.canvas, float(np.median(border.max(1))))
    if canvas_note:
        print(canvas_note, flush=True)
    probe = list(range(5, len(at), max(1, len(at) // 12)))

    def best_frac(i, frames_):
        js = np.where(np.abs(rt - at[i]) < 1500)[0]
        return min(changed_frac(a_small[i], frames_[j]) for j in js) if len(js) else 1.0

    mirrored = False
    if not overlay:
        flipped = [cv2.flip(r, 1) for r in r_small]
        normal_score = float(np.median([best_frac(i, r_small) for i in probe]))
        flip_score = float(np.median([best_frac(i, flipped) for i in probe]))
        mirrored = flip_score + 0.05 < normal_score
        del flipped
        if mirrored:
            rt, r_small, r_full = decode(a.raw, size, True, flip=True)
    print(f"overlay {overlay} mirrored {mirrored}", flush=True)

    # 1. global offset with an identity LUT, then a LUT, then per-frame matching.
    ident = np.tile(np.arange(256, dtype=np.float32), (3, 1))
    sample = list(range(5, len(at), max(1, len(at) // 40)))
    offs = []
    for i in sample:
        js = np.where(np.abs(rt - at[i]) < 1500)[0]
        if len(js) == 0:
            continue
        best = min(js, key=lambda j: changed_frac(a_small[i], r_small[j]))
        offs.append(rt[best] - at[i])
    offset = float(np.median(offs)) if offs and not overlay else 0.0

    mapped = r_small

    def match(i):
        if overlay:  # no camera pixels in the AR stream: nearest timestamp
            return int(np.argmin(np.abs(rt - at[i] - offset)))
        js = np.where(np.abs(rt - at[i] - offset) <= MATCH_WINDOW_MS)[0]
        if len(js) == 0:
            js = [int(np.argmin(np.abs(rt - at[i] - offset)))]
        sc = [(changed_frac(a_small[i], mapped[j]), j) for j in js]
        return min(sc)[1]

    lsample = list(range(3, len(at), max(1, len(at) // 60)))
    pairs = [(a_small[i], r_small[match(i)]) for i in lsample]
    lut = fit_lut(pairs)
    for _ in range(2):  # refit twice, excluding the (dilated) jacket pixels of the last fit
        masks = []
        for ar_s, r_s in pairs:
            d = cv2.absdiff(ar_s, apply_lut(r_s, lut)).max(2)
            masks.append(cv2.dilate((d > JACKET_DIFF).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0)
        lut = fit_lut(pairs, masks)
    lut_mask_frac = float(np.mean([m.mean() for m in masks]))
    mapped = [apply_lut(r, lut) for r in r_small]
    print(f"offset {offset:.0f} ms; lut fitted", flush=True)

    seg = PersonSeg()
    pcache: dict[int, np.ndarray] = {}
    rng = np.random.default_rng(7)
    frames = []
    prevA = None
    Js, distinct_idx = [], []
    bg_resid = []
    # Hands (lead 16:58 A2): pose hand points (pinky/index/thumb tips) from the sampler checkpoint,
    # same video time, source px -> recording px. A hand is "visible" when <= 50 % of a 5 px disc
    # at its centre is jacket. Grain: temporal noise inside the still jacket vs the camera
    # background in the same AR recording (same encoder), over the "still" window.
    lm_t, lm_rows = None, None
    if a.landmarks and os.path.exists(a.landmarks):
        with open(a.landmarks) as fh:
            ck = json.load(fh)["frames"]
        lm_rows = [f for f in ck if f.get("lm") and isinstance(f.get("videoMs"), (int, float))]
        lm_t = np.array([f["videoMs"] for f in lm_rows])
        cap = cv2.VideoCapture(a.raw)
        src_w = cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 1280
        cap.release()
        lm_scale = size[0] / src_w
    still_w = next((w for w in windows if w["name"] == "still"), None)
    still_frames, still_J, still_P = [], [], None
    disc = np.zeros((11, 11), np.uint8)
    cv2.circle(disc, (5, 5), 5, 1, -1)

    def hands(t_ms, J):
        if lm_t is None or not len(lm_t):
            return None
        k = int(np.argmin(np.abs(lm_t - t_ms)))
        if abs(lm_t[k] - t_ms) > 120:
            return None
        lm = lm_rows[k]["lm"]
        seen = hidden = 0
        for ids in ((17, 19, 21), (18, 20, 22)):
            pts = [lm[q] for q in ids if q < len(lm) and lm[q] and lm[q].get("visibility", 0) >= 0.5]
            if len(pts) < 2:
                continue
            x = np.mean([p_["x"] for p_ in pts]) * lm_scale
            y = np.mean([p_["y"] for p_ in pts]) * lm_scale
            if mirrored:
                x = size[0] - 1 - x
            xi, yi = int(round(x)), int(round(y))
            if xi < 5 or yi < 5 or xi >= size[0] - 5 or yi >= size[1] - 5:
                continue
            seen += 1
            patch = J[yi - 5 : yi + 6, xi - 5 : xi + 6]
            if (patch & (disc > 0)).sum() > 0.5 * disc.sum():
                hidden += 1
        return seen, hidden

    def head_disc(t_ms):
        """(x, y, r) around the head from the pose (nose + shoulders), recording px; None if no pose."""
        if lm_t is None or not len(lm_t):
            return None
        k = int(np.argmin(np.abs(lm_t - t_ms)))
        if abs(lm_t[k] - t_ms) > 120:
            return None
        lm = lm_rows[k]["lm"]
        if not all(q < len(lm) and lm[q] and lm[q].get("visibility", 0) >= 0.5 for q in (0, 11, 12)):
            return None
        sx = lambda q: (size[0] - 1 - lm[q]["x"] * lm_scale) if mirrored else lm[q]["x"] * lm_scale  # noqa: E731
        span = abs(sx(11) - sx(12))
        return sx(0), lm[0]["y"] * lm_scale, 0.75 * span + 10

    def wrist_pts(t_ms):
        if lm_t is None or not len(lm_t):
            return None
        k = int(np.argmin(np.abs(lm_t - t_ms)))
        if abs(lm_t[k] - t_ms) > 120:
            return []
        lm = lm_rows[k]["lm"]
        pts = []
        for q in (15, 16, 17, 18, 19, 20, 21, 22):
            if q < len(lm) and lm[q] and lm[q].get("visibility", 0) >= 0.5:
                x = lm[q]["x"] * lm_scale
                pts.append((size[0] - 1 - x if mirrored else x, lm[q]["y"] * lm_scale))
        return pts

    import time as _time
    t_start = _time.time()
    for i in range(len(at)):
        if at[i] / 1000 > a.max_t:
            break
        A = cv2.imdecode(a_full[i], cv2.IMREAD_COLOR)
        distinct = prevA is None or float(np.abs(A.astype(np.int16) - prevA).mean()) >= DISTINCT_MEAN
        prevA = A.astype(np.int16)
        j = match(i)
        R = cv2.imdecode(r_full[j], cv2.IMREAD_COLOR)
        d = (A.max(2) if overlay else cv2.absdiff(A, apply_lut(R, lut)).max(2)).astype(np.float32)
        J = jacket_mask(d)
        near = next((k for k in (j, j - 1, j + 1, j - 2, j + 2) if k in pcache), None)
        if near is None:
            # person region at 1/2 recording size; neighbours (<= 2 raw frames, ~80 ms) share it
            pcache[j] = cv2.resize(seg(r_small[j]).astype(np.uint8), size, interpolation=cv2.INTER_NEAREST) > 0
            near = j
        P = pcache[near]
        pa = int(P.sum())
        present = pa >= PERSON_MIN_FRAC * P.size
        jp = float((J & P).sum() / pa) if present else None
        JP = J & P
        # opacity proxy: median AR-vs-camera difference inside the drawn jacket on the person
        strength = float(np.median(d[JP])) if JP.sum() >= 200 else None
        far = cv2.dilate((J | P).astype(np.uint8), np.ones((15, 15), np.uint8)) == 0
        if far.sum() > 1000:
            bg_resid.append(float(np.percentile(d[far], 95)))
        row = {
            "i": i,
            "t": round(at[i] / 1000, 3),
            "rawT": round(rt[j] / 1000, 3),
            "distinct": bool(distinct),
            "personFrac": round(pa / P.size, 4),
            "jacketFrac": round(float(J.mean()), 4),
            "jacketPresent": None if jp is None else round(jp, 4),
            "jacketOutsidePersonFrac": round(float((J & ~P).sum() / P.size), 4),
            "jacketStrength": None if strength is None else round(strength, 1),
            # U5: see-through = holes enclosed by the jacket that show the PERSON (not background)
            "holePx": hole_px(J, P, cv2.cvtColor(R, cv2.COLOR_BGR2GRAY)),
            "interiorPx": interior_px(J, cv2.cvtColor(A, cv2.COLOR_BGR2GRAY), wrist_pts(at[i])),
            "uncoveredPx": uncovered_px(J, P, cv2.cvtColor(R, cv2.COLOR_BGR2GRAY), head_disc(at[i])),
            "cx": None if not J.any() else round(float(np.mean(np.nonzero(J)[1])), 2),
            "cy": None if not J.any() else round(float(np.mean(np.nonzero(J)[0])), 2),
        }
        hh = hands(at[i], J)
        if hh:
            row["handsSeen"], row["handsHidden"] = hh
        if distinct and still_w and still_w["t0"] <= at[i] / 1000 < still_w["t1"]:
            still_frames.append(cv2.cvtColor(A, cv2.COLOR_BGR2GRAY).astype(np.float32))
            still_J.append(J)
            still_P = P
        if distinct and i % a.edge_every == 0:
            w = edge_widths(d, J, rng)
            row["edgeW"] = round(float(np.median(w)), 3) if w else None
            row["edgeN"] = len(w)
        frames.append(row)
        if distinct:
            Js.append(np.packbits(J))
            distinct_idx.append(i)
        if i % 100 == 0:
            print(f"frame {i}/{len(at)} {_time.time() - t_start:.0f}s segs {len(pcache)}", flush=True)

    # flicker over distinct frames
    shape = (size[1], size[0])
    unpack = lambda b: np.unpackbits(b)[: shape[0] * shape[1]].reshape(shape).astype(bool)
    prev2, prev1 = None, None
    for k, i in enumerate(distinct_idx):
        cur = unpack(Js[k])
        if prev2 is not None:
            mid = prev1
            blips = ((mid != prev2) & (prev2 == cur)).astype(np.uint8)
            # 1-px boundary toggles (threshold noise on a still edge) are not shards or holes:
            # only blips that survive a 3x3 opening count.
            blips = cv2.morphologyEx(blips, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
            area = max(1, int(mid.sum()))
            frames[distinct_idx[k - 1]]["flickerPct"] = round(100 * float(blips.sum()) / area, 3) if mid.sum() >= 500 else None
        prev2, prev1 = prev1, cur

    # --- WOBBLE pass over consecutive distinct frames (jacket on ar.webm, body on raw.webm)
    def torso_poly(t_ms):
        if lm_t is None or not len(lm_t):
            return None
        k = int(np.argmin(np.abs(lm_t - t_ms)))
        if abs(lm_t[k] - t_ms) > 120:
            return None
        lm = lm_rows[k]["lm"]
        if not all(q < len(lm) and lm[q] and lm[q].get("visibility", 0) >= 0.5 for q in (11, 12, 23, 24)):
            return None
        pts = []
        for q in (11, 12, 24, 23):
            x = lm[q]["x"] * lm_scale
            pts.append((size[0] - 1 - x if mirrored else x, lm[q]["y"] * lm_scale))
        return np.array(pts, np.int32)

    def motion_class(t_ms):
        """turn / arms / still / other from the sampler checkpoint (yaw + wrist speed)."""
        if lm_t is None or len(lm_t) < 3:
            return None
        k = int(np.argmin(np.abs(lm_t - t_ms)))
        a_, b_ = max(0, k - 2), min(len(lm_rows) - 1, k + 2)
        dt = (lm_rows[b_]["videoMs"] - lm_rows[a_]["videoMs"]) / 1000 or 1e-3
        ya, yb, yk = lm_rows[a_].get("yawRaw"), lm_rows[b_].get("yawRaw"), lm_rows[k].get("yawRaw")
        num = (int, float)
        yaw_rate = abs((yb - ya) / dt) if isinstance(ya, num) and isinstance(yb, num) else 0
        wr = 0.0
        la, lb = lm_rows[a_]["lm"], lm_rows[b_]["lm"]
        for q in (15, 16):
            if q < len(la) and q < len(lb) and la[q] and lb[q]:
                wr = max(wr, np.hypot(lb[q]["x"] - la[q]["x"], lb[q]["y"] - la[q]["y"]) / dt)
        if (isinstance(yk, num) and abs(yk) > 45) or yaw_rate > 30:  # turning, or side/back view
            return "turn"
        if wr > 150:
            return "arms"
        if wr < 40 and yaw_rate < 10:
            return "still"
        return "other"

    dists = [f for f in frames if f["distinct"]]
    prevA = prevR = None
    for k, f in enumerate(dists):
        A = cv2.cvtColor(cv2.imdecode(a_full[f["i"]], cv2.IMREAD_COLOR), cv2.COLOR_BGR2GRAY)
        jr = int(np.argmin(np.abs(rt - f["rawT"] * 1000)))
        R = cv2.cvtColor(cv2.imdecode(r_full[jr], cv2.IMREAD_COLOR), cv2.COLOR_BGR2GRAY)
        f["motion"] = motion_class(f["t"] * 1000)
        if prevA is not None:
            pf = dists[k - 1]
            Jp = unpack(Js[k - 1])
            tor = torso_poly(pf["t"] * 1000)
            region = cv2.erode(Jp.astype(np.uint8), np.ones((5, 5), np.uint8))
            if tor is not None:
                tmask = np.zeros(Jp.shape, np.uint8)
                cv2.fillPoly(tmask, [tor], 1)
                region = region & tmask
            res = nonrigid(*track(prevA, A, region * 255))
            if res:
                f["wobblePx"], f["scaleStepPct"] = round(res[0], 3), round(res[1], 3)
            if tor is not None:
                body = np.zeros(Jp.shape, np.uint8)
                cv2.fillPoly(body, [tor], 255)
                rb = nonrigid(*track(prevR, R, body))
                if rb:
                    f["bodyWobblePx"] = round(rb[0], 3)
                # close thin vertical gaps (a black zip over the dark hoodie matches the camera)
                Jc = cv2.morphologyEx(unpack(Js[k]).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 11), np.uint8)) > 0
                sy = (tor[0][1] + tor[1][1]) / 2
                hy = (tor[2][1] + tor[3][1]) / 2
                span = abs(int(tor[0][0]) - int(tor[1][0]))
                x0 = int(max(0, min(tor[:, 0]) - 0.3 * span))
                x1 = int(min(size[0], max(tor[:, 0]) + 0.3 * span))
                Jfill = Jc.copy()
                cnts_, _ = cv2.findContours(Jc.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                if cnts_:
                    Jfill = cv2.drawContours(np.zeros(Jc.shape, np.uint8), cnts_, -1, 1, -1) > 0
                zb = zipper_bend(A, Jfill, tor)
                if zb is not None:
                    f["zipBendPx"] = round(zb, 3)
                cy = int(sy + 0.25 * (hy - sy))
                cx = int((tor[0][0] + tor[1][0]) / 2)
                cw = run_width(Jc, cy, cx)
                if cw:
                    f["chestW"] = cw
                    # hem: the lowest row whose torso run is >= 40 % of the chest width; none when
                    # the jacket reaches the frame bottom (hem not visible, e.g. close framing)
                    col = Jc[:, max(0, cx - 2) : cx + 3].any(1)
                    rows_ = np.nonzero(col)[0]
                    if len(rows_) and rows_.max() < Jc.shape[0] - 3:
                        for hrow in range(int(rows_.max()) - 2, int(rows_.max()) - 40, -1):
                            hw = run_width(Jc, hrow, cx)
                            if hw and hw >= 0.4 * cw:
                                f["hemW"] = hw
                                break
        prevA, prevR = A, R

    _sr = [f["jacketStrength"] for f in frames if f.get("jacketStrength") is not None]
    glitches = glitch_list(frames, float(np.median(_sr)) if _sr else None)
    grain = None
    if len(still_frames) >= 6:
        stack = np.stack(still_frames)
        tstd = stack.std(0)
        inner = cv2.erode(np.logical_and.reduce(still_J).astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
        bg = ~cv2.dilate((np.logical_or.reduce(still_J) | still_P).astype(np.uint8), np.ones((21, 21), np.uint8)).astype(bool)
        if inner.sum() > 500 and bg.sum() > 2000:
            js_, cs_ = float(np.median(tstd[inner])), float(np.median(tstd[bg]))
            grain = {
                "frames": len(still_frames),
                "jacketTemporalStd": round(js_, 3),
                "cameraTemporalStd": round(cs_, 3),
                "ratio": round(js_ / cs_, 3) if cs_ > 0 else None,
            }

    window_rows = lambda t0, t1: [f for f in frames if t0 <= f["t"] < t1]  # noqa: E731
    sums = summaries(frames, windows, size)

    rcad = np.diff(rt)
    out = {
        "ar": a.ar.replace("\\", "/"),
        "size": size,
        "nativeSize": native,
        "offsetMs": round(offset, 1),
        "overlayCanvas": overlay,
        "mirroredVsRaw": mirrored,
        "lutBackgroundResidualP95": stats(bg_resid),
        "lutExcludedFrac": round(lut_mask_frac, 3),
        # Self-check: a failed tone/geometry alignment shows up as a large "jacket" outside the
        # person or a high background residual; such a run must not be graded.
        "alignmentOk": bool(
            (stats(bg_resid) or {}).get("median", 99) < 20
            and np.median([f["jacketOutsidePersonFrac"] for f in frames]) < 0.12
        ),
        "rawRecorderGapMs": stats(list(rcad)),
        "grainStill": grain,
        "glitches": {
            "count": sum(1 for g in glitches if not g["startup"]),
            "startupCount": sum(1 for g in glitches if g["startup"]),
            "distinctFrames": sum(1 for f in frames if f["distinct"]),
            "byType": {t: sum(1 for g in glitches if t in g["types"] and not g["startup"]) for t in ("missing", "faded", "blip", "see-through", "uncovered", "interior", "jump")},
            "thresholds": {
                "blipPct": GLITCH_BLIP_PCT,
                "holePx": GLITCH_HOLE_PX,
                "seeThroughLum": SEE_THROUGH_LUM,
                "interiorPx": GLITCH_INTERIOR_PX,
                "interiorLum": INTERIOR_LUM,
                "jumpPx": GLITCH_JUMP_PX,
                "uncoveredPx": GLITCH_UNCOVERED_PX,
            },
            "frames": glitches,
        },
        "thresholds": {
            "jacketDiff": JACKET_DIFF,
            "minBlob": MIN_BLOB,
            "dropoutPresent": DROPOUT_PRESENT,
            "personMinFrac": PERSON_MIN_FRAC,
            "distinctMean": DISTINCT_MEAN,
            "edgeMinContrast": EDGE_MIN_CONTRAST,
        },
        **sums,
        "frames": frames,
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w") as fh:
        json.dump(out, fh)

    if a.sheet and any(not g["startup"] for g in glitches):
        gdir = os.path.join(os.path.dirname(os.path.abspath(a.sheet)), "glitches")
        os.makedirs(gdir, exist_ok=True)
        worst = sorted([g for g in glitches if not g["startup"]], key=lambda g: -g["score"])[:10]
        tiles = []
        for n, g in enumerate(worst):
            A = cv2.imdecode(a_full[g["i"]], cv2.IMREAD_COLOR)
            f = frames[g["i"]]
            cx = int(f["cx"]) if f.get("cx") is not None else size[0] // 2
            x0 = max(0, min(size[0] - 300, cx - 150))
            crop = A[:, x0 : x0 + 300]
            crop = cv2.resize(crop, (300, int(300 * crop.shape[0] / crop.shape[1])))
            cv2.putText(crop, f"{n + 1} {g['t']:.2f}s {'+'.join(g['types'])}", (4, 16), 0, 0.45, (0, 255, 255), 1)
            path = os.path.join(gdir, f"glitch-{n + 1:02d}-{g['t']:.2f}s.jpg")
            cv2.imwrite(path, cv2.resize(A, (size[0], size[1])), [cv2.IMWRITE_JPEG_QUALITY, 88])
            g["path"] = path.replace("\\", "/")
            tiles.append(crop)
        while len(tiles) % 5:
            tiles.append(np.zeros_like(tiles[0]))
        cv2.imwrite(os.path.join(gdir, "worst10.jpg"), np.vstack([np.hstack(tiles[r : r + 5]) for r in range(0, len(tiles), 5)]), [cv2.IMWRITE_JPEG_QUALITY, 85])
        with open(a.out, "w") as fh:  # re-save with the crop paths
            json.dump(out, fh)

    if a.sheet:
        # verification sheet: AR with J (green) and P (red) contours, 4 frames per window
        tiles = []
        picks = []
        for w in windows or [{"name": "all", "t0": 0, "t1": 1e9}]:
            rows = [f for f in window_rows(w["t0"], w["t1"]) if f["distinct"]]
            if rows:
                picks += [(w["name"], rows[int(k * (len(rows) - 1) / 3)]) for k in range(4)]
        for name, f in picks:
            i = f["i"]
            A = cv2.imdecode(a_full[i], cv2.IMREAD_COLOR)
            j = int(np.argmin(np.abs(rt - f["rawT"] * 1000)))
            R = cv2.imdecode(r_full[j], cv2.IMREAD_COLOR)
            d = (A.max(2) if overlay else cv2.absdiff(A, apply_lut(R, lut)).max(2)).astype(np.float32)
            J = jacket_mask(d)
            P = next((pcache[k] for k in (j, j - 1, j + 1, j - 2, j + 2) if k in pcache), None)
            vis = A.copy()
            for m, col in ((J, (0, 255, 0)), (P, (0, 0, 255))):
                if m is None:
                    continue
                cs, _ = cv2.findContours(m.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
                cv2.drawContours(vis, cs, -1, col, 1)
            if lm_t is not None and len(lm_t):
                k = int(np.argmin(np.abs(lm_t - f["t"] * 1000)))
                if abs(lm_t[k] - f["t"] * 1000) <= 120:
                    lm = lm_rows[k]["lm"]
                    for ids in ((17, 19, 21), (18, 20, 22)):
                        pts = [lm[q] for q in ids if q < len(lm) and lm[q] and lm[q].get("visibility", 0) >= 0.5]
                        if len(pts) >= 2:
                            x = np.mean([p_["x"] for p_ in pts]) * lm_scale
                            y = np.mean([p_["y"] for p_ in pts]) * lm_scale
                            x = size[0] - 1 - x if mirrored else x
                            xi, yi = int(round(x)), int(round(y))
                            if 5 <= xi < size[0] - 5 and 5 <= yi < size[1] - 5:
                                hid = (J[yi - 5 : yi + 6, xi - 5 : xi + 6] & (disc > 0)).sum() > 0.5 * disc.sum()
                                cv2.circle(vis, (xi, yi), 6, (255, 0, 255) if hid else (255, 255, 0), 2)
            jp = "-" if f["jacketPresent"] is None else f"{f['jacketPresent']:.2f}"
            fl = f.get("flickerPct")
            cv2.putText(vis, f"{name} #{i} {f['t']:.2f}s jp {jp} fl {fl}", (4, 16), 0, 0.5, (0, 255, 255), 1)
            tiles.append(cv2.resize(vis, (397, 223)))
        if tiles:
            cols = 4
            while len(tiles) % cols:
                tiles.append(np.zeros_like(tiles[0]))
            cv2.imwrite(a.sheet, np.vstack([np.hstack(tiles[r : r + cols]) for r in range(0, len(tiles), cols)]), [cv2.IMWRITE_JPEG_QUALITY, 85])
    print(json.dumps({"offsetMs": out["offsetMs"], "alignmentOk": out["alignmentOk"], "all": {k: v for k, v in out["all"].items()}}, indent=None))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--resummarize":
        sys.exit(resummarize(sys.argv[2]))
    sys.exit(main())
