import { Group, Vector2 } from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { FitResponse, Landmarks } from '../api';
import { disposeObject } from './dispose';

const colours = {
  chest: '#91e0c3',
  waist: '#e5c186',
  hip: '#9ab9ed',
  neck_base: '#a3a6ce',
  upper_arm: '#d6a4b8',
  wrist: '#9dc4ce',
};
export class MeasurementLayer extends Group {
  private resolution = new Vector2(800, 800);
  resize(width: number, height: number) {
    this.resolution.set(width, height);
    this.traverse((child) => {
      if (child instanceof Line2) child.material.resolution.copy(this.resolution);
    });
  }
  set(data: Landmarks, measurements: FitResponse['measurements']) {
    disposeObject(this);
    for (const [name, points] of Object.entries(data.girth_polylines)) {
      const colour = colours[name as keyof typeof colours] ?? '#ffffff';
      const geometry = new LineGeometry();
      geometry.setPositions([...points, points[0]].flat());
      const material = new LineMaterial({
        color: colour,
        linewidth: 1.7,
        depthTest: false,
        transparent: true,
        opacity: 0.9,
      });
      material.resolution.copy(this.resolution);
      const line = new Line2(geometry, material);
      line.renderOrder = 3;
      this.add(line);
      const element = document.createElement('span');
      element.className = 'tape-label';
      element.style.setProperty('--tape', colour);
      element.textContent = `${name.replaceAll('_', ' ')}  ${measurements[name].value_cm.toFixed(1)}`;
      const label = new CSS2DObject(element);
      const anchor = points.reduce((best, p) => (p[0] > best[0] ? p : best));
      label.position.set(anchor[0] + 0.075, anchor[1], anchor[2]);
      this.add(label);
    }
  }
  dispose() {
    disposeObject(this);
  }
}
