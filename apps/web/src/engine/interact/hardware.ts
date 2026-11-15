// Render-only zip hardware for the interactive zip and hood (agent Z): the zip pull (slider +
// pull tab), the metal teeth of an open zip and the hood's velcro tabs.
// Looks only: none of these meshes touches the cloth or the fit numbers.
//
// Look sources (docs/look/jacket-reference-spec.md, the user's photos):
//  - FB7675-100 parka: black coil zip on black tape, black pull (Parka1/3/5); the slider and
//    tab copy the size of the shell's own puller (garmentDetails pullerGeometry, look estimate).
//  - DQ4920-206 puffer: silver/gunmetal metal zip with a metal swoosh-shaped pull under the
//    storm placket (puffer-a4-*, Puffer1); the hood zips on with a silver zip and has black
//    velcro tabs at its front corners (Head-for-puffer, head-2/3).
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  DataTexture,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  RepeatWrapping,
  Shape,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export type ZipLook = 'coil-black' | 'metal-silver';

/** Pull dimensions (m): slider 10 × 16 × 5 mm; tab 2.6 cm (parka) / swoosh 3.4 cm (puffer). */
const SLIDER = { w: 0.01, h: 0.016, d: 0.005 };

/** Nike-swoosh-shaped outline (unit size, long axis along x), for the puffer's metal pull. */
function swooshShape() {
  const s = new Shape();
  s.moveTo(-0.5, 0.06);
  s.quadraticCurveTo(-0.57, -0.24, -0.3, -0.27);
  s.quadraticCurveTo(0.02, -0.29, 0.56, 0.22);
  s.quadraticCurveTo(0.02, -0.11, -0.31, -0.11);
  s.quadraticCurveTo(-0.45, -0.1, -0.5, 0.06);
  return s;
}

/**
 * Zip pull, origin at the slider's top centre, hanging along -Y, outward +Z (local metres).
 * Returns the group and its materials (disposed with it).
 */
export function zipPull(look: ZipLook) {
  const group = new Group();
  const metal =
    look === 'coil-black'
      ? new MeshPhysicalMaterial({
          color: 0x141416,
          metalness: 0.35,
          roughness: 0.42,
          clearcoat: 0.4,
        })
      : new MeshPhysicalMaterial({ color: 0x8c9096, metalness: 0.95, roughness: 0.28 });
  const slider = new BoxGeometry(SLIDER.w, SLIDER.h, SLIDER.d);
  slider.translate(0, -SLIDER.h / 2, SLIDER.d / 2);
  let tab: BufferGeometry;
  if (look === 'coil-black') {
    tab = new CapsuleGeometry(0.0045, 0.018, 4, 10);
    tab.scale(1, 1, 0.3);
    tab.translate(0, -0.03, 0.005);
  } else {
    const swoosh = new ExtrudeGeometry(swooshShape(), {
      depth: 0.04,
      bevelEnabled: true,
      bevelThickness: 0.015,
      bevelSize: 0.012,
      bevelSegments: 2,
      curveSegments: 10,
    });
    // 3.4 cm long, hanging: long axis down the zip, 1.6 mm thick.
    swoosh.scale(0.034, 0.034, 0.034);
    swoosh.rotateZ(-Math.PI / 2);
    swoosh.translate(0, -0.034, 0.004);
    tab = swoosh;
  }
  const merged = mergeGeometries([slider.toNonIndexed(), tab.toNonIndexed()])!;
  merged.computeVertexNormals();
  slider.dispose();
  tab.dispose();
  const mesh = new Mesh(merged, metal);
  mesh.castShadow = true;
  mesh.name = 'zip-pull';
  group.add(mesh);
  group.matrixAutoUpdate = false;
  return { group, mesh, material: metal };
}

