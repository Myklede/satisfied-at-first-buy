import { describe, expect, it } from 'vitest';
import {
  ArmDepthOrder,
  FarArm,
  ORDER,
  PairOrder,
  SegmentOrder,
  SleeveTakeover,
  TAKEOVER,
  armEvidence,
  boneGroup,
  drawPlan,
  f3xEnabled,
  frontScore,
  passOccluderIndex,
  segmentDistance,
  torsoOverlap,
  type Pt,
} from './armOccluder';

describe('F3X flag', () => {
  it('is on only for ?f3x=1', () => {
    expect(f3xEnabled('?f3x=1')).toBe(true);
    expect(f3xEnabled('?still=1&f3x=1')).toBe(true);
    expect(f3xEnabled('')).toBe(false);
    expect(f3xEnabled('?f3x=0')).toBe(false);
    expect(f3xEnabled('?f3arms=1')).toBe(false);
  });
});

describe('per-layer body occluders', () => {
  it('groups the rig bones', () => {
    expect(boneGroup('upperarm01.L')).toBe('armL');
    expect(boneGroup('lowerarm02.R')).toBe('armR');
    expect(boneGroup('spine03')).toBe('trunk');
    expect(boneGroup('clavicle.L')).toBe('trunk');
    expect(boneGroup('shoulder01.R')).toBe('trunk');
    expect(boneGroup('neck01')).toBe('head');
    expect(boneGroup('head')).toBe('head');
    expect(boneGroup('wrist.L')).toBe('none');
    expect(boneGroup('upperleg01.R')).toBe('none');
  });

  // 8 vertices: 0–2 spine, 3 left forearm, 4 half spine / half left upper arm, 5 right upper
  // arm, 6 head, 7 a finger.
  const rig = {
    bones: ['spine01', 'lowerarm01.L', 'upperarm01.L', 'upperarm01.R', 'head', 'finger2-1.L'],
    influences: 2,
    vertexCount: 8,
    skinIndices: Uint16Array.from([0, 0, 0, 0, 0, 0, 1, 1, 0, 2, 3, 3, 4, 4, 5, 5]),
    skinWeights: Float32Array.from([1, 0, 1, 0, 1, 0, 1, 0, 0.5, 0.5, 1, 0, 1, 0, 1, 0]),
    faces: Uint32Array.from([0, 1, 2, 0, 1, 4, 3, 4, 4, 5, 5, 5, 6, 6, 6, 3, 7, 7, 0, 3, 1]),
  };

  it('never lets an arm hide the torso layer', () => {
    // Triangles of spine vertices (and the shoulder vertex 4), and the head; none with an arm.
    expect(Array.from(passOccluderIndex(rig, 'torso'))).toEqual([0, 1, 2, 0, 1, 4, 6, 6, 6]);
  });

  it('lets only its own arm and the head hide a sleeve layer', () => {
    expect(Array.from(passOccluderIndex(rig, 'sleeveL'))).toEqual([3, 4, 4, 6, 6, 6]);
    expect(Array.from(passOccluderIndex(rig, 'sleeveR'))).toEqual([5, 5, 5, 6, 6, 6]);
  });
});

/** A facing person: shoulders at y 100, hips at y 300, 120 px wide (image px). */
const torso: Pt[] = [
  [260, 100],
  [140, 100],
  [150, 300],
  [250, 300],
];

/** 33 landmarks with the torso above and the given arm joints; world z per landmark. */
function pose(arms: {
  L: { e: Pt; w: Pt; ez?: number; wz?: number; vis?: number };
  R: { e: Pt; w: Pt; ez?: number; wz?: number; vis?: number };
}) {
  const l = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0.9 }));
  const world = Array.from({ length: 33 }, () => ({ z: 0 }));
  const set = (i: number, p: Pt, vis = 0.95, z = 0) => {
    l[i] = { x: p[0], y: p[1], visibility: vis };
    world[i] = { z };
  };
  set(11, torso[0]);
  set(12, torso[1]);
  set(24, torso[2]);
  set(23, torso[3]);
  set(13, arms.L.e, arms.L.vis, arms.L.ez);
  set(15, arms.L.w, arms.L.vis, arms.L.wz);
  set(14, arms.R.e, arms.R.vis, arms.R.ez);
  set(16, arms.R.w, arms.R.vis, arms.R.wz);
  return { l, world };
}

