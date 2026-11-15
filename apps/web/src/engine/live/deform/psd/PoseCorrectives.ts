// The 'pose-correctives' live jacket deformer (agent V7; contract.ts LiveJacketDeformer).
// On bind it learns this body + size's pose → cloth-shape map from TRUE cloth solves (a bake in
// Web Workers, model.ts), and on every frame adds the interpolated correction to the skinned
// jacket, faded in once the first poses are learnt. Before that, and whenever the pose is unknown,
// it is a no-op that says why in status().note. No temporal state; the basis stays 'preview' and
// the fit readouts never see it (they come from the skinned jacket before the chain).
// Models are cached in memory by binding.key for the session only: the kiosk stores no profile,
// so nothing body-derived is written to disk (no IndexedDB).
import type { LiveDeformContext, LiveGarmentBinding, LiveJacketDeformer } from '../../contract.ts';
import { PSD } from './config.ts';
import { PsdEvaluator, type PsdModelData } from './model.ts';

/** Progress of a running bake, for the note. */
export type PsdProgress = { learnt: number; total: number };

/** Runs the bake for one binding; calls onModel with each refit (done = the last one). */
export type PsdBaker = (
  binding: LiveGarmentBinding,
  onModel: (model: PsdModelData, progress: PsdProgress, done: boolean) => void,
  signal: AbortSignal,
) => Promise<void>;

export type PoseCorrectivesOptions = {
  baker: PsdBaker;
  /** Default true; the baker decides per product (PSD.defaultOnStyles). The labs pass `?psd=0`. */
  enabled?: boolean;
  /** Clock (ms), for the fade-in; default performance.now. */
  now?: () => number;
  /** Shared session cache (default: one per module). */
  cache?: Map<string, PsdModelData>;
};

/** The baker's refusal for a product that is not enabled (PSD.defaultOnStyles): not a failure. */
export class PsdNotEnabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PsdNotEnabledError';
  }
}

/** Session-only memory cache of finished models, by binding.key (a few bindings). */
const sessionCache = new Map<string, PsdModelData>();
const CACHE_ENTRIES = 4;

export class PoseCorrectives implements LiveJacketDeformer {
  readonly name = 'pose-correctives' as const;
  private binding: LiveGarmentBinding | null = null;
  private evaluator: PsdEvaluator | null = null;
  private readyAt = 0;
  private enabled: boolean;
  private note = 'no jacket';
  private lastApplyMs = 0;
  private abort: AbortController | null = null;
  private baker: PsdBaker;
  private now: () => number;
  private cache: Map<string, PsdModelData>;
  /** Progress of the bake behind the current model (diagnostics, the labs' HUD). */
  progress: PsdProgress | null = null;

  constructor(options: PoseCorrectivesOptions) {
    this.baker = options.baker;
    this.enabled = options.enabled ?? true;
    this.now = options.now ?? (() => performance.now());
    this.cache = options.cache ?? sessionCache;
  }

  /** The learnt model (null before the first poses are learnt). */
  get model() {
    return this.evaluator?.model ?? null;
  }

  /** Off: no bake runs (no workers, no CPU); turning it on starts the bake of the bound jacket. */
  setEnabled(on: boolean) {
    this.enabled = on;
    if (on && this.binding && !this.evaluator && !this.abort) this.start(this.binding);
  }

  bind(binding: LiveGarmentBinding | null) {
    this.abort?.abort();
    this.abort = null;
    this.binding = binding;
    this.evaluator = null;
    this.progress = null;
    if (!binding) {
      this.note = 'no jacket';
      return;
    }
    const cached = this.cache.get(binding.key);
    if (cached && cached.count === binding.count) {
      this.use(cached, this.now());
      this.note = `ready (${cached.samples.length} poses, cached)`;
      return;
    }
    if (!this.enabled) {
      this.note = 'off';
      return;
    }
    this.start(binding);
  }

  private start(binding: LiveGarmentBinding) {
    this.note = 'learning the jacket: true cloth solves of key poses';
    const abort = new AbortController();
    this.abort = abort;
    this.baker(
      binding,
      (model, progress, done) => {
        if (abort.signal.aborted || this.binding !== binding) return;
        if (model.count !== binding.count) throw new Error('PSD model does not match the jacket');
        const first = !this.evaluator;
        this.use(model, first ? this.now() : this.readyAt);
        this.progress = progress;
        this.note = done
          ? `ready (${progress.learnt} poses)`
          : `learning: ${progress.learnt} of ${progress.total} poses`;
        if (done) {
          this.cache.set(binding.key, model);
          while (this.cache.size > CACHE_ENTRIES)
            this.cache.delete(this.cache.keys().next().value!);
        }
      },
      abort.signal,
    ).catch((error: unknown) => {
      if (abort.signal.aborted) return;
      this.abort = null;
      if (error instanceof PsdNotEnabledError) {
        this.note = `off: ${error.message}`;
        return;
      }
      this.note = `bake failed: ${error instanceof Error ? error.message : String(error)}`;
      console.warn('[live] pose correctives', error);
    });
  }

  private use(model: PsdModelData, readyAt: number) {
    this.evaluator = new PsdEvaluator(model);
    this.readyAt = readyAt;
    this.guardChecked = null;
  }

  /** Particles the body guard moved in the last frame (diagnostics). */
  guarded = 0;
  private guardChecked: { body: number; ok: boolean } | null = null;
  /** Every guard vertex index lies inside the posed body array (checked once per body size). */
  private guardFits(vertex: Uint32Array, body: Float32Array) {
    if (this.guardChecked?.body !== body.length) {
      let max = 0;
      for (const v of vertex) if (v !== 0xffffffff && v > max) max = v;
      this.guardChecked = { body: body.length, ok: max * 3 + 2 < body.length };
    }
    return this.guardChecked.ok;
  }

  apply(positions: Float32Array, ctx: LiveDeformContext) {
    this.lastApplyMs = 0;
    const ev = this.evaluator,
      binding = this.binding;
    if (!this.enabled || !ev || !binding || !ctx.pose) return;
    const started = performance.now();
    const gain = Math.min(1, Math.max(0, (this.now() - this.readyAt) / PSD.fadeInMs));
    // The body guard needs the posed body and its normals (LiveAvatar passes both); without them
    // (or with a body of another size) it is skipped.
    const guard = ev.model.guard;
    const normals = (ctx as LiveDeformContext & { bodyNormals?: Float32Array }).bodyNormals;
    const body =
      guard &&
      normals &&
      normals.length === ctx.bodyPositions.length &&
      this.guardFits(guard.candidates, ctx.bodyPositions)
        ? { positions: ctx.bodyPositions, normals }
        : null;
    ev.apply(ctx.pose, ctx.drivers, binding, positions, gain, body);
    this.guarded = ev.guarded;
    this.lastApplyMs = performance.now() - started;
  }

  reset() {
    // No temporal state.
  }

  status() {
    let note = this.note;
    if (!this.enabled) note = 'off';
    else if (this.evaluator && this.binding === null) note = 'no jacket';
    return {
      active: this.enabled && this.evaluator !== null && this.binding !== null,
      note,
      lastApplyMs: this.lastApplyMs,
    };
  }

  dispose() {
    this.abort?.abort();
    this.abort = null;
    this.binding = null;
    this.evaluator = null;
  }
}
