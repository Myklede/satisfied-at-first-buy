// Test-only synthetic scene for the deformer tests: a tube "jacket" (front L/R + back panels,
// chest and hem paths) around a tube "body" with radial normals. Scene metres, Y up, +Z front.
import type { LiveGarmentBindingExt } from './types.ts';
import { BODY_TRUNK } from './types.ts';

export type TubeScene = {
  binding: LiveGarmentBindingExt;
  /** Jacket particles at the bind pose. */
  bound: Float32Array;
  body: Float32Array;
  normals: Float32Array;
  rows: number;
  cols: number;
};

export const JACKET_R = 0.16;
export const BODY_R = 0.14;
export const TOP_Y = 1.3;
export const STEP = 0.02;
export const ROWS = 31; // down to y = 0.7
export const CHEST_ROW = 5; // y = 1.2
export const COLS = 48;

function tube(radius: number, top: number, rows: number, cols: number) {
  const p = new Float32Array(rows * cols * 3);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const a = (2 * Math.PI * c) / cols;
      const k = (r * cols + c) * 3;
      p[k] = radius * Math.sin(a);
      p[k + 1] = top - r * STEP;
      p[k + 2] = radius * Math.cos(a);
    }
  return p;
}

export function tubeScene(): TubeScene {
  const bound = tube(JACKET_R, TOP_Y, ROWS, COLS);
  const triangles: number[] = [];
  for (let r = 0; r + 1 < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const a = r * COLS + c,
        b = r * COLS + ((c + 1) % COLS),
        d = (r + 1) * COLS + c,
        e = (r + 1) * COLS + ((c + 1) % COLS);
      triangles.push(a, d, b, b, d, e);
    }
  const n = ROWS * COLS;
  const panels = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = bound[i * 3],
      z = bound[i * 3 + 2];
    panels[i] = z < 0 ? 2 : x >= 0 ? 0 : 1;
  }
  const row = (r: number) => Array.from({ length: COLS }, (_, c) => r * COLS + c);
  const bodyRows = 40;
  const body = tube(BODY_R, TOP_Y + 0.05, bodyRows, 60);
  const normals = new Float32Array(body.length);
  for (let v = 0; v < body.length; v += 3) {
    const l = Math.hypot(body[v], body[v + 2]);
    normals[v] = body[v] / l;
    normals[v + 2] = body[v + 2] / l;
  }
  const binding: LiveGarmentBindingExt = {
    count: n,
    bound,
    triangles,
    skinDrivers: new Uint8Array(n * 4),
    skinWeights: new Float32Array(n * 4),
    asset: {
      panels,
      paths: { chest: row(CHEST_ROW), hem: row(ROWS - 1) },
      config: { gravity: -9.81, dampingPerSecond: 3, particleMass: 1e-4, collisionMargin: 0.002 },
      layer_m: 0.003,
    },
    key: 'tube',
    body: { neutral: body.slice(), regions: new Uint8Array(body.length / 3).fill(BODY_TRUNK) },
  };
  return { binding, bound, body, normals, rows: ROWS, cols: COLS };
}

/** Rigid motion of points: yaw (deg) about the Y axis, then a translation. */
export function moved(src: Float32Array, yawDeg: number, dx = 0, dy = 0, dz = 0, normals = false) {
  const c = Math.cos((yawDeg * Math.PI) / 180),
    s = Math.sin((yawDeg * Math.PI) / 180);
  const out = new Float32Array(src.length);
  for (let k = 0; k < src.length; k += 3) {
    const x = src[k],
      z = src[k + 2];
    out[k] = c * x + s * z + (normals ? 0 : dx);
    out[k + 1] = src[k + 1] + (normals ? 0 : dy);
    out[k + 2] = -s * x + c * z + (normals ? 0 : dz);
  }
  return out;
}
