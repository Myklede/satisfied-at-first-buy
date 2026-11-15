// Instant S/M/L for the Fit Lab (agent FL, prompt 33). All three sizes' shells are built once in
// the background, each in its own GarmentLayer (the kiosk's jacket look), bound to the live
// avatar's rig like LiveAvatar.setGarment does, and skinned on the CPU to the avatar's current
// driver matrices. Switching size = visibility + one skinning pass: no reload, no settle.
// Only the shown size is re-skinned per pose; a hidden size is posed when it is selected.
import {
  BufferAttribute,
  Float32BufferAttribute,
  Vector3,
  type BufferGeometry,
  type Mesh,
  type Object3D,
} from 'three';
import { api, type ClothAsset } from '../../api';
import type { ClothSnapshot } from '../../engine/cloth/ClothSolver';
import { compressionField } from '../../engine/cloth/compression';
import { GarmentLayer } from '../../engine/GarmentLayer';
import {
  bindGarment,
  skinGarment,
  uniqueEdges,
  type GarmentSkin,
} from '../../engine/live/garmentSkin';
import type { LiveAvatar } from '../../engine/live/LiveAvatar';
import { skinVertices } from '../../engine/motion/rig';
import type { Viewer } from '../../engine/Viewer';
import type { SizeLabel } from '../contract';
import { FIT_ZONE_ATTRIBUTE } from './look/types';
import { assignZones, FIT_ZONES, NO_ZONE, type FitZone } from './fitZones';

/** Particles sampled per zone for its annotation anchor (front half at rest). */
const ANCHOR_SAMPLES = 160;

export interface SizeShell {
  size: SizeLabel;
  asset: ClothAsset;
  layer: GarmentLayer;
  skin: GarmentSkin;
  snapshot: ClothSnapshot;
  edges: Uint32Array;
  restLengths: Float64Array;
  /** FIT_ZONES index per particle (NO_ZONE = none). */
  zones: Uint8Array;
  anchors: Map<FitZone, Uint32Array>;
  posedVersion: number;
}

/** fitZone attribute values (look/types.ts ZONE_INDEX order = FIT_ZONES order; -1 = none). */
export function fitZoneValues(zones: Uint8Array): Float32Array {
  const out = new Float32Array(zones.length);
  for (let i = 0; i < zones.length; i++) out[i] = zones[i] === NO_ZONE ? -1 : zones[i];
  return out;
}

/** Front-half particle samples per zone (paired arm zones anchor on the wearer's left, +X). */
export function zoneAnchors(zones: Uint8Array, rest: ArrayLike<number>): Map<FitZone, Uint32Array> {
  const anchors = new Map<FitZone, Uint32Array>();
  FIT_ZONES.forEach((zone, z) => {
    let ids: number[] = [];
    for (let i = 0; i < zones.length; i++) if (zones[i] === z) ids.push(i);
    if (zone === 'sleeve' || zone === 'bicep') ids = ids.filter((i) => rest[i * 3] >= 0);
    if (!ids.length) return;
    const meanZ = ids.reduce((s, i) => s + rest[i * 3 + 2], 0) / ids.length;
    const front = ids.filter((i) => rest[i * 3 + 2] >= meanZ);
    const step = Math.max(1, Math.floor(front.length / ANCHOR_SAMPLES));
    anchors.set(zone, Uint32Array.from(front.filter((_, k) => k % step === 0)));
  });
  return anchors;
}

export class SizeShells {
  private shells = new Map<SizeLabel, SizeShell>();
  private selectedSize?: SizeLabel;
  private visible = true;
  private key?: string;
  private loading?: Promise<void>;
  private v = new Vector3();

  /** Called after each size's shell is built (the panel restyles it for the see-through). */
  onBuilt?: (shell: SizeShell) => void;

  constructor(private viewer: Viewer) {}

  /** Lowest point (m, rest) of the shown size's body panels: where its hem hangs. */
  hemY(): number | null {
    const shell = this.current();
    if (!shell) return null;
    let min = Infinity;
    const { panels, initial } = shell.asset;
    for (let i = 0; i < panels.length; i++)
      if (panels[i] <= 2) min = Math.min(min, initial[i * 3 + 1]);
    return Number.isFinite(min) ? min : null;
  }

  get selected() {
    return this.selectedSize;
  }

  get ready() {
    return !!this.selectedSize && this.shells.has(this.selectedSize);
  }

  /** The shown shell (selected size), if built. */
  current(): SizeShell | undefined {
    return this.selectedSize ? this.shells.get(this.selectedSize) : undefined;
  }

