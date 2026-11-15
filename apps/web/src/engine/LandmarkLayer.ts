import { Group, Mesh, MeshBasicMaterial, SphereGeometry } from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { Landmarks } from '../api';
import { disposeObject } from './dispose';

export class LandmarkLayer extends Group {
  set(data: Landmarks) {
    disposeObject(this);
    for (const [name, point] of Object.entries(data.landmarks)) {
      const dot = new Mesh(
        new SphereGeometry(0.006, 10, 8),
        new MeshBasicMaterial({ color: 0xf2b886, depthTest: false }),
      );
      dot.position.set(...point);
      dot.renderOrder = 5;
      this.add(dot);
      if (/acromion|C7|HPS|wrist/.test(name)) {
        const element = document.createElement('span');
        element.className = 'landmark-label';
        element.textContent = name.replaceAll('_', ' ');
        const label = new CSS2DObject(element);
        label.position.copy(dot.position).addScalar(0.012);
        this.add(label);
      }
    }
  }
  dispose() {
    disposeObject(this);
  }
}
