// Tests check the geometry math on synthetic masks of known shape. They do NOT
// validate real-world accuracy (that needs tape measurements; see CALIBRATION.md).
import { describe, expect, it } from 'vitest';
import {
  POSE,
  PROFILE_FRACTIONS,
  STATURE_BANDS,
  aggregateScan,
  armAbductionDeg,
  bandExtreme,
  ellipsePerimeter,
  findShoulderCorner,
  frontSpan,
  measureFrontFrame,
  measureSideFrame,
  median,
  personFromMask,
  pixelScale,
  polylineXsAtRow,
  robustSigma,
  rowRuns,
  selectPerson,
  sideSpan,
  verticalExtent,
  type MaskImage,
  type PixelLandmark,
} from './scanGeometry';

// ---------- helpers ----------
function maskFromRows(rows: number[][]): MaskImage {
  const height = rows.length;
  const width = rows[0].length;
  return { width, height, data: Float32Array.from(rows.flat()) };
}

function interp(points: ReadonlyArray<readonly [number, number]>, y: number): number {
  // points sorted by descending y: [y, value]
  if (y >= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [y0, v0] = points[i - 1];
    const [y1, v1] = points[i];
    if (y >= y1) return v0 + ((y - y0) / (y1 - y0)) * (v1 - v0);
  }
  return points[points.length - 1][1];
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Rasterises inside(x_cm, y_cm) (y up from floor) with 4×4 supersampling → coverage 0..1. */
function render(inside: (x: number, y: number) => boolean, pxPerCm: number) {
  const X0 = -70;
  const Y1 = 180;
  const width = 140 * pxPerCm;
  const height = 185 * pxPerCm;
  const data = new Float32Array(width * height);
  const ss = 4;
  for (let j = 0; j < height; j++)
    for (let i = 0; i < width; i++) {
      let c = 0;
      for (let a = 0; a < ss; a++)
        for (let b = 0; b < ss; b++)
          if (inside(X0 + (i + (a + 0.5) / ss) / pxPerCm, Y1 - (j + (b + 0.5) / ss) / pxPerCm)) c++;
      data[j * width + i] = c / (ss * ss);
    }
  const toPx = (x: number, y: number) => ({ x: (x - X0) * pxPerCm, y: (Y1 - y) * pxPerCm });
  return { mask: { width, height, data } as MaskImage, toPx };
}

// ---------- synthetic figure (cm, y up from floor, x to image right) ----------
const H = 175;
const ABD = (35 * Math.PI) / 180; // arm abduction from vertical
const J = { x: 17, y: 140 }; // shoulder joint centre (designed)
const E = { x: J.x + 30 * Math.sin(ABD), y: J.y - 30 * Math.cos(ABD) };
const W = { x: E.x + 25 * Math.sin(ABD), y: E.y - 25 * Math.cos(ABD) };
const TIP = { x: W.x + 10 * Math.sin(ABD), y: W.y - 10 * Math.cos(ABD) };
const ACROMION = { x: 20, y: 145 }; // designed shoulder corner
const HW: Array<[number, number]> = [
  [145, 20],
  [138, 17],
  [128, 16.5],
  [118, 15.5],
  [107, 14],
  [95, 17],
  [89, 18],
  [80, 17],
];
const HD: Array<[number, number]> = [
  [150, 9],
  [140, 11],
  [128, 12],
  [118, 11],
  [107, 10],
  [95, 11.5],
  [89, 12],
  [80, 10],
];
const hw = (y: number) => interp(HW, y);
const hd = (y: number) => interp(HD, y);
const legHalf = (y: number) => (y >= 8 ? 5 + ((y - 8) * 3) / 72 : 5);
/** Designed front width (cm): torso above the crotch (80 cm), outer edges of both legs below. */
const frontWidth = (y: number) => (y >= 80 ? 2 * hw(y) : 2 * (9 + legHalf(y)));
/** Designed side depth (cm). */
const sideDepth = (y: number) => (y >= 80 ? 2 * hd(y) : 14);

function frontInside(x: number, y: number): boolean {
  const ax = Math.abs(x);
  if ((x / 8) ** 2 + ((y - 163) / 12) ** 2 <= 1) return true; // head, crown at 175
  if (ax <= 6 && y >= 145 && y <= 153) return true; // neck
  if (y > 145 && y <= 150 && ax <= 6.5 + ((150 - y) * 13.5) / 5) return true; // shoulder slope
  if (y >= 80 && y <= 145 && ax <= hw(y)) return true; // torso
  if (y >= 0 && y < 80) {
    if (Math.abs(ax - 9) <= legHalf(y)) return true; // legs and feet
  }
  // arms (mirror to +x)
  if (segmentDistance(ax, y, J.x, J.y, E.x, E.y) <= 5) return true;
  if (segmentDistance(ax, y, E.x, E.y, W.x, W.y) <= 4) return true;
  if (segmentDistance(ax, y, W.x, W.y, TIP.x, TIP.y) <= 4) return true;
  return false;
}

function sideInside(x: number, y: number): boolean {
  if ((x / 10) ** 2 + ((y - 163) / 12) ** 2 <= 1) return true;
  if (Math.abs(x) <= 6 && y >= 145 && y <= 153) return true;
  if (y >= 80 && y <= 150 && Math.abs(x) <= hd(y)) return true;
  if (y >= 8 && y < 80 && Math.abs(x) <= 7) return true;
  if (y >= 0 && y < 8 && x >= -5 && x <= 18) return true;
  return false;
}

function landmarks(
  toPx: (x: number, y: number) => { x: number; y: number },
  side: boolean,
): PixelLandmark[] {
  const lm: PixelLandmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  const set = (i: number, x: number, y: number) => (lm[i] = { ...toPx(x, y), visibility: 0.99 });
  const s = side ? 0 : 1; // side view: left/right overlap
  set(POSE.NOSE, side ? 9 : 0, 163);
  set(POSE.LEFT_SHOULDER, s * J.x, J.y);
  set(POSE.RIGHT_SHOULDER, -s * J.x, J.y);
  set(POSE.LEFT_ELBOW, s * E.x, E.y);
  set(POSE.RIGHT_ELBOW, -s * E.x, E.y);
  set(POSE.LEFT_WRIST, s * W.x, W.y);
  set(POSE.RIGHT_WRIST, -s * W.x, W.y);
  const k = { x: W.x + 6 * Math.sin(ABD), y: W.y - 6 * Math.cos(ABD) };
  for (const [l, r] of [
    [POSE.LEFT_PINKY, POSE.RIGHT_PINKY],
    [POSE.LEFT_INDEX, POSE.RIGHT_INDEX],
  ]) {
    set(l, s * k.x, k.y);
    set(r, -s * k.x, k.y);
  }
  set(POSE.LEFT_HIP, s * 10, 92);
  set(POSE.RIGHT_HIP, -s * 10, 92);
  set(POSE.LEFT_KNEE, s * 9, 45);
  set(POSE.RIGHT_KNEE, -s * 9, 45);
  set(POSE.LEFT_ANKLE, s * 9, 8);
  set(POSE.RIGHT_ANKLE, -s * 9, 8);
  set(POSE.LEFT_HEEL, s * 9, 1);
  set(POSE.RIGHT_HEEL, -s * 9, 1);
  set(POSE.LEFT_FOOT_INDEX, s * 9 + (side ? 15 : 0), 1);
  set(POSE.RIGHT_FOOT_INDEX, -s * 9 + (side ? 15 : 0), 1);
  return lm;
}

const SCALE = 3; // px per cm used for rendering

const front = render(frontInside, SCALE);
const frontLm = landmarks(front.toPx, false);
const side = render(sideInside, SCALE);
const sideLm = landmarks(side.toPx, true);

// ---------- tests ----------
describe('basic math', () => {
  it('Ramanujan perimeter is exact for a circle and matches a known ellipse', () => {
    expect(ellipsePerimeter(10, 10)).toBeCloseTo(20 * Math.PI, 10);
    // π[3·15 − √(35·25)] for a = 10, b = 5
    expect(ellipsePerimeter(10, 5)).toBeCloseTo(Math.PI * (45 - Math.sqrt(875)), 10);
    expect(ellipsePerimeter(10, 5)).toBeCloseTo(48.4422, 3);
    expect(Number.isNaN(ellipsePerimeter(-1, 2))).toBe(true);
  });

  it('median and robust sigma', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
    expect(robustSigma([5, 5, 5])).toBe(0);
    // MAD of [1,2,3,4,100] = median(|x−3|) = 1 → 1.4826
    expect(robustSigma([1, 2, 3, 4, 100])).toBeCloseTo(1.4826, 6);
  });
});

