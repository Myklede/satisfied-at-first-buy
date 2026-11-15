import { describe, expect, it } from 'vitest';
import type { ImageLandmark } from '../../contract';
import {
  exposureFromFace,
  faceSkinColour,
  liftFromP1,
  luminance,
  lumaPercentile,
  noiseSigma,
  plausibleSkin,
  whiteBalanceGains,
} from './colour';
import {
  CLASS,
  EXPOSURE_AT_REF,
  EXPOSURE_RANGE,
  FACE_Y_REF,
  LIFT_MAX,
  SKIN_CHROMA,
  WB_GAIN_RANGE,
  WB_STRENGTH,
} from './config';
import {
  faceBox,
  finishGeometry,
  frontal,
  inArm,
  inConvexQuad,
  regionAt,
  sleeveEnd,
  upperBodyRect,
  type Vec2,
} from './geometry';
import { coverageFromMetric, downsampleSize, packClasses, packPerson, staleScores } from './masks';

/** A facing person in a 960×540 frame, shoulder span 200 px (BlazePose indices). */
function person(overrides: Record<number, [number, number]> = {}): ImageLandmark[] {
  const pts: Record<number, [number, number]> = {
    0: [480, 100], // nose
    2: [468, 90],
    3: [460, 90],
    5: [492, 90],
    6: [500, 90],
    7: [450, 95],
    8: [510, 95],
    9: [488, 120],
    10: [472, 120],
    11: [580, 180], // left shoulder (image right)
    12: [380, 180], // right shoulder
    13: [600, 290],
    14: [360, 290],
    15: [610, 390],
    16: [350, 390],
    23: [540, 400],
    24: [420, 400],
    ...overrides,
  };
  return Array.from({ length: 33 }, (_, i) =>
    pts[i] ? { x: pts[i][0], y: pts[i][1], visibility: 0.99 } : { x: 0, y: 0, visibility: 0 },
  );
}

