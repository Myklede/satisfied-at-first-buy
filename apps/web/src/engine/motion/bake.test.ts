import { describe, expect, it } from 'vitest';
import type { ClothAsset } from '../cloth/ClothSolver';
import { parseArticulatedSdf } from './articulatedCollider';
import { bakeMotion, type BakedMotion, type RelaxCache } from './bake';
import { parseFrames, parseRig, type MotionAnchors } from './rig';
import { fixtureAvailable, fixtureBuffer, fixtureJson } from './testFixture';
import { pooledInstance, wasmKernels } from '../cloth/wasm/kernels';
import { wasmColliderKernels } from './wasm/colliderKernels';

// Physics plausibility on the public reference body (172/65 male): the short puffer DQ4920-206
// (hem ~4.5 cm above the hip line, S and M differ by 0.2 cm in length) against the long parka
// FB7675-100 (hem ~19 cm below the hip line). Short bakes through the rising part of
// reach_up_both keep the suite near a minute.
const NEEDED = [
  'rig.bin',
  'sdf.bin',
  'anchors.json',
  'frames-reach_up_both.bin',
  'cloth-DQ-S.json',
  'cloth-DQ-M.json',
  'fit-DQ.json',
  'cloth-FB-S.json',
];

describe.skipIf(!fixtureAvailable(...NEEDED))('fit-in-motion bake (reference body)', () => {
  const rig = parseRig(fixtureBuffer('rig.bin'));
  const sdf = parseArticulatedSdf(fixtureBuffer('sdf.bin'), rig);
  const anchors = fixtureJson<MotionAnchors>('anchors.json');
  const frames = parseFrames(fixtureBuffer('frames-reach_up_both.bin'), rig.drivers.length);
  const analytic = fixtureJson<{
    sizes: Record<
      string,
      { zones: Record<string, { value_cm: number; position_vs_hip_cm?: number }> }
    >;
  }>('fit-DQ.json');
  const bake = (size: string, maxFrames: number, product = 'DQ'): BakedMotion => {
    const asset = fixtureJson<ClothAsset>(`cloth-${product}-${size}.json`);
    const grid = new Float32Array(fixtureBuffer(`sdf-${asset.sdf.sdf_id}.bin`));
    return bakeMotion({ asset, grid, rig, sdf, frames, anchors, size }, undefined, { maxFrames });
  };
  const S = bake('S', 30),
    M = bake('M', 30),
    parka = bake('S', 30, 'FB');

  it('frame 0 (relaxed on the neutral motion body) matches the static analytic fit within the 2 cm gate', () => {
    for (const b of [S, M]) {
      const z = analytic.sizes[b.size].zones;
      expect(Math.abs(b.checks.neutral.shoulderCm - z.shoulder.value_cm)).toBeLessThanOrEqual(2);
      expect(Math.abs(b.checks.neutral.hemVsHipCm - z.hem.position_vs_hip_cm!)).toBeLessThanOrEqual(
        2,
      );
    }
  });

  it('a shorter garment exposes more than a longer one when reaching up', () => {
    const front = (b: BakedMotion) => b.metrics.map((m) => m.hemAboveCm.mid[0]);
    const s = front(S);
    // The short puffer rides above the mid waistband; the long parka stays well below it.
    expect(S.summary.exposure.mid.any).toBeGreaterThan(parka.summary.exposure.mid.any);
    expect(Math.max(...front(parka))).toBeLessThan(Math.max(...s) - 5);
    // Waistband monotonicity: a lower waistband exposes at least as much.
    for (const b of [S, M, parka]) {
      expect(b.summary.exposure.low.any).toBeGreaterThanOrEqual(b.summary.exposure.mid.any);
      expect(b.summary.exposure.mid.any).toBeGreaterThanOrEqual(b.summary.exposure.high.any);
    }
    // The hem rises during the reach (front centre, mid waistband).
    expect(s[s.length - 1] - s[0]).toBeGreaterThan(2);
  });

  it('no numerical explosion and little penetration', () => {
    for (const b of [S, M, parka]) {
      expect(b.checks.finite).toBe(true);
      const n = b.particles * 3;
      let far = 0;
      for (let f = 0; f < b.frameCount; f++)
        for (let k = 0; k < n; k += 3) {
          const d = Math.hypot(
            b.positions[f * n + k] - b.positions[k],
            b.positions[f * n + k + 1] - b.positions[k + 1],
            b.positions[f * n + k + 2] - b.positions[k + 2],
          );
          if (d > 1) far++;
        }
      expect(far).toBe(0); // nothing flies more than 1 m from its neutral position
      expect(b.checks.penetratingShare).toBeLessThan(0.01); // < 1 % of particle-frames > 5 mm inside
    }
  });

  it('is deterministic', () => {
    const a = bake('S', 4),
      b = bake('S', 4);
    expect(a.positions).toEqual(b.positions);
  }, 60000);

  it('a cached relax (later motions of the same size) bakes exactly like a fresh relax', () => {
    const asset = fixtureJson<ClothAsset>('cloth-DQ-S.json');
    const grid = new Float32Array(fixtureBuffer(`sdf-${asset.sdf.sdf_id}.bin`));
    const input = { asset, grid, rig, sdf, frames, anchors, size: 'S' },
      relaxCache: RelaxCache = {};
    const filling = bakeMotion(input, undefined, { maxFrames: 2, relaxCache });
    const fresh = bakeMotion(input, undefined, { maxFrames: 12 });
    const cached = bakeMotion(input, undefined, { maxFrames: 12, relaxCache });
    expect(filling.timings.relaxCached).toBe(false);
    expect(cached.timings.relaxCached).toBe(true);
    expect(cached.timings.relaxSeconds).toBe(fresh.timings.relaxSeconds);
    expect(cached.positions).toEqual(fresh.positions);
    expect(cached.strain).toEqual(fresh.strain);
    expect(cached.exposed).toEqual(fresh.exposed);
    expect(cached.metrics).toEqual(fresh.metrics);
    expect(cached.checks).toEqual(fresh.checks);
    // Another asset object (another size or a re-fetched shell) never reuses the entry.
    const other = bakeMotion({ ...input, asset: { ...asset } }, undefined, {
      maxFrames: 1,
      relaxCache,
    });
    expect(other.timings.relaxCached).toBe(false);
  }, 120000);

  it('the WebAssembly solver and collider bake exactly like JS (fresh and cached relax)', () => {
    const asset = fixtureJson<ClothAsset>('cloth-DQ-M.json');
    const grid = new Float32Array(fixtureBuffer(`sdf-${asset.sdf.sdf_id}.bin`));
    const input = { asset, grid, rig, sdf, frames, anchors, size: 'M' },
      js = bakeMotion(input, undefined, { maxFrames: 12 }),
      relaxCache: RelaxCache = {},
      wasm = { kernels: wasmKernels, colliderKernels: wasmColliderKernels },
      fresh = bakeMotion(input, undefined, { maxFrames: 12, relaxCache, ...wasm }),
      cached = bakeMotion(input, undefined, { maxFrames: 12, relaxCache, ...wasm });
    expect(cached.timings.relaxCached).toBe(true);
    // One solver and one collider instance per thread, reused across relax, motion and bakes.
    const solverInstance = pooledInstance('solver'),
      colliderInstance = pooledInstance('collider');
    expect(solverInstance?.busy).toBe(false);
    expect(colliderInstance?.busy).toBe(false);
    bakeMotion(input, undefined, { maxFrames: 2, relaxCache, ...wasm });
    expect(pooledInstance('solver')).toBe(solverInstance);
    expect(pooledInstance('collider')).toBe(colliderInstance);
    for (const wasm of [fresh, cached]) {
      expect(wasm.timings.relaxSeconds).toBe(js.timings.relaxSeconds);
      expect(wasm.positions).toEqual(js.positions);
      expect(wasm.strain).toEqual(js.strain);
      expect(wasm.exposed).toEqual(js.exposed);
      expect(wasm.metrics).toEqual(js.metrics);
      expect(wasm.checks).toEqual(js.checks);
    }
  }, 120000);
});