  /** Every built shell's layer (for the see-through controller; hidden ones stay hidden). */
  layers(): Object3D[] {
    return [...this.shells.values()].map((s) => s.layer);
  }

  /**
   * Builds the sizes of one fit on the avatar's body, the selected one first. Calling again with
   * the same avatar + fit is a no-op; a different one replaces everything.
   */
  load(avatar: LiveAvatar, fitId: string, sizes: readonly SizeLabel[], selected: SizeLabel) {
    const key = `${fitId}|${avatar.live.rig.vertexCount}|${String(avatar.neutral.drivers[3])}`;
    if (key === this.key && this.loading) return this.loading;
    this.dispose(false);
    this.key = key;
    this.selectedSize = selected;
    const order = [selected, ...sizes.filter((s) => s !== selected)];
    this.loading = (async () => {
      for (const size of order) {
        if (this.key !== key) return;
        const shell = await this.build(avatar, fitId, size);
        if (this.key !== key) {
          shell.layer.removeFromParent();
          shell.layer.dispose();
          return;
        }
        this.shells.set(size, shell);
        this.onBuilt?.(shell);
        shell.layer.visible = this.visible && size === this.selectedSize;
        if (size === this.selectedSize) this.pose(shell, avatar, true);
      }
    })();
    return this.loading;
  }

  private async build(avatar: LiveAvatar, fitId: string, size: SizeLabel): Promise<SizeShell> {
    const asset = await api.cloth(fitId, size);
    // Physics (Viewer.setGarment) reuses this asset instead of fetching it again, and the body's
    // collision field (shared by every size) downloads now, not when the judge first pinches.
    GarmentLayer.seedAsset(fitId, size, asset);
    void api
      .sdf(asset)
      .catch((e: unknown) => console.warn('[fitlab] collision field prefetch failed', e));
    const rig = avatar.live.rig;
    const neutralSkin = skinVertices(
      rig,
      avatar.neutral.drivers,
      new Float32Array(rig.vertexCount * 3),
    );
    // Same binding as LiveAvatar.setGarment (without the off-by-default F3 arm-free option).
    const skin = bindGarment(
      rig,
      avatar.neutral.drivers,
      neutralSkin,
      asset.body_positions,
      asset.initial,
      asset.panels,
      asset.triangles,
    );
    const layer = new GarmentLayer();
    layer.programs = this.viewer.garment.programs;
    const host = this.viewer.garment;
    layer.position.copy(host.position);
    layer.quaternion.copy(host.quaternion);
    layer.scale.copy(host.scale);
    layer.visible = false;
    (host.parent ?? this.viewer.scene).add(layer);
    await layer.preview(asset);
    // preview() is the lab path (ignores later frames); frames are keyed by the shown asset.
    (layer as unknown as { activeKey?: string }).activeKey = asset.key;
    const zones = assignZones(asset);
    const mesh = layer.pickTarget?.mesh;
    if (mesh && mesh.geometry.getAttribute('position').count === zones.length)
      mesh.geometry.setAttribute(
        FIT_ZONE_ATTRIBUTE,
        new Float32BufferAttribute(fitZoneValues(zones), 1),
      );
    const n = asset.panels.length;
    const tri = uniqueEdges(asset.triangles);
    const edges = new Uint32Array(tri.length + asset.welds.length);
    edges.set(tri);
    edges.set(asset.welds, tri.length);
    const rest = asset.rest;
    const restLengths = Float64Array.from({ length: edges.length / 2 }, (_, e) => {
      const a = edges[e * 2] * 3,
        b = edges[e * 2 + 1] * 3;
      return Math.hypot(rest[a] - rest[b], rest[a + 1] - rest[b + 1], rest[a + 2] - rest[b + 2]);
    });
    return {
      size,
      asset,
      layer,
      skin,
      edges,
      restLengths,
      zones,
      anchors: zoneAnchors(zones, asset.initial),
      posedVersion: -1,
      snapshot: {
        assetKey: asset.key,
        positions: new Float32Array(n * 3),
        strain: new Float32Array(n),
        gap: new Float32Array(n),
        compression: new Float32Array(n * 4),
        energy: 0,
        simulatedSeconds: 0,
        gapValid: false,
        strainValid: false,
      },
    };
  }

  /** Instant switch: returns false while that size is still being built (it shows when ready). */
  select(size: SizeLabel, avatar: LiveAvatar | undefined): boolean {
    this.selectedSize = size;
    for (const [s, shell] of this.shells) shell.layer.visible = this.visible && s === size;
    const shell = this.shells.get(size);
    if (shell && avatar) this.pose(shell, avatar, true);
    return !!shell;
  }

