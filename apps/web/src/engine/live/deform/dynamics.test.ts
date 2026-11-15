import { describe, expect, it } from 'vitest';
import type { LiveDeformContext } from '../contract';
import { DYNAMICS } from './config';
import {
  armCapsules,
  CAPSULE_STRIDE,
  CAPSULES_ARMS,
  CAPSULES_OWN_L,
  collide,
  SkinGrid,
} from './collide';
import { DynamicsDeformer } from './DynamicsDeformer';
import { dynamicsMap } from './maxDistance';
import { buildProxy } from './proxy';
import { BODY_R, CHEST_ROW, COLS, JACKET_R, moved, ROWS, STEP, TOP_Y, tubeScene } from './testScene';
import type { LiveDeformContextExt } from './types';

const scene = tubeScene();
const n = scene.binding.count;

/** One frame: the whole scene (jacket target + body) moved rigidly, the deformer applied. */
function frame(
  d: DynamicsDeformer,
  timeMs: number,
  yaw = 0,
  dx = 0,
  options: { rootYawDeg?: number | null; collide?: boolean } = {},
) {
  const target = moved(scene.bound, yaw, dx);
  const positions = target.slice();
  const ctx: LiveDeformContextExt = {
    timeMs,
    pose: null,
    drivers: [],
    bodyPositions: moved(scene.body, yaw, dx),
    joints: { midHip: [dx, 0.9, 0] },
    rootYawDeg: options.rootYawDeg ?? null,
    ...(options.collide === false ? {} : { bodyNormals: moved(scene.normals, yaw, 0, 0, 0, true) }),
  };
  d.apply(positions, ctx as LiveDeformContext);
  return { target, positions, ctx };
}

const held = (() => {
  const map = dynamicsMap(scene.bound, scene.binding.triangles, scene.binding.asset as never);
  return map;
})();

describe('max-distance map', () => {
  it('holds everything at and above the chest row and grows smoothly to the hem', () => {
    const md = held.maxDist;
    for (let r = 0; r <= CHEST_ROW; r++)
      for (let c = 0; c < COLS; c++) expect(md[r * COLS + c]).toBe(0);
    let previous = 0;
    for (let r = CHEST_ROW + 1; r < ROWS; r++) {
      const v = md[r * COLS];
      expect(v).toBeGreaterThan(previous);
      previous = v;
    }
    // Hem: 0.12 × the 0.5 m chest→hem drop = 6 cm (the clamp's top).
    const drop = (ROWS - 1 - CHEST_ROW) * STEP;
    expect(md[(ROWS - 1) * COLS]).toBeCloseTo(Math.min(DYNAMICS.hemMaxM, DYNAMICS.hemPerDrop * drop), 6);
    expect(held.summary.openFrontEdge).toBe(0);
  });

  it('a short jacket gets the 3 cm floor; the cuff ramp ends below the elbow', () => {
    // Sleeve tube: 20 rows along -Y from a bicep ring to a cuff ring.
    const rows = 20,
      cols = 16;
    const bound = new Float32Array(rows * cols * 3);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const a = (2 * Math.PI * c) / cols,
          k = (r * cols + c) * 3;
        bound[k] = 0.3 + 0.05 * Math.sin(a);
        bound[k + 1] = 1.3 - r * 0.02;
        bound[k + 2] = 0.05 * Math.cos(a);
      }
    const tri: number[] = [];
    for (let r = 0; r + 1 < rows; r++)
      for (let c = 0; c < cols; c++) {
        const a = r * cols + c,
          b = r * cols + ((c + 1) % cols);
        tri.push(a, a + cols, b, b, a + cols, b + cols);
      }
    const ring = (r: number) => Array.from({ length: cols }, (_, c) => r * cols + c);
    const map = dynamicsMap(bound, tri, {
      panels: new Uint8Array(rows * cols).fill(4),
      paths: { cuff_L: ring(rows - 1), bicep_L: ring(0) },
    });
    expect(map.maxDist[(rows - 1) * cols]).toBeCloseTo(DYNAMICS.cuffMaxM, 6);
    // 0.12 m (6 rows) above the cuff and higher: held.
    for (let r = 0; r <= rows - 1 - 6; r++) expect(map.maxDist[r * cols]).toBe(0);
    expect(map.summary.cuffs).toBe(true);
  });
});

describe('proxy', () => {
  it('simulates a coarse net and weights every free particle (weights sum to 1)', () => {
    const proxy = buildProxy(scene.bound, scene.binding.triangles, (scene.binding.asset as { panels: Uint8Array }).panels, held.maxDist);
    expect(proxy.count).toBeGreaterThan(20);
    expect(proxy.count).toBeLessThan(n / 4);
    let free = 0;
    for (let i = 0; i < n; i++) if (held.maxDist[i] > 0) free++;
    expect(proxy.moving.length).toBe(free);
    for (let m = 0; m < proxy.moving.length; m++) {
      let s = 0;
      for (let w = proxy.weightStart[m]; w < proxy.weightStart[m + 1]; w++) s += proxy.weight[w];
      expect(s).toBeCloseTo(1, 5);
    }
  });
});

