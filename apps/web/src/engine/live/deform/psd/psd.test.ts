import { describe, expect, it } from 'vitest';
import type { LiveGarmentBinding } from '../../contract';
import { bodyIdFromKey, productIdFromKey, styleAllowed } from './browserBaker';
import { psdRequested, psdWorkersRequested } from './index';
import { PSD } from './config';
import { armFeature, leftMask, mirrorField, mirrorMap, mirrorPose } from './features';
import { localOffsets, skinFromBound, toLocal, toWorld } from './localFrame';
import { GUARD_CANDIDATES, NO_GUARD } from './guard';
import { fitModel, PsdEvaluator, type PsdModelData, type PsdSample } from './model';
import { PoseCorrectives, PsdNotEnabledError, type PsdBaker } from './PoseCorrectives';
import { arms, HOLDOUT_POSES, largestChange, scheduleChain, TRAINING_CHAINS } from './poses';
import { fitRbf, rbfWeights } from './rbf';

/** The display stand of the reference body (rig header neutral_pose, rounded). */
const NEUTRAL = {
  shoulder_L_plane: 7.15,
  shoulder_L_elevation: 27.23,
  shoulder_L_axial: -7.89,
  shoulder_R_plane: 7.15,
  shoulder_R_elevation: 27.23,
  shoulder_R_axial: -7.89,
  elbow_L_flexion: 12,
  elbow_R_flexion: 12,
  hip_L_flexion: 8.42,
  hip_R_flexion: 8.42,
  knee_L_flexion: 7.56,
  knee_R_flexion: 7.56,
};

let seed = 12345;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};

/** 18 random rigid-ish drivers (rotation × scale near 1, translation), 3×4 row-major. */
function randomDrivers(D = 18) {
  const m = new Float64Array(D * 12);
  for (let d = 0; d < D; d++) {
    const ax = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
    const l = Math.hypot(ax[0], ax[1], ax[2]);
    const [x, y, z] = ax.map((v) => v / l);
    const a = rnd() * Math.PI,
      c = Math.cos(a),
      s = Math.sin(a),
      t = 1 - c,
      k = 0.95 + 0.1 * rnd();
    const R = [
      t * x * x + c, t * x * y - s * z, t * x * z + s * y,
      t * x * y + s * z, t * y * y + c, t * y * z - s * x,
      t * x * z - s * y, t * y * z + s * x, t * z * z + c,
    ]; // prettier-ignore
    for (let r = 0; r < 3; r++) {
      for (let col = 0; col < 3; col++) m[d * 12 + r * 4 + col] = k * R[r * 3 + col];
      m[d * 12 + r * 4 + 3] = rnd() - 0.5;
    }
  }
  return m;
}

/** A synthetic skin: N particles, 4 influences each over 18 drivers, a few dominant. */
function randomSkin(n: number) {
  const skinDrivers = new Uint8Array(n * 4),
    skinWeights = new Float32Array(n * 4),
    bound = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    let total = 0;
    for (let k = 0; k < 4; k++) {
      skinDrivers[i * 4 + k] = (i + k * 5) % 18;
      skinWeights[i * 4 + k] = k === 0 ? 1 : 0.3 * rnd();
      total += skinWeights[i * 4 + k];
    }
    for (let k = 0; k < 4; k++) skinWeights[i * 4 + k] /= total;
    bound[i * 3] = (i / n - 0.5) * 0.6; // across the body, X = the subject's left
    bound[i * 3 + 1] = 1 + 0.4 * rnd();
    bound[i * 3 + 2] = 0.1 * (rnd() - 0.5);
  }
  return { count: n, skinDrivers, skinWeights, bound };
}