  setVisible(on: boolean) {
    this.visible = on;
    for (const [s, shell] of this.shells) shell.layer.visible = on && s === this.selectedSize;
  }

  /** Per frame: re-skin the shown size when the avatar's pose changed. */
  update(avatar: LiveAvatar) {
    const shell = this.current();
    if (shell && this.visible) this.pose(shell, avatar, false);
  }

  private pose(shell: SizeShell, avatar: LiveAvatar, force: boolean) {
    if (!force && shell.posedVersion === avatar.version) return;
    const drivers = avatar.currentDrivers;
    if (!drivers) return;
    shell.posedVersion = avatar.version;
    const s = shell.snapshot;
    skinGarment(shell.skin, drivers, s.positions);
    compressionField(s.positions, shell.edges, shell.restLengths, s.compression);
    shell.layer.cloth.onFrame?.(s);
  }

  /** World-space anchor of a zone on the shown shell (centroid of its front-half samples). */
  anchor(zone: FitZone, out = new Vector3()): Vector3 | null {
    const shell = this.current();
    const ids = shell?.anchors.get(zone);
    const mesh = shell?.layer.pickTarget?.mesh;
    if (!shell || !ids || !mesh) return null;
    const pos = (mesh.geometry.getAttribute('position') as BufferAttribute).array;
    let x = 0,
      y = 0,
      z = 0;
    for (const i of ids) {
      x += pos[i * 3];
      y += pos[i * 3 + 1];
      z += pos[i * 3 + 2];
    }
    mesh.updateWorldMatrix(true, false);
    return out.set(x / ids.length, y / ids.length, z / ids.length).applyMatrix4(mesh.matrixWorld);
  }

  /** World anchor helper reusing one vector (annotation updates). */
  anchorShared(zone: FitZone) {
    return this.anchor(zone, this.v)?.clone() ?? null;
  }

  dispose(all = true) {
    this.key = undefined;
    this.loading = undefined;
    for (const shell of this.shells.values()) {
      shell.layer.removeFromParent();
      shell.layer.dispose();
    }
    this.shells.clear();
    if (all) this.selectedSize = undefined;
  }
}

/** Writes the fitZone attribute on a shell geometry from its cloth asset (physics shell too). */
export function writeFitZones(geometry: BufferGeometry, asset: ClothAsset): boolean {
  const position = geometry.getAttribute('position');
  if (!position || position.count !== asset.panels.length) return false;
  const existing = geometry.getAttribute(FIT_ZONE_ATTRIBUTE);
  if (existing && existing.count === position.count) return true;
  geometry.setAttribute(
    FIT_ZONE_ATTRIBUTE,
    new Float32BufferAttribute(fitZoneValues(assignZones(asset)), 1),
  );
  return true;
}

/**
 * Zone anchors of ANY mesh carrying the fitZone attribute (the physics shell, ZB's opened split
 * jacket): front-half samples per zone, chosen once per geometry from its positions then.
 */
export class MeshAnchors {
  private geometry?: BufferGeometry;
  private ids = new Map<FitZone, Uint32Array>();

  anchor(mesh: Mesh, zone: FitZone, out = new Vector3()): Vector3 | null {
    const g = mesh.geometry;
    const zoneAttr = g.getAttribute(FIT_ZONE_ATTRIBUTE);
    const pos = g.getAttribute('position');
    if (!zoneAttr || !pos) return null;
    if (g !== this.geometry) {
      this.geometry = g;
      this.ids.clear();
      const zones = Uint8Array.from({ length: zoneAttr.count }, (_, i) => {
        const z = zoneAttr.getX(i);
        return z >= 0 ? z : NO_ZONE;
      });
      const rest = pos.array as ArrayLike<number>;
      for (const [z, list] of zoneAnchors(zones, rest)) this.ids.set(z, list);
    }
    const ids = this.ids.get(zone);
    if (!ids?.length) return null;
    const p = pos.array as ArrayLike<number>;
    let x = 0,
      y = 0,
      z = 0;
    for (const i of ids) {
      x += p[i * 3];
      y += p[i * 3 + 1];
      z += p[i * 3 + 2];
    }
    mesh.updateWorldMatrix(true, false);
    return out.set(x / ids.length, y / ids.length, z / ids.length).applyMatrix4(mesh.matrixWorld);
  }
}
