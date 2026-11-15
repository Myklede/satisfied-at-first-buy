// The pose-space corrective model (agent V7): true-solve correction fields of the key poses,
// compressed by PCA and interpolated over pose by Gaussian RBFs, per side. Pure, no DOM.
//
// A sample's field is, per particle, B_i(pose)⁻¹ · (solved − LBS) minus the same at the neutral
// stand (localFrame.ts): only what the POSE changes; the neutral drape stays the live preview's.
// Prediction at a pose:
//   c_s   = Σ_k α_k(arm feature of side s) · q_k     (arm samples, rbf.ts), s = L, R
//   c_T   = Σ_k α_k(trunk feature) · q_k              (trunk samples)
//   local = Σ_j (m_i · c_L + (1 − m_i) · c_R + c_T)_j · U_j,i   (m_i: features.ts leftMask)
//   world = B_i(drivers) · local, added to the skinned particle, then the body guard (guard.ts).
import type { AnatomicalPose } from '../../../motion/rig.ts';
import { PSD, PSD_VERSION } from './config.ts';
import {
  ARM_FEATURES,
  armFeature,
  leftMask,
  mirrorField,
  mirrorMap,
  mirrorPose,
  TRUNK_FEATURES,
  trunkFeature,
  type Side,
} from './features.ts';
import { GUARD_CANDIDATES, NO_GUARD, type PsdGuard } from './guard.ts';
import { symmetricEigen } from './linalg.ts';
import { influencesOf, type SkinArrays } from './localFrame.ts';
import { fitRbf, rbfWeights, type Rbf } from './rbf.ts';

export type PsdSample = {
  id: string;
  kind: 'arm' | 'trunk';
  pose: AnatomicalPose;
  /** N·3 local correction field (pose minus neutral), metres. */
  field: Float32Array;
  /** Also train on its mirror image (poses.ts KeyPose.mirror). */
  mirror?: boolean;
};

export type PsdRegression = Rbf & { ids: string[]; coeffs: Float64Array };

/** Everything the run time needs; structured-clonable (worker → page). */
export type PsdModelData = {
  version: string;
  key: string;
  count: number;
  /** PCA components kept, r. */
  components: number;
  /** (N, r, 3) particle-major basis, metres per unit coefficient. */
  basis: Float32Array;
  /** Arm regressions per side (features of that side's arm). */
  armL: PsdRegression;
  armR: PsdRegression;
  trunk: PsdRegression | null;
  /** Per particle, the left arm's share (features.ts leftMask). */
  leftMask: Float32Array;
  /** The body's neutral (display) pose: missing DOFs take these values. */
  neutral: AnatomicalPose;
  /** RMS per particle of the PCA truncation over the training samples, m. */
  pcaRms: number;
  /** Sample ids in training order, mirrored ones suffixed "~" (diagnostics). */
  samples: string[];
  /** Body guard (guard.ts); null = none. */
  guard: PsdGuard | null;
};

type FitOptions = {
  maxComponents?: number;
  toleranceM?: number;
  sigmas?: readonly number[];
  trunkSigmas?: readonly number[];
  lambdas?: readonly number[];
};

/** The training set with each `mirror` sample's mirror image added. */
export function withMirrors(samples: PsdSample[], bound: ArrayLike<number>): PsdSample[] {
  if (!samples.some((s) => s.mirror)) return samples;
  const map = mirrorMap(bound);
  const out: PsdSample[] = [];
  for (const s of samples) {
    out.push(s);
    if (s.mirror)
      out.push({
        id: `${s.id}~`,
        kind: s.kind,
        pose: mirrorPose(s.pose),
        field: mirrorField(s.field, map),
      });
  }
  return out;
}

const TRUNK_DOFS = ['trunk_twist', 'trunk_flexion', 'trunk_lateral'];

/**
 * An arm sample baked with a trunk pose (one arm up with a lean) keeps only what the trunk
 * samples do not already explain: its field minus the trunk-only interpolation at its trunk pose.
 * The run time adds the two back, so the sample is reproduced at its own pose and the lean is not
 * counted twice.
 */
