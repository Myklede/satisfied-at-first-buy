import { Mesh, type Object3D } from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

export function disposeObject(object: Object3D) {
  object.traverse((child) => {
    if (child instanceof Mesh || 'geometry' in child) {
      const renderable = child as Mesh;
      renderable.geometry?.dispose();
      const materials = Array.isArray(renderable.material)
        ? renderable.material
        : [renderable.material];
      materials.forEach((material) => material?.dispose());
    }
    if (child instanceof CSS2DObject) child.element.remove();
  });
  object.clear();
}
