import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRAB_MODEL,
  flexion,
  fromHandLocal,
  grabSignal,
  gripFeatures,
  handFrame2d,
  naturalGripPoint,
  pointSegment,
  toHandLocal,
  validateGrabModel,
} from './grip';
import { DEFAULT_PINCH_TUNING } from './pinch';
import { synthHandIso } from './syntheticHand';
import type { SynthHandSpec } from './syntheticHand';

const at = { u: 0.9, v: 0.5, scale: 0.15 };
const POSES: Record<string, Omit<SynthHandSpec, 'u' | 'v' | 'scale'>> = {
  tipPinch: { curl: 0.45, thumb: { kind: 'tip', gap: 0.12 } },
  // Real key grips curl the index too (labelled index tip->palm median 0.56).
  keyGrip: { curl: 1.0, indexCurl: 0.85, thumb: { kind: 'side', gap: 0.08 } },
  // Pointing: index out, other fingers curled, thumb resting along the index (05-12-03).
  pointing: { curl: 1.0, indexCurl: 0.1, thumb: { kind: 'side', gap: 0.08 } },
  fistThumbOver: { curl: 1.0, indexCurl: 1.0, thumb: { kind: 'side', gap: 0.05 } },
  fistThumbAway: { curl: 1.0, indexCurl: 1.0, thumb: { kind: 'away' } },
  relaxedThumbSide: { curl: 0.6, indexCurl: 0.5, thumb: { kind: 'side', gap: 0.15 } },
  openFlat: { curl: 0.05, thumb: { kind: 'away' } },
  thumbOffCurled: { curl: 1.0, indexCurl: 0.55, thumb: { kind: 'away' } },
};
const signal = (name: string) => {
  const iso = synthHandIso({ ...at, ...POSES[name] });
  return { iso, f: gripFeatures(iso, iso), s: grabSignal(gripFeatures(iso, iso)) };
};
const { enterRatio, exitRatio, openRatio } = DEFAULT_PINCH_TUNING;

describe('geometry helpers', () => {
  it('flexion is 0 for a straight chain and π/2 for a right angle', () => {
    const a = { x: 0, y: 0, z: 0 };
    expect(flexion(a, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 })).toBeCloseTo(0, 12);
    expect(flexion(a, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 })).toBeCloseTo(Math.PI / 2, 12);
  });

  it('pointSegment clamps to the segment ends', () => {
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 2, y: 0, z: 0 };
    expect(pointSegment({ x: 1, y: 1, z: 0 }, a, b)).toEqual({ d: 1, t: 0.5 });
    expect(pointSegment({ x: 3, y: 0, z: 0 }, a, b)).toEqual({ d: 1, t: 1 });
  });

  it('hand-local coordinates round-trip and follow translation, rotation and scale', () => {
    const iso = synthHandIso({ ...at, ...POSES.tipPinch });
    const f = handFrame2d(iso);
    const p: [number, number] = [0.83, 0.31];
    const local = toHandLocal(p, f);
    expect(fromHandLocal(local, f)[0]).toBeCloseTo(p[0], 12);
    // Rotate the whole hand 30° about the origin, scale ×1.5 and translate: same local point
    // must land on the transformed original point.
    const c = Math.cos(Math.PI / 6) * 1.5;
    const s = Math.sin(Math.PI / 6) * 1.5;
    const T = (q: { x: number; y: number; z: number }) => ({
      x: c * q.x - s * q.y + 0.2,
      y: s * q.x + c * q.y - 0.1,
      z: q.z * 1.5,
    });
    const moved = fromHandLocal(local, handFrame2d(iso.map(T)));
    const expected = T({ x: p[0], y: p[1], z: 0 });
    expect(moved[0]).toBeCloseTo(expected.x, 10);
    expect(moved[1]).toBeCloseTo(expected.y, 10);
  });
});

