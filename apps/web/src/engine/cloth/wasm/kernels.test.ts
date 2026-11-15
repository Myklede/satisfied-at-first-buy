import { describe, expect, it, vi } from 'vitest';
import { ClothSolver } from '../ClothSolver';
import { SolverKernels, wasmKernels, type KernelFactory, type KernelInput } from './kernels';
import { SELF_CHECK_CONFIG, selfCheck, selfCheckAsset, selfCheckRun } from './selfCheck';
import { SOLVER_WASM_SOURCE_SHA256 } from './solverWasm';
import { checkKernels } from '../../motion/wasm/motionKernels';
import { motionWasmRequested } from '../../motion/MotionClient';

/** Kernels with one method replaced by a no-op: a forced JS/WebAssembly mismatch. */
const sabotaged =
  (method: keyof SolverKernels): KernelFactory =>
  (input: KernelInput) => {
    const kernels = new SolverKernels(input);
    Object.assign(kernels, { [method]: () => 0 });
    return kernels;
  };

describe('WebAssembly solver kernels', () => {
  it('are bit-identical to the JS solver on the self-check fixture', () => {
    expect(selfCheck()).toEqual({ ok: true });
    expect(selfCheckRun(SELF_CHECK_CONFIG, wasmKernels)).toEqual(selfCheckRun(SELF_CHECK_CONFIG));
  });

  it('the self-check catches a wrong result in every kernel', () => {
    for (const method of [
      'integrate',
      'resetLambdas',
      'stretch',
      'hinge',
      'tethers',
      'selfCollide',
      'limitHot',
      'limitAfterContact',
      'velocity',
      'contact',
      'layerContact',
    ] as const) {
      const result = selfCheck(sabotaged(method));
      expect(result.ok, method).toBe(false);
    }
  });

  it('the self-check catches different layer pairs from the WebAssembly rebuild', () => {
    const shifted: KernelFactory = (input) => {
      const kernels = new SolverKernels(input),
        rebuild = kernels.rebuildPairs.bind(kernels);
      kernels.rebuildPairs = (...args) => {
        const pairs = rebuild(...args);
        pairs.gap[0] += 1e-9;
        return pairs;
      };
      return kernels;
    };
    expect(selfCheck(shifted).ok).toBe(false);
  });

  it('falls back to JS (undefined), logging once, on a mismatch or a module that fails', () => {
    const log = vi.fn();
    expect(checkKernels(sabotaged('stretch'), log)).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/self-check failed \(differs from JS at fixture step/);
    const failing: KernelFactory = () => {
      throw new WebAssembly.CompileError('no module');
    };
    expect(checkKernels(failing, log)).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(2);
    expect(checkKernels(wasmKernels, log)).toBe(wasmKernels);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('attach and detach keep every number; the views share the wasm memory', () => {
    const asset = selfCheckAsset(SELF_CHECK_CONFIG),
      solver = new ClothSolver(asset, new Float32Array(8).fill(1)),
      before = solver.positions.slice();
    solver.attachKernels(wasmKernels);
    expect(solver.kernelsAttached).toBe(true);
    expect(solver.positions.buffer).not.toBe(before.buffer);
    expect(solver.positions).toEqual(before);
    solver.detachKernels();
    expect(solver.kernelsAttached).toBe(false);
    expect(solver.positions).toEqual(before);
  });

  it('?motionwasm=0 forces the JS solver', () => {
    expect(motionWasmRequested('?kiosk')).toBe(true);
    expect(motionWasmRequested('?kiosk&motionwasm=0')).toBe(false);
    expect(motionWasmRequested('')).toBe(true);
  });

  it('the embedded binary was built from the current solver.as.ts', async () => {
    // `npm run check:wasm` rebuilds it with the pinned compiler and compares the bytes.
    const fsModule = 'node:fs'; // apps/web has no Node types (see motion/testFixture.ts)
    const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
      readFileSync(path: URL): Uint8Array<ArrayBuffer>;
    };
    const source = readFileSync(new URL('./solver.as.ts', import.meta.url)),
      digest = new Uint8Array(await crypto.subtle.digest('SHA-256', source));
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe(SOLVER_WASM_SOURCE_SHA256);
  });
});
