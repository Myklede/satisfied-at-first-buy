import {
  BufferGeometry,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { GarmentFitResponse, SizeFit, ZoneMetric } from '../api';
import { disposeObject } from './dispose';
import { centimetres, seamLabel, type LengthFormat } from './fitLabelText';

const colours: Record<ZoneMetric['status'], string> = {
  fit: '#a4e3c8',
  relaxed: '#92bdff',
  tight: '#ff8c76',
  too_big: '#e8c181',
  unknown: '#a6afb7',
};
const lineMaterial = (colour: string) => new LineBasicMaterial({ color: colour, depthTest: false });
const dotMaterial = (colour: string) => new MeshBasicMaterial({ color: colour, depthTest: false });
const hemMaterial = (colour: string) =>
  new LineBasicMaterial({ color: colour, depthTest: false, transparent: true, opacity: 0.6 });

/** One object per program the annotations draw (programWarmup stand-ins; never drawn). */
export function annotationStandIns() {
  const none = new BufferGeometry();
  return [
    new Line(none, lineMaterial('#ffffff')),
    new Mesh(none, dotMaterial('#ffffff')),
    new Line(none, hemMaterial('#ffffff')),
  ];
}

export interface FitAnnotationOptions {
  /** Length format of every label (the kiosk passes its units toggle). */
  format: LengthFormat;
  /**
   * Kiosk: only the shoulder seam lines plus ONE large label carrying the prediction (analytic
   * fit engine) and the drawn-shell value as a labelled detail; no cuff or hem chips.
   */
  seamOnly: boolean;
}

export class FitAnnotationLayer extends Group {
  private options: FitAnnotationOptions = { format: centimetres, seamOnly: false };
  private last?: [SizeFit, GarmentFitResponse['sizes'], SizeFit | undefined];

  /** Changes the label style and redraws the current annotations (e.g. on a units toggle). */
  configure(options: Partial<FitAnnotationOptions>) {
    this.options = { ...this.options, ...options };
    if (this.last) this.set(...this.last);
  }

  /**
   * `current` = metrics measured on the displayed shell; `analytic` = the fit engine's metrics
   * for the same size (the prediction; see fitLabelText.ts).
   */
  set(current: SizeFit, all: GarmentFitResponse['sizes'], analytic?: SizeFit) {
    disposeObject(this);
    this.last = [current, all, analytic];
    if (this.options.seamOnly) {
      this.seamOnly(current, analytic);
      return;
    }
    const a = current.anchors;
    for (const side of ['L', 'R']) {
      for (const [zone, from, to] of [
        ['shoulder', `acromion_${side}`, `seam_${side}`],
        ['sleeve', `wrist_${side}`, `cuff_${side}`],
      ]) {
        const metric = current.zones[zone];
        if (!a[from] || !a[to] || metric.value_cm == null) continue;
        const gathered = current.elastic_zones?.includes(zone);
        const colour = gathered ? '#8f9ea1' : colours[metric.status];
        const line = new Line(
          new BufferGeometry().setFromPoints([new Vector3(...a[from]), new Vector3(...a[to])]),
          lineMaterial(colour),
        );
        line.renderOrder = 4;
        this.add(line);
        for (const [index, point] of [a[from], a[to]].entries()) {
          const dot = new Mesh(
            new SphereGeometry(index === 0 ? 0.006 : 0.008, 10, 8),
            dotMaterial(index === 0 ? '#ffffff' : colour),
          );
          dot.position.set(...point);
          dot.renderOrder = 4;
          this.add(dot);
        }
        const label = document.createElement('span');
        label.className = 'fit-label';
        label.style.color = colour;
        label.textContent = `${gathered ? 'elastic gather · ' : ''}${side} ${zone === 'shoulder' ? (metric.value_cm >= 0 ? '↓' : '↑') : 'cuff'} ${metric.value_cm >= 0 ? '+' : ''}${metric.value_cm.toFixed(1)} cm`;
        const object = new CSS2DObject(label);
        object.position.set(a[to][0] + (side === 'L' ? 0.1 : -0.1), a[to][1] + 0.03, a[to][2]);
        this.add(object);
      }
    }
    for (const size of Object.values(all)) {
      if (!size.polylines.hem?.length) continue;
      const ring = size.polylines.hem;
      const points = [...ring, ring[0]].map((point) => new Vector3(...point));
      const line = new Line(
        new BufferGeometry().setFromPoints(points),
        hemMaterial(size.size === current.size ? '#e8c181' : '#85939c'),
      );
      line.renderOrder = 3;
      this.add(line);
      const label = document.createElement('span');
      label.className = 'fit-label';
      label.textContent = `${size.size} hem`;
      const object = new CSS2DObject(label);
      const back = size.anchors.hem_back;
      if (back) {
        object.position.set(back[0] - 0.19, back[1], back[2]);
        this.add(object);
      }
    }
  }
  private seamOnly(current: SizeFit, analytic: SizeFit | undefined) {
    const a = current.anchors;
    const drawn = current.zones.shoulder;
    const predicted = analytic?.zones.shoulder;
    const text = seamLabel(
      predicted?.metric === 'shoulder_offset_cm' ? (predicted.value_cm ?? null) : null,
      drawn?.metric === 'simulated_offset_cm' ? (drawn.value_cm ?? null) : null,
      this.options.format,
    );
    if (!text) return;
    const colour = colours[predicted?.status ?? 'unknown'];
    const seams: Array<[number, number, number]> = [];
    for (const side of ['R', 'L']) {
      const from = a[`acromion_${side}`],
        to = a[`seam_${side}`];
      if (!from || !to) continue;
      seams.push(to);
      const line = new Line(
        new BufferGeometry().setFromPoints([new Vector3(...from), new Vector3(...to)]),
        lineMaterial(colour),
      );
      line.renderOrder = 4;
      this.add(line);
      for (const [index, point] of [from, to].entries()) {
        const dot = new Mesh(
          new SphereGeometry(index === 0 ? 0.008 : 0.011, 12, 10),
          dotMaterial(index === 0 ? '#ffffff' : colour),
        );
        dot.position.set(...point);
        dot.renderOrder = 4;
        this.add(dot);
      }
    }
    if (!seams.length) return;
    // One label for both sides (the fit engine has one shoulder zone), centred between the
    // seams and 8 cm below them, so it stays inside the X-ray shoulder close-up.
    const label = document.createElement('span');
    label.className = 'fit-label fit-label-large';
    label.style.borderColor = colour;
    const title = document.createElement('b');
    title.textContent = text.title;
    label.append(title);
    if (text.detail) {
      const detail = document.createElement('small');
      detail.textContent = text.detail;
      label.append(detail);
    }
    const object = new CSS2DObject(label);
    const mean = (k: number) => seams.reduce((sum, p) => sum + p[k], 0) / seams.length;
    object.position.set(mean(0), mean(1) - 0.08, mean(2));
    this.add(object);
  }
  dispose() {
    disposeObject(this);
    this.last = undefined;
  }
}
