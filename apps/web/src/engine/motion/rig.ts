// Motion rig and frames (P1 exports, services/body/body_service/motion/FORMAT.md).
// Scene frame: metres, X = subject's LEFT, Y up, +Z front, feet on Y = 0. Pure, no DOM.
//
// Skinning is Anny's linear blend skinning (P1 kept LBS, docs/validation/motion-skinning.md):
//   p' = Σ_k w_k · M[driver_of_bone[skin_indices_k]] · [p, 1]
// where M are the 18 per-frame driver matrices (3×4, row-major, T = W · R⁻¹).
import { blob, decodeSatb } from './satb.ts';

export const DRIVER_STRIDE = 12; // one 3×4 row-major matrix

export type AnatomicalPose = Record<string, number>;

export type MotionRig = {
  version: string;
  bones: string[];
  drivers: number[];
  neutralPose: AnatomicalPose;
  calibratedVertical: number[];
  restWorld: Float32Array; // (104, 4, 4)
  restVertices: Float32Array; // (V, 3)
  faces: Uint32Array; // (T, 3)
  skinIndices: Uint16Array; // (V, K)
  skinWeights: Float32Array; // (V, K)
  driverOfBone: Uint8Array; // (104,)
  /** driver_of_bone[skin_indices], baked once: (V, K) driver index per influence. */
  vertexDrivers: Uint8Array;
  influences: number;
  vertexCount: number;
  /**
   * Shoulder-ridge weight transfer (services/body/body_service/motion/ridge.py), present when the
   * service exports the rig with skinning 'lbs-ridge1'. Applied by skinVertices / vertexBlend.
   */
  ridge?: RidgeTransfer;
};

export type RidgeTransfer = {
  vertices: Uint32Array;
  mask: Float32Array;
  upperWeight: Float32Array;
  side: Uint8Array;
  upperDriver: [number, number];
  clavicleDriver: [number, number];
  humerusRest: [number[], number[]];
  rampDeg: [number, number];
  /** Vertex id -> index in the arrays above, or -1. */
  slot: Int32Array;
};

export type MotionPreset = {
  id: string;
  label: string;
  duration_s: number;
  hold: { start_s: number; end_s: number };
  keyframes: { t_s: number; pose: AnatomicalPose }[];
};

export type FrameInfo = {
  t_s: number;
  seated: boolean;
  root_offset_m: number[];
  ankle_deg: Record<string, number>;
  clamps: unknown[];
  warnings: string[];
};

export type MotionFrames = {
  motion: MotionPreset;
  fps: number;
  count: number;
  /** (F, 18, 3, 4) driver skinning matrices. */
  matrices: Float32Array;
  frames: FrameInfo[];
  poses: AnatomicalPose[];
  /** anchor.<name> blobs, e.g. 'ring.waistband_mid' → (F, 32, 3). */
  anchors: Map<string, { data: Float32Array; perFrame: number }>;
};

export type Attachment = { vertices: number[][]; weights: number[][]; rest: number[][] };
export type MotionAnchors = {
  version: string;
  frame: string;
  ring_samples: number;
  ring_index: Record<string, number>;
  rings: Record<string, Attachment>;
  tapes: Record<string, Attachment>;
  points: Record<string, number>;
  heights_m: Record<string, number>;
  exposure_vertices: Record<string, number[]>;
  waistband_default: string;
};

