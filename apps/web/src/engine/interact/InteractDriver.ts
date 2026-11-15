// Solver side of the interactive zip and hood (agent Z). Runs in the cloth worker (live path)
// and, unchanged, in Node tests. No DOM, Three.js or worker dependencies.
//
// The closed jacket is never touched: the base solver (the shell the fit was measured on, plus
// the hand pull) keeps its state while this driver runs a *second* solver on the split asset
// (seam.ts). Its particles start where the base solver's are. Each display frame:
//  1. the slider moves toward its target (rate-limited) and sets which zip teeth are closed;
//     the hood's zip opens/closes with the hand's distance (zipMath.hoodProgressFromDistance);
//  2. the split solver runs the base solver's substeps one at a time (config.substeps = 1 with
//     dt / substeps: the same h, gravity, damping, compliances), and after each substep the
//     closed teeth are welded (weld.ts). Only a region round the opened parts moves;
//  3. open teeth are free cloth edges: the fronts hang under gravity with body contact.
import { ClothSolver, type BodyCollider, type ClothAsset } from '../cloth/ClothSolver.ts';
import { INTERACT, splitMaterial } from './config.ts';
import { expandPositions, PANEL, splitSeams, type SeamSplit, type ZipLine } from './seam.ts';
import { weldPairs, type WeldSet } from './weld.ts';
import {
  approach,
  clampSlider,
  hoodFrontier,
  hoodProgressFromDistance,
  nextHoodState,
  teethForProgress,
  teethForSlider,
  type HoodState,
} from './zipMath.ts';

export interface InteractFrame {
  /** Wall time of this frame's solver work (ms). */
  stepMs: number;
  /** Slider position (m of zip arc from the collar top) and the zip length (m). */
  slider: number;
  zipLength: number;
  openTeeth: number;
  /** Largest gap (m) between the two sides of any open pair (how far the fronts opened). */
  maxGapM: number;
  hood: HoodState | null;
  hoodProgress: number;
  /** The detached hood is held where the judge let go (see hoodEnd). */
  hooked: boolean;
  /**
   * The hood's rigid transform from its place on the shell (row-major 3×4: x' = M·[x, 1]),
   * for agent H's authored hood (HoodLayer.setRigidTransform); null without a hood.
   */
  hoodMatrix: number[] | null;
  /**
   * The hand's displacement of the hood (m) from its place on the collar: H's padded hood takes
   * it as the rigid move of its lifted part (HoodLayer.setRigidTransform weights it per seam
   * point by how far it has lifted; its own peel keys do the turn). Zero without a hood.
   */
  hoodHand: [number, number, number];
  grabbing: boolean;
  /** Kinetic energy (J) of the moving particles. */
  energy: number;
  particles: number;
  /** Everything closed and at rest: the view may return to the measured shell. */
  restful: boolean;
}

export type GrabKind = 'hood' | 'fabric';

interface Grab {
  kind: GrabKind;
  ids: Int32Array;
  weights: Float64Array;
  base: Float64Array;
  request: [number, number, number];
  /** The hand, rate-limited (drives the hood's zip). */
  hand: [number, number, number];
  /** The cloth target actually applied (hand, held back where the fabric is at its limit). */
  applied: [number, number, number];
  /** Last applied displacement that kept the fabric within its limit, its length, the probe. */
  ok: [number, number, number];
  reach: number;
  probe: number;
  /** Largest shell edge ratio in the region at grab start (solver residue is not the hand's). */
  baseline: number;
  resisting: boolean;
  /** Hood grabs: the hand's displacement of the hood's zip edge when this grab started. */
  origin: [number, number, number];
}

/** Smallest reach probe (m) after rejections (as pullDriver MIN_PROBE_M). */
const MIN_PROBE_M = 0.0005;

function centroid(ids: ArrayLike<number>, p: ArrayLike<number>) {
  let x = 0,
    y = 0,
    z = 0;
  for (let k = 0; k < ids.length; k++) {
    x += p[ids[k] * 3];
    y += p[ids[k] * 3 + 1];
    z += p[ids[k] * 3 + 2];
  }
  const n = Math.max(1, ids.length);
  return [x / n, y / n, z / n] as [number, number, number];
}

/**
 * Panel id the interaction solver gives the hood: none of the solver's panel rules apply to it
 * (no layer pairs, no self-contact mask, no hood layer offset). The hood is kinematic there
 * (semi-rigid, applyHoodTransform); as panel 7 its layer pairs let the moving hood shove the
 * collar along with it (686 collar particles moved > 5 cm on the live DQ M shell).
 */
export const SOLVER_HOOD_PANEL = 8;

/**
 * Pairs of front particles on the same row (render_uv v within 1 cm), `span` metres of material
 * arc apart along it (render_uv |u| = arc from the centre front, shell.py), on the same side of
 * the opened zip; `arc` = their flat-pattern distance (the row's material arc). The side is the
 * sign of x in the shell; the zip's duplicates (the wearer's right copies) are on the right.
 */