describe('mask primitives', () => {
  it('selects the seeded component, else the largest', () => {
    const m = maskFromRows([
      [1, 0, 0, 0, 0],
      [0, 0, 1, 1, 0],
      [0, 0, 1, 1, 0],
    ]);
    const seeded = selectPerson(m, [{ x: 0.5, y: 0.5 }]);
    expect(seeded?.area).toBe(1);
    const largest = selectPerson(m, [{ x: 4.5, y: 0.5 }]);
    expect(largest?.area).toBe(4);
    expect(largest?.bbox).toEqual({ left: 2, top: 1, right: 3, bottom: 2 });
    expect(selectPerson(maskFromRows([[0, 0]]), [])).toBeNull();
  });

  it('finds sub-pixel run edges by interpolating the threshold crossing', () => {
    const m = maskFromRows([[0, 0, 0.25, 1, 1, 0.75, 0, 0]]);
    const p = selectPerson(m, [{ x: 3.5, y: 0.5 }]);
    expect(p).not.toBeNull();
    const runs = rowRuns(p!, 0);
    expect(runs).toHaveLength(1);
    expect(runs[0].l).toBeCloseTo(2 + 5 / 6, 10); // 2.5 + (0.5−0.25)/(1−0.25)
    expect(runs[0].r).toBeCloseTo(5 + 5 / 6, 10); // 5.5 + (0.75−0.5)/0.75
    // binary mask: edges on pixel boundaries
    const b = selectPerson(maskFromRows([[0, 1, 1, 0]]), [{ x: 1.5, y: 0.5 }]);
    expect(rowRuns(b!, 0)).toEqual([{ l: 1, r: 3 }]);
  });

  it('derives stature pixels and scale from mask top/bottom, heels only if lower', () => {
    const rows = Array.from({ length: 400 }, (_, y) =>
      Array.from({ length: 20 }, (_, x) => (y >= 10 && y < 360 && x >= 5 && x < 15 ? 1 : 0)),
    );
    const p = selectPerson(maskFromRows(rows), [{ x: 10, y: 100 }])!;
    const e = verticalExtent(p);
    expect(e.crownY).toBe(10);
    expect(e.floorY).toBe(360);
    expect(pixelScale(e, 175)).toBeCloseTo(2, 12);
    expect(verticalExtent(p, [350]).floorY).toBe(360); // heel above mask bottom: ignored
    expect(verticalExtent(p, [365]).floorY).toBe(365); // feet cut off in the mask: heel wins
    expect(() => pixelScale(e, 0)).toThrow(RangeError);
  });
});