export function trunkResiduals(
  all: PsdSample[],
  neutral: AnatomicalPose,
  options: Pick<FitOptions, 'trunkSigmas' | 'lambdas'> = {},
): PsdSample[] {
  const leaning = (pose: AnatomicalPose) =>
    TRUNK_DOFS.some(
      (dof) => Math.abs((pose[dof] ?? neutral[dof] ?? 0) - (neutral[dof] ?? 0)) > 0.5,
    );
  const trunk = all.filter((s) => s.kind === 'trunk');
  if (!trunk.length || !all.some((s) => s.kind === 'arm' && leaning(s.pose))) return all;
  const M = trunk[0].field.length;
  const K = trunk.length + 1; // + the neutral stand, field 0
  const centers = new Float64Array(K * TRUNK_FEATURES);
  const values = new Float64Array(K * M);
  trunk.forEach((t, k) => {
    trunkFeature(t.pose, neutral, centers, k * TRUNK_FEATURES);
    values.set(t.field, k * M);
  });
  trunkFeature({}, neutral, centers, trunk.length * TRUNK_FEATURES);
  const rbf = fitRbf(
    centers,
    K,
    TRUNK_FEATURES,
    values,
    M,
    options.trunkSigmas ?? PSD.trunkSigmaCandidates,
    options.lambdas ?? PSD.lambdaCandidates,
  );
  const alpha = new Float64Array(K);
  return all.map((s) => {
    if (s.kind !== 'arm' || !leaning(s.pose)) return s;
    rbfWeights(rbf, trunkFeature(s.pose, neutral), alpha);
    const field = Float32Array.from(s.field);
    for (let k = 0; k < K; k++) {
      const a = alpha[k];
      if (!a) continue;
      for (let i = 0; i < M; i++) field[i] -= a * values[k * M + i];
    }
    return { ...s, field };
  });
}

/**
 * Fits the model. `bound` = the binding's neutral particle positions (masks, mirror map);
 * `neutral` = the body's display pose. Samples of either kind may be missing (a partial,
 * progressive bake).
 */
export function fitModel(
  samples: PsdSample[],
  neutral: AnatomicalPose,
  bound: ArrayLike<number>,
  key: string,
  options: FitOptions = {},
  guard: PsdGuard | null = null,
): PsdModelData {
  const n = bound.length / 3;
  const M = n * 3;
  if (samples.some((s) => s.field.length !== M))
    throw new Error('A PSD sample does not match the binding');
  if (!samples.length) throw new Error('No PSD samples');
  const all = trunkResiduals(withMirrors(samples, bound), neutral, options);
  const K = all.length;
  // Gram matrix of the fields (K×K), float64.
  const gram = new Float64Array(K * K);
  for (let j = 0; j < K; j++)
    for (let k = j; k < K; k++) {
      const a = all[j].field,
        b = all[k].field;
      let s = 0;
      for (let i = 0; i < M; i++) s += a[i] * b[i];
      gram[j * K + k] = s;
      gram[k * K + j] = s;
    }
  const { values, vectors } = symmetricEigen(gram, K);
  const maxR = Math.min(K, options.maxComponents ?? PSD.maxComponents);
  const tol = options.toleranceM ?? PSD.pcaToleranceM;
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);
  let r = 0,
    residual = total;
  while (r < maxR && values[r] > 1e-12 * Math.max(values[0], 1e-30)) {
    residual -= Math.max(0, values[r]);
    r++;
    if (Math.sqrt(Math.max(0, residual) / (K * n)) <= tol) break;
  }
  r = Math.max(1, r);
  const pcaRms = Math.sqrt(Math.max(0, residual) / (K * n));
  // Basis U_j = Σ_k V_kj · D_k / √λ_j, stored particle-major (i, j, c).
  const basis = new Float32Array(n * r * 3);
  const scale = Float64Array.from({ length: r }, (_, j) =>
    values[j] > 0 ? 1 / Math.sqrt(values[j]) : 0,
  );
  for (let k = 0; k < K; k++) {
    const f = all[k].field;
    for (let j = 0; j < r; j++) {
      const w = vectors[k * K + j] * scale[j];
      if (!w) continue;
      for (let i = 0; i < n; i++) {
        const o = (i * r + j) * 3;
        basis[o] += w * f[i * 3];
        basis[o + 1] += w * f[i * 3 + 1];
        basis[o + 2] += w * f[i * 3 + 2];
      }
    }
  }
  // Coefficients of each sample: q_kj = V_kj · √λ_j.
  const coeff = (k: number) =>
    Float64Array.from(
      { length: r },
      (_, j) => vectors[k * K + j] * Math.sqrt(Math.max(0, values[j])),
    );
  const regress = (kind: 'arm' | 'trunk', side: Side): PsdRegression | null => {
    const picked = all.map((s, k) => ({ s, k })).filter((e) => e.s.kind === kind);
    if (!picked.length) return null;
    const d = kind === 'arm' ? ARM_FEATURES : TRUNK_FEATURES;
    const Kk = picked.length + 1; // + the neutral stand, value 0
    const centers = new Float64Array(Kk * d);
    const coeffs = new Float64Array(Kk * r);
    picked.forEach(({ s, k }, row) => {
      if (kind === 'arm') armFeature(s.pose, neutral, side, centers, row * d);
      else trunkFeature(s.pose, neutral, centers, row * d);
      coeffs.set(coeff(k), row * r);
    });
    if (kind === 'arm') armFeature({}, neutral, side, centers, picked.length * d);
    else trunkFeature({}, neutral, centers, picked.length * d);
    const rbf = fitRbf(
      centers,
      Kk,
      d,
      coeffs,
      r,
      kind === 'trunk'
        ? (options.trunkSigmas ?? PSD.trunkSigmaCandidates)
        : (options.sigmas ?? PSD.sigmaCandidates),
      options.lambdas ?? PSD.lambdaCandidates,
    );
    return { ...rbf, coeffs, ids: [...picked.map((e) => e.s.id), 'neutral'] };
  };
  return {
    version: PSD_VERSION,
    key,
    count: n,
    components: r,
    basis,
    armL: regress('arm', 'L') ?? emptyRegression(r, ARM_FEATURES),
    armR: regress('arm', 'R') ?? emptyRegression(r, ARM_FEATURES),
    trunk: regress('trunk', 'L'),
    leftMask: leftMask(bound),
    neutral: { ...neutral },
    pcaRms,
    samples: all.map((s) => s.id),
    guard,
  };
}