export function frontRows(
  asset: ClothAsset,
  fronts: ArrayLike<number>,
  span: number,
  sourceCount: number,
) {
  const uv = asset.render_uv ?? [],
    x = asset.initial,
    a: number[] = [],
    b: number[] = [],
    arc: number[] = [];
  if (!uv.length) return { a: new Int32Array(0), b: new Int32Array(0), arc: new Float64Array(0) };
  // Split vertices from sourceCount on are copies (seam.ts); the fronts' are the right side's.
  const side = (i: number) => (i >= sourceCount || x[i * 3] < -1e-3 ? -1 : 1);
  const list = Array.from(fronts);
  for (const i of list) {
    const ui = Math.abs(uv[i * 2]),
      vi = uv[i * 2 + 1],
      si = side(i);
    let best = -1,
      bestErr = Infinity;
    for (const j of list) {
      if (j === i || side(j) !== si || Math.abs(uv[j * 2 + 1] - vi) > 0.01) continue;
      const du = Math.abs(uv[j * 2]) - ui,
        err = Math.abs(du - span);
      if (du > 0.8 * span && du < 1.25 * span && err < bestErr) {
        bestErr = err;
        best = j;
      }
    }
    if (best < 0) continue;
    a.push(i);
    b.push(best);
    arc.push(Math.abs(uv[best * 2]) - ui);
  }
  return { a: Int32Array.from(a), b: Int32Array.from(b), arc: Float64Array.from(arc) };
}

/** Split asset with the base solver's substeps unrolled into single-substep frames. */
export function unrolledAsset(split: SeamSplit): ClothAsset {
  const c = split.asset.config,
    n = Math.max(1, Math.round(c.substeps));
  return {
    ...split.asset,
    panels: split.asset.panels.map((p) => (p === PANEL.hood ? SOLVER_HOOD_PANEL : p)),
    config: {
      // Lofted jackets (the puffer) hold their shape in the split solver (config.ts LOFTED_SPLIT).
      ...splitMaterial(c, split.asset.maximum_loft_m ?? 0),
      substeps: 1,
      dt: c.dt / n,
      selfEvery: (c.selfEvery ?? 1) * n,
    },
  };
}

function toward(
  from: readonly number[],
  to: readonly number[],
  step: number,
): [number, number, number] {
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]],
    n = Math.hypot(d[0], d[1], d[2]),
    f = n > step ? step / n : 1;
  return [from[0] + d[0] * f, from[1] + d[1] * f, from[2] + d[2] * f];
}

function scale(v: readonly number[], f: number): [number, number, number] {
  return [v[0] * f, v[1] * f, v[2] * f];
}

/** Smoothstep of t clamped to [0, 1]. */
function smooth01(t: number) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

/** Row-major 3×3 rotation turning direction a onto direction b (identity when parallel). */
export function rotationBetween(a: readonly number[], b: readonly number[]) {
  const la = Math.hypot(a[0], a[1], a[2]),
    lb = Math.hypot(b[0], b[1], b[2]);
  if (!(la > 1e-9 && lb > 1e-9)) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const ax = a[0] / la,
    ay = a[1] / la,
    az = a[2] / la,
    bx = b[0] / lb,
    by = b[1] / lb,
    bz = b[2] / lb;
  let kx = ay * bz - az * by,
    ky = az * bx - ax * bz,
    kz = ax * by - ay * bx;
  const s = Math.hypot(kx, ky, kz),
    c = ax * bx + ay * by + az * bz;
  if (s < 1e-9) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  kx /= s;
  ky /= s;
  kz /= s;
  const C = 1 - c;
  // Rodrigues: R = I cosθ + sinθ [k]× + (1 − cosθ) k kᵀ.
  return [
    c + kx * kx * C,
    kx * ky * C - kz * s,
    kx * kz * C + ky * s,
    ky * kx * C + kz * s,
    c + ky * ky * C,
    ky * kz * C - kx * s,
    kz * kx * C - ky * s,
    kz * ky * C + kx * s,
    c + kz * kz * C,
  ];
}

export class InteractDriver {
  readonly split: SeamSplit;
  readonly solver: ClothSolver;
  readonly substeps: number;
  private zip: WeldSet;
  private hoodSet?: WeldSet;
  private hoodIds: number[] = [];
  slider = 0;
  sliderTarget = 0;
  hoodState: HoodState | null;
  hoodProgress = 0;
  private grab?: Grab;
  /** Hood held in the air where the judge let go (only when fully detached; see hoodEnd). */
  private hooked = false;
  /** Displacement (m) of the hood's zip edge from where it sits on the collar (held / hooked). */
  private hoodOffset: [number, number, number] = [0, 0, 0];
  /** Hood zip progress the zip runs to after a let-go (see grabEnd). */
  private hoodSnapTarget = 0;
  private hoodMatrix: number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  private quietSince = 0;
  private frameStart = new Float64Array(0);
  private activeAt = 0;
  private clock = 0;
  /** Parts in the moving region: the zip's fronts and/or the hood. */
  private regionParts = '';
  /** Particle positions when everything was closed (the base solver's state at start). */
  private home: Float64Array;
  /** Particles held kinematic by a grab or the hook (inverse mass 0 while held). */
  private pinned: Int32Array = new Int32Array(0);