export function parseRig(buffer: ArrayBuffer): MotionRig {
  const file = decodeSatb(buffer, 'rig');
  const h = file.header as unknown as {
    version: string;
    bones: string[];
    drivers: number[];
    skinning: string;
    neutral_pose: AnatomicalPose;
    calibrated_vertical: number[];
    ridge?: {
      ramp_deg: [number, number];
      upper_driver: [number, number];
      clavicle_driver: [number, number];
      humerus_rest: [number[], number[]];
    };
  };
  if (h.skinning !== 'lbs' && h.skinning !== 'lbs-ridge1')
    throw new Error(`Unsupported skinning ${h.skinning}`);
  const bones = h.bones.length;
  const restVertices = blob(file, 'rest_vertices', Float32Array, [null, 3]);
  const vertexCount = restVertices.length / 3;
  const skinIndices = blob(file, 'skin_indices', Uint16Array, [vertexCount, null]);
  const influences = skinIndices.length / vertexCount;
  const skinWeights = blob(file, 'skin_weights', Float32Array, [vertexCount, influences]);
  const driverOfBone = blob(file, 'driver_of_bone', Uint8Array, [bones]);
  const vertexDrivers = new Uint8Array(skinIndices.length);
  for (let i = 0; i < skinIndices.length; i++) {
    const bone = skinIndices[i];
    if (bone >= bones) throw new Error('Skin index out of range');
    vertexDrivers[i] = driverOfBone[bone];
  }
  for (const d of driverOfBone) if (d >= h.drivers.length) throw new Error('Driver out of range');
  let ridge: RidgeTransfer | undefined;
  if (h.skinning === 'lbs-ridge1') {
    if (!h.ridge) throw new Error('Ridge skinning without ridge data');
    const vertices = blob(file, 'ridge_vertices', Uint32Array, [null]);
    const n = vertices.length;
    const slot = new Int32Array(vertexCount).fill(-1);
    vertices.forEach((v, i) => {
      if (v >= vertexCount) throw new Error('Ridge vertex out of range');
      slot[v] = i;
    });
    ridge = {
      vertices,
      mask: blob(file, 'ridge_mask', Float32Array, [n]),
      upperWeight: blob(file, 'ridge_upper_weight', Float32Array, [n]),
      side: blob(file, 'ridge_side', Uint8Array, [n]),
      upperDriver: h.ridge.upper_driver,
      clavicleDriver: h.ridge.clavicle_driver,
      humerusRest: h.ridge.humerus_rest,
      rampDeg: h.ridge.ramp_deg,
      slot,
    };
  }
  return {
    version: h.version,
    bones: h.bones,
    drivers: h.drivers,
    neutralPose: h.neutral_pose,
    calibratedVertical: h.calibrated_vertical,
    restWorld: blob(file, 'rest_world', Float32Array, [bones, 4, 4]),
    restVertices,
    faces: blob(file, 'faces', Uint32Array, [null, 3]),
    skinIndices,
    skinWeights,
    driverOfBone,
    vertexDrivers,
    influences,
    vertexCount,
    ...(ridge ? { ridge } : {}),
  };
}

/**
 * Ridge transfer factor per side (ridge.py ridge_factor): the humerus direction relative to the
 * clavicle driver, e = angle from the rest-frame down axis, r = smoothstep((e - lo) / (hi - lo)).
 * Driver rotations are the left 3×3 of the 3×4 driver matrices.
 */
export function ridgeFactors(ridge: RidgeTransfer, m: ArrayLike<number>): [number, number] {
  const out: [number, number] = [0, 0];
  const [lo, hi] = ridge.rampDeg;
  for (let s = 0; s < 2; s++) {
    const u = ridge.upperDriver[s] * DRIVER_STRIDE,
      c = ridge.clavicleDriver[s] * DRIVER_STRIDE,
      h0 = ridge.humerusRest[s];
    // q = R_U h0
    const q0 = m[u] * h0[0] + m[u + 1] * h0[1] + m[u + 2] * h0[2],
      q1 = m[u + 4] * h0[0] + m[u + 5] * h0[1] + m[u + 6] * h0[2],
      q2 = m[u + 8] * h0[0] + m[u + 9] * h0[1] + m[u + 10] * h0[2];
    // h = R_C^T q
    const hx = m[c] * q0 + m[c + 4] * q1 + m[c + 8] * q2,
      hy = m[c + 1] * q0 + m[c + 5] * q1 + m[c + 9] * q2,
      hz = m[c + 2] * q0 + m[c + 6] * q1 + m[c + 10] * q2;
    const e = (Math.acos(Math.max(-1, Math.min(1, -hy / Math.hypot(hx, hy, hz)))) * 180) / Math.PI;
    const x = Math.max(0, Math.min(1, (e - lo) / (hi - lo)));
    out[s] = x * x * (3 - 2 * x);
  }
  return out;
}

