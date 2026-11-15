// Solver side of the hand pull (M4). Runs in the cloth worker and, unchanged, in Node tests.
// No DOM, Three.js or worker dependencies.
//
// Each display frame (`tick`):
//  1. the requested hand displacement is rate-limited (maxTargetSpeed) and capped by `reach`,
//     the largest displacement the fabric accepted so far plus reachGrowth·dt;
//  2. a trial step runs with the patch targets = rest + weight × displacement;
//  3. if any region edge is longer than rest × (its limit + strainMargin), the step is undone
//     and retried with a smaller displacement (clampTrials × clampShrink). The grab "slips":
//     the target stops following the hand and `resisting` is reported for the amber cursor;
//  4. a few hard strain passes (clampPasses) catch what the last trial left.
// Only the local region runs (ClothSolver.setRegion); the rest of the garment is kinematic.
import type { ClothSolver, RegionStrain } from '../cloth/ClothSolver';
import { HAND_PULL, type HandPullConfig } from './config.ts';
import { patchFollow } from './tension.ts';

export type PullPhase = 'idle' | 'pulling' | 'releasing';

export interface PullFrame {
  phase: PullPhase;
  /** Wall time of this frame's solver work (all trials), ms. */
  stepMs: number;
  trials: number;
  /** |requested| and |applied| displacement (m). */
  requested: number;
  applied: number;
  /** Applied displacement vector (m). */
  displacement: [number, number, number];
  resisting: boolean;
  strain: RegionStrain;
  /** Region strain excess at grab start, after removing solver residue above the clamp. */
  baselineExcess: number;
  /**
   * Largest (length − allowed) / rest over region edges, allowed = max(limit + margin, the
   * edge's length at grab start). ≤ 0: no edge was stretched beyond the clamp by the hand.
   */
  overClamp: number;
  particles: number;
  /**
   * Observation only (tension readout, prompts/06 F3): the grab's displacement measured on the
   * patch particles after this frame (tension.ts patchFollow), m; zero unless pulling.
   */
  follow: [number, number, number];
  /** |hand request − follow| (m): how far the hand is ahead of the fabric; 0 unless pulling. */
  gap: number;
}

const length3 = (v: ArrayLike<number>) => Math.hypot(v[0], v[1], v[2]);
/** Smallest reach probe (m) and the pause after it is rejected (frames); numerical choices. */
const MIN_PROBE_M = 0.0005;
const HOLD_FRAMES = 10;

/** Moves `from` toward `to` by at most `step` (Euclidean). Pure; exported for tests. */
export function stepToward(
  from: readonly number[],
  to: readonly number[],
  step: number,
): [number, number, number] {
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]],
    n = length3(d);
  if (n <= step || n === 0) return [to[0], to[1], to[2]];
  const f = step / n;
  return [from[0] + d[0] * f, from[1] + d[1] * f, from[2] + d[2] * f];
}

/** Scales v so its length is at most `limit`. Pure; exported for tests. */
export function clampLength(v: readonly number[], limit: number): [number, number, number] {
  const n = length3(v);
  if (n <= limit || n === 0) return [v[0], v[1], v[2]];
  const f = Math.max(0, limit) / n;
  return [v[0] * f, v[1] * f, v[2] * f];
}

export class PullDriver {
  phase: PullPhase = 'idle';
  private ids = new Int32Array(0);
  private weights = new Float64Array(0);
  private base = new Float64Array(0);
  private request: [number, number, number] = [0, 0, 0];
  private applied: [number, number, number] = [0, 0, 0];
  private reach = 0;
  /** Reach growth allowed this frame (m); halves after each rejection, see tick(). */
  private probe = 0;
  /** Frames left without probing after the minimum probe was rejected (at the fabric limit). */
  private hold = 0;
  private centres: number[] = [];
  private releasedAt = 0;
  private clock = 0;
  private baseline = 0;
  private targets: number[] = [];
  private idList: number[] = [];

  readonly solver: ClothSolver;
  private cfg: HandPullConfig;
  constructor(solver: ClothSolver, cfg: HandPullConfig = HAND_PULL) {
    this.solver = solver;
    this.cfg = cfg;
  }

  /** Clamp limit for edge e expressed as excess over its own limit (see config). */
  get margin() {
    return this.cfg.strainMargin;
  }