describe('grip features and grab signal (provisional model)', () => {
  it('tip pinch: tip ratio = gap, grip "pinch", closed', () => {
    const { f, s } = signal('tipPinch');
    expect(f.tipRatio).toBeCloseTo(0.12, 6);
    expect(s.grip).toBe('pinch');
    expect(s.openness).toBeLessThan(enterRatio);
  });

  it('key grip: tip ratio reads half-open but thumb-to-index is small -> closed "lateral"', () => {
    const { f, s } = signal('keyGrip');
    expect(f.tipRatio).toBeGreaterThan(enterRatio);
    expect(f.thumbToIndex).toBeLessThan(0.15);
    expect(f.occludedThumb2d).toBeLessThan(0.2); // thumb tip behind the index in 2D
    expect(s.grip).toBe('lateral');
    expect(s.openness).toBeLessThan(enterRatio);
  });

  it('fist is closed with the thumb over the fingers, open once the thumb lifts away', () => {
    expect(signal('fistThumbOver').s.openness).toBeLessThan(enterRatio);
    // 05-09-55: the user released a key grip by lifting the thumb with all fingers still curled.
    expect(signal('fistThumbAway').s.openness).toBeGreaterThan(exitRatio);
  });

  it('pointing (index out, others curled, thumb along the index) is NOT a grab', () => {
    const { f, s } = signal('pointing');
    expect(f.thumbToIndex).toBeLessThan(0.25); // looks like a key grip by the thumb alone...
    // ...but the index is extended, so it never reaches the grab level (real pointing, index
    // tip->palm ~0.98, reads ~0.5; this synthetic index ~0.85 reads ~0.35).
    expect(s.openness).toBeGreaterThan(enterRatio);
  });

  it('a thumb tucked into the palm engages a fist', () => {
    const iso = synthHandIso({ ...at, ...POSES.fistThumbAway });
    const palm = [0, 5, 9, 13, 17].reduce(
      (c, i) => ({ x: c.x + iso[i].x / 5, y: c.y + iso[i].y / 5, z: c.z + iso[i].z / 5 }),
      { x: 0, y: 0, z: 0 },
    );
    iso[4] = { x: palm.x - 0.02, y: palm.y, z: palm.z - 0.05 }; // thumb tip over the palm centre
    // Same curled hand with the thumb away is open (> exit); tucked, it is back below exit.
    expect(signal('fistThumbAway').s.openness).toBeGreaterThan(exitRatio);
    expect(grabSignal(gripFeatures(iso, iso)).openness).toBeLessThan(exitRatio);
  });

  it('relaxed hand with the thumb resting along the index is NOT closed', () => {
    const { f, s } = signal('relaxedThumbSide');
    expect(f.thumbToIndex).toBeLessThan(0.2); // the overlap seen in the recordings...
    expect(s.openness).toBeGreaterThan(enterRatio); // ...resolved by finger extension
  });

  it('flat open hand is a decisive open; thumb-off with curled fingers is open but not decisive', () => {
    const open = signal('openFlat').s;
    expect(open.openness).toBeGreaterThan(openRatio);
    expect(open.extension).toBeGreaterThan(openRatio);
    const thumbOff = signal('thumbOffCurled').s;
    expect(thumbOff.openness).toBeGreaterThan(exitRatio);
    expect(thumbOff.extension).toBeLessThan(openRatio);
  });

  it('thumb in front of the index gives no occlusion cue', () => {
    const iso = synthHandIso({ ...at, ...POSES.keyGrip });
    iso[4] = { ...iso[4], z: iso[4].z - 0.2 }; // move the thumb tip toward the camera
    expect(gripFeatures(iso, iso).occludedThumb2d).toBe(Infinity);
  });

  it('the natural grip point is the tip midpoint for a pinch and moves continuously', () => {
    const iso = synthHandIso({ ...at, ...POSES.tipPinch });
    const [x, y] = naturalGripPoint(iso);
    expect(x).toBeCloseTo((iso[4].x + iso[8].x) / 2, 10);
    expect(y).toBeCloseTo((iso[4].y + iso[8].y) / 2, 10);
    // Slide the thumb tip from the index tip down the side of the finger: no jumps.
    let prev: [number, number] | undefined;
    for (let k = 0; k <= 40; k++) {
      const h = synthHandIso({ ...at, ...POSES.tipPinch });
      const t = k / 40;
      h[4] = {
        x: h[8].x + (h[6].x - h[8].x) * t - 0.02,
        y: h[8].y + (h[6].y - h[8].y) * t,
        z: h[8].z + (h[6].z - h[8].z) * t,
      };
      const p = naturalGripPoint(h);
      if (prev) expect(Math.hypot(p[0] - prev[0], p[1] - prev[1])).toBeLessThan(0.01);
      prev = p;
    }
  });

  it('confidence: visible contact and tight fists are clear; hidden thumb contact is ambiguous', () => {
    expect(signal('tipPinch').s.confidence).toBe('clear');
    expect(signal('fistThumbOver').s.confidence).toBe('clear');
    // World landmarks claim contact, but in the image the thumb tip is far behind the index.
    const world = synthHandIso({ ...at, ...POSES.tipPinch });
    // Thumb tip pushed 1 hand size away from the camera: gap ~0.5 (real hallucinations 0.43–0.71).
    const image = world.map((l, i) => (i === 4 ? { ...l, z: l.z + at.scale * 1.0 } : l));
    const g = gripFeatures(world, image);
    expect(g.thumbIndexImageGap).toBeGreaterThan(DEFAULT_GRAB_MODEL.clearContactGap);
    const s = grabSignal(g);
    expect(s.openness).toBeLessThan(enterRatio);
    expect(s.confidence).toBe('ambiguous');
  });

  it('validates the model', () => {
    expect(() => validateGrabModel(DEFAULT_GRAB_MODEL)).not.toThrow();
    expect(() => validateGrabModel({ ...DEFAULT_GRAB_MODEL, curlGain: 0 })).toThrow(RangeError);
  });
});