describe('row spans', () => {
  it('front: separate arm runs are excluded, merged rows are flagged, legs are bridged', () => {
    const torso = { l: 40, r: 60 };
    const leftArm = { l: 20, r: 28 };
    const rightArm = { l: 72, r: 80 };
    expect(frontSpan([leftArm, torso, rightArm], 50, [24, 76])).toEqual({
      status: 'ok',
      left: 40,
      right: 60,
    });
    expect(frontSpan([{ l: 20, r: 60 }, rightArm], 50, [24, 76])).toEqual({ status: 'merged' });
    // legs: centre falls in the gap; the tape spans both legs
    expect(
      frontSpan(
        [
          { l: 38, r: 49 },
          { l: 51, r: 62 },
        ],
        50,
        [],
      ),
    ).toEqual({
      status: 'ok',
      left: 38,
      right: 62,
    });
    // a hand beyond the arm centreline is not torso
    expect(frontSpan([{ l: 5, r: 10 }, torso], 50, [24])).toEqual({
      status: 'ok',
      left: 40,
      right: 60,
    });
    // only a run on one side of the centre → invalid
    expect(frontSpan([{ l: 51, r: 62 }], 50, [])).toEqual({ status: 'none' });
  });

  it('side: run containing centre, else nearest within tolerance', () => {
    expect(
      sideSpan(
        [
          { l: 10, r: 30 },
          { l: 40, r: 45 },
        ],
        20,
        3,
      ),
    ).toEqual({ l: 10, r: 30 });
    expect(sideSpan([{ l: 10, r: 30 }], 32, 3)).toEqual({ l: 10, r: 30 });
    expect(sideSpan([{ l: 10, r: 30 }], 34, 3)).toBeNull();
  });

  it('polyline crossings and abduction angle', () => {
    const poly = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 20 },
    ];
    expect(polylineXsAtRow(poly, 5)).toEqual([5]);
    expect(polylineXsAtRow(poly, 15)).toEqual([10]);
    expect(polylineXsAtRow(poly, 25)).toEqual([]);
    const lm: PixelLandmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 1 }));
    lm[POSE.LEFT_SHOULDER] = { x: 0, y: 0, visibility: 1 };
    lm[POSE.LEFT_ELBOW] = { x: Math.sin(Math.PI / 6), y: Math.cos(Math.PI / 6), visibility: 1 };
    expect(armAbductionDeg(lm, 'left')).toBeCloseTo(30, 10);
  });
});