function emptyRegression(r: number, d: number): PsdRegression {
  return {
    centers: new Float64Array(d),
    K: 1,
    d,
    sigma: 1,
    lambda: 0,
    inverse: Float64Array.of(1),
    looRms: 0,
    coeffs: new Float64Array(r),
    ids: ['neutral'],
  };
}

/** Reusable per-frame buffers for one model. */
export class PsdEvaluator {
  private feature = new Float64Array(Math.max(ARM_FEATURES, TRUNK_FEATURES));
  private alpha: Float64Array;
  private phi: Float64Array;
  readonly cL: Float64Array;
  readonly cR: Float64Array;
  private cT: Float64Array;
  private c: Float64Array;
  readonly model: PsdModelData;
  /** Particles the body guard moved in the last apply() (diagnostics). */
  guarded = 0;
  /** How far past its neutral distance a particle stays guarded (PSD.guardRadiusM; tools vary it). */
  guardRadiusM: number = PSD.guardRadiusM;
  /** Which guard rules run (tools compare them): both = candidates, clearance where none is near. */
  guardMode: 'both' | 'candidates' | 'clearance' = 'both';
  constructor(model: PsdModelData) {
    this.model = model;
    const K = Math.max(model.armL.K, model.armR.K, model.trunk?.K ?? 1);
    this.alpha = new Float64Array(K);
    this.phi = new Float64Array(K);
    const r = model.components;
    this.cL = new Float64Array(r);
    this.cR = new Float64Array(r);
    this.cT = new Float64Array(r);
    this.c = new Float64Array(r);
  }

  private coefficients(reg: PsdRegression, x: Float64Array, out: Float64Array) {
    const r = this.model.components;
    rbfWeights(reg, x, this.alpha, this.phi);
    out.fill(0);
    for (let k = 0; k < reg.K; k++) {
      const a = this.alpha[k];
      if (a === 0) continue;
      for (let j = 0; j < r; j++) out[j] += a * reg.coeffs[k * r + j];
    }
  }

  /** Arm-corrective weights of the last prepare(), [left, right] (diagnostics). */
  readonly fade = new Float64Array(2);
  /** Elevation fade thresholds (PSD.fade; tools vary them). null = no fade. */
  fadeDeg: { full: number; zero: number } | null = PSD.fade;

  /** 1 up to fade.full deg of the side's shoulder elevation, smoothstep to 0 at fade.zero. */
  private fadeOf(pose: AnatomicalPose, side: 'L' | 'R') {
    const f = this.fadeDeg;
    if (!f) return 1;
    const key = `shoulder_${side}_elevation`;
    const v = pose[key];
    const e = v !== undefined && Number.isFinite(v) ? v : (this.model.neutral[key] ?? 0);
    const t = Math.min(1, Math.max(0, (e - f.full) / (f.zero - f.full)));
    return 1 - t * t * (3 - 2 * t);
  }