/** Ridge share t of vertex slot i (mask × upper weight × side factor). */
function ridgeShare(ridge: RidgeTransfer, i: number, factors: [number, number]) {
  return ridge.mask[i] * ridge.upperWeight[i] * factors[ridge.side[i]];
}

export function parseFrames(buffer: ArrayBuffer, driverCount: number): MotionFrames {
  const file = decodeSatb(buffer, 'motion-frames');
  const h = file.header as unknown as {
    motion: MotionPreset;
    fps: number;
    frame_count: number;
    frames: FrameInfo[];
    poses: AnatomicalPose[];
  };
  const count = h.frame_count;
  const matrices = blob(file, 'driver_matrices', Float32Array, [count, driverCount, 3, 4]);
  const anchors = new Map<string, { data: Float32Array; perFrame: number }>();
  for (const [name, entry] of file.blobs) {
    if (!name.startsWith('anchor.')) continue;
    if (!(entry.array instanceof Float32Array) || entry.shape[0] !== count)
      throw new Error(`Anchor ${name} has an unexpected layout`);
    anchors.set(name.slice(7), { data: entry.array, perFrame: entry.array.length / count });
  }
  return {
    motion: h.motion,
    fps: h.fps,
    count,
    matrices,
    frames: h.frames,
    poses: h.poses,
    anchors,
  };
}

/** Anchor values of one frame, e.g. anchorFrame(frames, 'ring.waistband_mid', 10) → 32×3. */
export function anchorFrame(frames: MotionFrames, name: string, frame: number): Float32Array {
  const entry = frames.anchors.get(name);
  if (!entry) throw new Error(`Anchor ${name} missing from frames`);
  return entry.data.subarray(frame * entry.perFrame, (frame + 1) * entry.perFrame);
}

/**
 * Driver matrices at time t (s), linearly interpolated between the two neighbouring 30 fps
 * frames (component-wise lerp of the 3×4 matrices, i.e. the lerp of the skinned positions;
 * exact at the frames themselves). Clamped to the motion's range.
 */
export function matricesAt(frames: MotionFrames, t: number, out: Float64Array) {
  const n = frames.matrices.length / frames.count;
  if (out.length !== n) throw new Error('Driver buffer size mismatch');
  const x = Math.max(0, Math.min(frames.count - 1, t * frames.fps));
  const i = Math.min(frames.count - 2, Math.floor(x)),
    f = x - i,
    m = frames.matrices,
    a = i * n,
    b = a + n;
  for (let k = 0; k < n; k++) out[k] = m[a + k] * (1 - f) + m[b + k] * f;
  return out;
}

export function frameMatrices(frames: MotionFrames, frame: number, out: Float64Array) {
  const n = frames.matrices.length / frames.count;
  const m = frames.matrices;
  for (let k = 0; k < n; k++) out[k] = m[frame * n + k];
  return out;
}

/** Blended 3×4 LBS transform of vertex v into out[0..11]. */
export function vertexBlend(
  rig: MotionRig,
  v: number,
  m: ArrayLike<number>,
  out: Float64Array,
  offset = 0,
) {
  out.fill(0, offset, offset + 12);
  const K = rig.influences;
  for (let k = 0; k < K; k++) {
    const w = rig.skinWeights[v * K + k];
    if (!w) continue;
    const d = rig.vertexDrivers[v * K + k] * DRIVER_STRIDE;
    for (let j = 0; j < 12; j++) out[offset + j] += w * m[d + j];
  }
  const ridge = rig.ridge;
  if (ridge && ridge.slot[v] >= 0) {
    const i = ridge.slot[v],
      t = ridgeShare(ridge, i, ridgeFactors(ridge, m));
    if (t) {
      const s = ridge.side[i],
        cd = ridge.clavicleDriver[s] * DRIVER_STRIDE,
        ud = ridge.upperDriver[s] * DRIVER_STRIDE;
      for (let j = 0; j < 12; j++) out[offset + j] += t * (m[cd + j] - m[ud + j]);
    }
  }
  return out;
}