describe('shoulder corner', () => {
  // Contour with a kink at x = 50: descent 0.3 px/px, then 1.5 px/px outward.
  const xs = Array.from({ length: 101 }, (_, i) => i + 0.5);
  const kink = (x: number) => (x < 50 ? 0.3 * x : 15 + 1.5 * (x - 50));

  it('finds the convex kink and its turn angle (outward +x)', () => {
    const ys = xs.map(kink);
    const c = findShoulderCorner(xs, ys, 1, 10, [20, 80]);
    expect(c).not.toBeNull();
    expect(Math.abs(c!.x - 50)).toBeLessThanOrEqual(1);
    const expectedTurn = ((Math.atan(1.5) - Math.atan(0.3)) * 180) / Math.PI; // 39.6°
    expect(c!.turnDeg).toBeGreaterThan(expectedTurn - 5);
    expect(c!.turnDeg).toBeLessThanOrEqual(expectedTurn + 1e-9);
  });

  it('works mirrored (outward −x) and rejects concave or straight contours', () => {
    const mirrored = xs.map((x) => kink(101 - x));
    const c = findShoulderCorner(xs, mirrored, -1, 10, [20, 80]);
    expect(Math.abs(c!.x - 51)).toBeLessThanOrEqual(1);
    const concave = xs.map((x) => (x < 50 ? 1.5 * x : 75 + 0.3 * (x - 50)));
    expect(findShoulderCorner(xs, concave, 1, 10, [20, 80])).toBeNull();
    expect(
      findShoulderCorner(
        xs,
        xs.map((x) => 0.5 * x),
        1,
        10,
        [20, 80],
      ),
    ).toBeNull();
  });
});

