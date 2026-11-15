// Evaluation only: signed distance to the posed body mesh. Exact closest point per triangle
// (Ericson, Real-Time Collision Detection 5.1.5) over a triangle grid (3 cm search), and the sign
// from the angle-weighted pseudonormal of the closest feature (face, edge or vertex: Bærentzen &
// Aanæs 2005), which is correct for a closed mesh; interpolated vertex normals are not (they
// flipped the sign beside the wrist in the first evaluation).
type Feature = { kind: 0 | 1 | 2; a: number; b: number };

export class BodySdf {
  private cells = new Map<number, number[]>();
  private faceN: Float64Array;
  private vertN: Float64Array;
  private edgeN = new Map<number, [number, number, number]>();

  constructor(
    private p: ArrayLike<number>,
    _normals: ArrayLike<number>,
    private f: ArrayLike<number>,
    private cell = 0.03,
  ) {
    const T = f.length / 3,
      V = p.length / 3;
    this.faceN = new Float64Array(T * 3);
    this.vertN = new Float64Array(V * 3);
    for (let t = 0; t < T; t++) {
      const ids = [f[t * 3], f[t * 3 + 1], f[t * 3 + 2]];
      const P = ids.map((v) => [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]]);
      const e1 = sub(P[1], P[0]),
        e2 = sub(P[2], P[0]);
      const n = norm(cross(e1, e2));
      this.faceN.set(n, t * 3);
      for (let k = 0; k < 3; k++) {
        // Angle-weighted vertex normal.
        const u = norm(sub(P[(k + 1) % 3], P[k])),
          w = norm(sub(P[(k + 2) % 3], P[k]));
        const angle = Math.acos(Math.max(-1, Math.min(1, dot(u, w))));
        for (let a = 0; a < 3; a++) this.vertN[ids[k] * 3 + a] += angle * n[a];
        // Edge normal: sum of the adjacent faces' normals.
        const key = edgeKey(ids[k], ids[(k + 1) % 3]);
        const en = this.edgeN.get(key);
        if (en) for (let a = 0; a < 3; a++) en[a] += n[a];
        else this.edgeN.set(key, [n[0], n[1], n[2]]);
      }
      const lo = [0, 1, 2].map((a) => Math.min(P[0][a], P[1][a], P[2][a]));
      const hi = [0, 1, 2].map((a) => Math.max(P[0][a], P[1][a], P[2][a]));
      for (let x = Math.floor(lo[0] / cell); x <= Math.floor(hi[0] / cell); x++)
        for (let y = Math.floor(lo[1] / cell); y <= Math.floor(hi[1] / cell); y++)
          for (let z = Math.floor(lo[2] / cell); z <= Math.floor(hi[2] / cell); z++) {
            const key = this.key(x, y, z);
            const list = this.cells.get(key);
            if (list) list.push(t);
            else this.cells.set(key, [t]);
          }
    }
  }

  private key(x: number, y: number, z: number) {
    return ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
  }

  /** Signed distance (m, negative inside); +Infinity beyond the 3 cm search. */
  distance(x: number, y: number, z: number) {
    const c = this.cell;
    const cx = Math.floor(x / c),
      cy = Math.floor(y / c),
      cz = Math.floor(z / c);
    let best = Infinity,
      bestT = -1,
      bestQ: number[] = [0, 0, 0],
      bestF: Feature = { kind: 2, a: 0, b: 0 };
    const seen = new Set<number>();
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (let k = -1; k <= 1; k++) {
          const list = this.cells.get(this.key(cx + i, cy + j, cz + k));
          if (!list) continue;
          for (const t of list) {
            if (seen.has(t)) continue;
            seen.add(t);
            const r = this.closest(t, x, y, z);
            if (r.d < best) {
              best = r.d;
              bestT = t;
              bestQ = r.q;
              bestF = r.feature;
            }
          }
        }
    if (bestT < 0) return Infinity;
    const n =
      bestF.kind === 2
        ? [this.faceN[bestT * 3], this.faceN[bestT * 3 + 1], this.faceN[bestT * 3 + 2]]
        : bestF.kind === 1
          ? (this.edgeN.get(edgeKey(bestF.a, bestF.b)) ?? [0, 0, 0])
          : [this.vertN[bestF.a * 3], this.vertN[bestF.a * 3 + 1], this.vertN[bestF.a * 3 + 2]];
    const s = dot([x - bestQ[0], y - bestQ[1], z - bestQ[2]], n) >= 0 ? 1 : -1;
    return best * s;
  }

  private closest(t: number, x: number, y: number, z: number) {
    const { p, f } = this;
    const ia = f[t * 3],
      ib = f[t * 3 + 1],
      ic = f[t * 3 + 2];
    const A = [p[ia * 3], p[ia * 3 + 1], p[ia * 3 + 2]],
      B = [p[ib * 3], p[ib * 3 + 1], p[ib * 3 + 2]],
      C = [p[ic * 3], p[ic * 3 + 1], p[ic * 3 + 2]];
    const P = [x, y, z];
    const ab = sub(B, A),
      ac = sub(C, A),
      ap = sub(P, A);
    const d1 = dot(ab, ap),
      d2 = dot(ac, ap);
    let q: number[], feature: Feature;
    if (d1 <= 0 && d2 <= 0) {
      q = A;
      feature = { kind: 0, a: ia, b: ia };
    } else {
      const bp = sub(P, B);
      const d3 = dot(ab, bp),
        d4 = dot(ac, bp);
      const cp = sub(P, C);
      const d5 = dot(ab, cp),
        d6 = dot(ac, cp);
      const vc = d1 * d4 - d3 * d2,
        vb = d5 * d2 - d1 * d6,
        va = d3 * d6 - d5 * d4;
      if (d3 >= 0 && d4 <= d3) {
        q = B;
        feature = { kind: 0, a: ib, b: ib };
      } else if (d6 >= 0 && d5 <= d6) {
        q = C;
        feature = { kind: 0, a: ic, b: ic };
      } else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        q = add(A, scale(ab, v));
        feature = { kind: 1, a: ia, b: ib };
      } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        q = add(A, scale(ac, w));
        feature = { kind: 1, a: ia, b: ic };
      } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
        q = add(B, scale(sub(C, B), w));
        feature = { kind: 1, a: ib, b: ic };
      } else {
        const den = 1 / (va + vb + vc);
        q = add(A, add(scale(ab, vb * den), scale(ac, vc * den)));
        feature = { kind: 2, a: 0, b: 0 };
      }
    }
    return { d: Math.hypot(x - q[0], y - q[1], z - q[2]), q, feature };
  }
}