  /**
   * Starts a grab of `ids` (patch particles) with `weights` (0..1, 1 at the patch centre).
   * The local region is centred on `centre` (plus a previous region still springing back).
   */
  begin(ids: readonly number[], weights: readonly number[], centre: readonly number[]) {
    if (ids.length === 0 || ids.length !== weights.length) throw new Error('Invalid grab patch');
    if (centre.length !== 3 || !centre.every(Number.isFinite)) throw new Error('Invalid centre');
    if (!weights.every((w) => w > 0 && w <= 1)) throw new Error('Patch weights must be in (0, 1]');
    this.solver.release();
    this.centres =
      this.phase === 'releasing' ? [...this.centres.slice(-3), ...centre] : [...centre];
    this.solver.setRegion(
      this.centres,
      this.cfg.regionRadiusM,
      this.cfg.regionBlendM,
      this.cfg.regionFrozenPanels,
    );
    const m = this.solver.inverseMass,
      keep = ids.map((id, j) => [id, weights[j]] as const).filter(([id]) => m[id] > 0);
    if (!keep.length) throw new Error('Grab patch outside the moving region');
    this.ids = Int32Array.from(keep.map(([id]) => id));
    this.weights = Float64Array.from(keep.map(([, w]) => w));
    this.idList = Array.from(this.ids);
    // Clamp edges = patch border. Solver residue above the clamp there is removed before the
    // hand acts; what cannot be removed (pinned against the kinematic remainder) may stay but
    // the hand never lengthens it (per-edge floor = length now).
    this.solver.freezeStrainFloor(centre, this.cfg.clampRadiusM);
    this.solver.clampStrain(this.cfg.strainMargin, 60);
    this.baseline = Math.max(0, this.solver.regionStrain().maxExcess);
    this.solver.freezeStrainFloor(centre, this.cfg.clampRadiusM);
    const p = this.solver.positions;
    this.base = Float64Array.from(
      this.idList.flatMap((id) => [p[id * 3], p[id * 3 + 1], p[id * 3 + 2]]),
    );
    this.request = [0, 0, 0];
    this.applied = [0, 0, 0];
    this.reach = 0;
    this.probe = this.cfg.reachGrowth * this.solver.asset.config.dt;
    this.hold = 0;
    this.targets = Array.from(this.base);
    this.solver.grab(this.idList, this.targets);
    this.phase = 'pulling';
  }

  /** Requested hand displacement (m, scene frame) since grab start. */
  setRequest(displacement: readonly number[]) {
    if (displacement.length !== 3 || !displacement.every(Number.isFinite))
      throw new Error('Invalid displacement');
    this.request = clampLength(displacement, this.cfg.maxReachM);
  }

  end() {
    if (this.phase !== 'pulling') return;
    this.solver.release();
    this.phase = 'releasing';
    this.releasedAt = this.clock;
  }

  /** Stops everything at once (exit): the garment stays where it is, nothing moves. */
  stop() {
    this.solver.release();
    this.solver.clearRegion();
    this.phase = 'idle';
  }

  /** Region particles at rest where they are (velocity 0, previous = current). */
  private stopRegionMotion() {
    const ids = this.solver.activeRegion?.particles;
    if (!ids) return;
    const { positions, previous, velocity } = this.solver;
    for (const id of ids)
      for (let a = 0; a < 3; a++) {
        previous[id * 3 + a] = positions[id * 3 + a];
        velocity[id * 3 + a] = 0;
      }
  }

  private setTargets(d: readonly number[]) {
    const t = this.targets,
      b = this.base,
      w = this.weights;
    for (let j = 0; j < w.length; j++) {
      t[j * 3] = b[j * 3] + d[0] * w[j];
      t[j * 3 + 1] = b[j * 3 + 1] + d[1] * w[j];
      t[j * 3 + 2] = b[j * 3 + 2] + d[2] * w[j];
    }
    this.solver.move(this.idList, t);
  }