  /** Coefficients for `pose` (cL, cR include the trunk term). Returns false when all are ~0. */
  prepare(pose: AnatomicalPose) {
    const m = this.model;
    const r = m.components;
    this.coefficients(m.armL, armFeature(pose, m.neutral, 'L', this.feature), this.cL);
    this.coefficients(m.armR, armFeature(pose, m.neutral, 'R', this.feature), this.cR);
    if (m.trunk) this.coefficients(m.trunk, trunkFeature(pose, m.neutral, this.feature), this.cT);
    else this.cT.fill(0);
    // Elevation fade (PSD.fade): each side's arm correctives fade out as its own arm rises.
    const fL = this.fadeOf(pose, 'L'),
      fR = this.fadeOf(pose, 'R');
    this.fade[0] = fL;
    this.fade[1] = fR;
    let any = false;
    for (let j = 0; j < r; j++) {
      this.cL[j] = fL * this.cL[j] + this.cT[j];
      this.cR[j] = fR * this.cR[j] + this.cT[j];
      if (Math.abs(this.cL[j]) > 1e-9 || Math.abs(this.cR[j]) > 1e-9) any = true;
    }
    return any;
  }

  /** The local correction field at `pose` (N·3), unguarded, for validation and tests. */
  local(pose: AnatomicalPose, out = new Float32Array(this.model.count * 3)) {
    const m = this.model;
    const r = m.components,
      basis = m.basis,
      mask = m.leftMask,
      c = this.c;
    this.prepare(pose);
    for (let i = 0; i < m.count; i++) {
      const w = mask[i];
      for (let j = 0; j < r; j++) c[j] = w * this.cL[j] + (1 - w) * this.cR[j];
      let x = 0,
        y = 0,
        z = 0;
      for (let j = 0; j < r; j++) {
        const o = (i * r + j) * 3;
        x += c[j] * basis[o];
        y += c[j] * basis[o + 1];
        z += c[j] * basis[o + 2];
      }
      out[i * 3] = x;
      out[i * 3 + 1] = y;
      out[i * 3 + 2] = z;
    }
    return out;
  }