const down = {
  L: { e: [275, 200] as Pt, w: [280, 290] as Pt },
  R: { e: [125, 200] as Pt, w: [120, 290] as Pt },
};
/** Both forearms folded across the chest, 20 cm in front of it. */
const crossed = {
  L: { e: [270, 210] as Pt, w: [170, 190] as Pt, ez: -0.08, wz: -0.2 },
  R: { e: [130, 210] as Pt, w: [230, 195] as Pt, ez: -0.08, wz: -0.22 },
};
/** Hands behind the back: wrists over the torso, farther than it, hardly visible. */
const behind = {
  L: { e: [275, 220] as Pt, w: [215, 270] as Pt, ez: 0.05, wz: 0.18, vis: 0.2 },
  R: { e: [125, 220] as Pt, w: [185, 270] as Pt, ez: 0.05, wz: 0.18, vis: 0.2 },
};

describe('order evidence', () => {
  it('measures the share of a segment over the torso', () => {
    expect(torsoOverlap([275, 200], [280, 290], torso)).toBe(0);
    expect(torsoOverlap([270, 210], [170, 190], torso)).toBeGreaterThanOrEqual(0.8);
    expect(segmentDistance([0, 0], [10, 10], [0, 10], [10, 0])).toBe(0);
    expect(segmentDistance([0, 0], [10, 0], [0, 5], [10, 5])).toBe(5);
  });

  it('has no opinion on a segment beside the torso', () => {
    expect(frontScore({ overlap: 0, dz: -1, visibility: 0 })).toBeNull();
    const { l, world } = pose(down);
    expect(frontScore(armEvidence(l, world, 'L')!.fore)).toBeNull();
  });

  it('reads a visible forearm across the chest as in front, a hidden far one as behind', () => {
    const c = pose(crossed);
    expect(frontScore(armEvidence(c.l, c.world, 'L')!.fore)).toBeGreaterThan(0.7);
    expect(frontScore(armEvidence(c.l, c.world, 'R')!.fore)).toBeGreaterThan(0.7);
    const b = pose(behind);
    expect(frontScore(armEvidence(b.l, b.world, 'L')!.fore)).toBeLessThan(ORDER.toBehind);
  });

  it('keeps a clearly visible arm in front whatever the depth says', () => {
    // MediaPipe's z can be wrong by more than the saturation depth; visibility 0.95 still wins.
    expect(frontScore({ overlap: 1, dz: -1, visibility: 0.95 })).toBeGreaterThan(ORDER.toBehind);
  });

  it('falls back on the visibility without world landmarks', () => {
    const c = pose(crossed);
    expect(frontScore(armEvidence(c.l, null, 'L')!.fore)).toBeGreaterThan(0);
  });
});

describe('order hysteresis', () => {
  it('ignores a short burst of contrary evidence', () => {
    const s = new SegmentOrder();
    let flips = 0,
      last = s.state;
    for (let i = 0; i < 90; i++) {
      // In front, with two bad frames (66 ms) in every ten.
      const score = i % 10 >= 8 ? -1 : 0.8;
      const now = s.update(score, i * 33);
      if (now !== last) flips++;
      last = now;
    }
    expect(flips).toBe(0);
    expect(s.state).toBe('front');
  });

  it('goes behind on sustained evidence and comes back, never faster than the dwell', () => {
    const s = new SegmentOrder();
    const flips: number[] = [];
    let last = s.update(0.8, 0);
    const feed = (score: number | null, from: number, to: number) => {
      for (let t = from; t < to; t += 33) {
        const now = s.update(score, t);
        if (now !== last) flips.push(t);
        last = now;
      }
    };
    feed(-0.8, 33, 1000);
    expect(s.state).toBe('behind');
    feed(0.8, 1000, 2000);
    expect(s.state).toBe('front');
    expect(flips.length).toBe(2);
    expect(flips[1] - flips[0]).toBeGreaterThanOrEqual(ORDER.dwellMs);
  });

  it('returns to the front when the segment leaves the torso', () => {
    const s = new SegmentOrder();
    for (let t = 0; t < 1000; t += 33) s.update(-0.9, t);
    expect(s.state).toBe('behind');
    for (let t = 1000; t < 3000; t += 33) s.update(null, t);
    expect(s.state).toBe('front');
  });

  it('adopts the first frame, and starts over when the clip restarts', () => {
    const s = new SegmentOrder();
    expect(s.update(-0.9, 5000)).toBe('behind');
    expect(s.update(0.9, 0)).toBe('front');
  });

  it('keeps the forearm pair order without evidence and against noise', () => {
    const p = new PairOrder();
    expect(p.update(null, 0)).toBe('R');
    // Left clearly nearer for a second: the left forearm goes on top.
    for (let t = 33; t < 1200; t += 33) p.update(-0.15, t);
    expect(p.top).toBe('L');
    let flips = 0;
    for (let i = 0; i < 60; i++) {
      const before = p.top;
      // ±4 cm noise round zero, and gaps without evidence.
      p.update(i % 7 === 0 ? null : i % 2 ? 0.04 : -0.04, 1200 + i * 33);
      if (p.top !== before) flips++;
    }
    expect(flips).toBe(0);
  });
});