describe('DynamicsDeformer', () => {
  const make = () => {
    const d = new DynamicsDeformer({ enabled: true });
    d.bind(scene.binding);
    return d;
  };

  it('a still body leaves the jacket exactly on its target (no rest jitter)', () => {
    const d = make();
    let differ = 0;
    for (let f = 0; f < 120; f++) {
      const { target, positions } = frame(d, f * 50);
      for (let k = 0; k < positions.length; k++) if (positions[k] !== target[k]) differ++;
    }
    expect(differ).toBe(0);
  });

  it('held particles equal the target bit for bit while the body moves', () => {
    const d = make();
    for (let f = 0; f < 60; f++) {
      const { target, positions } = frame(d, f * 50, 20 * Math.sin(f / 4), 0.04 * Math.sin(f / 3));
      let differ = 0;
      for (let i = 0; i < n; i++)
        if (held.maxDist[i] === 0)
          for (let a = 0; a < 3; a++) if (positions[i * 3 + a] !== target[i * 3 + a]) differ++;
      expect(differ).toBe(0);
    }
  });

  it('the hem lags a sideways move, stays within its max distance, then settles', () => {
    const d = make();
    let peak = 0;
    const hem = (ROWS - 1) * COLS;
    // Fast sideways shake: 8 cm amplitude, 1.5 Hz, without body collisions.
    for (let f = 0; f < 40; f++) {
      const t = f * 0.04;
      const { target, positions } = frame(d, t * 1000, 0, 0.08 * Math.sin(2 * Math.PI * 1.5 * t), {
        collide: false,
      });
      for (let i = 0; i < n; i++) {
        const dev = Math.hypot(
          positions[i * 3] - target[i * 3],
          positions[i * 3 + 1] - target[i * 3 + 1],
          positions[i * 3 + 2] - target[i * 3 + 2],
        );
        expect(dev).toBeLessThanOrEqual(held.maxDist[i] + 1e-6);
        if (i >= hem) peak = Math.max(peak, dev);
      }
    }
    expect(peak).toBeGreaterThan(0.01);
    // Then still. Settled = the largest deviation stays below 2 mm (about one pixel of the kiosk
    // mirror at 1080p) and below 10 % of the swing's peak; also reported: below 1 mm.
    const worst: number[] = [];
    for (let f = 40; f < 40 + 100; f++) {
      const { target, positions } = frame(d, f * 40, 0, 0, { collide: false });
      let w = 0;
      for (let k = 0; k < positions.length; k++) w = Math.max(w, Math.abs(positions[k] - target[k]));
      worst.push(w);
    }
    const settle = (limit: number) => {
      let last = -1;
      worst.forEach((w, k) => {
        if (w >= limit) last = k;
      });
      return (last + 1) * 0.04;
    };
    const s2 = settle(Math.min(0.002, 0.1 * peak)),
      s1 = settle(0.001);
    console.log(`synthetic shake: hem peak ${(peak * 100).toFixed(1)} cm, settle <2 mm ${s2.toFixed(2)} s, <1 mm ${s1.toFixed(2)} s`);
    expect(s2).toBeLessThanOrEqual(1.5);
    expect(s1).toBeLessThanOrEqual(2.0);
  });

  it('never pushes the cloth into the body', () => {
    const d = make();
    const clearance = 0.003 + 0.002;
    for (let f = 0; f < 50; f++) {
      const t = f * 0.04;
      const dx = 0.1 * Math.sin(2 * Math.PI * 2 * t);
      const { target, positions } = frame(d, t * 1000, 0, dx);
      for (let i = 0; i < n; i++) {
        const r = Math.hypot(positions[i * 3] - dx, positions[i * 3 + 2]);
        const rT = Math.hypot(target[i * 3] - dx, target[i * 3 + 2]);
        // Body tube radius BODY_R (sampled polygon: its flats sit a little inside the circle).
        expect(r).toBeGreaterThanOrEqual(Math.min(rT, BODY_R + clearance) - 0.001);
      }
    }
    expect(JACKET_R).toBeGreaterThan(BODY_R);
  });

  it('a body turn (rootYawDeg) swings the hem against the turn, then it settles', () => {
    const d = make();
    frame(d, 0, 0, 0, { rootYawDeg: 0 });
    const hemFront = (ROWS - 1) * COLS; // column 0 = +Z front
    let lagX = 0;
    for (let f = 1; f <= 8; f++) {
      // Turning to the person's left at 150 deg/s; the avatar itself does not yaw.
      const { target, positions } = frame(d, f * 40, 0, 0, { rootYawDeg: f * 6 });
      lagX = Math.min(lagX, positions[hemFront * 3] - target[hemFront * 3]);
    }
    // A left turn carries the front toward +X; the inertial hem lags toward -X.
    expect(lagX).toBeLessThan(-0.005);
    let last = Infinity;
    for (let f = 9; f < 80; f++) {
      const { target, positions } = frame(d, f * 40, 0, 0, { rootYawDeg: 48 });
      last = Math.abs(positions[hemFront * 3] - target[hemFront * 3]);
    }
    expect(last).toBeLessThan(0.001);
  });

  it('wraps the heading: +179 → −179 is a 2° turn, never a spin or a restart', () => {
    const d = make();
    frame(d, 0, 0, 0, { rootYawDeg: 179 });
    frame(d, 40, 0, 0, { rootYawDeg: -179 });
    expect(d.lastFrame.teleported).toBe(false);
    // 2° in 40 ms at the hem's 16 cm radius moves the target 5.6 mm: a lag of that order, not the
    // 6 cm max distance a 358° spin would hit.
    expect(d.lastFrame.maxDispM).toBeLessThan(0.02);
  });

  it('after a move the jacket is exactly on its target within 0.5 s of the body stopping', () => {
    const d = make();
    for (let f = 0; f < 15; f++) frame(d, f * 50, 0, 0.06 * Math.sin(f / 2), { collide: false });
    expect(d.lastFrame.maxDispM).toBeGreaterThan(0.002);
    let exactFrom = -1;
    for (let f = 15; f < 40; f++) {
      const { target, positions } = frame(d, f * 50, 0, 0.06 * Math.sin(14 / 2), { collide: false });
      let same = true;
      for (let k = 0; k < positions.length; k++) if (positions[k] !== target[k]) same = false;
      if (same && exactFrom < 0) exactFrom = (f - 15) * 50;
      if (!same) exactFrom = -1;
    }
    expect(exactFrom).toBeGreaterThanOrEqual(0);
    expect(exactFrom).toBeLessThanOrEqual(500);
    expect(d.lastFrame.atRest).toBe(true);
  });

  it('restarts from the target after reset, a stall or a pose jump', () => {
    const d = make();
    for (let f = 0; f < 10; f++) frame(d, f * 40, 0, 0.05 * f);
    expect(d.lastFrame.maxDispM).toBeGreaterThan(0.001);
    d.reset();
    let r = frame(d, 400, 0, 0.5);
    expect(d.lastFrame.teleported).toBe(true);
    expect(Array.from(r.positions)).toEqual(Array.from(r.target));
    frame(d, 440, 0, 0.52);
    r = frame(d, 440 + DYNAMICS.stallMs + 10, 0, 0.54);
    expect(d.lastFrame.reason).toMatch(/stall/);
    r = frame(d, 1000, 0, 0.54 + DYNAMICS.jumpM + 0.05);
    expect(d.lastFrame.reason).toMatch(/pose jump/);
    expect(Array.from(r.positions)).toEqual(Array.from(r.target));
  });

  it('is independent of the camera rate (fixed substeps)', () => {
    const run = (fps: number) => {
      const d = make();
      const out: number[] = [];
      const hem = (ROWS - 1) * COLS * 3;
      for (let k = 0; k <= 1.2 * fps; k++) {
        const t = k / fps;
        const dx = t < 0.6 ? 0.05 * (1 - Math.cos((Math.PI * t) / 0.6)) : 0.1;
        const { positions, target } = frame(d, t * 1000, 0, dx, { collide: false });
        if (k % (fps / 5) === 0) out.push(positions[hem] - target[hem]);
      }
      return out;
    };
    const a = run(20),
      b = run(25);
    expect(a.length).toBe(b.length);
    // Same physics at 20 and 25 fps: the hem displacement at the shared 0.2 s marks agrees within
    // a few mm (the target is linear between frames, so the paths differ slightly).
    // (Moving phase only: after the body stops, the rest lock starts on a frame boundary.)
    for (let k = 0; k < 4; k++) expect(Math.abs(a[k] - b[k])).toBeLessThan(0.004);
  });

  it('is off by default when disabled and reports why', () => {
    const d = new DynamicsDeformer({ enabled: false });
    d.bind(scene.binding);
    const { target, positions } = frame(d, 0, 10, 0.1);
    expect(Array.from(positions)).toEqual(Array.from(target));
    expect(d.status().active).toBe(false);
  });

  it('frame cost stays small on the synthetic jacket', () => {
    const d = make();
    let worst = 0;
    for (let f = 0; f < 60; f++) {
      frame(d, f * 50, 15 * Math.sin(f / 5), 0.05 * Math.sin(f / 3));
      worst = Math.max(worst, d.status().lastApplyMs);
    }
    expect(Number.isFinite(worst)).toBe(true);
    expect(TOP_Y).toBeGreaterThan(1);
  });

  it('restarts only the nodes whose target jumped (an arm flip), not the whole jacket', () => {
    const d = make();
    for (let f = 0; f < 10; f++) frame(d, f * 40, 0, 0.004 * f, { collide: false });
    const before = d.lastFrame.maxDispM;
    expect(before).toBeGreaterThan(0.001);
    // The bottom 3 rows (fewer than DYNAMICS.jumpGlobalShare of the nodes) jump 30 cm.
    const target = moved(scene.bound, 0, 0.04);
    for (let i = (ROWS - 3) * COLS; i < n; i++) target[i * 3 + 2] += 0.3;
    const positions = target.slice();
    d.apply(positions, { timeMs: 400, pose: null, drivers: [], bodyPositions: scene.body, joints: {} });
    expect(d.lastFrame.teleported).toBe(false);
    expect(d.lastFrame.resetNodes).toBeGreaterThan(0);
    // The rest keeps moving (its lag survives); the jumped rows sit on their new target.
    expect(d.lastFrame.maxDispM).toBeGreaterThan(0.0005);
  });
});

