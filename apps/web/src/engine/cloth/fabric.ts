import { BufferGeometry, Float32BufferAttribute } from 'three';
import type { ClothAsset } from '../../api';
import { smoothNormals } from './normals';

export type Finish = 'glossy_ripstop' | 'satin_matte';

/** Height of a sine-power chamber and its derivative w.r.t. the phase t in [0, 1]. */
export function chamberProfile(t: number, k: number): { height: number; slope: number } {
  const s = Math.max(Math.sin(Math.PI * t), 0.04);
  return {
    height: Math.pow(s, k),
    slope: k * Math.PI * Math.cos(Math.PI * t) * Math.pow(s, k - 1),
  };
}

/** Amplitude of a sine fold that stores `compression` (fraction) of excess length per
 * wavelength: arc(A, L) ~= L (1 + (pi A / L)^2) => A = L sqrt(c) / pi. Clamped to the loft. */
export function foldAmplitude(compression: number, wavelength: number, loft: number) {
  if (!(compression > 0)) return 0;
  return Math.min(loft, (wavelength * Math.sqrt(compression)) / Math.PI);
}

/**
 * Per-vertex auxiliary coordinates the server does not provide:
 * x = signed torso arc from centre BACK (box grid is centred on CB), wrapped at the front;
 * y = sleeve arc from the outer side of the cuff (for the cuff tab);
 * z = panel id.
 */
export function fabricAux(asset: ClothAsset, positions: ArrayLike<number>) {
  const n = asset.panels.length,
    uv = asset.render_uv ?? [],
    aux = new Float32Array(n * 3);
  const torso = (p: number) => p >= 0 && p <= 3;
  // Torso rows are contiguous in index order and their u increases along the row.
  let start = 0;
  const flush = (end: number) => {
    let cb = NaN,
      best = Infinity;
    for (let i = start; i < end - 1; i++) {
      const a = i,
        b = i + 1;
      const xa = positions[a * 3],
        xb = positions[b * 3];
      // The back crossing of x = 0 (z behind the row's front).
      if (xa * xb <= 0 && xa !== xb) {
        const t = xa / (xa - xb);
        const z = positions[a * 3 + 2] * (1 - t) + positions[b * 3 + 2] * t;
        if (z < best) {
          best = z;
          cb = uv[a * 2] * (1 - t) + uv[b * 2] * t;
        }
      }
    }
    for (let i = start; i < end; i++) {
      let d = Number.isFinite(cb) ? uv[i * 2] - cb : uv[i * 2];
      const half = Number.isFinite(cb) ? cb : Infinity;
      if (d < -half) d += 2 * half;
      if (d > half) d -= 2 * half;
      aux[i * 3] = d;
    }
  };
  for (let i = 0; i <= n; i++) {
    const rowBreak =
      i === n ||
      !torso(asset.panels[i]) ||
      (i > start && torso(asset.panels[i - 1]) && uv[i * 2] < uv[(i - 1) * 2]);
    if (rowBreak) {
      if (i > start && torso(asset.panels[start])) flush(i);
      start = i === n || torso(asset.panels[i]) ? i : i + 1;
    }
  }
  for (const [panel, sign] of [
    [4, 1],
    [5, -1],
  ]) {
    let maxV = -Infinity;
    for (let i = 0; i < n; i++) if (asset.panels[i] === panel) maxV = Math.max(maxV, uv[i * 2 + 1]);
    let outer = NaN,
      reach = -Infinity,
      circumference = 0;
    for (let i = 0; i < n; i++) {
      if (asset.panels[i] !== panel || uv[i * 2 + 1] < maxV - 0.002) continue;
      circumference = Math.max(circumference, uv[i * 2]);
      if (positions[i * 3] * sign > reach) {
        reach = positions[i * 3] * sign;
        outer = uv[i * 2];
      }
    }
    for (let i = 0; i < n; i++) {
      if (asset.panels[i] !== panel) continue;
      let d = Number.isFinite(outer) ? uv[i * 2] - outer : 1e3;
      if (circumference > 0) {
        if (d > circumference / 2) d -= circumference;
        if (d < -circumference / 2) d += circumference;
      }
      aux[i * 3 + 1] = d;
    }
  }
  for (let i = 0; i < n; i++) aux[i * 3 + 2] = asset.panels[i];
  return aux;
}

/** Base (inner-surface) normals and the compression field; relief is shaded analytically. */
export class FabricSurface {
  constructor(
    readonly asset: ClothAsset,
    readonly geometry: BufferGeometry,
    compression: Float32Array,
  ) {
    const n = asset.panels.length;
    geometry.setAttribute(
      '_quilt_uv',
      new Float32BufferAttribute(
        asset.render_uv?.length ? asset.render_uv : new Float32Array(n * 2),
        2,
      ),
    );
    geometry.setAttribute(
      '_quilt_params',
      new Float32BufferAttribute(asset.quilt?.length ? asset.quilt : new Float32Array(n * 4), 4),
    );
    geometry.setAttribute('_compression', new Float32BufferAttribute(compression, 4));
    const positions = geometry.getAttribute('position').array;
    geometry.setAttribute(
      '_fabric_aux',
      new Float32BufferAttribute(fabricAux(asset, positions), 3),
    );
  }
  update(positions: ArrayLike<number>, compression?: Float32Array) {
    if (compression) {
      const c = this.geometry.getAttribute('_compression');
      c.array.set(compression);
      c.needsUpdate = true;
    }
    const normal = this.geometry.getAttribute('normal');
    if (normal.array instanceof Float32Array && this.geometry.index) {
      smoothNormals(positions, this.geometry.index.array, normal.array);
      normal.needsUpdate = true;
    }
  }
}