describe('ArmDepthOrder', () => {
  it('draws both sleeves over the torso for arms down and crossed arms', () => {
    const o = new ArmDepthOrder();
    for (const arms of [down, crossed]) {
      const { l, world } = pose(arms);
      const order = o.update({ landmarks: l, world, tMs: 0, bandPx: 30 });
      expect(order.L).toEqual({ upper: 'front', fore: 'front' });
      expect(order.R).toEqual({ upper: 'front', fore: 'front' });
    }
  });

  it('puts the forearms under the torso for hands behind the back', () => {
    const o = new ArmDepthOrder();
    const { l, world } = pose(behind);
    let order = o.update({ landmarks: l, world, tMs: 0 });
    for (let t = 33; t < 600; t += 33) order = o.update({ landmarks: l, world, tMs: t });
    expect(order.L.fore).toBe('behind');
    expect(order.R.fore).toBe('behind');
  });

  it('does not flip once in 60 frames of crossed arms with noisy depth', () => {
    const o = new ArmDepthOrder();
    let flips = 0;
    let last = '';
    for (let i = 0; i < 60; i++) {
      // The wrists' depth jumps ±15 cm frame to frame (worse than MediaPipe on the venue clip).
      const jitter = (i % 2 ? 1 : -1) * 0.15;
      const { l, world } = pose({
        L: { ...crossed.L, wz: -0.2 + jitter },
        R: { ...crossed.R, wz: -0.22 - jitter },
      });
      const order = o.update({ landmarks: l, world, tMs: i * 33, bandPx: 30 });
      const key = JSON.stringify(order);
      if (last && key !== last) flips++;
      last = key;
      expect(order.L.fore).toBe('front');
      expect(order.R.fore).toBe('front');
    }
    expect(flips).toBe(0);
  });

  it('holds everything while the person is still', () => {
    const o = new ArmDepthOrder();
    const c = pose(crossed);
    const before = o.update({ landmarks: c.l, world: c.world, tMs: 0, bandPx: 30 });
    const b = pose(behind);
    for (let t = 33; t < 2000; t += 33)
      expect(o.update({ landmarks: b.l, world: b.world, tMs: t, hold: true })).toEqual(before);
  });
});

