import { describe, expect, it, vi } from 'vitest';
import { parseArticulatedSdf, type ArticulatedSdf } from '../articulatedCollider';
import { parseRig } from '../rig';
import { fixtureAvailable, fixtureBuffer } from '../testFixture';
import { colliderSelfCheck } from './colliderCheck';
import {
  ColliderKernels,
  wasmColliderKernels,
  type ColliderKernelFactory,
} from './colliderKernels';
import { checkColliderKernels } from './motionKernels';

/** Collider kernels whose `method` result is nudged by 1e-12: a forced mismatch. */
const nudged =
  (method: 'distance' | 'surface' | 'exact'): ColliderKernelFactory =>
  (sdf: ArticulatedSdf, pose) => {
    const kernels = new ColliderKernels(sdf, pose);
    if (method === 'surface') {
      const surface = kernels.surface.bind(kernels);
      kernels.surface = (x, y, z, out) => {
        surface(x, y, z, out);
        out[0] += 1e-12;
      };
    } else {
      const query = kernels[method].bind(kernels) as (...args: unknown[]) => number;
      Object.assign(kernels, { [method]: (...args: unknown[]) => query(...args) + 1e-12 });
    }
    return kernels;
  };

describe.skipIf(!fixtureAvailable('rig.bin', 'sdf.bin'))('WebAssembly collider queries', () => {
  const rig = parseRig(fixtureBuffer('rig.bin'));
  const sdf = parseArticulatedSdf(fixtureBuffer('sdf.bin'), rig);

  it('answer the body-data check bit-identically to the JS collider, also after detach', () => {
    expect(colliderSelfCheck(sdf, rig)).toEqual({ ok: true });
  });

  it('the check catches a wrong distance, surface velocity or exact distance', () => {
    for (const method of ['distance', 'surface', 'exact'] as const)
      expect(colliderSelfCheck(sdf, rig, nudged(method)).ok, method).toBe(false);
  });

  it('a failing check falls back to the JS collider and logs once', () => {
    const log = vi.fn();
    expect(checkColliderKernels(sdf, rig, nudged('distance'), log)).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(checkColliderKernels(sdf, rig, wasmColliderKernels, log)).toBe(wasmColliderKernels);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
