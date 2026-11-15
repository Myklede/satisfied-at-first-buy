// Baked cloth playback: positions of one (size, motion) bake at a fractional frame (linear
// between the two baked 30 fps frames) and an optional tension map from the baked strain.
// Plain Three.js. The look is deliberately simple (product colour, soft sheen); the studio's
// quilted shader lives in GarmentLayer (agent M4) and is not reused here.
import {
  BufferGeometry,
  Color,
  DoubleSide,
  BufferAttribute,
  Group,
  Mesh,
  MeshPhysicalMaterial,
} from 'three';
import { smoothNormals } from '../cloth/normals.ts';
import { STRAIN_SCALE, type BakedMotion } from './bake.ts';

const RELAXED = new Color('#2f62c9');
const LIMIT = new Color('#f2401f');

/** The baked cloth's material (one per layer; also MotionScene's program warm-up stand-in). */
export function motionGarmentMaterial() {
  return new MeshPhysicalMaterial({
    roughness: 0.5,
    metalness: 0,
    sheen: 0.4,
    sheenRoughness: 0.6,
    side: DoubleSide,
    vertexColors: true,
  });
}

export class MotionGarmentLayer extends Group {
  private geometry = new BufferGeometry();
  private positions: Float32Array;
  private normals: Float32Array;
  private colours: Float32Array;
  private base: Color;
  private material: MeshPhysicalMaterial;
  private tension = false;
  /** Strain (len/rest − 1) shown fully red: the woven stretch limit (asset stretchMax − 1). */
  private limit: number;

  constructor(triangles: ArrayLike<number>, particles: number, colour: string, stretchMax: number) {
    super();
    this.base = new Color(colour);
    this.limit = Math.max(1e-3, stretchMax - 1);
    this.positions = new Float32Array(particles * 3);
    this.normals = new Float32Array(particles * 3);
    this.colours = new Float32Array(particles * 3);
    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('normal', new BufferAttribute(this.normals, 3));
    this.geometry.setAttribute('color', new BufferAttribute(this.colours, 3));
    this.geometry.setIndex(Array.from(triangles));
    this.material = motionGarmentMaterial();
    const mesh = new Mesh(this.geometry, this.material);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    this.add(mesh);
  }

  setTension(enabled: boolean) {
    this.tension = enabled;
  }

  /** Show the bake at fractional frame `f`. */
  show(bake: BakedMotion, f: number) {
    const n = bake.particles,
      count = n * 3,
      x = Math.max(0, Math.min(bake.frameCount - 1, f)),
      i = Math.min(bake.frameCount - 2, Math.floor(x)),
      t = x - i,
      a = i * count,
      b = a + count,
      p = bake.positions;
    if (n * 3 !== this.positions.length) throw new Error('Bake does not match this garment');
    for (let k = 0; k < count; k++) this.positions[k] = p[a + k] * (1 - t) + p[b + k] * t;
    smoothNormals(this.positions, this.geometry.index!.array, this.normals);
    const frame = Math.round(x);
    for (let v = 0; v < n; v++) {
      if (this.tension) {
        const strain = (bake.strain[frame * n + v] / 255) * STRAIN_SCALE;
        const s = Math.max(0, Math.min(1, strain / this.limit));
        this.colours[v * 3] = RELAXED.r + (LIMIT.r - RELAXED.r) * s;
        this.colours[v * 3 + 1] = RELAXED.g + (LIMIT.g - RELAXED.g) * s;
        this.colours[v * 3 + 2] = RELAXED.b + (LIMIT.b - RELAXED.b) * s;
      } else this.base.toArray(this.colours, v * 3);
    }
    for (const name of ['position', 'normal', 'color'])
      this.geometry.getAttribute(name).needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