describe('PSD local frames', () => {
  it('world → local → world is the identity', () => {
    const skin = randomSkin(40);
    const m = randomDrivers();
    const delta = Float64Array.from({ length: 120 }, () => rnd() - 0.5);
    const back = toWorld(
      skin,
      m,
      toLocal(skin, m, delta, new Float64Array(120)),
      new Float64Array(120),
    );
    for (let i = 0; i < 120; i++) expect(back[i]).toBeCloseTo(delta[i], 10);
  });
  it('LBS from the bound positions reproduces them at the bind drivers', () => {
    const skin = randomSkin(30);
    const m0 = randomDrivers();
    const p = skinFromBound(skin, skin.bound, m0, m0, new Float64Array(90));
    for (let i = 0; i < 90; i++) expect(p[i]).toBeCloseTo(skin.bound[i], 6);
  });
  it('a solve equal to the LBS has no correction, and a stored offset follows the drivers', () => {
    const skin = randomSkin(30);
    const m0 = randomDrivers(),
      m = randomDrivers();
    const lbs = skinFromBound(skin, skin.bound, m0, m, new Float64Array(90));
    const zero = localOffsets(skin, skin.bound, m0, m, lbs);
    for (const v of zero) expect(Math.abs(v)).toBeLessThan(1e-6);
    // solved = LBS + B(m)·o  →  localOffsets recovers o
    const o = Float64Array.from({ length: 90 }, () => 0.05 * (rnd() - 0.5));
    const w = toWorld(skin, m, o, new Float64Array(90));
    const solved = lbs.map((v, i) => v + w[i]);
    const back = localOffsets(skin, skin.bound, m0, m, solved);
    for (let i = 0; i < 90; i++) expect(back[i]).toBeCloseTo(o[i], 6);
  });
});

describe('PSD features and masks', () => {
  it('the arm feature is continuous through the gimbal at zero elevation', () => {
    const a = armFeature({ shoulder_L_elevation: 0, shoulder_L_plane: 0 }, NEUTRAL, 'L');
    const b = armFeature({ shoulder_L_elevation: 0, shoulder_L_plane: 90 }, NEUTRAL, 'L');
    for (let i = 0; i < 4; i++) expect(a[i]).toBeCloseTo(b[i], 12);
    // Missing DOFs take the neutral's value.
    const n = armFeature({}, NEUTRAL, 'R');
    const full = armFeature(NEUTRAL, NEUTRAL, 'R');
    expect(Array.from(n)).toEqual(Array.from(full));
  });
  it('the left mask is 1 on the left, 0 on the right, ½ at the centre', () => {
    const bound = Float32Array.of(0.3, 1, 0, -0.3, 1, 0, 0, 1, 0);
    const m = leftMask(bound, 0);
    expect(Array.from(m)).toEqual([1, 0, 0.5]);
  });
});

describe('PSD interpolation', () => {
  it('an RBF reproduces its samples and decays to zero far away', () => {
    const centers = Float64Array.of(0, 0, 1, 0, 0, 1, 1, 1);
    const values = Float64Array.of(0, 1, 2, 3);
    const rbf = fitRbf(centers, 4, 2, values, 1, [0.8], [1e-12]);
    const w = new Float64Array(4);
    for (let k = 0; k < 4; k++) {
      rbfWeights(rbf, centers, w, undefined, k * 2);
      const f = w.reduce((s, a, j) => s + a * values[j], 0);
      expect(f).toBeCloseTo(values[k], 8);
    }
    rbfWeights(rbf, [20, 20], w);
    expect(Math.abs(w.reduce((s, a, j) => s + a * values[j], 0))).toBeLessThan(1e-9);
  });

  const n = 24;
  const skin = randomSkin(n);
  const samples: PsdSample[] = TRAINING_CHAINS.flatMap((c) =>
    c.poses.map((p) => ({
      id: p.id,
      kind: p.kind,
      pose: p.pose,
      field: Float32Array.from({ length: n * 3 }, () => 0.1 * (rnd() - 0.5)),
    })),
  );
  const model = fitModel(samples, NEUTRAL, skin.bound, 'test', {
    maxComponents: 64,
    toleranceM: 0,
    lambdas: [1e-10],
  });
  const ev = new PsdEvaluator(model);
  ev.fadeDeg = null; // the interpolation itself (the elevation fade has its own test)

  it('equals the solve at every training pose (the poses are mirror-symmetric)', () => {
    expect(model.components).toBe(model.samples.length); // + the mirrored one-arm samples
    for (const s of samples) {
      const local = ev.local(s.pose);
      for (let i = 0; i < n * 3; i++) expect(local[i]).toBeCloseTo(s.field[i], 4);
    }
  });
  it('is zero at the neutral stand', () => {
    for (const v of ev.local({})) expect(Math.abs(v)).toBeLessThan(1e-6);
  });
  it('apply adds B(drivers)·local to the skinned positions', () => {
    const pose = HOLDOUT_POSES[0].pose;
    const m = randomDrivers();
    const positions = Float32Array.from(skin.bound);
    expect(ev.apply(pose, m, skin, positions, 0.5)).toBe(true);
    const expected = toWorld(skin, m, ev.local(pose), new Float64Array(n * 3));
    for (let i = 0; i < n * 3; i++)
      expect(positions[i]).toBeCloseTo(skin.bound[i] + 0.5 * expected[i], 5);
  });
});

