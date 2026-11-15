// Start-up check of the WebAssembly collider queries on the judge's own body data (the motion
// worker's `body` message): a JS ArticulatedCollider and one with kernels answer the same
// deterministic query sequence (points around the skin, two poses, gradients, thresholds, cache
// hits, surface velocity, exact distance) and every float64 must match. Any difference or
// failure means the bake keeps the JS collider. Body data stays in memory.
import { ArticulatedCollider, type ArticulatedSdf } from '../articulatedCollider.ts';
import { DRIVER_STRIDE, type MotionRig } from '../rig.ts';
import { wasmColliderKernels, type ColliderKernelFactory } from './colliderKernels.ts';
import type { SelfCheckResult } from '../../cloth/wasm/selfCheck.ts';

/** Two poses: the rest pose, then every driver shifted a little (a moving body). */
function poses(rig: MotionRig) {
  const rest = new Float64Array(rig.drivers.length * DRIVER_STRIDE),
    moved = new Float64Array(rest.length);
  for (let d = 0; d < rig.drivers.length; d++) {
    const o = d * DRIVER_STRIDE;
    rest[o] = rest[o + 5] = rest[o + 10] = 1;
    moved.set(rest.subarray(o, o + 12), o);
    moved[o + 3] = 0.004 * Math.sin(d);
    moved[o + 7] = 0.003 * Math.cos(d);
    moved[o + 11] = -0.002 * Math.sin(2 * d);
  }
  return [rest, moved];
}

/** The query sequence; returns every output in order. */
export function colliderTrace(collider: ArticulatedCollider, rig: MotionRig, stride = 41) {
  const out: number[] = [],
    g = new Float64Array(3),
    v = new Float64Array(3),
    [rest, moved] = poses(rig);
  let seed = 12345;
  const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  for (const [current, previous] of [
    [rest, rest],
    [moved, rest],
  ]) {
    collider.setFrame(current, previous, 1 / 60);
    for (let i = 0; i < rig.vertexCount; i += stride) {
      const k = i * 3,
        x = rig.restVertices[k] + 0.03 * random(),
        y = rig.restVertices[k + 1] + 0.03 * random(),
        z = rig.restVertices[k + 2] + 0.03 * random();
      g.fill(7);
      out.push(collider.distance(x, y, z, g, 0.012), ...g);
      out.push(collider.distance(x + 0.0003, y, z - 0.0002, g, 0.012), ...g); // cache neighbour
      collider.surfaceVelocity(x + 0.0003, y, z - 0.0002, v);
      out.push(...v);
      collider.surfaceVelocity(x, y + 0.002, z, v); // a new point: queries first
      out.push(...v);
      out.push(collider.distance(x, y, z), collider.distance(x, y, z, g, Infinity), ...g);
      if (i % (stride * 4) === 0) out.push(collider.exactDistance(x, y, z, 0.02));
    }
  }
  return Float64Array.from(out);
}

/** JS against `factory`; ok only when both traces are bit-identical, also after detaching. */
export function colliderSelfCheck(
  sdf: ArticulatedSdf,
  rig: MotionRig,
  factory: ColliderKernelFactory = wasmColliderKernels,
): SelfCheckResult {
  try {
    const js = new ArticulatedCollider(sdf, rig).setFrame(poses(rig)[0]),
      wasm = new ArticulatedCollider(sdf, rig).setFrame(poses(rig)[0]);
    wasm.attachKernels(factory);
    const a = colliderTrace(js, rig),
      b = colliderTrace(wasm, rig);
    // Detach copies the query state back: both must continue identically in JS.
    wasm.detachKernels();
    const a2 = colliderTrace(js, rig, 97),
      b2 = colliderTrace(wasm, rig, 97);
    const same = (p: Float64Array, q: Float64Array) => {
      const u = new Uint8Array(p.buffer),
        w = new Uint8Array(q.buffer);
      return u.length === w.length && u.every((byte, i) => byte === w[i]);
    };
    if (!same(a, b)) return { ok: false, reason: 'collider queries differ from JS' };
    if (!same(a2, b2)) return { ok: false, reason: 'collider state differs after detach' };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