describe('turned body', () => {
  it('names the far arm from the heading, with hysteresis and no flip-flop', () => {
    const f = new FarArm();
    expect(f.update(0)).toBeNull();
    expect(f.update(ORDER.yawFar - 1)).toBeNull();
    // Turned to the person's left: the left arm is the far one.
    expect(f.update(ORDER.yawFar + 1)).toBe('L');
    // Hovering between the thresholds: no change.
    for (const yaw of [30, 25, 31, 24, 29]) expect(f.update(yaw)).toBe('L');
    expect(f.update(ORDER.yawNear - 1)).toBeNull();
    expect(f.update(-60)).toBe('R');
    expect(f.update(-90)).toBe('R');
    // The back: both arms beside the torso again, until clearly out of it.
    expect(f.update(-160)).toBeNull();
    expect(f.update(-145)).toBeNull();
    expect(f.update(-120)).toBe('R');
    expect(f.update(null)).toBe('R');
  });

  it('puts the far arm under the torso and the near arm over it, at once and steadily', () => {
    const o = new ArmDepthOrder();
    // Profile to the person's left: the shoulder line collapses, the overlap test is blind.
    const { l, world } = pose(down);
    let flips = 0,
      last = '';
    for (let i = 0; i < 40; i++) {
      // The heading wobbles ±6° round 40°.
      const order = o.update({ landmarks: l, world, tMs: i * 66, yawDeg: 40 + (i % 2 ? 6 : -6) });
      const key = JSON.stringify(order);
      if (last && key !== last) flips++;
      last = key;
    }
    expect(flips).toBe(0);
    expect(o.last.L).toEqual({ upper: 'behind', fore: 'behind' });
    expect(o.last.R).toEqual({ upper: 'front', fore: 'front' });
    expect(drawPlan(o.last)[0]).toEqual({ side: 'L', part: 'all', under: true });
    // Facing again: both in front.
    for (let i = 40; i < 60; i++) o.update({ landmarks: l, world, tMs: i * 66, yawDeg: 5 });
    expect(o.last.L).toEqual({ upper: 'front', fore: 'front' });
  });

  it('lets a far hand that reaches across the chest come in front', () => {
    const o = new ArmDepthOrder();
    const { l, world } = pose(crossed);
    for (let i = 0; i < 20; i++)
      o.update({ landmarks: l, world, tMs: i * 66, yawDeg: 45, bandPx: 30 });
    expect(o.last.L.upper).toBe('behind');
    expect(o.last.L.fore).toBe('front');
  });
});

describe('sleeve takeover', () => {
  it('leaves a hanging or raised arm to the current path', () => {
    const t = new SleeveTakeover();
    for (let ms = 0; ms < 2000; ms += 33) expect(t.update(0, false, ms)).toBe(0);
    expect(t.on).toBe(false);
  });

  it('takes over when the forearm comes over the torso, cross-fading', () => {
    const t = new SleeveTakeover();
    t.update(0, false, 0);
    const first = t.update(1, false, 33);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(1);
    for (let ms = 66; ms <= 33 + TAKEOVER.blendMs + 33; ms += 33) t.update(1, false, ms);
    expect(t.weight).toBe(1);
  });

  it('gives the sleeve back only after the arm stayed clear, and not on a dip', () => {
    const t = new SleeveTakeover();
    for (let ms = 0; ms < 500; ms += 33) t.update(1, false, ms);
    // Between the thresholds: still the pieces.
    for (let ms = 500; ms < 1500; ms += 33) expect(t.update(0.2, false, ms)).toBe(1);
    // A dip of 200 ms below the lower threshold: still the pieces.
    for (let ms = 1500; ms < 1700; ms += 33) expect(t.update(0, false, ms)).toBe(1);
    for (let ms = 1700; ms < 2000; ms += 33) t.update(0.6, false, ms);
    expect(t.weight).toBe(1);
    // Clear for good: back to the current path.
    for (let ms = 2000; ms < 3000; ms += 33) t.update(0, false, ms);
    expect(t.weight).toBe(0);
    expect(t.on).toBe(false);
  });

  it('takes over for an arm behind the torso, and at once on the first frame', () => {
    const t = new SleeveTakeover();
    expect(t.update(0, true, 0)).toBe(1);
  });
});

describe('composite order', () => {
  it('draws whole sleeves over the torso, the top forearm last', () => {
    expect(
      drawPlan({
        L: { upper: 'front', fore: 'front' },
        R: { upper: 'front', fore: 'front' },
        foreTop: 'L',
      }),
    ).toEqual([
      { side: 'R', part: 'all', under: false },
      { side: 'L', part: 'all', under: false },
    ]);
  });

  it('splits a sleeve whose forearm is behind the torso', () => {
    expect(
      drawPlan({
        L: { upper: 'front', fore: 'behind' },
        R: { upper: 'behind', fore: 'behind' },
        foreTop: 'R',
      }),
    ).toEqual([
      { side: 'L', part: 'fore', under: true },
      { side: 'R', part: 'all', under: true },
      { side: 'L', part: 'upper', under: false },
    ]);
  });
});
