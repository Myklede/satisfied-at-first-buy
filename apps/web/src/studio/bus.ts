// StudioBus (contract.ts): the one garment state every Studio view follows. Synchronous, tiny.
// Patches are validated and clamped; a patch that changes nothing notifies nobody.
import type { GarmentState, JacketId, SizeLabel, StateSource, StudioBus } from './contract';

const JACKETS: readonly JacketId[] = ['FB7675-100', 'DQ4920-206'];
const SIZES: readonly SizeLabel[] = ['S', 'M', 'L'];

export const DEFAULT_GARMENT_STATE: GarmentState = Object.freeze({
  jacket: 'FB7675-100',
  size: 'M',
  zip: 0,
  hoodOn: true,
  hemPull: 0,
});

type Listener = (next: GarmentState, prev: GarmentState, source: StateSource) => void;

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Returns the patched state, or throws on an invalid value (a programming error, not user input). */
export function applyPatch(prev: GarmentState, patch: Partial<GarmentState>): GarmentState {
  const next: GarmentState = { ...prev };
  if (patch.jacket !== undefined) {
    if (!JACKETS.includes(patch.jacket)) throw new Error(`unknown jacket ${String(patch.jacket)}`);
    next.jacket = patch.jacket;
  }
  if (patch.size !== undefined) {
    if (!SIZES.includes(patch.size)) throw new Error(`unknown size ${String(patch.size)}`);
    next.size = patch.size;
  }
  if (patch.zip !== undefined) {
    if (!Number.isFinite(patch.zip)) throw new Error('zip must be a finite number');
    next.zip = clamp01(patch.zip);
  }
  if (patch.hemPull !== undefined) {
    if (!Number.isFinite(patch.hemPull)) throw new Error('hemPull must be a finite number');
    next.hemPull = clamp01(patch.hemPull);
  }
  if (patch.hoodOn !== undefined) next.hoodOn = patch.hoodOn === true;
  return next;
}

function same(a: GarmentState, b: GarmentState): boolean {
  return (
    a.jacket === b.jacket &&
    a.size === b.size &&
    a.zip === b.zip &&
    a.hoodOn === b.hoodOn &&
    a.hemPull === b.hemPull
  );
}

export function createStudioBus(initial: Partial<GarmentState> = {}): StudioBus {
  let state = applyPatch(DEFAULT_GARMENT_STATE, initial);
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    set(patch, source) {
      const next = applyPatch(state, patch);
      if (same(next, state)) return;
      const prev = state;
      state = Object.freeze(next);
      for (const fn of [...listeners]) {
        try {
          fn(state, prev, source);
        } catch (err) {
          // One broken view must not stop the others from following the garment.
          console.error('StudioBus listener failed', err);
        }
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