  /** One display frame (solver dt). Returns null when idle (nothing moves, nothing to draw). */
  tick(now: () => number = () => performance.now()): PullFrame | null {
    if (this.phase === 'idle') return null;
    const started = now(),
      cfg = this.cfg,
      dt = this.solver.asset.config.dt,
      margin = this.cfg.strainMargin,
      /** Numerical tolerance on the clamp check (relative length; 1e-6 = 1 µm per metre). */
      tolerance = 1e-6;
    this.clock += dt;
    let trials = 0,
      strain: RegionStrain;
    if (this.phase === 'pulling') {
      let candidate = stepToward(this.applied, this.request, cfg.maxTargetSpeed * dt);
      const growth = cfg.reachGrowth * dt,
        limit = Math.min(cfg.maxReachM, this.reach + (this.hold > 0 ? 0 : this.probe)),
        probing = length3(candidate) > this.reach;
      candidate = clampLength(candidate, limit);
      const saved = this.solver.saveRegionState();
      let shrunk = false;
      for (;;) {
        this.setTargets(candidate);
        this.solver.step();
        trials++;
        strain = this.solver.regionStrain();
        if (this.solver.overClamp(margin) <= tolerance || trials > cfg.clampTrials) break;
        this.solver.restoreRegionState(saved);
        // Second try: last frame's accepted displacement (valid one frame ago, so it usually
        // passes: a typical frame costs at most two region steps). Then shrink.
        const previous = this.applied;
        candidate =
          trials === 1 && length3(previous) < length3(candidate)
            ? [previous[0], previous[1], previous[2]]
            : [
                candidate[0] * cfg.clampShrink,
                candidate[1] * cfg.clampShrink,
                candidate[2] * cfg.clampShrink,
              ];
        shrunk = true;
      }
      // Hard passes until the clamp holds (Gauss-Seidel on conflicting edge chains converges
      // slowly; bounded so a pathological case cannot stall the worker).
      for (let round = 0; round < 4 && this.solver.overClamp(margin) > tolerance; round++) {
        this.solver.clampStrain(margin, cfg.clampPasses);
        strain = this.solver.regionStrain();
      }
      if (this.solver.overClamp(margin) > tolerance) {
        // Still over: the fabric's own motion (e.g. the swing of a release grabbed again before
        // it settled) stretched clamp edges that no hand target relaxes. Keep the last accepted
        // frame (within the clamp) and stop that motion, so the clamp holds in every frame.
        this.solver.restoreRegionState(saved);
        this.stopRegionMotion();
        candidate = [this.applied[0], this.applied[1], this.applied[2]];
        this.setTargets(candidate);
        strain = this.solver.regionStrain();
        shrunk = true;
      }
      this.applied = candidate;
      const size = length3(candidate);
      this.reach = shrunk ? size : Math.max(this.reach, size);
      // Adaptive probe: at the fabric limit the reach would otherwise grow and be rejected on
      // alternate frames (a visible 2 mm flicker). Each rejection halves the probe (down to
      // 0.5 mm); accepted probes restore it; a hand that eases off restores it fully.
      // At the limit (smallest probe rejected) probing pauses for HOLD_FRAMES, so a pull held
      // against the fabric costs one region step per frame instead of two.
      if (this.hold > 0) this.hold--;
      if (shrunk) {
        if (this.probe <= MIN_PROBE_M) this.hold = HOLD_FRAMES;
        this.probe = Math.max(MIN_PROBE_M, this.probe * 0.5);
      } else if (probing) this.probe = Math.min(growth, this.probe * 1.5);
      else {
        this.probe = growth;
        this.hold = 0;
      }
    } else {
      this.solver.step();
      trials = 1;
      strain = this.solver.regionStrain();
      const since = this.clock - this.releasedAt;
      if (
        since >= cfg.releaseMaxS ||
        (since >= cfg.releaseMinS && this.solver.regionEnergy() < cfg.settleEnergy)
      ) {
        this.solver.clearRegion();
        this.phase = 'idle';
      }
    }
    if (!this.solver.positions.every(Number.isFinite)) {
      this.stop();
      throw new Error('Cloth solver became non-finite during the pull');
    }
    const requested = length3(this.request),
      pulling = this.phase === 'pulling',
      applied = pulling ? length3(this.applied) : 0,
      // Read-only measurement of the particles this frame produced (no solver state written).
      follow = pulling
        ? patchFollow(this.solver.positions, this.ids, this.weights, this.base)
        : ([0, 0, 0] as [number, number, number]),
      gap = pulling
        ? Math.hypot(
            this.request[0] - follow[0],
            this.request[1] - follow[1],
            this.request[2] - follow[2],
          )
        : 0;
    return {
      phase: this.phase,
      stepMs: now() - started,
      trials,
      requested,
      applied,
      displacement: [...this.applied],
      resisting: this.phase === 'pulling' && requested - applied > cfg.resistShowM,
      strain,
      baselineExcess: this.baseline,
      overClamp: this.solver.activeRegion ? this.solver.overClamp(margin) : 0,
      particles: this.solver.activeRegion?.particles.length ?? 0,
      follow,
      gap,
    };
  }
}
