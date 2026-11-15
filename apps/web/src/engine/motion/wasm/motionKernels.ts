// Which solver the motion worker bakes with: the WebAssembly kernels (cloth/wasm/kernels.ts) when
// they pass the start-up self-check (cloth/wasm/selfCheck.ts), plain JS otherwise. The judge
// never sees the difference: both give the same bits, JS is only slower. `?motionwasm=0` on the
// page (MotionClient.motionWasmRequested) forces JS for A/B measurements.
import { wasmKernels, type KernelFactory } from '../../cloth/wasm/kernels.ts';
import { selfCheck } from '../../cloth/wasm/selfCheck.ts';
import type { ArticulatedSdf } from '../articulatedCollider.ts';
import type { MotionRig } from '../rig.ts';
import { colliderSelfCheck } from './colliderCheck.ts';
import { wasmColliderKernels, type ColliderKernelFactory } from './colliderKernels.ts';

/** Runs the self-check on `candidate`; the factory if it passed, else undefined (logged once). */
export function checkKernels(
  candidate: KernelFactory,
  log: (message: string) => void = console.warn,
): KernelFactory | undefined {
  const result = selfCheck(candidate);
  if (result.ok) return candidate;
  log(`Motion bakes use the JS solver: WebAssembly self-check failed (${result.reason}).`);
  return undefined;
}

let decided: { kernels?: KernelFactory } | undefined;
/** The kernels for this thread's bakes (checked once per thread), or undefined for JS. */
export function motionKernels(enabled: boolean): KernelFactory | undefined {
  if (!enabled) return undefined;
  decided ??= { kernels: checkKernels(wasmKernels) };
  return decided.kernels;
}

/**
 * The WebAssembly collider for this body (checked on the body's own data, once per body), or
 * undefined for the JS collider (logged once per body).
 */
export function checkColliderKernels(
  sdf: ArticulatedSdf,
  rig: MotionRig,
  candidate: ColliderKernelFactory = wasmColliderKernels,
  log: (message: string) => void = console.warn,
): ColliderKernelFactory | undefined {
  const result = colliderSelfCheck(sdf, rig, candidate);
  if (result.ok) return candidate;
  log(`Motion bakes use the JS collider: WebAssembly self-check failed (${result.reason}).`);
  return undefined;
}
