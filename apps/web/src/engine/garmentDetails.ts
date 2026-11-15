import {
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  Shape,
  TubeGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ClothAsset } from '../api';
import { PANEL } from './garmentSurface';
import { detailEstimates, look } from './garmentLook';

/** A point fixed to the garment material: triangle + barycentric weights (+ side of the body). */
export type SurfaceAnchor = { tri: number; bary: [number, number, number] };

/**
 * Find the garment triangle containing chart coordinates (L, V) among triangles whose corners
 * all satisfy `accept`; returns barycentric weights. Pure function (unit tested).
 */
export function anchorAt(
  triangles: ArrayLike<number>,
  chartL: ArrayLike<number>,
  chartV: ArrayLike<number>,
  accept: (vertex: number) => boolean,
  L: number,
  V: number,
): SurfaceAnchor | undefined {
  let best: SurfaceAnchor | undefined,
    bestOut = Infinity;
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t],
      b = triangles[t + 1],
      c = triangles[t + 2];
    if (!accept(a) || !accept(b) || !accept(c)) continue;
    const x1 = chartL[a],
      y1 = chartV[a],
      x2 = chartL[b],
      y2 = chartV[b],
      x3 = chartL[c],
      y3 = chartV[c];
    const det = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
    if (Math.abs(det) < 1e-12) continue;
    const w1 = ((y2 - y3) * (L - x3) + (x3 - x2) * (V - y3)) / det;
    const w2 = ((y3 - y1) * (L - x3) + (x1 - x3) * (V - y3)) / det;
    const w3 = 1 - w1 - w2;
    const out = Math.max(0, -w1) + Math.max(0, -w2) + Math.max(0, -w3);
    if (out < bestOut) {
      bestOut = out;
      best = { tri: t / 3, bary: [w1, w2, w3] };
      if (out === 0) break;
    }
  }
  return bestOut < 0.05 ? best : undefined;
}

// The hood's face-opening edges are shell geometry now (shell.py hood_rim, panel 7); the
// profile below only sets how far the cord toggles stand off the collar.
/** Rim rise easing and padded-edge radius at |arc from CF| = s (both ends collapse). */
export function hoodRimProfile(s: number) {
  const along = Math.abs(s) - look.hoodRimOpeningM;
  const t = Math.min(
    1,
    along / look.hoodRimRampM,
    (look.hoodRimLengthM - along) / look.hoodRimRampM,
  );
  const ease = t <= 0 ? 0 : t * t * (3 - 2 * t);
  return { ease, radius: look.hoodRimRadiusM * Math.sqrt(ease) };
}

type Placed = {
  anchor: SurfaceAnchor;
  object: Mesh;
  /** Offset along the outward normal (metres): the relief height at the anchor. */
  lift: number;
  /** Hang under gravity (cords, pull tabs) instead of lying along the surface's down direction. */
  hang: boolean;
};

/**
 * Zip sliders and pulls: black coated hardware on the FB7675-100 (user photos Parka3/5: black
 * pocket and front pulls on the black coil). Look convention for the finish.
 */
const metal = () =>
  new MeshPhysicalMaterial({ color: 0x141416, metalness: 0.35, roughness: 0.42, clearcoat: 0.4 });
/** DQ4920-206 gunmetal swoosh pull (see swooshPullGeometry). */
const gunmetal = () =>
  new MeshPhysicalMaterial({ color: 0x8a8b8e, metalness: 0.8, roughness: 0.32 });
/** White plastic bungee toggle (toggleGeometry). */
const toggleCord = () => new MeshPhysicalMaterial({ color: 0xf2f1ec, roughness: 0.55, sheen: 0.4 });

/**
 * One fresh instance of every detail material (programWarmup stand-ins: same program keys as
 * the ones GarmentDetails.build draws). All are FrontSide shadow casters.
 */
export function detailMaterialVariants(): MeshPhysicalMaterial[] {
  return [metal(), gunmetal(), toggleCord()];
}

/** Zip slider + pull tab, origin at the slider's top centre, tab hanging along -Y (metres). */
function pullerGeometry(scale = 1) {
  const slider = new BoxGeometry(0.009 * scale, 0.014 * scale, 0.004 * scale);
  slider.translate(0, -0.007 * scale, 0.002 * scale);
  const tab = new CapsuleGeometry(0.004 * scale, 0.016 * scale, 4, 10);
  tab.scale(1, 1, 0.3);
  tab.translate(0, -0.026 * scale, 0.0045 * scale);
  const merged = mergeGeometries([slider.toNonIndexed(), tab.toNonIndexed()])!;
  merged.computeVertexNormals();
  return merged;
}

/**
 * DQ4920-206 main zip: gunmetal slider with a tapered metal pull plate, narrow at the slider and
 * widening to a rounded end where the swoosh is debossed (garmentLook detailEstimates.pufferZip;
 * the user's photos puffer-a4-1/-4). Origin at the slider's top centre, hanging along -Y.
 */
