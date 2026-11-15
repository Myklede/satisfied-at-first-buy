// Small dense linear algebra for the pose-space correctives (agent V7): K×K with K ≤ ~60
// samples. Pure, no DOM, float64.

/** Inverse of a K×K matrix (row-major) by Gauss–Jordan with partial pivoting. */
export function invert(a: Float64Array, K: number): Float64Array {
  const m = Float64Array.from(a);
  const inv = new Float64Array(K * K);
  for (let i = 0; i < K; i++) inv[i * K + i] = 1;
  for (let c = 0; c < K; c++) {
    let pivot = c,
      best = Math.abs(m[c * K + c]);
    for (let r = c + 1; r < K; r++) {
      const v = Math.abs(m[r * K + c]);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (!(best > 1e-14)) throw new Error('Singular matrix');
    if (pivot !== c)
      for (let j = 0; j < K; j++) {
        let t = m[c * K + j];
        m[c * K + j] = m[pivot * K + j];
        m[pivot * K + j] = t;
        t = inv[c * K + j];
        inv[c * K + j] = inv[pivot * K + j];
        inv[pivot * K + j] = t;
      }
    const d = 1 / m[c * K + c];
    for (let j = 0; j < K; j++) {
      m[c * K + j] *= d;
      inv[c * K + j] *= d;
    }
    for (let r = 0; r < K; r++) {
      if (r === c) continue;
      const f = m[r * K + c];
      if (!f) continue;
      for (let j = 0; j < K; j++) {
        m[r * K + j] -= f * m[c * K + j];
        inv[r * K + j] -= f * inv[c * K + j];
      }
    }
  }
  return inv;
}

/**
 * Eigen-decomposition of a symmetric K×K matrix (cyclic Jacobi). Returns the eigenvalues in
 * descending order and the eigenvectors as the COLUMNS of `vectors` (row-major K×K).
 */
export function symmetricEigen(a: Float64Array, K: number) {
  const m = Float64Array.from(a);
  const v = new Float64Array(K * K);
  for (let i = 0; i < K; i++) v[i * K + i] = 1;
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < K; p++) for (let q = p + 1; q < K; q++) off += m[p * K + q] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < K; p++)
      for (let q = p + 1; q < K; q++) {
        const apq = m[p * K + q];
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (m[q * K + q] - m[p * K + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1),
          s = t * c;
        for (let k = 0; k < K; k++) {
          const mkp = m[k * K + p],
            mkq = m[k * K + q];
          m[k * K + p] = c * mkp - s * mkq;
          m[k * K + q] = s * mkp + c * mkq;
        }
        for (let k = 0; k < K; k++) {
          const mpk = m[p * K + k],
            mqk = m[q * K + k];
          m[p * K + k] = c * mpk - s * mqk;
          m[q * K + k] = s * mpk + c * mqk;
        }
        for (let k = 0; k < K; k++) {
          const vkp = v[k * K + p],
            vkq = v[k * K + q];
          v[k * K + p] = c * vkp - s * vkq;
          v[k * K + q] = s * vkp + c * vkq;
        }
      }
  }
  const order = Array.from({ length: K }, (_, i) => i).sort((x, y) => m[y * K + y] - m[x * K + x]);
  const values = Float64Array.from(order, (i) => m[i * K + i]);
  const vectors = new Float64Array(K * K);
  order.forEach((src, dst) => {
    for (let k = 0; k < K; k++) vectors[k * K + dst] = v[k * K + src];
  });
  return { values, vectors };
}
