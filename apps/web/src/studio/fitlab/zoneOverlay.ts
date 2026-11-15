// Fit X-ray overlay (agent FL): tints the problem zones on the jacket shell on screen and draws
// (callouts now live in ui/annotations.ts). The tint mesh shares the shell's own position buffer (it moves with
// the live preview and with the cloth solver) and draws over the X-ray shell. Display only.
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Vector3,
  type Camera,
} from 'three';
import type { ClothAsset } from '../../api';
import {
  assignZones,
  FIT_ZONES,
  NO_ZONE,
  TONE_RGBA,
  type FitZone,
  type ZoneState,
} from './fitZones';

/** Particles sampled per zone for its callout anchor (front-facing at rest). */
const ANCHOR_SAMPLES = 160;
/** Collar pulse when the zip reaches the top (ms). */
export const PULSE_MS = 1600;

export class ZoneOverlay {
  private mesh?: Mesh;
  private shell?: Mesh;
  private position?: BufferAttribute;
  private colors?: BufferAttribute;
  private zones?: Uint8Array;
  private anchors = new Map<FitZone, Uint32Array>();
  private assetKey?: string;
  private states: ZoneState[] = [];
  private material = new MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });
  private pulseStart = -Infinity;
  private visible = false;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept so FL's call compiles
  constructor(_host: HTMLElement) {}

  /** Binds to the shell on screen; rebuilds when the shell mesh, its buffer or its asset change. */
  bind(shell: Mesh | undefined, asset: ClothAsset | undefined) {
    const position = shell?.geometry.getAttribute('position') as BufferAttribute | undefined;
    if (!shell || !asset || !position) return this.unbind();
    if (shell === this.shell && position === this.position && asset.key === this.assetKey) return;
    this.unbind();
    if (position.count !== asset.panels.length) return;
    this.zones = assignZones(asset);
    this.assetKey = asset.key;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', position);
    if (shell.geometry.index) geometry.setIndex(shell.geometry.index);
    this.colors = new BufferAttribute(new Float32Array(position.count * 4), 4);
    geometry.setAttribute('color', this.colors);
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.renderOrder = 3;
    this.mesh.frustumCulled = false;
    this.mesh.visible = this.visible;
    shell.add(this.mesh);
    this.shell = shell;
    this.position = position;
    // Callout anchors: the front-facing half of each zone at rest (the side the camera sees).
    this.anchors.clear();
    const p = asset.initial;
    FIT_ZONES.forEach((zone, z) => {
      const ids: number[] = [];
      for (let i = 0; i < this.zones!.length; i++) if (this.zones![i] === z) ids.push(i);
      if (!ids.length) return;
      // Paired zones (both sleeves) anchor on one arm (the wearer's left, +X), not between them.
      const side = zone === 'sleeve' || zone === 'bicep' ? ids.filter((i) => p[i * 3] >= 0) : ids;
      if (!side.length) return;
      const meanZ = side.reduce((s, i) => s + p[i * 3 + 2], 0) / side.length;
      const front = side.filter((i) => p[i * 3 + 2] >= meanZ);
      const step = Math.max(1, Math.floor(front.length / ANCHOR_SAMPLES));
      this.anchors.set(zone, Uint32Array.from(front.filter((_, k) => k % step === 0)));
    });
    this.paint(1);
  }

  unbind() {
    this.mesh?.removeFromParent();
    this.mesh?.geometry.dispose();
    this.mesh = this.shell = this.position = this.colors = this.zones = undefined;
    this.assetKey = undefined;
    this.anchors.clear();
  }

  setVisible(on: boolean) {
    this.visible = on;
    if (this.mesh) this.mesh.visible = on;
  }

  setStates(states: ZoneState[]) {
    this.states = states;
    this.paint(1);
  }

  pulseCollar() {
    this.pulseStart = performance.now();
  }

  private paint(collarGain: number) {
    const colors = this.colors,
      zones = this.zones;
    if (!colors || !zones) return;
    const tone = new Map(this.states.map((s) => [FIT_ZONES.indexOf(s.zone), TONE_RGBA[s.tone]]));
    const c = colors.array as Float32Array;
    const collar = FIT_ZONES.indexOf('collar');
    for (let i = 0; i < zones.length; i++) {
      const rgba = zones[i] === NO_ZONE ? TONE_RGBA.none : (tone.get(zones[i]) ?? TONE_RGBA.none);
      c[i * 4] = rgba[0];
      c[i * 4 + 1] = rgba[1];
      c[i * 4 + 2] = rgba[2];
      c[i * 4 + 3] = zones[i] === collar ? Math.min(1, rgba[3] * collarGain) : rgba[3];
    }
    colors.needsUpdate = true;
  }

  /** World-space anchor point of a zone on the bound shell (front-facing particles' mean, moves
   *  with the live preview). FL feeds this to AnnotationLayer. Returns false if the zone has none. */
  anchorWorld(zone: FitZone, out: Vector3): boolean {
    const ids = this.anchors.get(zone);
    if (!ids || !ids.length || !this.shell || !this.position) return false;
    const pos = this.position.array as ArrayLike<number>;
    let x = 0,
      y = 0,
      z = 0;
    for (const i of ids) {
      x += pos[i * 3];
      y += pos[i * 3 + 1];
      z += pos[i * 3 + 2];
    }
    this.shell.updateMatrixWorld();
    out.set(x / ids.length, y / ids.length, z / ids.length).applyMatrix4(this.shell.matrixWorld);
    return true;
  }

  /** Per frame: collar pulse only. Callouts moved to ui/annotations.ts (AnnotationLayer);
   *  the signature is kept so FL's call keeps compiling. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept so FL's call compiles
  update(_camera: Camera, _width: number, _height: number, _mirrored: boolean) {
    const t = performance.now() - this.pulseStart;
    if (t >= 0 && t < PULSE_MS + 50) {
      const k = t < PULSE_MS ? 1 + 0.6 * Math.abs(Math.sin((t / PULSE_MS) * 3 * Math.PI)) : 1;
      this.paint(k);
    }
  }

  dispose() {
    this.unbind();
    this.material.dispose();
  }
}
