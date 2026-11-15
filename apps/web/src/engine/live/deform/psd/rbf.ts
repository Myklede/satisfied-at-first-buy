// Gaussian radial basis interpolation over pose features (agent V7). Pure, no DOM.
//
//   f(x) = Σ_k α_k(x) · y_k,   α(x) = (Φ + λI)⁻¹ · φ(x),   Φ_jk = exp(−|x_j − x_k|² / σ²)
//
// so a prediction is a weighted sum of the training samples' values (y_k: the samples' correction
// coefficients), exact at the samples when λ → 0, and decaying to 0 (= plain LBS, the neutral
// sample's value) far from every sample: an unseen pose is never extrapolated wildly. σ and λ are
// chosen by leave-one-out cross-validation in closed form (Rippa, Adv. Comput. Math. 11, 1999):
// the error of predicting sample k from the others is (A⁻¹Y)_k / (A⁻¹)_kk.
import { invert } from './linalg.ts';

export type Rbf = {
  /** Training features, K×d (row-major). */
  centers: Float64Array;
  K: number;
  d: number;
  sigma: number;
  lambda: number;
  /** (Φ + λI)⁻¹, K×K. */
  inverse: Float64Array;
  /** Leave-one-out RMS error of the chosen σ, λ (units of the values' norm per sample). */
  looRms: number;
};

function kernelMatrix(centers: Float64Array, K: number, d: number, sigma: number, lambda: number) {
  const a = new Float64Array(K * K);
  const s2 = sigma * sigma;
  for (let j = 0; j < K; j++)
    for (let k = j; k < K; k++) {
      let r2 = 0;
      for (let c = 0; c < d; c++) r2 += (centers[j * d + c] - centers[k * d + c]) ** 2;
      const v = Math.exp(-r2 / s2) + (j === k ? lambda : 0);
      a[j * K + k] = v;
      a[k * K + j] = v;
    }
  return a;
}

/**
 * Fits the RBF to K samples with values Y (K×r, row-major): picks (σ, λ) from the candidates by
 * leave-one-out error over all r outputs. With one sample the RBF is that sample's bump.
 */
export function fitRbf(
  centers: Float64Array,
  K: number,
  d: number,
  values: Float64Array,
  r: number,
  sigmas: readonly number[],
  lambdas: readonly number[],
): Rbf {
  if (centers.length !== K * d || values.length !== K * r) throw new Error('RBF size mismatch');
  let best: Rbf | null = null;
  for (const sigma of sigmas)
    for (const lambda of lambdas) {
      let inverse: Float64Array;
      try {
        inverse = invert(kernelMatrix(centers, K, d, sigma, lambda), K);
      } catch {
        continue; // singular at this width: duplicate centres need a ridge
      }
      let sum = 0;
      if (K > 1)
        for (let k = 0; k < K; k++) {
          const diag = inverse[k * K + k];
          for (let c = 0; c < r; c++) {
            let ck = 0;
            for (let j = 0; j < K; j++) ck += inverse[k * K + j] * values[j * r + c];
            sum += (ck / diag) ** 2;
          }
        }
      const looRms = Math.sqrt(sum / Math.max(1, K));
      if (!Number.isFinite(looRms)) continue;
      if (!best || looRms < best.looRms - 1e-12)
        best = { centers: Float64Array.from(centers), K, d, sigma, lambda, inverse, looRms };
    }
  if (!best) throw new Error('No RBF width gave a solvable system');
  return best;
}

/** Sample weights α(x) into out (K). `scratch` (K) holds φ(x). */
export function rbfWeights(
  rbf: Rbf,
  x: ArrayLike<number>,
  out: Float64Array,
  scratch: Float64Array = new Float64Array(rbf.K),
  xo = 0,
) {
  const { K, d, centers, inverse } = rbf;
  const s2 = rbf.sigma * rbf.sigma;
  for (let k = 0; k < K; k++) {
    let r2 = 0;
    for (let c = 0; c < d; c++) r2 += (x[xo + c] - centers[k * d + c]) ** 2;
    scratch[k] = Math.exp(-r2 / s2);
  }
  for (let j = 0; j < K; j++) {
    let s = 0;
    for (let k = 0; k < K; k++) s += inverse[j * K + k] * scratch[k];
    out[j] = s;
  }
  return out;
}
