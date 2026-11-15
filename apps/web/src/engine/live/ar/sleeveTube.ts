// The sleeve is one continuous tube from the shoulder seam to the cuff (agent F3, behind
// ?f3shoulder=1; lead 23:2x and 23:5x: RC5's sleeve heads ballooned outward, widest at mid upper
// arm, and on the puffer the dropped-shoulder cap ended WIDER than the sleeve under it, a step
// and a shelf at the bicep). Pure.
//
// A real sleeve (FB7675 S bicep 40 cm, DQ4920 the same chambers to the cuff) changes width
// smoothly and narrows a little toward the cuff; its head is no wider than the arm below it. Here
// every sleeve vertex of the upper arm keeps only TUBE_KEEP of how far it stands outside the
// tube: the sleeve's own radius at the bicep (the upper arm's lower part), widening by at most
// TUBE_HEAD_FLARE toward the shoulder. The seam stays where it is (no tear): the correction
// fades in over TUBE_SEAM_M of cloth from the body panels.
import { geodesicDistance, uniqueEdges } from '../garmentSkin';
import { PANEL } from '../../garmentSurface';

export const TUBE_KEEP = 0.15;
/** The tube may widen toward the shoulder by this share of the bicep radius. */
export const TUBE_HEAD_FLARE = 0.1;
/** Cloth distance (m) from the body panels over which the correction fades in. */
export const TUBE_SEAM_M = 0.06;
/** The bicep band: this share of the shoulder→elbow bone, measured from the shoulder. */
export const TUBE_BICEP: readonly [number, number] = [0.45, 0.7];

export type Joints = Partial<Record<string, readonly [number, number, number]>>;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Per asset (positions at rest): 0 at the seam, 1 from TUBE_SEAM_M of cloth on (sleeves only). */
export function seamWeights(
  panels: ArrayLike<number>,
  triangles: ArrayLike<number>,
  positions: ArrayLike<number>,
): Float32Array {
  const n = panels.length;
  const isSleeve = (i: number) => panels[i] === PANEL.sleeveL || panels[i] === PANEL.sleeveR;
  const dist = geodesicDistance(
    n,
    (i) => !isSleeve(i),
    uniqueEdges(triangles),
    positions,
    TUBE_SEAM_M,
  );
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) if (isSleeve(i)) w[i] = smooth(0, TUBE_SEAM_M, dist[i]);
  return w;
}

/**
 * Pulls the upper sleeves in to a straight tube, in place (scene m). `seam` from seamWeights.
 * Returns the largest pull (m).
 */
export function tubeSleeves(
  positions: Float32Array,
  panels: ArrayLike<number>,
  joints: Joints,
  seam: ArrayLike<number>,
  keep = TUBE_KEEP,
): number {
  let removed = 0;
  for (const [panel, s, e] of [
    [PANEL.sleeveL, 'lShoulder', 'lElbow'],
    [PANEL.sleeveR, 'rShoulder', 'rElbow'],
  ] as const) {
    const S = joints[s],
      E = joints[e];
    if (!S || !E) continue;
    const ax = E[0] - S[0],
      ay = E[1] - S[1],
      az = E[2] - S[2];
    const len2 = ax * ax + ay * ay + az * az;
    if (!(len2 > 1e-6)) continue;
    const n = Math.min(panels.length, positions.length / 3);
    const radial = (v: number) => {
      const px = positions[v * 3] - S[0],
        py = positions[v * 3 + 1] - S[1],
        pz = positions[v * 3 + 2] - S[2];
      const t = (px * ax + py * ay + pz * az) / len2;
      const dx = px - t * ax,
        dy = py - t * ay,
        dz = pz - t * az;
      return { t, dx, dy, dz, r: Math.hypot(dx, dy, dz) };
    };
    // The bicep radius: a high percentile of the band's radial distances (the outside of the tube).
    const band: number[] = [];
    for (let v = 0; v < n; v++) {
      if (panels[v] !== panel) continue;
      const q = radial(v);
      if (q.t >= TUBE_BICEP[0] && q.t <= TUBE_BICEP[1]) band.push(q.r);
    }
    if (band.length < 8) continue;
    band.sort((a, b) => a - b);
    const rb = band[Math.floor(0.9 * (band.length - 1))];
    for (let v = 0; v < n; v++) {
      if (panels[v] !== panel || !(seam[v] > 0)) continue;
      const q = radial(v);
      // Below the shoulder joint only: the cap's top over the shoulder is not a tube.
      if (q.t >= TUBE_BICEP[0] || q.t < -0.1 || q.r < 1e-6) continue;
      const allowed = rb * (1 + TUBE_HEAD_FLARE * smooth(TUBE_BICEP[0], 0, q.t));
      const excess = q.r - allowed;
      if (excess <= 0) continue;
      const cut = excess * (1 - keep) * seam[v];
      const k = cut / q.r;
      positions[v * 3] -= q.dx * k;
      positions[v * 3 + 1] -= q.dy * k;
      positions[v * 3 + 2] -= q.dz * k;
      removed = Math.max(removed, cut);
    }
  }
  return removed;
}