/** LBS of all vertices (or `ids`) into out (V×3, or ids.length×3). */
export function skinVertices(
  rig: MotionRig,
  m: ArrayLike<number>,
  out: Float32Array | Float64Array,
  ids?: ArrayLike<number>,
) {
  const K = rig.influences,
    r = rig.restVertices,
    W = rig.skinWeights,
    D = rig.vertexDrivers;
  const count = ids ? ids.length : rig.vertexCount;
  for (let s = 0; s < count; s++) {
    const v = ids ? ids[s] : s;
    const x = r[v * 3],
      y = r[v * 3 + 1],
      z = r[v * 3 + 2];
    let px = 0,
      py = 0,
      pz = 0;
    for (let k = 0; k < K; k++) {
      const w = W[v * K + k];
      if (!w) continue;
      const d = D[v * K + k] * DRIVER_STRIDE;
      px += w * (m[d] * x + m[d + 1] * y + m[d + 2] * z + m[d + 3]);
      py += w * (m[d + 4] * x + m[d + 5] * y + m[d + 6] * z + m[d + 7]);
      pz += w * (m[d + 8] * x + m[d + 9] * y + m[d + 10] * z + m[d + 11]);
    }
    out[s * 3] = px;
    out[s * 3 + 1] = py;
    out[s * 3 + 2] = pz;
  }
  const ridge = rig.ridge;
  if (ridge) {
    const factors = ridgeFactors(ridge, m);
    if (factors[0] || factors[1]) {
      const add = (row: number, i: number) => {
        const t = ridgeShare(ridge, i, factors);
        if (!t) return;
        const v = ridge.vertices[i],
          sd = ridge.side[i],
          c = ridge.clavicleDriver[sd] * DRIVER_STRIDE,
          u = ridge.upperDriver[sd] * DRIVER_STRIDE;
        const x = r[v * 3],
          y = r[v * 3 + 1],
          z = r[v * 3 + 2];
        for (let a = 0; a < 3; a++) {
          const o = a * 4;
          out[row * 3 + a] +=
            t *
            ((m[c + o] - m[u + o]) * x +
              (m[c + o + 1] - m[u + o + 1]) * y +
              (m[c + o + 2] - m[u + o + 2]) * z +
              (m[c + o + 3] - m[u + o + 3]));
        }
      };
      if (ids) {
        for (let s = 0; s < count; s++) {
          const i = ridge.slot[ids[s]];
          if (i >= 0) add(s, i);
        }
      } else for (let i = 0; i < ridge.vertices.length; i++) add(ridge.vertices[i], i);
    }
  }
  return out;
}

/** Apply a 3×4 transform at m[o..o+11] to (x, y, z). */
export function transformPoint(
  m: ArrayLike<number>,
  o: number,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
) {
  out[0] = m[o] * x + m[o + 1] * y + m[o + 2] * z + m[o + 3];
  out[1] = m[o + 4] * x + m[o + 5] * y + m[o + 6] * z + m[o + 7];
  out[2] = m[o + 8] * x + m[o + 9] * y + m[o + 10] * z + m[o + 11];
  return out;
}