const edgeKey = (a: number, b: number) => Math.min(a, b) * 1_000_003 + Math.max(a, b);
const sub = (u: number[], v: number[]) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
const add = (u: number[], v: number[]) => [u[0] + v[0], u[1] + v[1], u[2] + v[2]];
const scale = (u: number[], s: number) => [u[0] * s, u[1] * s, u[2] * s];
const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const cross = (u: number[], v: number[]) => [
  u[1] * v[2] - u[2] * v[1],
  u[2] * v[0] - u[0] * v[2],
  u[0] * v[1] - u[1] * v[0],
];
const norm = (u: number[]) => {
  const l = Math.hypot(u[0], u[1], u[2]) || 1;
  return [u[0] / l, u[1] / l, u[2] / l];
};

/** Ray parity (Möller–Trumbore) along three axes, majority vote: is (x, y, z) inside the mesh? */
export function insideByParity(p: ArrayLike<number>, f: ArrayLike<number>, x: number, y: number, z: number) {
  const dirs = [
    [1, 0.0123, 0.0071],
    [0.0091, 1, 0.0137],
    [0.0113, 0.0067, 1],
  ];
  let votes = 0;
  for (const d of dirs) {
    let hits = 0;
    for (let t = 0; t < f.length; t += 3) {
      const a = f[t] * 3,
        b = f[t + 1] * 3,
        c = f[t + 2] * 3;
      const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
      const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
      const h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
      const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      const s = [x - p[a], y - p[a + 1], z - p[a + 2]];
      const u = inv * (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]);
      if (u < 0 || u > 1) continue;
      const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
      const v = inv * (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]);
      if (v < 0 || u + v > 1) continue;
      if (inv * (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) > 0) hits++;
    }
    if (hits % 2 === 1) votes++;
  }
  return votes >= 2;
}
