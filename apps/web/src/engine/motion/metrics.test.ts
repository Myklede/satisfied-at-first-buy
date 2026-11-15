import { describe, expect, it } from 'vitest';
import {
  cuffBeyondWrist,
  exposedMask,
  hemAbove,
  hemAboveWaistband,
  restriction,
  summarise,
  summarySentence,
  type FrameAnchors,
  type FrameMetrics,
  type GarmentTopology,
} from './metrics';

// Synthetic geometry only: a horizontal hem circle of radius 0.15 m at height h around the
// Y axis, and a waistband ring of radius 0.14 m at height 0.93 m (32 points, 0 = front +Z).
function hemCircle(h: number, n = 96, tilt = 0) {
  const positions = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    positions[i * 3] = 0.15 * Math.sin(a);
    positions[i * 3 + 1] = h + tilt * Math.cos(a); // tilt > 0: front higher than back
    positions[i * 3 + 2] = 0.15 * Math.cos(a);
  }
  return positions;
}
function ring(h: number) {
  const points = new Float64Array(96),
    up = new Float64Array(96);
  for (let i = 0; i < 32; i++) {
    const a = (2 * Math.PI * i) / 32;
    points.set([0.14 * Math.sin(a), h, 0.14 * Math.cos(a)], i * 3);
    up.set([0, 1, 0], i * 3);
  }
  return { points, up };
}
const topology = (n = 96): GarmentTopology => ({
  hem: Uint32Array.from({ length: n }, (_, i) => i),
  cuff: { L: Uint32Array.of(0, 1, 2), R: Uint32Array.of(3, 4, 5) },
  zone: new Uint8Array(n),
  edgeLimit: new Float32Array(0),
});
const anchors = (): FrameAnchors => ({
  rings: { low: ring(0.88), mid: ring(0.93), high: ring(0.98) },
  points: new Float64Array(12),
  joints: new Float64Array(12),
});

describe('hem height against the waistband', () => {
  it('measures (hem − ring)·up at the vertical line through each ring point', () => {
    const values = hemAboveWaistband(topology(), hemCircle(0.9), anchors());
    for (const v of values.mid) expect(v).toBeCloseTo(-3, 6); // hem 3 cm below mid: covered
    for (const v of values.low) expect(v).toBeCloseTo(2, 6); // 2 cm above the low waistband
  });
  it('front rides up more than back when the hem tilts', () => {
    const values = hemAboveWaistband(topology(), hemCircle(0.93, 96, 0.04), anchors());
    expect(values.mid[0]).toBeCloseTo(4, 1); // front: +4 cm
    expect(values.mid[16]).toBeCloseTo(-4, 1); // back: −4 cm (covered)
    expect(Math.abs(values.mid[8])).toBeLessThan(0.1); // sides
  });
  it('ignores hem points far from the line', () => {
    const p = hemCircle(0.9);
    expect(hemAbove(Uint32Array.of(0, 1, 2), p, 0, 0.93, -0.14, 0, 1, 0)).toBeNull();
  });
  it('exposed-skin mask: vertices below a raised hem are exposed', () => {
    const p = hemCircle(1.0);
    const skin = Float64Array.of(0, 0.95, 0.14, 0, 1.05, 0.14),
      up = Float64Array.of(0, 1, 0, 0, 1, 0),
      out = new Uint8Array(2);
    expect(exposedMask(topology(), p, skin, up, out)).toBe(1);
    expect(Array.from(out)).toEqual([1, 0]);
  });
});

describe('wrist and restriction', () => {
  it('cuff centroid along the forearm minus the wrist landmark', () => {
    const positions = new Float64Array(18);
    // Left cuff ring around (0.3, 0.80, 0); right cuff at (−0.3, 0.86, 0).
    for (let i = 0; i < 3; i++) positions.set([0.3, 0.8, 0], i * 3);
    for (let i = 3; i < 6; i++) positions.set([-0.3, 0.86, 0], i * 3);
    const a = anchors();
    // Forearms point down: elbow at 1.05, wrist joint at 0.85, wrist landmark at 0.84.
    a.joints = Float64Array.of(0.3, 0.85, 0, -0.3, 0.85, 0, 0.3, 1.05, 0, -0.3, 1.05, 0);
    a.points = Float64Array.of(0.3, 0.84, 0, -0.3, 0.84, 0, 0.3, 1.05, 0, -0.3, 1.05, 0);
    const r = cuffBeyondWrist(topology(), positions, a);
    expect(r.L).toBeCloseTo(4, 6); // 4 cm past the wrist: covered
    expect(r.R).toBeCloseTo(-2, 6); // 2 cm above it: wrist shows
  });
  it('counts edges within the slack of their limit per zone', () => {
    const t: GarmentTopology = {
      ...topology(4),
      zone: Uint8Array.of(0, 0, 3, 3),
      edgeLimit: Float32Array.of(0.03, 0.03),
    };
    const zones = restriction(t, Uint32Array.of(0, 1, 2, 3), Float32Array.of(0.0295, 0.01));
    expect(zones[0]).toEqual({ atLimit: 1, edges: 1, peakStrain: expect.closeTo(0.0295, 6) });
    expect(zones[3].atLimit).toBe(0);
  });
});

describe('summary', () => {
  const frame = (front: number, back: number, wrist: number): FrameMetrics => {
    const values = new Float32Array(32).fill(-5);
    values[0] = front;
    values[16] = back;
    return {
      hemAboveCm: { low: values, mid: values, high: values },
      cuffBeyondWristCm: { L: wrist, R: wrist },
      zones: Array.from({ length: 7 }, () => ({ atLimit: 0, edges: 10, peakStrain: 0.01 })),
    };
  };
  it('peaks, ride-up and a sentence built from the numbers', () => {
    const s = summarise('S', [frame(-3, -4, 2), frame(6.1, 1.2, -1.5), frame(-2, -4, 1)]);
    expect(s.exposure.mid.front).toBeCloseTo(6.1, 5);
    expect(s.exposure.mid.back).toBeCloseTo(1.2, 5);
    expect(s.neutralExposure.mid.any).toBe(0);
    expect(s.wrist.L.rideUp).toBeCloseTo(3.5, 6);
    expect(s.wrist.L.exposed).toBeCloseTo(1.5, 6);
    expect(s.peakFrame).toBe(1);
    const m = summarise('M', [frame(-5, -6, 3), frame(0.8, -1, 1), frame(-5, -6, 3)]);
    expect(summarySentence('Reach up with both arms', 'mid', [s, m])).toBe(
      'Reach up with both arms: belly exposed at the front: S 6.1 cm, M 0.8 cm; lower back: S 1.2 cm, M 0.0 cm. ' +
        'S sleeve rides 3.5 cm and shows 1.5 cm of wrist; M sleeve rides 2.0 cm, wrist covered.',
    );
  });
});
