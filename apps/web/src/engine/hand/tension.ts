// Tension readout for the hand pull (prompts/06 F3). Pure functions, no DOM or Three.js: runs in
// the cloth worker (patchFollow, inside PullDriver.tick, read-only) and on the main thread.
// Observation only: nothing here writes solver state.
import { HAND_TENSION, type HandTensionConfig } from './config.ts';

/** Centimetres per inch (exact, by definition of the international inch). */
const CM_PER_INCH = 2.54;

/**
 * Displacement of the grab (m, scene frame) measured on the patch particles.
 *
 * The driver moves patch particle j toward base_j + w_j·d (w = patch weight, 1 at the grab
 * point). The returned vector is the least-squares d for the particles' MEASURED positions:
 * d = Σ w_j (p_j − base_j) / Σ w_j². It equals the applied target when the patch sits exactly
 * on its targets and is smaller when the fabric's constraints hold the patch back.
 *
 * `positions` holds all particles (xyz); `ids`/`weights` the patch; `base` the patch particles'
 * positions at grab start (xyz per patch particle, same order as `ids`).
 */
export function patchFollow(
  positions: ArrayLike<number>,
  ids: ArrayLike<number>,
  weights: ArrayLike<number>,
  base: ArrayLike<number>,
): [number, number, number] {
  if (ids.length !== weights.length || base.length !== ids.length * 3)
    throw new Error('Patch follow: ids, weights and base sizes differ');
  let sx = 0,
    sy = 0,
    sz = 0,
    ww = 0;
  for (let j = 0; j < ids.length; j++) {
    const id = ids[j],
      w = weights[j];
    sx += w * (positions[id * 3] - base[j * 3]);
    sy += w * (positions[id * 3 + 1] - base[j * 3 + 1]);
    sz += w * (positions[id * 3 + 2] - base[j * 3 + 2]);
    ww += w * w;
  }
  if (!(ww > 0)) return [0, 0, 0];
  return [sx / ww, sy / ww, sz / ww];
}

export interface TensionSample {
  /** Sample time (s, any monotonic clock). */
  t: number;
  /** |follow| (m): how far the grabbed fabric has moved from rest. */
  follow: number;
  /** |hand request − follow| (m): how far the hand is ahead of the fabric. */
  gap: number;
}

/**
 * "Taut" = the fabric stopped following the hand: the hand is at least `tautGapM` ahead of the
 * fabric AND the fabric gained at most `plateauGrowthM` over the last `plateauWindowS`. It ends
 * when the gap falls below `tautExitGapM` or the fabric gains more than `plateauGrowthM` over
 * the window again. Constants and their reasons: HAND_TENSION in config.ts.
 */
export class TautDetector {
  private samples: TensionSample[] = [];
  taut = false;
  /** Largest follow seen since reset (m). */
  maxFollow = 0;
  /** Samples flagged taut since reset. */
  tautSamples = 0;
  constructor(private cfg: HandTensionConfig = HAND_TENSION) {}

  reset() {
    this.samples = [];
    this.taut = false;
    this.maxFollow = 0;
    this.tautSamples = 0;
  }

  update(sample: TensionSample): boolean {
    if (![sample.t, sample.follow, sample.gap].every(Number.isFinite))
      throw new Error('Tension sample must be finite');
    const cfg = this.cfg,
      list = this.samples;
    list.push(sample);
    // Keep exactly one sample at or before the window start (the reference for the growth).
    while (list.length > 2 && list[1].t <= sample.t - cfg.plateauWindowS) list.shift();
    this.maxFollow = Math.max(this.maxFollow, sample.follow);
    const first = list[0],
      covered = sample.t - first.t >= cfg.plateauWindowS,
      growth = sample.follow - Math.min(...list.map((s) => s.follow)),
      plateau = covered && growth <= cfg.plateauGrowthM;
    if (this.taut) this.taut = sample.gap >= cfg.tautExitGapM && growth <= cfg.plateauGrowthM;
    else this.taut = plateau && sample.gap >= cfg.tautGapM;
    if (this.taut) this.tautSamples++;
    return this.taut;
  }
}

/** "1.9 cm · 0.75 in": centimetres (1 decimal) and inches (2 decimals). */
export function formatFollow(metres: number): string {
  if (!Number.isFinite(metres)) return '—';
  const cm = Math.max(0, metres) * 100;
  return `${cm.toFixed(1)} cm · ${(cm / CM_PER_INCH).toFixed(2)} in`;
}

/** Fit id and size from a cloth asset key (`{fit_id}:{size}:{asset version}:{pose version}`). */
export function parseAssetKey(key: string): { fit: string; size: string } | undefined {
  const parts = key.split(':');
  if (parts.length !== 4 || !parts[0] || !parts[1]) return undefined;
  return { fit: parts[0], size: parts[1] };
}

export interface SizeFollow {
  size: string;
  /** Largest follow over the judge's own pulls (m); undefined until a pull ended. */
  handMaxM?: number;
  handTaut?: boolean;
  /** Last standard pull (fixed point and direction): largest follow (m) and whether it went taut. */
  standardM?: number;
  standardTaut?: boolean;
}

/**
 * Measured follow per size for ONE fit (one judge's body + jacket). Recording a different fit
 * forgets the previous one, so a new judge never sees the last judge's numbers.
 */
export class FollowLog {
  private fit?: string;
  private sizes = new Map<string, SizeFollow>();

  private entry(fit: string, size: string) {
    if (fit !== this.fit) {
      this.fit = fit;
      this.sizes.clear();
    }
    let e = this.sizes.get(size);
    if (!e) this.sizes.set(size, (e = { size }));
    return e;
  }

  recordHand(fit: string, size: string, followM: number, taut: boolean) {
    if (!Number.isFinite(followM) || followM < 0) throw new Error('Follow must be finite, ≥ 0');
    const e = this.entry(fit, size);
    if (e.handMaxM === undefined || followM > e.handMaxM) {
      e.handMaxM = followM;
      e.handTaut = taut;
    } else if (followM === e.handMaxM) e.handTaut ||= taut;
  }

  recordStandard(fit: string, size: string, followM: number, taut: boolean) {
    if (!Number.isFinite(followM) || followM < 0) throw new Error('Follow must be finite, ≥ 0');
    const e = this.entry(fit, size);
    e.standardM = followM;
    e.standardTaut = taut;
  }

  /** Entries for `fit` (empty for any other fit), sorted with `order`. */
  entries(fit: string | undefined, order: (sizes: string[]) => string[] = (s) => s) {
    if (!fit || fit !== this.fit) return [];
    return order([...this.sizes.keys()]).map((size) => ({ ...this.sizes.get(size)! }));
  }

  clear() {
    this.fit = undefined;
    this.sizes.clear();
  }
}
