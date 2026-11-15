// Body collision interface for the cloth solver. Scene frame: metres, Y up, +Z = body front.
//
// The solver only ever asks "how far is this point from the body surface, and in which
// direction is outside?". A static posed-body grid SDF (GridSdfCollider) and a per-frame
// articulated body SDF (motion P2, services/body/body_service/motion/FORMAT.md) are therefore
// interchangeable: call `ClothSolver.setCollider(collider)` before `step()` whenever the body
// moves. No Three.js / DOM / worker dependencies.

export interface BodyCollider {
  /**
   * Signed distance in metres from the body surface (positive outside, negative inside).
   * When `gradient` is given and the returned distance is below `threshold` (default +∞),
   * writes ∂distance/∂(x, y, z) into gradient[0..2]. The solver normalises it, so any positive
   * multiple of the outward normal is acceptable; a zero vector means "no reliable direction"
   * and the contact is skipped for that particle.
   */
  distance(x: number, y: number, z: number, gradient?: Float64Array, threshold?: number): number;
  /**
   * Optional velocity (m/s) of the body surface closest to (x, y, z), written into out[0..2].
   * Moving colliders provide it so contact friction acts on the cloth's velocity *relative to
   * the skin* (sleeves are carried by a raised arm instead of sliding off). Static colliders
   * omit it (zero).
   */
  surfaceVelocity?(x: number, y: number, z: number, out: Float64Array): void;
  /**
   * Optional upper bound (m) on how far any body surface point moved since the previous pose of
   * this same collider object. When set, `ClothSolver.setCollider` keeps each particle's contact
   * slack minus this bound instead of re-querying every particle (and keeps its contact planes
   * when the bound is 0, e.g. while a motion holds still).
   */
  readonly motionBound?: number;
}

export type GridSdfLayout = {
  origin: readonly number[];
  dimensions: readonly number[];
  spacing: number;
};

/**
 * Trilinear signed distance grid, flat index (i·ny + j)·nz + k, node (i,j,k) at
 * origin + (i,j,k)·spacing (the layout written by services/body/body_service/garment/sdf.py).
 * Outside the grid the distance is extended by the Euclidean distance to the clamped point,
 * an upper bound that keeps the gradient pointing back towards the box.
 */
export class GridSdfCollider implements BodyCollider {
  readonly values: Float32Array;
  private ox: number;
  private oy: number;
  private oz: number;
  private nx: number;
  private ny: number;
  private nz: number;
  private spacing: number;
  private inverseSpacing: number;

  constructor(values: Float32Array, layout: GridSdfLayout) {
    const [nx, ny, nz] = layout.dimensions;
    if (values.length !== nx * ny * nz) throw new Error('SDF byte count mismatch');
    this.values = values;
    [this.ox, this.oy, this.oz] = layout.origin;
    [this.nx, this.ny, this.nz] = [nx, ny, nz];
    this.spacing = layout.spacing;
    this.inverseSpacing = 1 / layout.spacing;
  }

  distance(x: number, y: number, z: number, gradient?: Float64Array, threshold = Infinity) {
    const gx = Math.max(0, Math.min(this.nx - 1.00001, (x - this.ox) * this.inverseSpacing));
    const gy = Math.max(0, Math.min(this.ny - 1.00001, (y - this.oy) * this.inverseSpacing));
    const gz = Math.max(0, Math.min(this.nz - 1.00001, (z - this.oz) * this.inverseSpacing));
    const i = Math.floor(gx),
      j = Math.floor(gy),
      k = Math.floor(gz),
      u = gx - i,
      v = gy - j,
      w = gz - k;
    const sx = this.ny * this.nz,
      sy = this.nz,
      base = i * sx + j * sy + k,
      f = this.values;
    const c000 = f[base],
      c100 = f[base + sx],
      c010 = f[base + sy],
      c110 = f[base + sx + sy];
    const c001 = f[base + 1],
      c101 = f[base + sx + 1],
      c011 = f[base + sy + 1],
      c111 = f[base + sx + sy + 1];
    const a = c000 * (1 - u) + c100 * u,
      b = c010 * (1 - u) + c110 * u;
    const c = c001 * (1 - u) + c101 * u,
      d = c011 * (1 - u) + c111 * u;
    const lower = a * (1 - v) + b * v,
      upper = c * (1 - v) + d * v;
    const ox = x - (this.ox + gx * this.spacing),
      oy = y - (this.oy + gy * this.spacing),
      oz = z - (this.oz + gz * this.spacing);
    const extension = Math.sqrt(ox * ox + oy * oy + oz * oz);
    const value = lower * (1 - w) + upper * w + extension;
    if (gradient && value < threshold) {
      gradient[0] =
        Math.abs(ox) < 1e-12
          ? ((c100 - c000) * (1 - v) * (1 - w) +
              (c110 - c010) * v * (1 - w) +
              (c101 - c001) * (1 - v) * w +
              (c111 - c011) * v * w) *
            this.inverseSpacing
          : 0;
      gradient[1] =
        Math.abs(oy) < 1e-12 ? ((b - a) * (1 - w) + (d - c) * w) * this.inverseSpacing : 0;
      gradient[2] = Math.abs(oz) < 1e-12 ? (upper - lower) * this.inverseSpacing : 0;
      if (extension > 1e-12) {
        gradient[0] += ox / extension;
        gradient[1] += oy / extension;
        gradient[2] += oz / extension;
      }
    }
    return value;
  }
}