describe('finish geometry (region of real clothing to cover)', () => {
  const g = finishGeometry(person())!;

  it('scales from the shoulder span and finds torso, arms, head, cuffs', () => {
    expect(g.span).toBeCloseTo(200, 6);
    expect(g.torso).not.toBeNull();
    expect(g.arms.every(Boolean)).toBe(true);
    expect(g.head).not.toBeNull();
    expect(g.cuffs.every(Boolean)).toBe(true);
  });

  it('covers the chest, the shoulder tops and the arms; not the face, background or hands', () => {
    const at = (x: number, y: number) => regionAt(g, [x, y], false);
    expect(at(480, 300).inside).toBe(true); // chest
    expect(at(600, 170).inside).toBe(true); // left shoulder top (above the landmark)
    expect(at(605, 340).inside).toBe(true); // left forearm
    expect(at(605, 340).armDir).not.toBeNull();
    // Above the shoulder, outside the torso quad's top: only the shoulder band (clothes class
    // only) holds it, up to 1.2 x the shoulder line -> chin distance; never the head.
    expect(at(580, 150).inside).toBe(true);
    expect(at(580, 150).bandOnly).toBe(true);
    expect(at(480, 300).bandOnly).toBe(false); // chest: any clothing
    expect(at(530, 120).bandOnly).toBe(true); // beside the face, below the band top
    expect(at(530, 90).inside).toBe(false); // above the band
    expect(at(490, 110).excluded).toBe('head');
    expect(at(480, 100).inside).toBe(false); // nose
    expect(at(480, 100).excluded).toBe('head');
    expect(at(480, 125).excluded).toBe('head'); // chin band (above the chin line)
    expect(at(150, 300).inside).toBe(false); // background beside the person
    expect(at(612, 420).inside).toBe(false); // the hand, beyond the flat wrist cut
    expect(at(480, 470).inside).toBe(false); // below the hips (trousers)
  });

  it('excludes the bare neck only without the class mask', () => {
    // Between the chin line (≈ 138) and the shoulder line (180), on the centre line.
    expect(regionAt(g, [480, 160], true).excluded).toBe('neck');
    expect(regionAt(g, [480, 160], false).inside).toBe(true);
    // Off the neck band, the shoulder tops still count without classes.
    expect(regionAt(g, [570, 165], true).inside).toBe(true);
  });

  it('needs both shoulders; no hips = arms only', () => {
    expect(
      finishGeometry(person({}).map((p, i) => (i === 12 ? { ...p, visibility: 0.1 } : p))),
    ).toBe(null);
    const noHips = finishGeometry(
      person().map((p, i) => (i === 23 || i === 24 ? { ...p, visibility: 0.1 } : p)),
    )!;
    expect(noHips.torso).toBeNull();
    expect(regionAt(noHips, [480, 300], false).inside).toBe(false);
    expect(regionAt(noHips, [605, 340], false).inside).toBe(true);
  });

  it('quad and capsule primitives', () => {
    const q: Vec2[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(inConvexQuad([5, 5], q)).toBe(true);
    expect(inConvexQuad([5, 5], [...q].reverse())).toBe(true);
    expect(inConvexQuad([11, 5], q)).toBe(false);
    const s = { a: [0, 0] as Vec2, b: [10, 0] as Vec2, radius: 2, flatEnd: true };
    expect(inArm([5, 1.9], s)).toBe(true);
    expect(inArm([11, 0], s)).toBe(false); // flat cap
    expect(inArm([11, 0], { ...s, flatEnd: false })).toBe(true); // round cap
    expect(inArm([-1, 0], s)).toBe(true); // round start
    expect(inArm([-1, 0], { ...s, flatStart: true })).toBe(false); // flat at the shoulder
  });

  it('assigns the hand capsules to the nearer wrist', () => {
    const g2 = finishGeometry(person(), [{ a: [350, 392], b: [345, 440], radius: 20 }])!;
    expect(g2.hands[0]).toBeNull();
    expect(g2.hands[1]?.radius).toBe(20);
  });

  it('cuff depth follows the forearm foreshortening', () => {
    const inPlane = finishGeometry(person())!.cuffs[0]!; // forearm 101 px of 148 expected
    const toward = finishGeometry(person({ 15: [602, 300] }))!.cuffs[0]!; // 10 px: pointing at us
    expect(toward.depth).toBeGreaterThan(0.95);
    expect(inPlane.depth).toBeLessThan(0.8);
    expect(inPlane.depth).toBeGreaterThanOrEqual(0.2);
  });

  it('sleeve end: the far end of the first jacket run; unresolved when it runs on', () => {
    const c = { wrist: [0, 0] as Vec2, dir: [1, 0] as Vec2, halfWidth: 10, depth: 0.5 };
    expect(sleeveEnd(c, (x) => (x < 7 ? 1 : 0))).toBeGreaterThan(4);
    expect(sleeveEnd(c, (x) => (x < 7 ? 1 : 0))).toBeLessThan(7);
    expect(sleeveEnd(c, () => 1)).toBeNull(); // over other jacket (arms crossed)
    expect(sleeveEnd(c, () => 0)).toBeNull(); // no sleeve on the axis
  });
});

describe('finish masks', () => {
  it('downsamples the person mask by an integer step', () => {
    expect(downsampleSize(960, 540, 320)).toEqual({ step: 3, width: 320, height: 180 });
    const data = new Float32Array(8 * 4).fill(0);
    data[0] = 1;
    data[2] = 0.5;
    const out = packPerson({ data, width: 8, height: 4 }, 4);
    expect(out.width).toBe(4);
    expect(out.height).toBe(2);
    expect(out.data[0]).toBe(255);
    expect(out.data[1]).toBe(128);
    expect(packPerson({ data, width: 8, height: 4 }, 4, out)).toBe(out); // reused
  });

  it('packs categories into filterable channels (clothes, body skin, face/hair, person)', () => {
    const k = [CLASS.clothes, CLASS.others, CLASS.bodySkin, CLASS.background];
    const one = packClasses({ data: Uint8Array.from(k), width: 4, height: 1 }, 8);
    expect(Array.from(one.data.slice(0, 4))).toEqual([255, 0, 0, 255]); // clothes
    expect(Array.from(one.data.slice(4, 8))).toEqual([255, 0, 0, 255]); // others count as clothing
    expect(Array.from(one.data.slice(8, 12))).toEqual([0, 255, 0, 255]); // body skin
    expect(Array.from(one.data.slice(12, 16))).toEqual([0, 0, 0, 0]); // background
    // 2×2 blocks: a block half clothes, half face skin.
    const block = packClasses(
      {
        data: Uint8Array.from([CLASS.clothes, CLASS.faceSkin, CLASS.clothes, CLASS.hair]),
        width: 2,
        height: 2,
      },
      1,
    );
    expect(block.width).toBe(1);
    expect(Array.from(block.data)).toEqual([128, 0, 128, 255]);
  });

  it('scores a stale-mask render against the fresh mask of the same frame', () => {
    // px: [R ref clothing, G, B uncovered, A fill]
    const ref = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const test = Uint8Array.from([0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 0]);
    // Pixel 0: clothing left uncovered (missed); pixel 1: covered; pixel 2: fill on non-clothing.
    expect(staleScores(ref, test)).toEqual({ clothingPx: 2, missed: 0.5, wrongFill: 0.5 });
    expect(staleScores(new Uint8Array(8), new Uint8Array(8))).toBeNull();
  });

  it('reads coverage from the metric readback', () => {
    const px = Uint8Array.from([
      255,
      255,
      0,
      255, // clothing, uncovered before, covered after
      255,
      0,
      0,
      255, // clothing, covered both
      0,
      255,
      255,
      255, // not clothing: ignored
      255,
      255,
      255,
      255, // clothing, uncovered both
    ]);
    expect(coverageFromMetric(px)).toEqual({
      regionPx: 3,
      uncoveredBefore: 2 / 3,
      uncoveredAfter: 1 / 3,
    });
    expect(coverageFromMetric(new Uint8Array(8))).toBeNull();
  });
});

describe('finish colour match', () => {
  const srgb = (c: number) =>
    Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));

  it('white balance follows the light cast seen on the face, partially and clamped', () => {
    // A mild cool cast (face 5 % less red, 5 % more blue than the skin's own chroma).
    const face: [number, number, number] = [SKIN_CHROMA[0] * 0.95, 1, SKIN_CHROMA[1] * 1.05];
    const g = whiteBalanceGains(face);
    expect(luminance(g)).toBeCloseTo(1, 2);
    expect(g[0] / g[1]).toBeCloseTo(Math.pow(0.95, WB_STRENGTH), 3);
    expect(g[2] / g[1]).toBeCloseTo(Math.pow(1.05, WB_STRENGTH), 3);
    // A strong cast (cam-parka's face) moves the right way but stays within the clamp.
    const strong = whiteBalanceGains([1.43 * 0.15, 0.15, 0.799 * 0.15]);
    expect(strong[0]).toBeLessThan(strong[1]);
    expect(strong[2]).toBeGreaterThan(strong[1]);
    strong.forEach((c) => {
      expect(c).toBeGreaterThanOrEqual(WB_GAIN_RANGE[0]);
      expect(c).toBeLessThanOrEqual(WB_GAIN_RANGE[1]);
    });
    // A neutral light (face = skin chroma) leaves the jacket alone.
    const n = whiteBalanceGains([SKIN_CHROMA[0], 1, SKIN_CHROMA[1]]);
    n.forEach((c) => expect(c).toBeCloseTo(1, 6));
  });

  it('face reference: frontal only, box fully in frame', () => {
    const l = person();
    expect(frontal(l)).toBe(true);
    expect(faceBox(l, 960, 540)).not.toBeNull();
    // Head turned: the nose off the eyes' midpoint by > 0.25 eye spacings.
    expect(frontal(person({ 0: [492, 100] }))).toBe(false);
    // Face cut by the top of the frame: no reference.
    expect(
      faceBox(
        person({ 0: [480, 4], 2: [468, 2], 5: [492, 2], 9: [488, 20], 10: [472, 20] }),
        960,
        540,
      ),
    ).toBeNull();
  });

  it('upper-body box for the segmenter: landmarks 0–24 padded by 0.3 S, clamped', () => {
    const r = upperBodyRect(person(), 200, { width: 960, height: 540 })!;
    expect(r.x).toBeCloseTo(350 - 60, 6);
    expect(r.y).toBeCloseTo(90 - 60, 6);
    expect(r.x + r.w).toBeCloseTo(610 + 60, 6);
    expect(r.y + r.h).toBeCloseTo(400 + 60, 6);
    expect(upperBodyRect(null, 200, { width: 960, height: 540 })).toBeNull();
  });

  it('face reference must look like lit skin (rejects hood, hair, dark clothing)', () => {
    expect(plausibleSkin([0.39, 0.267, 0.198])).toBe(true); // cam-parka 2.5 s face
    expect(plausibleSkin([0.95, 1.0, 1.05])).toBe(false); // white hood (back view)
    expect(plausibleSkin([0.006, 0.0045, 0.004])).toBe(false); // dark hoodie, face cut off
    expect(plausibleSkin([0.08, 0.075, 0.07])).toBe(false); // grey, not reddish
  });

  it('exposure follows the face luminance, clamped', () => {
    expect(exposureFromFace(FACE_Y_REF)).toBeCloseTo(EXPOSURE_AT_REF, 6);
    expect(exposureFromFace(FACE_Y_REF * 2)).toBeGreaterThan(EXPOSURE_AT_REF);
    expect(exposureFromFace(100)).toBe(EXPOSURE_RANGE[1]);
    expect(exposureFromFace(0.001)).toBe(EXPOSURE_RANGE[0]);
    expect(exposureFromFace(0)).toBe(EXPOSURE_AT_REF); // unknown: unchanged
  });

  it('face skin: trimmed mean without classes, class pixels with', () => {
    const px = new Uint8Array(40 * 4);
    for (let i = 0; i < 40; i++) {
      const v = i < 10 ? 20 : i >= 38 ? 255 : 150; // eyes/brows dark, highlights bright
      px.set([v, v, v, 255], i * 4);
    }
    const trimmed = faceSkinColour(px)!;
    const lin150 = Math.pow((150 / 255 + 0.055) / 1.055, 2.4);
    expect(trimmed[0]).toBeCloseTo(lin150, 3);
    const onlyDark = faceSkinColour(px, (i) => i < 10)!;
    expect(srgb(onlyDark[0])).toBe(20);
    expect(faceSkinColour(px, () => false)).toBeNull();
  });

  it('black level and lift', () => {
    const px = new Uint8Array(100 * 4);
    for (let i = 0; i < 100; i++) px.set([i + 40, i + 40, i + 40, 255], i * 4);
    expect(lumaPercentile(px, 0.01)).toBeCloseTo(40 / 255, 2);
    expect(liftFromP1(40 / 255)).toBeCloseTo(0.8 * (40 / 255), 6);
    expect(liftFromP1(0.9)).toBe(LIFT_MAX);
  });

  it('noise σ (Immerkær) recovers a known σ and ignores a smooth gradient', () => {
    const W = 64,
      H = 64;
    const flat = new Uint8Array(W * H * 4);
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
    for (let i = 0; i < W * H; i++) {
      const v = Math.max(0, Math.min(255, 128 + 3 * gauss()));
      flat.set([v, v, v, 255], i * 4);
    }
    expect(noiseSigma(flat, W, H)).toBeGreaterThan(2.4);
    expect(noiseSigma(flat, W, H)).toBeLessThan(3.6);
    const ramp = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) ramp.set([x * 2, x * 2, x * 2, 255], (y * W + x) * 4);
    expect(noiseSigma(ramp, W, H)).toBeLessThan(0.05);
  });
});