/** Metal teeth stripes (procedural: light tooth / dark gap, one tooth per v unit). */
function teethTexture() {
  const data = new Uint8Array(4 * 8);
  for (let i = 0; i < 8; i++) {
    const v = i < 4 ? 235 : 70;
    data.set([v, v, v, 255], i * 4);
  }
  const texture = new DataTexture(data, 1, 8);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

/**
 * A strip of zip teeth along a polyline of cloth vertices (updated every frame). `pairs`
 * vertices, two strip vertices each (± half width across the line).
 */
export class TeethStrip {
  readonly mesh: Mesh<BufferGeometry, MeshPhysicalMaterial>;
  private position: BufferAttribute;
  private normal: BufferAttribute;
  constructor(
    readonly count: number,
    colour: number,
    /** Tooth pitch (m): a #5 metal zip, ~4 mm (look estimate). */
    readonly pitch = 0.004,
  ) {
    const geometry = new BufferGeometry();
    this.position = new BufferAttribute(new Float32Array(count * 2 * 3), 3);
    this.normal = new BufferAttribute(new Float32Array(count * 2 * 3), 3);
    const uv = new Float32Array(count * 2 * 2),
      index: number[] = [];
    for (let k = 0; k < count; k++) {
      uv.set([0, 0, 1, 0], k * 4);
      if (k + 1 < count) {
        const a = k * 2;
        index.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
    }
    geometry.setAttribute('position', this.position);
    geometry.setAttribute('normal', this.normal);
    geometry.setAttribute('uv', new BufferAttribute(uv, 2));
    geometry.setIndex(index);
    const material = new MeshPhysicalMaterial({
      color: colour,
      metalness: 0.9,
      roughness: 0.3,
      map: teethTexture(),
      side: DoubleSide,
    });
    this.mesh = new Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
  }

  /**
   * Lays the strip on the line: `points` (k → xyz) with outward `normals`, `arc` (m) along the
   * line, `width` (m) across it, lifted `lift` (m) along the normal. Draws pairs [0, upTo).
   */
  update(
    points: ArrayLike<number>,
    normals: ArrayLike<number>,
    arc: ArrayLike<number>,
    upTo: number,
    width: number,
    lift: number,
  ) {
    const p = this.position.array as Float32Array,
      n = this.normal.array as Float32Array,
      uv = this.mesh.geometry.getAttribute('uv').array as Float32Array,
      count = this.count;
    for (let k = 0; k < count; k++) {
      const i = k * 3,
        prev = Math.max(0, k - 1) * 3,
        next = Math.min(count - 1, k + 1) * 3;
      let tx = points[next] - points[prev],
        ty = points[next + 1] - points[prev + 1],
        tz = points[next + 2] - points[prev + 2];
      const nx = normals[i],
        ny = normals[i + 1],
        nz = normals[i + 2];
      // Across = normal × tangent (in the surface, perpendicular to the line).
      let ax = ny * tz - nz * ty,
        ay = nz * tx - nx * tz,
        az = nx * ty - ny * tx;
      const al = Math.hypot(ax, ay, az) || 1;
      ax /= al;
      ay /= al;
      az /= al;
      tx = 0;
      ty = 0;
      tz = 0;
      const h = width / 2;
      for (let s = 0; s < 2; s++) {
        const o = (k * 2 + s) * 3,
          sign = s ? 1 : -1;
        p[o] = points[i] + nx * lift + ax * h * sign;
        p[o + 1] = points[i + 1] + ny * lift + ay * h * sign;
        p[o + 2] = points[i + 2] + nz * lift + az * h * sign;
        n[o] = nx;
        n[o + 1] = ny;
        n[o + 2] = nz;
        uv[(k * 2 + s) * 2 + 1] = arc[k] / this.pitch;
      }
    }
    this.position.needsUpdate = true;
    this.normal.needsUpdate = true;
    this.mesh.geometry.getAttribute('uv').needsUpdate = true;
    const segments = Math.max(0, Math.min(count, upTo) - 1);
    this.mesh.geometry.setDrawRange(0, segments * 6);
    this.mesh.visible = segments > 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.map?.dispose();
    this.mesh.material.dispose();
  }
}

/** Black velcro tab (look estimate from Head-for-puffer: ~2.5 × 1.5 cm, 3 mm thick). */
export function velcroTab() {
  const geometry = new BoxGeometry(0.025, 0.015, 0.003);
  const material = new MeshPhysicalMaterial({ color: 0x0b0b0c, roughness: 0.95 });
  const mesh = new Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  mesh.castShadow = true;
  return mesh;
}

/**
 * The open edge of a padded front: a band from the inner (fit) surface up to the drawn relief
 * along the cut edge. The garment shader displaces the surface outward by the loft, so an open
 * edge was a single sheet seen edge-on (a thin film); this closes it to the padding's depth.
 * Look only (render), updated every frame from the split cloth.
 */
export class EdgeWall {
  readonly mesh: Mesh<BufferGeometry, MeshPhysicalMaterial>;
  private position: BufferAttribute;
  private normal: BufferAttribute;
  constructor(
    readonly count: number,
    colour: string | number,
  ) {
    const geometry = new BufferGeometry();
    this.position = new BufferAttribute(new Float32Array(count * 2 * 3), 3);
    this.normal = new BufferAttribute(new Float32Array(count * 2 * 3), 3);
    const index: number[] = [];
    for (let k = 0; k + 1 < count; k++) {
      const a = k * 2;
      index.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    geometry.setAttribute('position', this.position);
    geometry.setAttribute('normal', this.normal);
    geometry.setIndex(index);
    const material = new MeshPhysicalMaterial({ color: colour, roughness: 0.6, side: DoubleSide });
    this.mesh = new Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.visible = false;
  }

  /**
   * `points`/`normals`: the edge's cloth vertices and outward normals; `across`: unit vectors in
   * the surface pointing out of the panel (the wall's normal); walls from `low` to `high` (m)
   * along the normal. Draws pairs [0, upTo).
   */
  update(
    points: ArrayLike<number>,
    normals: ArrayLike<number>,
    across: ArrayLike<number>,
    upTo: number,
    low: number,
    high: number,
  ) {
    const p = this.position.array as Float32Array,
      n = this.normal.array as Float32Array;
    for (let k = 0; k < this.count; k++) {
      const i = k * 3;
      for (let s = 0; s < 2; s++) {
        const o = (k * 2 + s) * 3,
          h = s ? high : low;
        for (let c = 0; c < 3; c++) {
          p[o + c] = points[i + c] + normals[i + c] * h;
          n[o + c] = across[i + c];
        }
      }
    }
    this.position.needsUpdate = true;
    this.normal.needsUpdate = true;
    const segments = Math.max(0, Math.min(this.count, upTo) - 1);
    this.mesh.geometry.setDrawRange(0, segments * 6);
    this.mesh.visible = segments > 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