describe('PSD mirror and body guard', () => {
  it('mirrors poses and fields across the mid-sagittal plane', () => {
    expect(mirrorPose({ shoulder_R_elevation: 170, trunk_twist: 10, elbow_L_flexion: 30 })).toEqual(
      {
        shoulder_L_elevation: 170,
        trunk_twist: -10,
        elbow_R_flexion: 30,
      },
    );
    const bound = Float32Array.of(0.2, 1, 0.1, -0.2, 1, 0.1, 0, 1.2, 0);
    const map = mirrorMap(bound);
    expect(Array.from(map)).toEqual([1, 0, 2]);
    const field = Float32Array.of(0.01, 0.02, 0.03, 0, 0, 0, 0.5, 0, 0);
    const mirrored = mirrorField(field, map);
    [-0, 0, 0, -0.01, 0.02, 0.03, -0.5, 0, 0].forEach((v, i) =>
      expect(mirrored[i]).toBeCloseTo(v, 6),
    );
  });
  it('a correction never pushes a particle through its skin plane', () => {
    // One particle 1 cm in front of a body vertex (normal +Z); identity drivers.
    const skin = {
      count: 1,
      skinDrivers: Uint8Array.of(0, 0, 0, 0),
      skinWeights: Float32Array.of(1, 0, 0, 0),
    };
    const bound = Float32Array.of(0, 1, 0.01);
    const sample: PsdSample = {
      id: 'in',
      kind: 'arm',
      pose: HOLDOUT_POSES[0].pose,
      field: Float32Array.of(0, 0, -0.03),
    };
    // Candidate 0 is the body vertex in front (normal +Z); the other slots are unused.
    const candidates = new Uint32Array(GUARD_CANDIDATES).fill(NO_GUARD);
    candidates[0] = 0;
    const guard = {
      candidates,
      distance: Float32Array.of(0.01),
      normal: Float32Array.of(0, 0, 1),
      clearance: Float32Array.of(0.01),
    };
    const body = { positions: Float32Array.of(0, 1, 0), normals: Float32Array.of(0, 0, 1) };
    const model = fitModel([sample], NEUTRAL, bound, 'g', { lambdas: [1e-10] }, guard);
    const ev = new PsdEvaluator(model);
    ev.fadeDeg = null; // the interpolation itself (the elevation fade has its own test)
    const eye = Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);
    const free = Float32Array.from(bound);
    ev.apply(sample.pose, eye, skin, free, 1);
    expect(free[2]).toBeCloseTo(-0.02, 4); // unguarded: 2 cm inside
    const guarded = Float32Array.from(bound);
    ev.apply(sample.pose, eye, skin, guarded, 1, body);
    expect(guarded[2]).toBeCloseTo(PSD.guardMarginM, 6);
    expect(ev.guarded).toBe(1);
    // Far from every candidate (the solve slid it away), the stale plane is not applied ...
    ev.guardRadiusM = 0.005;
    ev.guardMode = 'candidates';
    const slid = Float32Array.from(bound);
    ev.apply(sample.pose, eye, skin, slid, 1, body);
    expect(slid[2]).toBeCloseTo(-0.02, 4);
    expect(ev.guarded).toBe(0);
    // ... and the fallback limits the inward part to the neutral clearance (1 cm) − margin.
    ev.guardMode = 'both';
    const limited = Float32Array.from(bound);
    ev.apply(sample.pose, eye, skin, limited, 1, body);
    expect(limited[2]).toBeCloseTo(PSD.guardMarginM, 6);
    expect(ev.guarded).toBe(1);
  });
});

