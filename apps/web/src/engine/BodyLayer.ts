import { Group, Mesh, MeshPhysicalMaterial, BufferGeometry, Float32BufferAttribute } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { disposeObject } from './dispose';

export class BodyLayer extends Group {
  /** The mannequin material (persistent; read by the Viewer's program warm-up). */
  readonly material = new MeshPhysicalMaterial({
    // Matte warm-grey mannequin (Part E): reads apart from the White parka.
    color: 0xc4bfb6,
    roughness: 0.6,
    metalness: 0,
  });
  private generation = 0;
  display(positions: number[], triangles: number[]) {
    for (const child of [...this.children]) {
      disposeObject(child);
      this.remove(child);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setIndex(triangles);
    geometry.computeVertexNormals();
    const mesh = new Mesh(geometry, this.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.add(mesh);
  }
  async load(id: string, signal?: AbortSignal) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid body ID');
    const generation = ++this.generation;
    const response = await fetch(`/api/body/${id}/mesh.glb`, { signal, cache: 'no-store' });
    if (!response.ok) throw new Error('Could not load the body mesh. Build your body again.');
    const gltf = await new GLTFLoader().parseAsync(await response.arrayBuffer(), '');
    if (generation !== this.generation || signal?.aborted) {
      disposeObject(gltf.scene);
      return;
    }
    // Keep the old mesh until its replacement has loaded successfully.
    for (const child of [...this.children]) {
      disposeObject(child);
      this.remove(child);
    }
    gltf.scene.traverse((child) => {
      if (child instanceof Mesh) {
        const previous = Array.isArray(child.material) ? child.material : [child.material];
        previous.forEach((material) => material.dispose());
        child.material = this.material;
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    this.add(gltf.scene);
  }
  wireframe(enabled: boolean) {
    this.material.wireframe = enabled;
  }
  dispose() {
    this.generation++;
    disposeObject(this);
    this.material.dispose();
  }
}
