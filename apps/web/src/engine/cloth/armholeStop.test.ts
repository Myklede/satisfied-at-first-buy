import { describe, expect, it } from 'vitest';
import { applyArmholeStop, rebaseArmholeStop, type ArmholeStop } from './armholeStop.ts';

/** One seam particle (id 1) with its anchor at `anchor` and the humerus axis `axis`. */
function stop(anchor: number[], axis: number[]): ArmholeStop {
  return {
    ids: Uint32Array.of(1),
    anchors: Float64Array.from(anchor),
    axis: Float64Array.from(axis),
    offsets: new Float64Array(1),
  };
}

describe('armhole stop', () => {
  it('is a no-op on the rest state and while the arm hangs (the seam may sag distally)', () => {
    // Arm down: axis points down (-Y). Seam at the armpit, 1 cm from its anchor.
    const positions = Float64Array.of(9, 9, 9, 0.2, 1.3, 0, 7, 7, 7);
    const s = stop([0.21, 1.3, 0], [0, -1, 0]);
    rebaseArmholeStop(s, positions);
    const before = positions.slice();
    expect(applyArmholeStop(s, positions, [1, 1, 1])).toBe(0);
    expect(positions).toEqual(before);
    positions[4] -= 0.02; // the coat sags 2 cm (distal along a hanging arm): allowed
    expect(applyArmholeStop(s, positions, [1, 1, 1])).toBe(0);
    expect(positions[4]).toBeCloseTo(1.28, 12);
  });

  it('keeps the seam with the armpit when the arm rises (the coat is carried up)', () => {
    const positions = Float64Array.of(0, 0, 0, 0.2, 1.3, 0);
    const s = stop([0.2, 1.3, 0], [0, -1, 0]);
    rebaseArmholeStop(s, positions); // offset 0
    // Arm overhead: the armpit point moved up 12 cm, the axis now points up (+Y).
    s.anchors.set([0.2, 1.42, 0]);
    s.axis.set([0, 1, 0]);
    const push = applyArmholeStop(s, positions, [1, 1]);
    expect(push).toBeCloseTo(0.12, 12);
    expect(positions[4]).toBeCloseTo(1.42, 12); // lifted with the armpit
    expect(positions[3]).toBe(0.2); // only along the axis
    // Already beyond the armpit (distal): untouched.
    positions[4] = 1.5;
    expect(applyArmholeStop(s, positions, [1, 1])).toBe(0);
    expect(positions[4]).toBe(1.5);
  });

  it('can push toward the arm-carried anchor instead of along the axis, never past it', () => {
    const positions = Float64Array.of(0, 0, 0, 0.25, 1.3, 0);
    const s = stop([0.25, 1.3, 0], [0, -1, 0]);
    rebaseArmholeStop(s, positions);
    s.direction = 'anchor';
    // Arm raised: the anchor (outside the body) is 10 cm higher and 5 cm further out.
    s.anchors.set([0.3, 1.4, 0]);
    s.axis.set([0, 1, 0]);
    applyArmholeStop(s, positions, [1, 1]);
    expect(positions[4]).toBeCloseTo(1.4, 12); // the violation is removed...
    expect(positions[3]).toBeCloseTo(0.3, 12); // ...by moving to the anchor, not into the body
    s.stiffness = 0.5;
    positions.set([0.25, 1.3, 0], 3);
    applyArmholeStop(s, positions, [1, 1]);
    expect(positions[4]).toBeCloseTo(1.35, 12); // compliant: half the violation per call
  });

  it('leaves pinned particles alone', () => {
    const positions = Float64Array.of(0, 0, 0, 0.2, 1.3, 0);
    const s = stop([0.2, 1.3, 0], [0, 1, 0]);
    s.anchors.set([0.2, 1.4, 0]);
    expect(applyArmholeStop(s, positions, [1, 0])).toBe(0);
    expect(positions[4]).toBe(1.3);
  });
});

describe('long-range attachments from the armhole stop', () => {
  // A 1×4 strip of particles 10 cm apart along -Y, source at the top (id 0).
  const strip = () => Float64Array.of(0, 1, 0, 0, 0.9, 0, 0, 0.8, 0, 0, 0.7, 0);
  const edges = [0, 1, 1, 2, 2, 3];

  it('measures geodesic distances to the nearest source along the cloth', async () => {
    const { buildGeodesicTethers } = await import('./armholeStop.ts');
    const t = buildGeodesicTethers(edges, strip(), [0], [1, 2, 3], 1.03);
    expect(Array.from(t.children)).toEqual([1, 2, 3]);
    expect(Array.from(t.sources)).toEqual([0, 0, 0]);
    expect(t.lengths[2]).toBeCloseTo(0.3 * 1.03, 12);
  });

  it('is a no-op at rest and pulls the panel up with a lifted source, in one pass', async () => {
    const { buildGeodesicTethers, applyArmholeTethers } = await import('./armholeStop.ts');
    const p = strip();
    const t = buildGeodesicTethers(edges, p, [0], [1, 2, 3], 1.03);
    const before = p.slice();
    applyArmholeTethers(t, p, [1, 1, 1, 1]);
    expect(p).toEqual(before);
    p[1] = 1.2; // the seam is lifted 20 cm
    applyArmholeTethers(t, p, [1, 1, 1, 1]);
    // The last particle is now within 0.309 m of the lifted seam (was 0.3 m below the old one).
    expect(1.2 - p[10]).toBeCloseTo(0.309, 9);
    expect(p[10]).toBeGreaterThan(0.85);
  });
});

describe('vertical long-range attachments', () => {
  it('only lift a child that hangs lower than its source allows, and never move it sideways', async () => {
    const { applyArmholeTethers } = await import('./armholeStop.ts');
    // Source at y 1.2 (lifted seam); child 0.5 m lower and 0.3 m behind (across the torso).
    const p = Float64Array.of(0, 1.2, 0, 0, 0.7, -0.3);
    const tethers = {
      children: Uint32Array.of(1),
      sources: Uint32Array.of(0),
      lengths: Float64Array.of(0.4),
      mode: 'vertical' as const,
    };
    applyArmholeTethers(tethers, p, [1, 1]);
    expect(p[4]).toBeCloseTo(0.8, 12); // lifted to 1.2 - 0.4
    expect(p[3]).toBe(0);
    expect(p[5]).toBe(-0.3); // not pulled toward the source through the body
    applyArmholeTethers(tethers, p, [1, 1]);
    expect(p[4]).toBeCloseTo(0.8, 12); // satisfied: no-op
  });
});
