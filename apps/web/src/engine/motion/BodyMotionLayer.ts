// Measured body animated by P1's rig: CPU linear blend skinning per frame (rig.ts, the same
// formula as Anny / P1's reference, verified ≤ 0.001 mm in rig.test.ts) and a red highlight on
// exposure-zone skin the garment leaves uncovered. Plain Three.js, no React.
import { BufferGeometry, Color, BufferAttribute, Group, Mesh, MeshStandardMaterial } from 'three';
import { smoothNormals } from '../cloth/normals.ts';
import { matricesAt, skinVertices, type MotionFrames, type MotionRig } from './rig.ts';

const SKIN = new Color('#c4bfb6'); // the studio mannequin colour (BodyLayer.ts)
const EXPOSED = new Color('#e5332a');

/** The posed body's material (one per layer; also MotionScene's program warm-up stand-in). */
export function motionBodyMaterial() {
  return new MeshStandardMaterial({ roughness: 0.62, metalness: 0, vertexColors: true });
}

export class BodyMotionLayer extends Group {
  private geometry = new BufferGeometry();
  private positions: Float32Array;
  private normals: Float32Array;
  private colours: Float32Array;
  private matrices: Float64Array;
  private material = motionBodyMaterial();
  private rig: MotionRig;
  private highlighted = new Uint32Array(0);

  constructor(rig: MotionRig) {
    super();
    this.rig = rig;
    this.positions = new Float32Array(rig.vertexCount * 3);
    this.normals = new Float32Array(rig.vertexCount * 3);
    this.colours = new Float32Array(rig.vertexCount * 3);
    for (let v = 0; v < rig.vertexCount; v++) SKIN.toArray(this.colours, v * 3);
    this.matrices = new Float64Array(rig.drivers.length * 12);
    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('normal', new BufferAttribute(this.normals, 3));
    this.geometry.setAttribute('color', new BufferAttribute(this.colours, 3));
    this.geometry.setIndex(Array.from(rig.faces));
    const mesh = new Mesh(this.geometry, this.material);
    mesh.castShadow = mesh.receiveShadow = true;
    this.add(mesh);
  }

  /** Pose the body at time t (s) of the motion (30 fps frames, linearly interpolated). */
  pose(frames: MotionFrames, t: number) {
    matricesAt(frames, t, this.matrices);
    skinVertices(this.rig, this.matrices, this.positions);
    smoothNormals(this.positions, this.geometry.index!.array, this.normals);
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('normal').needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }

  /** Paint the given body vertices red (exposed skin); every other vertex returns to skin. */
  highlight(vertices: ArrayLike<number>) {
    for (const v of this.highlighted) SKIN.toArray(this.colours, v * 3);
    this.highlighted = Uint32Array.from(vertices);
    for (const v of this.highlighted) EXPOSED.toArray(this.colours, v * 3);
    this.geometry.getAttribute('color').needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