export function swooshPullGeometry() {
  const z = detailEstimates.pufferZip;
  const slider = new BoxGeometry(0.008, z.sliderLengthM, 0.0045);
  slider.translate(0, -0.5 * z.sliderLengthM, 0.00225);
  const n = z.pullNarrowM / 2,
    w = z.pullWidthM / 2,
    len = z.pullLengthM;
  // Plate outline: straight narrow neck, one edge bowed like the swoosh's sweep, rounded end.
  const plate = new Shape();
  plate.moveTo(-n, 0);
  plate.lineTo(n, 0);
  plate.quadraticCurveTo(w * 1.1, -0.45 * len, w, -len + w);
  plate.quadraticCurveTo(w, -len, 0, -len);
  plate.quadraticCurveTo(-w, -len, -w, -len + w);
  plate.quadraticCurveTo(-w * 0.7, -0.5 * len, -n, 0);
  const pull = new ExtrudeGeometry(plate, {
    depth: 0.0016,
    bevelEnabled: true,
    bevelThickness: 0.0004,
    bevelSize: 0.0004,
    bevelSegments: 2,
    curveSegments: 8,
  });
  pull.translate(0, -0.75 * z.sliderLengthM, 0.0036);
  const merged = mergeGeometries([slider.toNonIndexed(), pull])!; // extrusions are non-indexed
  merged.computeVertexNormals();
  return merged;
}

/** Bungee cord hanging from its exit with a barrel toggle (look convention; white plastic). */
function toggleGeometry(side: number) {
  const curve = new CatmullRomCurve3([
    new Vector3(0, 0, 0),
    new Vector3(0.004 * side, -0.02, 0.006),
    new Vector3(0.006 * side, -0.045, 0.008),
  ]);
  const cord = new TubeGeometry(curve, 16, 0.0016, 8, false);
  const toggle = new CylinderGeometry(0.0055, 0.0055, 0.016, 16);
  toggle.translate(0.006 * side, -0.054, 0.008);
  const knot = new CylinderGeometry(0.0028, 0.0028, 0.005, 10);
  knot.translate(0.006 * side, -0.065, 0.008);
  const merged = mergeGeometries([
    cord.toNonIndexed(),
    toggle.toNonIndexed(),
    knot.toNonIndexed(),
  ])!;
  merged.computeVertexNormals();
  return merged;
}

/**
 * Render-only hardware bound to the garment surface (zip pullers, pocket pullers, hood cord
 * toggles). Positions come from sourced render_details or labelled photo estimates; the meshes
 * follow their triangle when the cloth moves and never touch the fit surface.
 */