describe('synthetic figure, front + side', () => {
  const fp = personFromMask(front.mask, frontLm)!;
  const fm = measureFrontFrame(fp, frontLm, H);
  const sp = personFromMask(side.mask, sideLm)!;
  const sm = measureSideFrame(sp, sideLm, H);

  it('recovers the pixel scale from the mask stature', () => {
    expect(fm.pxPerCm).toBeCloseTo(SCALE, 1);
    expect(sm.pxPerCm).toBeCloseTo(SCALE, 1);
  });

  it('measures torso width where arms are apart and flags rows where they touch', () => {
    let checked = 0;
    PROFILE_FRACTIONS.forEach((f, k) => {
      const w = fm.widthsCm[k];
      if (!Number.isFinite(w)) return;
      checked++;
      const yCm = H * f;
      // half a pixel each side of tolerance + bin height (0.875 cm) times max slope (0.5)
      expect(Math.abs(w - frontWidth(yCm))).toBeLessThan(1 / SCALE + 0.5);
    });
    expect(checked).toBeGreaterThan(40);
    // At 78 % stature (136.5 cm) the designed arm overlaps the torso.
    const k78 = PROFILE_FRACTIONS.findIndex((f) => Math.abs(f - 0.78) < 1e-9);
    expect(fm.mergedBins[k78]).toBe(true);
    expect(Number.isNaN(fm.widthsCm[k78])).toBe(true);
    // At 72 % (126 cm) the arm is clear of the torso.
    const k72 = PROFILE_FRACTIONS.findIndex((f) => Math.abs(f - 0.72) < 1e-9);
    expect(fm.mergedBins[k72]).toBe(false);
    expect(fm.widthsCm[k72]).toBeCloseTo(2 * hw(126), 0);
  });

  it('measures side depth', () => {
    PROFILE_FRACTIONS.forEach((f, k) => {
      expect(Math.abs(sm.depthsCm[k] - sideDepth(H * f))).toBeLessThan(1 / SCALE + 0.2);
    });
  });

  it('places the acromion at the designed shoulder corner', () => {
    const { left, right } = fm.acromion;
    expect(left && right).toBeTruthy();
    const designedL = front.toPx(ACROMION.x, ACROMION.y);
    const designedR = front.toPx(-ACROMION.x, ACROMION.y);
    expect(Math.hypot(left!.x - designedL.x, left!.y - designedL.y) / SCALE).toBeLessThan(1.5);
    expect(Math.hypot(right!.x - designedR.x, right!.y - designedR.y) / SCALE).toBeLessThan(1.5);
    expect(Math.abs(fm.shoulderWidthCm! - 2 * ACROMION.x)).toBeLessThan(1.5);
  });

  it('arm length is the corner → elbow → wrist polyline', () => {
    const designed = Math.hypot(E.x - ACROMION.x, E.y - ACROMION.y) + 25;
    expect(Math.abs(fm.armLengthCm.left! - designed)).toBeLessThan(1.5);
    expect(Math.abs(fm.armLengthCm.right! - designed)).toBeLessThan(1.5);
    const exact =
      (Math.hypot(
        fm.acromion.left!.x - frontLm[POSE.LEFT_ELBOW].x,
        fm.acromion.left!.y - frontLm[POSE.LEFT_ELBOW].y,
      ) +
        Math.hypot(
          frontLm[POSE.LEFT_ELBOW].x - frontLm[POSE.LEFT_WRIST].x,
          frontLm[POSE.LEFT_ELBOW].y - frontLm[POSE.LEFT_WRIST].y,
        )) /
      fm.pxPerCm;
    expect(fm.armLengthCm.left).toBeCloseTo(exact, 10);
  });

  it('aggregates girths as band extremes of the ellipse profile', () => {
    const agg = aggregateScan([fm, fm, fm], [sm, sm]);
    // Expected from the designed shape, using only bins where the front width is valid.
    for (const name of ['chest_cm', 'waist_cm', 'hip_cm'] as const) {
      const band = STATURE_BANDS[name];
      const truth = new Float64Array(PROFILE_FRACTIONS.length).fill(NaN);
      PROFILE_FRACTIONS.forEach((f, k) => {
        if (Number.isFinite(fm.widthsCm[k]))
          truth[k] = ellipsePerimeter(frontWidth(H * f) / 2, sideDepth(H * f) / 2);
      });
      const expected = bandExtreme(truth, band)!;
      const got = agg.measurements[name]!;
      expect(Math.abs(got.value_cm - expected.value)).toBeLessThan(1.5);
      expect(got.spread_cm).toBe(0); // identical frames
      expect(got.frames).toBe(2);
    }
    // waist minimum is at the designed 107 cm (61.1 %)
    expect(Math.abs(agg.measurements.waist_cm!.fraction! - 107 / H)).toBeLessThanOrEqual(0.006);
    expect(agg.measurements.shoulder_width_cm!.value_cm).toBeCloseTo(fm.shoulderWidthCm!, 10);
    expect(agg.measurements.arm_length_cm!.frames).toBe(3);
  });

  it('reports why a girth is missing instead of inventing it', () => {
    const merged = {
      ...fm,
      widthsCm: fm.widthsCm.map(() => NaN),
      mergedBins: fm.mergedBins.map(() => true),
    };
    const agg = aggregateScan([merged], [sm]);
    expect(agg.measurements.chest_cm).toBeUndefined();
    expect(agg.missing.chest_cm).toMatch(/arms touched the torso/);
    const noSide = aggregateScan([fm], []);
    expect(noSide.missing.waist_cm).toMatch(/side depth/);
  });

  it('per-frame spread reflects frame-to-frame variation', () => {
    const wider = { ...fm, widthsCm: fm.widthsCm.map((w) => w + 1) };
    const agg = aggregateScan([fm, wider, fm, wider], [sm]);
    expect(agg.measurements.waist_cm!.spread_cm).toBeGreaterThan(0);
  });
});