  /**
   * Adds gain · B_i(drivers) · local_i(pose) to `positions` (N·3, skinned) in place: the run-time
   * path. With `body` (the posed body vertex positions and normals, V·3 each) and a model guard,
   * the body guard bounds the result (guard.ts). Returns false (positions untouched) when the pose
   * is at the neutral stand.
   */
  apply(
    pose: AnatomicalPose,
    drivers: ArrayLike<number>,
    skin: SkinArrays,
    positions: Float32Array,
    gain = 1,
    body: { positions: ArrayLike<number>; normals: ArrayLike<number> } | null = null,
  ) {
    const m = this.model;
    this.guarded = 0;
    if (positions.length !== m.count * 3 || skin.count !== m.count)
      throw new Error('PSD model does not match the jacket');
    if (!this.prepare(pose) || gain === 0) return false;
    const r = m.components,
      basis = m.basis,
      mask = m.leftMask,
      cL = this.cL,
      cR = this.cR,
      c = this.c;
    const G = influencesOf(skin);
    const W = skin.skinWeights,
      D = skin.skinDrivers;
    const guard = body ? m.guard : null;
    const gc = guard?.candidates,
      gd = guard?.distance,
      gn = guard?.normal,
      gg = guard?.clearance;
    const useCandidates = this.guardMode !== 'clearance',
      useClearance = this.guardMode !== 'candidates';
    const bp = body?.positions,
      bn = body?.normals;
    const A = GUARD_CANDIDATES;
    const margin = PSD.guardMarginM;
    let guarded = 0;
    for (let i = 0; i < m.count; i++) {
      const w = mask[i];
      let coeff: Float64Array;
      if (w >= 1) coeff = cL;
      else if (w <= 0) coeff = cR;
      else {
        for (let j = 0; j < r; j++) c[j] = w * cL[j] + (1 - w) * cR[j];
        coeff = c;
      }
      let x = 0,
        y = 0,
        z = 0;
      let o = i * r * 3;
      for (let j = 0; j < r; j++, o += 3) {
        const k = coeff[j];
        x += k * basis[o];
        y += k * basis[o + 1];
        z += k * basis[o + 2];
      }
      // The blend's linear part (3×3) at this frame.
      let b0 = 0,
        b1 = 0,
        b2 = 0,
        b4 = 0,
        b5 = 0,
        b6 = 0,
        b8 = 0,
        b9 = 0,
        b10 = 0;
      for (let k = 0, s = i * G; k < G; k++, s++) {
        const wk = W[s];
        if (wk === 0) continue;
        const d = D[s] * 12;
        b0 += wk * drivers[d];
        b1 += wk * drivers[d + 1];
        b2 += wk * drivers[d + 2];
        b4 += wk * drivers[d + 4];
        b5 += wk * drivers[d + 5];
        b6 += wk * drivers[d + 6];
        b8 += wk * drivers[d + 8];
        b9 += wk * drivers[d + 9];
        b10 += wk * drivers[d + 10];
      }
      let wx = gain * (b0 * x + b1 * y + b2 * z),
        wy = gain * (b4 * x + b5 * y + b6 * z),
        wz = gain * (b8 * x + b9 * y + b10 * z);
      const p = i * 3;
      let tested = false;
      // Cheap pre-test on the particle's own skin normal (carried by its LBS frame): a correction
      // that does not head into the skin by more than PSD.guardSlackM past its clearance skips
      // the candidate search (most particles at most poses).
      let inward = true;
      if (gn && gg && gc && gc[i * A] !== NO_GUARD) {
        const lx = gn[p],
          ly = gn[p + 1],
          lz = gn[p + 2];
        const sx = b0 * lx + b1 * ly + b2 * lz,
          sy = b4 * lx + b5 * ly + b6 * lz,
          sz = b8 * lx + b9 * ly + b10 * lz;
        const sl = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
        inward = (wx * sx + wy * sy + wz * sz) / sl < -(gg[i] - margin) + PSD.guardSlackM;
      }
      if (inward && useCandidates && gc && gd && bp && bn && gc[i * A] !== NO_GUARD) {
        // The candidate skin vertex nearest the corrected particle, posed.
        const cx = positions[p] + wx,
          cy = positions[p + 1] + wy,
          cz = positions[p + 2] + wz;
        let q = -1,
          best = Infinity;
        for (let k = i * A, e = k + A; k < e; k++) {
          const v = gc[k];
          if (v === NO_GUARD) break;
          const t = v * 3;
          const dd = (cx - bp[t]) ** 2 + (cy - bp[t + 1]) ** 2 + (cz - bp[t + 2]) ** 2;
          if (dd < best) {
            best = dd;
            q = t;
          }
        }
        // Skin only counts near the particle (it may have been carried far from all candidates).
        const reach = gd[i] + this.guardRadiusM;
        if (q >= 0 && best <= reach * reach) {
          tested = true;
          const nx = bn[q],
            ny = bn[q + 1],
            nz = bn[q + 2];
          const d0 =
            (positions[p] - bp[q]) * nx +
            (positions[p + 1] - bp[q + 1]) * ny +
            (positions[p + 2] - bp[q + 2]) * nz;
          const d1 = d0 + wx * nx + wy * ny + wz * nz;
          const floor = d0 < margin ? d0 : margin;
          if (d1 < floor) {
            const sh = floor - d1;
            wx += sh * nx;
            wy += sh * ny;
            wz += sh * nz;
            guarded++;
          }
        }
      }
      if (inward && !tested && useClearance && gn && gg && gc && gc[i * A] !== NO_GUARD) {
        // No skin vertex near: limit the inward part along the particle's own skin normal, carried
        // by its LBS frame, to its neutral clearance − margin (sliding along the body is free).
        const lx = gn[p],
          ly = gn[p + 1],
          lz = gn[p + 2];
        let nx = b0 * lx + b1 * ly + b2 * lz,
          ny = b4 * lx + b5 * ly + b6 * lz,
          nz = b8 * lx + b9 * ly + b10 * lz;
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (l > 0) {
          nx /= l;
          ny /= l;
          nz /= l;
          const allowed = -Math.max(0, gg[i] - margin);
          const s = wx * nx + wy * ny + wz * nz;
          if (s < allowed) {
            const sh = allowed - s;
            wx += sh * nx;
            wy += sh * ny;
            wz += sh * nz;
            guarded++;
          }
        }
      }
      positions[p] += wx;
      positions[p + 1] += wy;
      positions[p + 2] += wz;
    }
    this.guarded = guarded;
    return true;
  }
}