export class GarmentDetails extends Group {
  private placed: Placed[] = [];
  private materials: MeshPhysicalMaterial[] = [];
  build(
    asset: ClothAsset,
    coordinates: {
      arc: Float32Array;
      quiltUv: Float32Array;
      collarHeight: number;
      collarRings: number[][];
    },
    positions: ArrayLike<number>,
  ) {
    this.clear();
    const d = asset.render_details ?? {};
    const panels = asset.panels,
      n = panels.length;
    const L = new Float32Array(n),
      V = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      L[i] = coordinates.arc[i * 4];
      V[i] =
        panels[i] === PANEL.collar ? coordinates.arc[i * 4 + 2] : coordinates.quiltUv[i * 2 + 1];
    }
    const loft = asset.maximum_loft_m;
    const side = (sign: number) => (i: number) => positions[i * 3] * sign >= -0.002;
    const front = (i: number) => panels[i] === PANEL.frontL || panels[i] === PANEL.frontR;
    const collar = (i: number) => panels[i] === PANEL.collar;
    let hemV = 0;
    for (let i = 0; i < n; i++) if (front(i)) hemV = Math.max(hemV, V[i]);
    // Collar top height above the neckline at the top-ring column nearest arc `l` on a side.
    const topRing = coordinates.collarRings[coordinates.collarRings.length - 1] ?? [];
    const collarTop = (l: number, sign: number) => {
      let best = Infinity,
        height = coordinates.collarHeight;
      for (const id of topRing) {
        if (positions[id * 3] * sign < -0.002) continue;
        const e = Math.abs(L[id] - l);
        if (e < best) {
          best = e;
          // The column's own top height (arc.w): a funnel's last ring turns back down inside its
          // top edge, so the last ring's height put the puller below the edge (L3).
          height = Math.max(V[id], coordinates.arc[id * 4 + 3]);
        }
      }
      return height;
    };
    const place = (
      accept: (i: number) => boolean,
      l: number,
      v: number,
      geometry: BufferGeometry,
      material: MeshPhysicalMaterial,
      lift: number,
      hang: boolean,
    ) => {
      const anchor = anchorAt(asset.triangles, L, V, accept, l, v);
      if (!anchor) return;
      const object = new Mesh(geometry, material);
      object.castShadow = true;
      object.matrixAutoUpdate = false;
      this.add(object);
      this.placed.push({ anchor, object, lift, hang });
    };
    if (d.front_kind === 1) {
      // Two-way zip (retailer_copy): top slider below the collar edge, bottom slider at the hem.
      const m = metal();
      this.materials.push(m);
      // Lifts clear the drawn relief at the anchor (collar stand 0.62 loft, zip tape 0.34 loft).
      place(collar, 0.0, collarTop(0, 1) - 0.012, pullerGeometry(), m, 0.62 * loft + 0.002, false);
      place(front, 0.0, hemV - 0.045, pullerGeometry(), m, 0.36 * loft + 0.0015, false);
    }
    if (d.front_kind === 2 && d.storm_flap_width_m) {
      // Storm-flap front (DQ4920-206): the zip is closed to the collar top; its slider sits at the
      // placket's free edge (wearer's right, scene -X), on the collar's outer face below its rolled
      // top; the pull hangs (L3: laid along the funnel it stuck out like a blade).
      const m = gunmetal();
      this.materials.push(m);
      const l = 0.5 * d.storm_flap_width_m + 0.002;
      place(
        (i) => collar(i) && side(-1)(i),
        l,
        collarTop(l, -1) - 0.015,
        swooshPullGeometry(),
        m,
        0.4 * loft + 0.002,
        true,
      );
    }
    if (d.pockets_kind === 1 && d.pocket_top_m && d.pocket_length_m) {
      // Slanted zip pockets: the puller sits at the lower end of each slit (Parka1/3), 6 mm in.
      const m = metal();
      this.materials.push(m);
      const slant = (detailEstimates.parka.pocketSlantDeg * Math.PI) / 180,
        along = d.pocket_length_m - 0.006;
      for (const sign of [1, -1])
        place(
          (i) => front(i) && side(sign)(i),
          detailEstimates.parka.pocketArcFromCfM + along * Math.sin(slant),
          d.pocket_top_m + along * Math.cos(slant),
          pullerGeometry(0.75),
          m,
          0.45 * loft + 0.001,
          true,
        );
    }
    if (d.hood_kind === 1) {
      // Attached hood: bungee drawcord + toggles at the neck (retailer_copy), position estimated.
      const m = toggleCord();
      this.materials.push(m);
      for (const sign of [1, -1])
        place(
          (i) => collar(i) && side(sign)(i),
          detailEstimates.parkaToggleArcFromCfM,
          collarTop(detailEstimates.parkaToggleArcFromCfM, sign) - 0.004,
          toggleGeometry(sign),
          m,
          // Cords exit the hood edge, which stands outside the collar here.
          0.62 * loft +
            look.hoodRimGapM +
            2 * hoodRimProfile(detailEstimates.parkaToggleArcFromCfM).radius +
            0.002,
          true,
        );
    }
    this.triangles = asset.triangles;
    this.update(positions);
  }
  /** Re-seat every detail on its triangle (call whenever garment positions change). */
  update(positions: ArrayLike<number>, triangles?: ArrayLike<number>, normals?: ArrayLike<number>) {
    const tri = triangles ?? this.triangles;
    if (!tri) return;
    const p = [new Vector3(), new Vector3(), new Vector3()];
    const origin = new Vector3(),
      normal = new Vector3(),
      down = new Vector3(),
      right = new Vector3(),
      e1 = new Vector3(),
      e2 = new Vector3(),
      matrix = new Matrix4();
    for (const item of this.placed) {
      const { tri: t, bary } = item.anchor;
      origin.set(0, 0, 0);
      normal.set(0, 0, 0);
      for (let k = 0; k < 3; k++) {
        const v = tri[t * 3 + k];
        p[k].set(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
        origin.addScaledVector(p[k], bary[k]);
        if (normals)
          normal.add(
            e1.set(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]).multiplyScalar(bary[k]),
          );
      }
      if (!normals || normal.lengthSq() < 1e-12)
        normal.crossVectors(e1.subVectors(p[1], p[0]), e2.subVectors(p[2], p[0]));
      normal.normalize();
      origin.addScaledVector(normal, item.lift);
      // Down along the surface, or straight down for hanging parts (cords, pocket pullers).
      down.set(0, -1, 0);
      if (!item.hang) down.addScaledVector(normal, normal.y).normalize();
      const z = e2.copy(normal).addScaledVector(down, -normal.dot(down)).normalize();
      right.crossVectors(z, down).normalize();
      // Local axes: x = right, y = up, z = outward (right-handed: right x up = z).
      matrix.makeBasis(right, e1.copy(down).negate(), z).setPosition(origin);
      item.object.matrix.copy(matrix);
      item.object.matrixWorldNeedsUpdate = true;
    }
  }
  triangles?: ArrayLike<number>;
  override clear() {
    for (const item of this.placed) item.object.geometry.dispose();
    for (const m of this.materials) m.dispose();
    this.placed = [];
    this.materials = [];
    return super.clear();
  }
  dispose() {
    this.clear();
  }
}