  readonly hasHood: boolean;

  constructor(base: ClothSolver, options: { hood: boolean; collider?: BodyCollider }) {
    this.hasHood = options.hood;
    this.split = splitSeams(base.asset, { hood: options.hood });
    this.substeps = Math.max(1, Math.round(base.asset.config.substeps));
    this.solver = new ClothSolver(unrolledAsset(this.split), base.sdf);
    if (options.collider) this.solver.setCollider(options.collider);
    const start = expandPositions(this.split, base.positions);
    this.home = start.slice();
    this.solver.positions.set(start);
    this.solver.previous.set(start);
    this.solver.velocity.fill(0);
    this.solver.energy = 0;
    const closed = (line: ZipLine) => ({
      a: line.a,
      b: line.b,
      closed: new Uint8Array(line.a.length).fill(1),
    });
    this.zip = closed(this.split.zip);
    if (this.split.hood) {
      this.hoodSet = closed(this.split.hood);
      const panels = this.split.asset.panels;
      for (let i = 0; i < panels.length; i++) if (panels[i] === PANEL.hood) this.hoodIds.push(i);
    }
    this.hoodState = this.split.hood ? 'attached' : null;
    const panels = this.split.asset.panels,
      fronts: number[] = [];
    for (let i = 0; i < panels.length; i++)
      if (panels[i] === PANEL.frontL || panels[i] === PANEL.frontR) fronts.push(i);
    this.fronts = Int32Array.from(fronts);
    this.rows = frontRows(
      this.split.asset,
      this.fronts,
      INTERACT.frontFlatSpanM,
      this.split.sourceCount,
    );
    const uv = this.split.asset.render_uv ?? [],
      x0 = this.split.asset.initial;
    for (const i of this.fronts) {
      if (!uv.length || Math.abs(uv[i * 2]) >= INTERACT.frontEdgeBandM) continue;
      // Nearest zip pair (its tooth decides whether this part of the edge is open).
      let pair = 0,
        best = Infinity;
      for (let k = 0; k < this.split.zip.a.length; k++) {
        const q = this.split.zip.a[k] * 3,
          d = Math.abs(x0[q + 1] - x0[i * 3 + 1]) + Math.abs(x0[q + 2] - x0[i * 3 + 2]);
        if (d < best) {
          best = d;
          pair = k;
        }
      }
      this.edgeBand.push([i, i >= this.split.sourceCount || x0[i * 3] < -1e-3 ? -1 : 1, pair]);
    }
    this.edgeHalfGap = 0.5 * this.split.asset.maximum_loft_m;
  }

  /** Front panel particles of the split asset (wearer's left and right). */
  private fronts: Int32Array;
  /** Pairs along each front row, INTERACT.frontFlatSpanM of material arc apart (frontRows). */
  private rows: { a: Int32Array; b: Int32Array; arc: Float64Array };
  /** 0 = worn shape, 1 = the flat-pattern row length acts fully (blended in and out). */
  private flatBlend = 0;
  /** Front particles near the zip edge with their side (+1 wearer's left, −1 right). */
  private edgeBand: Array<[number, number, number]> = [];
  private edgeHalfGap = 0;

  /**
   * An unzipped front's natural bending state is its flat pattern piece, not the worn curve the
   * zip held round the chest (lead's direction 2026-11-13). The solver's hinges are one
   * triangle wide, where that curve is almost straight (worn 2.76 cm vs flat 2.77 cm on the live
   * puffer M): flattening them changed nothing. The curve lives at panel scale, so while the
   * zip is open each front row is held, softly, at its flat length over INTERACT.frontFlatSpanM
   * (chord → material arc, one-sided: it may fold shorter, never curl round), and the fronts'
   * soft tether supports let go; gravity and body contact settle them. Closed, both return.
   * Split solver only. Physics with a flat-pattern rest, not measured against a real jacket.
   */
  private updateFrontRest(dt: number) {
    const target = this.slider > 0 || this.sliderTarget > 0 ? 1 : 0,
      next = approach(this.flatBlend, target, dt / INTERACT.frontFlatBlendS);
    if (next === this.flatBlend) return;
    const was = this.flatBlend;
    this.flatBlend = next;
    if (was === 0 || next === 0) this.solver.setSoftSupports(this.fronts, next === 0);
  }

  /** Closed hood teeth: the collar side back at its attached place, at rest (see tick). */
  private holdHoodTeeth() {
    const set = this.hoodSet;
    if (!set) return;
    const s = this.solver,
      p = s.positions,
      v = s.velocity,
      h = this.home;
    for (let k = 0; k < set.a.length; k++) {
      const i = set.a[k];
      if (!set.closed[k] || !s.inverseMass[i]) continue;
      for (let c = 0; c < 3; c++) {
        p[i * 3 + c] = h[i * 3 + c];
        v[i * 3 + c] = 0;
      }
    }
  }