describe('PSD key-pose schedule', () => {
  it('every chain fits the service limit, on the bake grid, at the presets’ ramp speed', () => {
    for (const chain of TRAINING_CHAINS) {
      const s = scheduleChain(
        chain.poses.map((p) => p.pose),
        NEUTRAL,
      );
      expect(s.durationS).toBeLessThanOrEqual(PSD.maxChainS);
      expect(s.request.poses[0]).toEqual({ t: 0, pose: {} });
      for (const t of s.sampleTimes)
        expect(Math.abs(t * PSD.bakeFps - Math.round(t * PSD.bakeFps))).toBeLessThan(1e-6);
      for (let k = 1; k < s.request.poses.length; k += 2) {
        const ramp = s.request.poses[k].t - s.request.poses[k - 1].t;
        const change = largestChange(s.request.poses[k - 1].pose, s.request.poses[k].pose, NEUTRAL);
        expect(change / ramp).toBeLessThanOrEqual(PSD.rampDegPerS + 1e-6);
      }
    }
  });
  it('hold-out poses are not training poses', () => {
    const train = TRAINING_CHAINS.flatMap((c) => c.poses.map((p) => JSON.stringify(p.pose)));
    for (const h of HOLDOUT_POSES) expect(train).not.toContain(JSON.stringify(h.pose));
  });
});