/** General inverse of a 3×4 affine transform (src at s, dst at d). */
export function invertAffine(src: ArrayLike<number>, s: number, dst: Float64Array, d: number) {
  const a = src[s],
    b = src[s + 1],
    c = src[s + 2],
    e = src[s + 4],
    f = src[s + 5],
    g = src[s + 6],
    h = src[s + 8],
    i = src[s + 9],
    j = src[s + 10];
  const A = f * j - g * i,
    B = -(e * j - g * h),
    C = e * i - f * h;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('Singular skinning transform');
  const r = 1 / det;
  const m00 = A * r,
    m01 = -(b * j - c * i) * r,
    m02 = (b * g - c * f) * r,
    m10 = B * r,
    m11 = (a * j - c * h) * r,
    m12 = -(a * g - c * e) * r,
    m20 = C * r,
    m21 = -(a * i - b * h) * r,
    m22 = (a * f - b * e) * r;
  const tx = src[s + 3],
    ty = src[s + 7],
    tz = src[s + 11];
  dst[d] = m00;
  dst[d + 1] = m01;
  dst[d + 2] = m02;
  dst[d + 3] = -(m00 * tx + m01 * ty + m02 * tz);
  dst[d + 4] = m10;
  dst[d + 5] = m11;
  dst[d + 6] = m12;
  dst[d + 7] = -(m10 * tx + m11 * ty + m12 * tz);
  dst[d + 8] = m20;
  dst[d + 9] = m21;
  dst[d + 10] = m22;
  dst[d + 11] = -(m20 * tx + m21 * ty + m22 * tz);
  return dst;
}

/** Skin weight of vertex v carried by the given driver indices. */
export function driverWeight(rig: MotionRig, v: number, drivers: ReadonlySet<number>) {
  let w = 0;
  for (let k = 0; k < rig.influences; k++)
    if (drivers.has(rig.vertexDrivers[v * rig.influences + k]))
      w += rig.skinWeights[v * rig.influences + k];
  return w;
}

/** Driver indices of the arm bones (upper arm and forearm, both sides). */
export function armDrivers(rig: MotionRig): Set<number> {
  const out = new Set<number>();
  rig.drivers.forEach((bone, d) => {
    if (/^(upperarm01|lowerarm01)\.[LR]$/.test(rig.bones[bone])) out.add(d);
  });
  if (out.size !== 4) throw new Error('Rig has no upper arm / forearm drivers');
  return out;
}

/**
 * Points carried by the body's skinning: each point is bound to its nearest body vertex at
 * the binding frame and stored in that vertex's rest space (inverse of its blended LBS
 * transform), so it follows exactly as a skin point with that vertex's weights would.
 * Used for the cloth's shoulder root anchors (ClothSolver.setRootAnchors).
 */
export class SkinBinding {
  readonly vertices: Uint32Array;
  readonly rest: Float64Array;
  private blend = new Float64Array(12);
  private inverse = new Float64Array(12);
  private point = new Float64Array(3);
  private rig: MotionRig;
  constructor(
    rig: MotionRig,
    points: ArrayLike<number>,
    bindMatrices: ArrayLike<number>,
    bindSkin: ArrayLike<number>,
    allowed?: (vertex: number) => boolean,
  ) {
    this.rig = rig;
    const n = points.length / 3;
    this.vertices = new Uint32Array(n);
    this.rest = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = points[i * 3],
        y = points[i * 3 + 1],
        z = points[i * 3 + 2];
      let best = Infinity,
        id = 0;
      for (let v = 0; v < rig.vertexCount; v++) {
        if (allowed && !allowed(v)) continue;
        const d =
          (bindSkin[v * 3] - x) ** 2 +
          (bindSkin[v * 3 + 1] - y) ** 2 +
          (bindSkin[v * 3 + 2] - z) ** 2;
        if (d < best) {
          best = d;
          id = v;
        }
      }
      this.vertices[i] = id;
      vertexBlend(rig, id, bindMatrices, this.blend);
      invertAffine(this.blend, 0, this.inverse, 0);
      transformPoint(this.inverse, 0, x, y, z, this.point);
      this.rest.set(this.point, i * 3);
    }
  }
  pose(m: ArrayLike<number>, out: Float64Array) {
    for (let i = 0; i < this.vertices.length; i++) {
      vertexBlend(this.rig, this.vertices[i], m, this.blend);
      transformPoint(
        this.blend,
        0,
        this.rest[i * 3],
        this.rest[i * 3 + 1],
        this.rest[i * 3 + 2],
        this.point,
      );
      out.set(this.point, i * 3);
    }
    return out;
  }
}