  /** One substep of the flat-pattern row springs (see updateFrontRest). */
  private flattenRows() {
    const blend = this.flatBlend * INTERACT.frontFlatFraction,
      f = INTERACT.frontFlatStiffness;
    if (!(blend > 0)) return;
    const { a, b, arc: flat } = this.rows,
      s = this.solver,
      p = s.positions,
      w = s.inverseMass,
      h = this.home;
    // Rest = the worn chord blended toward the flat row length (the material arc).
    const arc = Array.from(flat, (L, k) => {
      const i = a[k] * 3,
        j = b[k] * 3,
        worn = Math.hypot(h[i] - h[j], h[i + 1] - h[j + 1], h[i + 2] - h[j + 2]);
      return worn + (L - worn) * blend;
    });
    // The two padded front edges meet at the midline instead of passing through each other
    // (the region solver runs no cloth self-contact): each side's edge band stays on its own
    // side by half the padding's depth.
    const t = this.edgeHalfGap;
    for (const [i, sgn, pair] of this.edgeBand) {
      // Only beside open teeth: closed ones are welded at the midline.
      if (!w[i] || this.zip.closed[pair]) continue;
      const x = p[i * 3] * sgn;
      if (x < t) p[i * 3] = t * sgn;
    }
    for (let k = 0; k < a.length; k++) {
      const i = a[k] * 3,
        j = b[k] * 3,
        wi = w[a[k]],
        wj = w[b[k]],
        sum = wi + wj;
      if (!(sum > 0)) continue;
      const dx = p[j] - p[i],
        dy = p[j + 1] - p[i + 1],
        dz = p[j + 2] - p[i + 2],
        d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!(d > 1e-9) || d >= arc[k]) continue;
      const c = ((arc[k] - d) / d) * f;
      p[i] -= dx * c * (wi / sum);
      p[i + 1] -= dy * c * (wi / sum);
      p[i + 2] -= dz * c * (wi / sum);
      p[j] += dx * c * (wj / sum);
      p[j + 1] += dy * c * (wj / sum);
      p[j + 2] += dz * c * (wj / sum);
    }
  }

  /**
   * Back to "everything closed" at the base solver's current state (a new interaction after the
   * view returned to the measured shell). Same as a fresh driver, without rebuilding the solver.
   */
  reset(base: ClothSolver) {
    const s = this.solver;
    s.release();
    s.clearRegion();
    this.pinned = new Int32Array(0) as Int32Array;
    const start = expandPositions(this.split, base.positions);
    this.home = start.slice();
    s.positions.set(start);
    s.previous.set(start);
    s.velocity.fill(0);
    s.energy = 0;
    this.zip.closed.fill(1);
    this.hoodSet?.closed.fill(1);
    this.slider = this.sliderTarget = 0;
    this.hoodState = this.split.hood ? 'attached' : null;
    this.hoodProgress = 0;
    this.grab = undefined;
    this.hooked = false;
    this.hoodOffset = [0, 0, 0];
    this.hoodSnapTarget = 0;
    this.regionParts = '';
    this.clock = this.quietSince = this.activeAt = 0;
    if (this.flatBlend > 0) {
      this.flatBlend = 0;
      this.solver.setSoftSupports(this.fronts, true);
    }
  }

  get zipLength() {
    return this.split.zip.length;
  }

  /**
   * Moving region (ClothSolver.setRegion): round the zip line when the zip is in play, round the
   * hood when it is; sleeves stay kinematic (they hang beside the fronts and are not opened).
   * Re-set only when the parts change (a new region restarts the band anchors).
   */
  private updateRegion() {
    const zip = this.slider > 0 || this.sliderTarget > 0 || this.grab?.kind === 'fabric';
    const hood = !!this.hoodState && (this.hoodState !== 'attached' || this.grab?.kind === 'hood');
    const parts = `${zip ? 'z' : ''}${hood ? 'h' : ''}` || 'z';
    if (parts === this.regionParts && this.solver.activeRegion) return;
    this.regionParts = parts;
    const p = this.solver.positions,
      centres: number[] = [];
    if (parts.includes('z')) {
      const line = this.split.zip.a;
      for (let k = 0; k < line.length; k += 3)
        centres.push(p[line[k] * 3], p[line[k] * 3 + 1], p[line[k] * 3 + 2]);
    }
    if (parts.includes('h') && this.split.hood) {
      centres.push(...centroid(this.hoodIds, p));
      const h = this.split.hood.a;
      for (let k = 0; k < h.length; k += 6)
        centres.push(p[h[k] * 3], p[h[k] * 3 + 1], p[h[k] * 3 + 2]);
    }
    // The hood is never cloth here: kinematic, moved by applyHoodTransform (semi-rigid).
    const frozen = [4, 5, PANEL.hood, SOLVER_HOOD_PANEL];
    // Keep a grab: setRegion makes outside particles kinematic and leaves grabs to the caller.
    this.solver.setRegion(centres, INTERACT.regionRadiusM, INTERACT.regionBlendM, frozen);
    this.pin(this.pinned);
  }

  /**
   * Held particles are kinematic (inverse mass 0) and sit exactly on their targets. A grab that
   * keeps the particle's mass (as the hand pull does, so the strain clamp can make it slip) fed
   * the projection jump into the particle's velocity every substep: a hanging hood held that way
   * buzzed at the 2 m/s velocity limit.
   */
  private pin(ids: Int32Array) {
    const m = this.solver.inverseMass;
    for (const id of this.pinned) if (!ids.includes(id)) this.unpinOne(id);
    for (const id of ids) m[id] = 0;
    this.pinned = ids;
  }

  private unpinOne(id: number) {
    const s = this.solver,
      inRegion = s.activeRegion?.particles.includes(id) ?? true;
    s.inverseMass[id] = inRegion ? 1 / s.asset.config.particleMass : 0;
    for (let c = 0; c < 3; c++) {
      s.velocity[id * 3 + c] = 0;
      s.previous[id * 3 + c] = s.positions[id * 3 + c];
    }
  }

  /** Slider target (m of arc from the collar top); the slider follows at INTERACT.sliderSpeed. */
  setSlider(arc: number) {
    if (!Number.isFinite(arc)) throw new Error('Invalid slider position');
    this.sliderTarget = clampSlider(arc, this.zipLength);
  }

  /**
   * Grab cloth of the split solver: `ids`/`weights` = patch (split-asset particles). 'hood'
   * grabs open or close the hood's zip with the hand's distance; 'fabric' grabs only move the
   * cloth (the open fronts).
   */
  grabBegin(kind: GrabKind, ids: readonly number[], weights: readonly number[]) {
    if (kind === 'hood' && (!this.hoodSet || !this.hoodState))
      throw new Error('This jacket has no detachable hood');
    if (!ids.length || ids.length !== weights.length) throw new Error('Invalid grab patch');
    if (!weights.every((w) => w > 0 && w <= 1)) throw new Error('Patch weights must be in (0, 1]');
    const P = this.split.asset.panels,
      n = P.length;
    const keep = ids
      .map((id, j) => [id, weights[j]] as const)
      .filter(([id]) => Number.isInteger(id) && id >= 0 && id < n)
      .filter(([id]) => (kind === 'hood' ? P[id] === PANEL.hood : P[id] !== PANEL.hood));
    if (!keep.length)
      throw new Error(kind === 'hood' ? 'The grab is not on the hood' : 'Invalid grab');
    this.solver.release();
    this.pin(new Int32Array(0));
    if (kind === 'hood') {
      // The hood is held by its zip edge (as a hand takes a detached hood): the edge follows the
      // hand from where it is now (hooked, partly unzipped, or on the collar).
      const origin: [number, number, number] = [...this.hoodOffset];
      this.hoodSnapTarget = this.hoodProgress;
      this.hooked = false;
      this.grab = {
        kind,
        ids: new Int32Array(0),
        weights: new Float64Array(0),
        base: new Float64Array(0),
        request: [...origin],
        hand: [...origin],
        applied: [...origin],
        ok: [...origin],
        reach: 0,
        probe: 0,
        baseline: 0,
        resisting: false,
        origin: [...origin],
      };
      this.updateRegion();
      return;
    }
    this.hooked = false;
    // The held particles move rigidly with the hand (kinematic, see pin()): only the patch's
    // core, so a weighted fall-off does not shear the pinned cloth itself. The rest of the
    // patch is pulled along by the cloth.
    const top = Math.max(...keep.map(([, w]) => w));
    const core = keep.filter(([, w]) => w >= INTERACT.grabCoreWeight * top);
    const grabIds = Int32Array.from(core.map(([id]) => id)),
      p = this.solver.positions;
    this.grab = {
      kind,
      ids: grabIds,
      weights: Float64Array.from(core.map(() => 1)),
      base: Float64Array.from(
        Array.from(grabIds).flatMap((id) => [p[id * 3], p[id * 3 + 1], p[id * 3 + 2]]),
      ),
      request: [0, 0, 0],
      hand: [0, 0, 0],
      applied: [0, 0, 0],
      ok: [0, 0, 0],
      reach: 0,
      probe: 0,
      baseline: 0,
      resisting: false,
      origin: [0, 0, 0],
    };
    this.updateRegion();
    this.grab.baseline = this.solver.regionStrain().maxShellRatio;
    this.setGrabTargets();
  }

  /**
   * Hood off and set down (HOOD_DEFAULT 'off-resting', or the harness): fully detached, resting
   * where a hood let go fully off rests (restOffset), as if the judge had taken it off. No-op
   * without a detachable hood or during a grab.
   */
  setHoodOff() {
    if (!this.hoodSet || !this.hoodState || this.grab) return;
    this.hoodProgress = this.hoodSnapTarget = 1;
    this.hoodSet.closed.fill(0);
    this.hooked = true;
    this.hoodOffset = [...this.restOffset()];
    this.hoodState = 'detached';
    this.updateRegion();
    this.applyHoodTransform(this.hoodOffset);
  }

  /** Requested hand displacement (m, scene frame) since the grab started. */
  grabMove(displacement: readonly number[]) {
    const g = this.grab;
    if (!g) return;
    if (displacement.length !== 3 || !displacement.every(Number.isFinite))
      throw new Error('Invalid displacement');
    const d = [
        g.origin[0] + displacement[0],
        g.origin[1] + displacement[1],
        g.origin[2] + displacement[2],
      ],
      n = Math.hypot(d[0], d[1], d[2]),
      f = n > INTERACT.hoodMaxReachM ? INTERACT.hoodMaxReachM / n : 1;
    g.request = [d[0] * f, d[1] * f, d[2] * f];
  }

  /**
   * Let go. A partly detached hood hangs from the teeth still closed and the fronts fall back
   * (physics). A fully detached hood has nothing holding it, so it stays held where the judge
   * let go (a demo convenience, labelled in the UI; not physics) until it is grabbed again.
   */
  grabEnd() {
    const g = this.grab;
    if (!g) return;
    this.grab = undefined;
    if (g.kind === 'hood') {
      // The semi-rigid hood stays where it was let go. Let go almost off / almost on, its zip
      // runs to that end (UX, like the slider's stops; INTERACT.hoodSnap).
      // Bringing it back (attaching), a hood let go within half the travel zips on: aligning a
      // hood with a collar by hand on a screen is coarse (UX, INTERACT.hoodAttachSnap).
      const p = this.hoodProgress,
        on = this.hoodState === 'attaching' ? INTERACT.hoodAttachSnap : INTERACT.hoodSnap;
      this.hoodSnapTarget = p >= 1 - INTERACT.hoodSnap ? 1 : p <= on ? 0 : p;
      this.hoodOffset = [...g.hand];
      this.hooked = this.hoodSnapTarget === 1;
    } else {
      this.solver.release();
      this.pin(new Int32Array(0));
    }
    if (this.hoodState) this.hoodState = nextHoodState(this.hoodState, this.hoodProgress, false);
  }

  /**
   * The hood is a semi-rigid body, not free cloth (lead's decision 2026-11-13: a padded hood holds
   * its form; agent H is authoring its shapes). Until H's API lands this is a stopgap: the
   * hood's own vertices (its shape on the shell) moved by one rigid transform, no deformation.
   *  - Peeling off: the hood turns rigidly about the zip's frontier (the first tooth still
   *    closed), so its open end follows the hand while the closed teeth stay on the collar.
   *  - Near and past the end of the zip, the turn gives way to a plain translation by the hand
   *    (blended over the last INTERACT.hoodFreeBlend of the progress), so it is continuous.
   * The hood's particles are kinematic in the interaction solver; the collar side of each
   * closed tooth is welded to the hood's side.
   */
  private applyHoodTransform(hand: readonly number[]) {
    const line = this.split.hood;
    if (!line) return;
    const progress = this.hoodProgress,
      h = this.home,
      n = line.b.length,
      frontier = hoodFrontier(progress, line.length);
    let kf = n - 1;
    for (let k = 0; k < n; k++)
      if (!(line.arc[k] < frontier)) {
        kf = k;
        break;
      }
    const free = smooth01((progress - (1 - INTERACT.hoodFreeBlend)) / INTERACT.hoodFreeBlend),
      pivot = [h[line.b[kf] * 3], h[line.b[kf] * 3 + 1], h[line.b[kf] * 3 + 2]],
      end = line.b[0],
      u = [h[end * 3] - pivot[0], h[end * 3 + 1] - pivot[1], h[end * 3 + 2] - pivot[2]],
      turn = 1 - free,
      v = [u[0] + hand[0] * turn, u[1] + hand[1] * turn, u[2] + hand[2] * turn],
      R = rotationBetween(u, v),
      t = [hand[0] * free, hand[1] * free, hand[2] * free],
      o = [0, 1, 2].map(
        (c) =>
          pivot[c] -
          (R[c * 3] * pivot[0] + R[c * 3 + 1] * pivot[1] + R[c * 3 + 2] * pivot[2]) +
          t[c],
      ),
      p = this.solver.positions,
      prev = this.solver.previous,
      vel = this.solver.velocity;
    this.hoodMatrix = [R[0], R[1], R[2], o[0], R[3], R[4], R[5], o[1], R[6], R[7], R[8], o[2]];
    for (const i of this.hoodIds) {
      const x = h[i * 3] - pivot[0],
        y = h[i * 3 + 1] - pivot[1],
        z = h[i * 3 + 2] - pivot[2];
      for (let c = 0; c < 3; c++) {
        const q = pivot[c] + R[c * 3] * x + R[c * 3 + 1] * y + R[c * 3 + 2] * z + t[c];
        p[i * 3 + c] = q;
        prev[i * 3 + c] = q;
        vel[i * 3 + c] = 0;
      }
    }
  }

  private setGrabTargets() {
    const g = this.grab;
    if (!g) return;
    if (g.kind === 'hood') return this.applyHoodTransform(g.hand);
    const t: number[] = [];
    for (let j = 0; j < g.weights.length; j++)
      for (let c = 0; c < 3; c++) t.push(g.base[j * 3 + c] + g.applied[c]);
    this.solver.grab(Array.from(g.ids), t);
    if (this.pinned !== g.ids) this.pin(g.ids);
    else for (const id of g.ids) this.solver.inverseMass[id] = 0;
  }

  /** Hood zip progress from the hand (pulling off) or the hood's edge (bringing it back). */
  private hoodTargetProgress() {
    const g = this.grab;
    if (!g || g.kind !== 'hood') return this.hoodProgress;
    // How far the hand has taken the hood's edge from the collar: the same measure pulling off
    // and bringing back, so the zip is reversible.
    return hoodProgressFromDistance(Math.hypot(...g.hand));
  }

  private rest?: [number, number, number];
  /**
   * Where a hood let go fully off is set down (lead's UX direction 2026-11-13; a demo
   * convenience, not physics): beside the jacket on the wearer's right (−X: the far side in the
   * hood view, which looks from the left-back, so the hood is seen but does not fill the view),
   * at hip height, clear of the body and of the front view of the jacket. As an
   * offset of the hood's place on the collar. From the shown shell's bounds, no fixed numbers
   * besides the clearances in INTERACT.
   */
  private restOffset(): [number, number, number] {
    if (this.rest) return this.rest;
    const p = this.home,
      panels = this.split.asset.panels;
    let minX = Infinity,
      minY = Infinity,
      hx = 0,
      hy = 0,
      hz = 0,
      zc = 0,
      n = 0,
      nt = 0;
    for (let i = 0; i < panels.length; i++) {
      if (panels[i] === PANEL.hood) {
        hx += p[i * 3];
        hy += p[i * 3 + 1];
        hz += p[i * 3 + 2];
        n++;
        continue;
      }
      minX = Math.min(minX, p[i * 3]);
      minY = Math.min(minY, p[i * 3 + 1]);
      if (panels[i] <= PANEL.back) {
        zc += p[i * 3 + 2];
        nt++;
      }
    }
    if (!n || !nt) return (this.rest = [0, 0, 0]);
    const target = [minX - INTERACT.hoodRestSideM, minY + INTERACT.hoodRestAboveHemM, zc / nt];
    this.rest = [target[0] - hx / n, target[1] - hy / n, target[2] - hz / n];
    return this.rest;
  }

  /** Arc positions of the zip pairs' midpoints (for the main thread's slider mapping). */
  zipTrack(out = new Float32Array(this.zip.a.length * 3)) {
    const p = this.solver.positions;
    for (let k = 0; k < this.zip.a.length; k++)
      for (let c = 0; c < 3; c++)
        out[k * 3 + c] = (p[this.zip.a[k] * 3 + c] + p[this.zip.b[k] * 3 + c]) / 2;
    return out;
  }

  /** One display frame (the base solver's dt). */
  tick(now: () => number = () => performance.now()): InteractFrame {
    const started = now(),
      dt = this.solver.asset.config.dt * this.substeps;
    this.clock += dt;
    this.slider = approach(this.slider, this.sliderTarget, INTERACT.sliderSpeed * dt);
    this.updateFrontRest(dt);
    const open = teethForSlider(this.split.zip.arc, this.slider, this.zip.closed);
    const g = this.grab;
    if (g) {
      const step = INTERACT.hoodTargetSpeed * dt;
      g.hand = toward(g.hand, g.request, step);
    }
    if (g && g.kind !== 'hood') {
      const step = INTERACT.hoodTargetSpeed * dt;
      // The cloth target follows the hand but never beyond the reach the fabric accepted so far
      // plus a probe (as the hand pull's reach probe): a held patch cannot tear the cloth.
      if (!g.probe) g.probe = step;
      const candidate = toward(g.applied, g.hand, step),
        n = Math.hypot(...candidate),
        cap = g.reach + g.probe;
      g.applied = n > cap && n > 0 ? scale(candidate, cap / n) : candidate;
    }
    if (this.hoodSet && this.hoodState) {
      const held = g?.kind === 'hood';
      if (held) this.hoodProgress = this.hoodTargetProgress();
      else {
        // Let go: the zip finishes running to its snap target; a hood zipping back on is drawn
        // home at the hand's speed limit (no jump).
        this.hoodProgress = approach(this.hoodProgress, this.hoodSnapTarget, 2 * dt);
        if (this.hoodSnapTarget === 0)
          this.hoodOffset = toward(this.hoodOffset, [0, 0, 0], INTERACT.hoodTargetSpeed * dt);
        else if (this.hooked) {
          // Fully off and let go: eased to its resting place beside the hip (UX, see restOffset).
          const rest = this.restOffset(),
            k = 1 - Math.exp(-dt / INTERACT.hoodRestTauS);
          this.hoodOffset = [0, 1, 2].map(
            (c) => this.hoodOffset[c] + (rest[c] - this.hoodOffset[c]) * k,
          ) as [number, number, number];
        }
      }
      const line = this.split.hood!;
      teethForProgress(line.arc, line.length, this.hoodProgress, this.hoodSet.closed);
      if (!held) this.applyHoodTransform(this.hoodOffset);
      this.hoodState = nextHoodState(this.hoodState, this.hoodProgress, g?.kind === 'hood');
    }
    this.updateRegion();
    if (g) this.setGrabTargets();
    const s = this.solver,
      ids = s.activeRegion?.particles ?? new Int32Array(0);
    if (this.frameStart.length < ids.length * 3) this.frameStart = new Float64Array(ids.length * 3);
    for (let j = 0; j < ids.length; j++)
      for (let c = 0; c < 3; c++) this.frameStart[j * 3 + c] = s.positions[ids[j] * 3 + c];
    for (let k = 0; k < this.substeps; k++) {
      s.step();
      this.flattenRows();
      weldPairs(this.zip, s.positions, s.velocity, s.inverseMass, INTERACT.weldStepM);
      // The hood's closed teeth hold the collar's side where the attached hood holds it (its
      // place on the shell): the zipped part of the hood stays on the collar (H's contract).
      // Welding it to the moving semi-rigid hood dragged the whole collar along as the hood
      // turned (710 collar particles moved > 5 cm, live DQ M); not holding it at all let the
      // funnel collar, which the hood's root supports, sag 12.8 cm.
      this.holdHoodTeeth();
    }
    if (!s.positions.every(Number.isFinite)) throw new Error('Zip simulation became non-finite');
    if (g && g.kind !== 'hood') {
      const ratio = s.regionStrain().maxShellRatio,
        limit = Math.max(g.baseline, s.asset.config.stretchMax) + INTERACT.grabStrainMargin;
      if (ratio > limit) {
        // Too far: back to the last accepted target (applied next frame), smaller probe.
        g.applied = [...g.ok];
        g.probe = Math.max(MIN_PROBE_M, g.probe / 2);
        g.resisting = true;
      } else {
        g.ok = [...g.applied];
        g.reach = Math.max(g.reach, Math.hypot(...g.applied));
        g.probe = Math.min(INTERACT.hoodTargetSpeed * dt, g.probe * 1.5);
        g.resisting =
          Math.hypot(g.hand[0] - g.applied[0], g.hand[1] - g.applied[1], g.hand[2] - g.applied[2]) >
          0.01;
      }
    }
    const energy = s.regionEnergy();
    // Visible motion this frame (m): the kinetic energy never reaches zero on this shell (the
    // strain limiter holds some particles against a velocity it re-derives every substep, a
    // ~1e-5 J floor with no displacement), so rest is judged on displacement.
    let moved = 0;
    for (let j = 0; j < ids.length; j++) {
      const k = ids[j] * 3,
        o = j * 3;
      moved = Math.max(
        moved,
        Math.abs(s.positions[k] - this.frameStart[o]) +
          Math.abs(s.positions[k + 1] - this.frameStart[o + 1]) +
          Math.abs(s.positions[k + 2] - this.frameStart[o + 2]),
      );
    }
    const closed =
      open === 0 && this.slider === 0 && (!this.hoodState || this.hoodState === 'attached') && !g;
    if (!closed) this.activeAt = this.clock;
    if (!closed || moved > INTERACT.settleMotionM) this.quietSince = this.clock;
    const restful =
      closed &&
      (this.clock - this.quietSince >= INTERACT.settleMinS ||
        this.clock - this.activeAt >= INTERACT.settleMaxS);
    let maxGap = 0;
    const p = s.positions;
    for (let k = 0; k < this.zip.a.length; k++) {
      if (this.zip.closed[k]) continue;
      const i = this.zip.a[k] * 3,
        j = this.zip.b[k] * 3;
      maxGap = Math.max(maxGap, Math.hypot(p[i] - p[j], p[i + 1] - p[j + 1], p[i + 2] - p[j + 2]));
    }
    return {
      stepMs: now() - started,
      slider: this.slider,
      zipLength: this.zipLength,
      openTeeth: open,
      maxGapM: maxGap,
      hood: this.hoodState,
      hoodProgress: this.hoodProgress,
      hooked: this.hooked,
      hoodMatrix: this.split.hood ? [...this.hoodMatrix] : null,
      hoodHand: g?.kind === 'hood' ? [...g.hand] : [...this.hoodOffset],
      grabbing: !!g,
      energy,
      particles: s.activeRegion?.particles.length ?? 0,
      restful,
    };
  }
}