describe('PoseCorrectives deformer', () => {
  const n = 6;
  const skin = randomSkin(n);
  const binding: LiveGarmentBinding = {
    count: n,
    bound: skin.bound,
    triangles: [0, 1, 2],
    skinDrivers: skin.skinDrivers,
    skinWeights: skin.skinWeights,
    asset: {},
    key: 'a'.repeat(64) + '|parka|S|v1',
  };
  const model: PsdModelData = fitModel(
    [
      {
        id: 'up',
        kind: 'arm',
        pose: arms(30, 45, 0, 40),
        field: new Float32Array(n * 3).fill(0.02),
      },
    ],
    NEUTRAL,
    skin.bound,
    binding.key,
  );
  const ctx = (pose: Record<string, number> | null) => ({
    timeMs: 0,
    pose,
    drivers: randomDrivers(),
    bodyPositions: new Float32Array(0),
    joints: {},
  });

  it('is a no-op with a note before its bake is ready', () => {
    const never: PsdBaker = () => new Promise(() => undefined);
    const d = new PoseCorrectives({ baker: never, cache: new Map(), enabled: true });
    d.bind(binding);
    const positions = Float32Array.from(skin.bound);
    d.apply(positions, ctx(arms(30, 45, 0, 40)));
    expect(Array.from(positions)).toEqual(Array.from(skin.bound));
    expect(d.status().active).toBe(false);
    expect(d.status().note).toMatch(/learning/);
  });

  it('fades in once ready, caches the finished model, and is off on request', async () => {
    let clock = 1000;
    const cache = new Map<string, PsdModelData>();
    const baker: PsdBaker = async (_b, onModel) => onModel(model, { learnt: 1, total: 1 }, true);
    const d = new PoseCorrectives({ baker, cache, now: () => clock, enabled: true });
    d.bind(binding);
    await Promise.resolve();
    expect(d.status().active).toBe(true);
    expect(cache.has(binding.key)).toBe(true);
    const pose = arms(30, 45, 0, 40);
    const at0 = Float32Array.from(skin.bound);
    d.apply(at0, ctx(pose));
    expect(Array.from(at0)).toEqual(Array.from(skin.bound)); // gain 0 at the start of the fade
    clock += PSD.fadeInMs;
    const full = Float32Array.from(skin.bound);
    d.apply(full, ctx(pose));
    expect(full.some((v, i) => Math.abs(v - skin.bound[i]) > 1e-4)).toBe(true);
    const unknown = Float32Array.from(skin.bound);
    d.apply(unknown, ctx(null));
    expect(Array.from(unknown)).toEqual(Array.from(skin.bound));
    // A second deformer on the same binding starts ready from the session cache.
    const again = new PoseCorrectives({
      baker: () => new Promise(() => undefined),
      cache,
      enabled: true,
    });
    again.bind(binding);
    expect(again.status().note).toMatch(/cached/);
    d.setEnabled(false);
    const off = Float32Array.from(skin.bound);
    d.apply(off, ctx(pose));
    expect(Array.from(off)).toEqual(Array.from(skin.bound));
    expect(d.status()).toMatchObject({ active: false, note: 'off' });
    d.setEnabled(true);
    d.bind(null);
    expect(d.status().note).toBe('no jacket');
  });

  it('bakes nothing while off, and starts the bake when turned on', () => {
    let calls = 0;
    const counting: PsdBaker = () => {
      calls++;
      return new Promise(() => undefined);
    };
    const d = new PoseCorrectives({ baker: counting, cache: new Map(), enabled: false });
    d.bind(binding);
    expect(calls).toBe(0);
    expect(d.status().note).toBe('off');
    d.setEnabled(true);
    expect(calls).toBe(1);
    expect(d.status().note).toMatch(/learning/);
  });

  it('fades each side out as its arm rises (PSD.fade)', () => {
    const up = arms(40, 110, 0, 10);
    const m = fitModel(
      [{ id: 'up', kind: 'arm', pose: up, field: new Float32Array(n * 3).fill(0.02) }],
      NEUTRAL,
      skin.bound,
      'fade',
      { lambdas: [1e-10] },
    );
    const ev = new PsdEvaluator(m);
    const eye = Float64Array.of(
      ...Array.from({ length: 18 }, () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]).flat(),
    );
    const raised = Float32Array.from(skin.bound);
    ev.apply(up, eye, skin, raised, 1);
    expect(Array.from(ev.fade)).toEqual([0, 0]); // 110 deg is past the fade
    expect(Array.from(raised)).toEqual(Array.from(skin.bound));
    ev.fadeDeg = null;
    const full = Float32Array.from(skin.bound);
    ev.apply(up, eye, skin, full, 1);
    expect(full[1]).toBeCloseTo(skin.bound[1] + 0.02, 4);
    ev.fadeDeg = PSD.fade;
    ev.prepare({ ...up, shoulder_L_elevation: 85 });
    expect(ev.fade[0]).toBeCloseTo(0.5, 6); // halfway between full (70) and zero (100)
    expect(ev.fade[1]).toBe(0);
  });

  it('is on by default only for allow-listed products (PSD.defaultOnStyles)', async () => {
    expect(PSD.defaultOnStyles).toEqual([]);
    expect(psdRequested('')).toBe('auto');
    expect(psdRequested('?psd=0')).toBe('off');
    expect(psdRequested('?psd=1')).toBe('on');
    expect(psdWorkersRequested('?psdworkers=1')).toBe(1);
    expect(psdWorkersRequested('?psdworkers=7')).toBeUndefined();
    const products = [
      { product_id: 'b'.repeat(64), style: 'FB7675-100' },
      { product_id: 'c'.repeat(64), style: 'DQ4920-206' },
    ];
    expect(productIdFromKey(binding.key)).toBeNull(); // 'parka' is not a product id
    const key = (p: string) => `${'a'.repeat(64)}|${p}|S|v1`;
    expect(
      styleAllowed(products, productIdFromKey(key('b'.repeat(64))), PSD.defaultOnStyles),
    ).toEqual({ style: 'FB7675-100', allowed: false });
    expect(styleAllowed(products, 'b'.repeat(64), ['FB7675-100'])).toEqual({
      style: 'FB7675-100',
      allowed: true,
    });
    expect(
      styleAllowed(products, productIdFromKey(key('c'.repeat(64))), PSD.defaultOnStyles),
    ).toEqual({ style: 'DQ4920-206', allowed: false });
    // A refused product: no correctives, a plain note (not a failure).
    const refusing: PsdBaker = async () => {
      throw new PsdNotEnabledError('not validated for DQ4920-206 yet');
    };
    const d = new PoseCorrectives({ baker: refusing, cache: new Map(), enabled: true });
    d.bind(binding);
    await Promise.resolve();
    await Promise.resolve();
    expect(d.status()).toMatchObject({
      active: false,
      note: 'off: not validated for DQ4920-206 yet',
    });
  });

  it('reads the body id from the binding key', () => {
    expect(bodyIdFromKey(binding.key)).toBe('a'.repeat(64));
    expect(bodyIdFromKey('nope|x')).toBeNull();
  });
});
