// The live jacket deformer chain (contract.ts "Live jacket deformers"). LiveAvatar runs it after
// the LBS skinning, on the DISPLAY copy of the jacket; the skinned copy (fit readouts) is never
// touched. Order: 'pose-correctives' (agent V7, from v7slot.ts), then 'dynamics' (agent V6).
// A stage that throws or writes a non-finite position is rolled back for that frame and turned
// off until the next jacket binding, with the error in its status: the live view never breaks.
import type { LiveDeformContext, LiveGarmentBinding, LiveJacketDeformer } from '../contract.ts';
import { DYNAMICS } from './config.ts';
import { DynamicsDeformer } from './DynamicsDeformer.ts';
import type { DeformStatus } from './types.ts';
import { createPoseCorrectives } from './v7slot.ts';

export const DEFORMER_ORDER = ['pose-correctives', 'dynamics'] as const;
export type DeformerName = (typeof DEFORMER_ORDER)[number];

type Stage = { deformer: LiveJacketDeformer; enabled: boolean; failed: string | null };

export class DeformerChain {
  private stages: Stage[];
  private scratch = new Float32Array(0);
  private bound = false;

  constructor(deformers: LiveJacketDeformer[]) {
    const rank = (d: LiveJacketDeformer) => DEFORMER_ORDER.indexOf(d.name);
    if (deformers.some((d) => rank(d) < 0)) throw new Error('Unknown deformer');
    this.stages = [...deformers]
      .sort((a, b) => rank(a) - rank(b))
      .map((deformer) => ({ deformer, enabled: true, failed: null }));
  }

  get names() {
    return this.stages.map((s) => s.deformer.name);
  }

  get<T extends LiveJacketDeformer = LiveJacketDeformer>(name: DeformerName): T | undefined {
    return this.stages.find((s) => s.deformer.name === name)?.deformer as T | undefined;
  }

  /** Turns a stage on or off (a stage that is off leaves the positions untouched). */
  setEnabled(name: DeformerName, on: boolean) {
    const stage = this.stages.find((s) => s.deformer.name === name);
    if (!stage) return;
    const d = stage.deformer as LiveJacketDeformer & { setEnabled?: (on: boolean) => void };
    if (d.setEnabled) d.setEnabled(on);
    else stage.enabled = on;
    d.reset();
  }

  bind(binding: LiveGarmentBinding | null) {
    this.bound = binding !== null;
    for (const s of this.stages) {
      s.failed = null;
      try {
        s.deformer.bind(binding);
      } catch (error) {
        s.failed = `bind failed: ${error instanceof Error ? error.message : String(error)}`;
        console.error(`[live] deformer ${s.deformer.name}`, error);
      }
    }
  }

  /** Deforms the display positions (N·3) in place. */
  apply(positions: Float32Array, ctx: LiveDeformContext) {
    if (!this.bound) return;
    for (const s of this.stages) {
      if (!s.enabled || s.failed) continue;
      if (this.scratch.length !== positions.length) this.scratch = new Float32Array(positions.length);
      this.scratch.set(positions);
      try {
        s.deformer.apply(positions, ctx);
        for (let i = 0; i < positions.length; i++)
          if (!Number.isFinite(positions[i])) throw new Error('non-finite position');
      } catch (error) {
        positions.set(this.scratch);
        s.failed = `off after an error: ${error instanceof Error ? error.message : String(error)}`;
        console.error(`[live] deformer ${s.deformer.name}`, error);
      }
    }
  }

  reset() {
    for (const s of this.stages) s.deformer.reset();
  }

  status(): DeformStatus[] {
    return this.stages.map((s) => {
      const own = s.deformer.status();
      if (s.failed) return { name: s.deformer.name, active: false, note: s.failed, lastApplyMs: 0 };
      if (!s.enabled) return { name: s.deformer.name, active: false, note: 'off', lastApplyMs: 0 };
      return { name: s.deformer.name, ...own };
    });
  }

  dispose() {
    for (const s of this.stages) s.deformer.dispose();
  }
}

export type LiveDeformerOptions = {
  /** The 'dynamics' stage on or off (default DYNAMICS.defaultOn). */
  dynamics?: boolean;
  /** false leaves V7's stage out of the chain entirely (tests, A/B of the dynamics alone). */
  poseCorrectives?: boolean;
};

/** The live chain: V7's pose correctives when its slot is filled, then V6's dynamics. */
export function createLiveDeformers(options: LiveDeformerOptions = {}) {
  const stages: LiveJacketDeformer[] = [];
  if (createPoseCorrectives && options.poseCorrectives !== false) stages.push(createPoseCorrectives());
  stages.push(new DynamicsDeformer({ enabled: options.dynamics ?? DYNAMICS.defaultOn }));
  return new DeformerChain(stages);
}