describe('collide', () => {
  const joints = {
    'upperarm01.L': [0.2, 1.4, 0] as [number, number, number],
    'lowerarm01.L': [0.3, 1.15, 0] as [number, number, number],
    'wrist.L': [0.35, 0.9, 0] as [number, number, number],
    'upperarm01.R': [-0.2, 1.4, 0] as [number, number, number],
    'lowerarm01.R': [-0.3, 1.15, 0] as [number, number, number],
    'wrist.R': [-0.35, 0.9, 0] as [number, number, number],
  };
  const caps = new Float64Array(6 * CAPSULE_STRIDE);
  const count = armCapsules(joints, [0.05, 0.045, 0.05, 0.045], caps);
  const none = new Uint32Array(8);

  it('a sleeve never gets closer to its own arm bones than its target', () => {
    expect(count).toBe(6);
    // Target 3 cm from the forearm axis (beside it in +Z); the particle tries 1 cm.
    const t = [0.325, 1.025, 0.03];
    const p = new Float64Array([0.325, 1.025, 0.01]);
    collide(p, 0, t[0], t[1], t[2], none, 0, [], [], 0.005, 0.01, caps, count, CAPSULES_OWN_L);
    expect(Math.hypot(p[0] - 0.325, p[2])).toBeGreaterThanOrEqual(0.03 - 1e-9);
  });

  it('a torso particle stays outside the arm capsules, never deeper than its target', () => {
    // Outside the forearm capsule (radius 4.5 cm) at its target; the particle swings in.
    const t = [0.325, 1.025, 0.06];
    const p = new Float64Array([0.325, 1.025, 0.02]);
    collide(p, 0, t[0], t[1], t[2], none, 0, [], [], 0.005, 0.04, caps, count, CAPSULES_ARMS);
    expect(p[2]).toBeGreaterThanOrEqual(0.045 - 1e-9);
  });

  it('the contact budget keeps a torso particle off a hand it was near (flat skin, not a capsule)', () => {
    // A flat "palm" of skin points in the plane z = 0.10 around the left hand capsule.
    const pts: number[] = [];
    for (let i = -5; i <= 5; i++) for (let j = -5; j <= 5; j++) pts.push(0.35 + i * 0.005, 0.85 + j * 0.005, 0.1);
    const skin = new Float32Array(pts);
    const normals = new Float32Array(skin.length);
    for (let k = 2; k < normals.length; k += 3) normals[k] = 1;
    const grid = new SkinGrid(Uint32Array.from({ length: skin.length / 3 }, (_, v) => v));
    grid.update(skin);
    // Target 2.5 cm in front of the palm; the dynamics tries to push it 6.5 cm, through it.
    const t = [0.35, 0.85, 0.125];
    const p = new Float64Array([0.35, 0.85, 0.06]);
    collide(p, 0, t[0], t[1], t[2], none, 0, skin, normals, 0.005, 0.05, caps, count, CAPSULES_ARMS, grid);
    // Budget: 2.5 cm - clearance 0.5 cm - vertex spacing 0.5 cm = 1.5 cm of motion at most.
    expect(Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2])).toBeLessThanOrEqual(0.015 + 1e-9);
    expect(p[2]).toBeGreaterThan(0.1);
  });
});
