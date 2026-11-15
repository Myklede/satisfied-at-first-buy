// The mirror view in the KIOSK's look: the kiosk's own Viewer (stage light, AO composer, the
// mannequin material) with its GarmentLayer (quilting relief, seams, decals and logos, hardware,
// padded hood) and its program warm-up, so the live jacket looks exactly like the kiosk's jacket.
// The live avatar (LiveAvatar, the shared LivePosedScene) stays the source of truth: every frame
// its skinned body and jacket positions are copied into the Viewer's layers. The jacket is still a
// skinned PREVIEW; only the look is the kiosk's.
//
// Engine APIs used read-only (owned by agent S): Viewer (garment, body, camera, controls,
// renderer, tapes, fitAnnotations, idleTurntable, dispose), GarmentLayer.preview(asset) and its
// ClothClient.onFrame (the path the kiosk's solver frames take), BodyLayer.display.
import { BufferAttribute, Mesh, type BufferGeometry } from 'three';
import type { ClothAsset } from '../../api.ts';
import type { ClothSnapshot } from '../cloth/ClothSolver.ts';
import { compressionField } from '../cloth/compression.ts';
import { uniqueEdges } from './garmentSkin.ts';
import { presetPose } from '../CameraRig.ts';
import { Viewer } from '../Viewer.ts';
import type { LiveAvatar } from './LiveAvatar.ts';

/** Longest gap between two mirror draws when nothing changed (ms). */
const IDLE_DRAW_MS = 100;
/** Draw rate while externalDrive is on (the cloth worker posts frames at about this rate). */
const EXTERNAL_DRAW_HZ = 60;

export class KioskMirrorView {
  readonly viewer: Viewer;
  fps = 0;
  private bodyGeometry?: BufferGeometry;
  private snapshot?: ClothSnapshot;
  private assetKey?: string;
  private shownAsset?: ClothAsset;
  /** The solver's material edges (triangle edges + welds) and their rest lengths (asset.rest). */
  private edges?: Uint32Array;
  private restLengths?: Float64Array;
  private jacketLoad = 0;
  private bodyAvatar?: LiveAvatar;
  private bodyVersion = -1;
  private updatedAvatar?: LiveAvatar;
  private updatedVersion = -1;
  /**
   * Fit Lab hook (agent FL, prompt 31; unset = unchanged behaviour): per-particle inner gap (cm)
   * of the copied jacket, computed by the caller from the posed avatar. When it returns an array
   * of the particle count, the frame carries it (gapValid), so the GarmentLayer heatmap colours
   * the live jacket; null = no gap this frame (the heatmap keeps its last values).
   */
  gapField?: (jacket: Float32Array, avatar: LiveAvatar) => Float32Array | null;
  /**
   * Fit Lab hook (agent FL, prompt 31; default false = unchanged behaviour): the Viewer's body and
   * garment are driven by someone else (the kiosk's cloth solver via Viewer.setGarment, for the
   * interactive zip/hood). While on, update() copies nothing from the avatar and the view draws at
   * up to EXTERNAL_DRAW_HZ (solver frames do not mark the view dirty). Turning it off does not
   * restore the avatar's layers: call setBody(avatar) and setJacket(asset) again.
   */
  externalDrive = false;

  constructor(container: HTMLElement) {
    this.viewer = new Viewer(container, (fps) => {
      this.fps = fps;
    });
    this.viewer.idleTurntable = false;
    this.viewer.tapes.visible = false;
    this.viewer.fitAnnotations.visible = false;
    this.throttle();
    this.frame('upper');
    // The Viewer's own camera rig may still be easing in from construction: frame again once.
    setTimeout(() => this.frame(this.view), 1200);
    this.watchVisibility(container);
  }

  /**
   * ?mirrorSkip=1 (F2, D9; default off): while the mirror is not on screen (Full AR, ?arfull=1
   * hides it) the per-pose geometry copy and the composer draw are skipped; that main-thread time
   * goes to the AR. On becoming visible again the latest pose is copied at once (never stale).
   */
  private hidden = false;
  private skippedAvatar?: LiveAvatar;
  private visibility?: IntersectionObserver;
  private watchVisibility(container: HTMLElement) {
    if (typeof location === 'undefined' || typeof IntersectionObserver === 'undefined') return;
    if (new URLSearchParams(location.search).get('mirrorSkip') !== '1') return;
    this.visibility = new IntersectionObserver((entries) => {
      const shown = entries.some((e) => e.isIntersecting);
      if (shown === !this.hidden) return;
      this.hidden = !shown;
      if (!shown) return;
      this.dirty = true;
      const avatar = this.skippedAvatar;
      this.skippedAvatar = undefined;
      if (avatar) this.update(avatar);
    });
    this.visibility.observe(container);
  }

  private dirty = true;
  private lastDraw = 0;
  /**
   * The Viewer draws every display refresh (up to 144 Hz on this laptop) with its AO composer,
   * competing on the GPU with the pose model and the AR view. The live mirror only changes when a
   * pose arrives (~30 Hz): draw on change, and at least IDLE_DRAW_MS apart otherwise (camera
   * eases, dress morphs and the hood keep animating at that rate). Wraps the Viewer's composer
   * render of this instance only.
   */
  private throttle() {
    const composer = this.viewer.composer;
    const draw = composer.render.bind(composer);
    composer.render = (deltaTime?: number) => {
      if (this.hidden) return;
      const now = performance.now();
      if (this.externalDrive) {
        if (now - this.lastDraw < 1000 / EXTERNAL_DRAW_HZ - 2) return;
      } else if (!this.dirty && now - this.lastDraw < IDLE_DRAW_MS) return;
      this.dirty = false;
      this.lastDraw = now;
      this.draws.push(now);
      while (this.draws.length && now - this.draws[0] > 1000) this.draws.shift();
      draw(deltaTime);
    };
    this.viewer.controls.addEventListener('change', () => {
      this.dirty = true;
    });
  }
  private draws: number[] = [];
  /** Mirror frames actually drawn over the last second. */
  get drawFps() {
    return this.draws.length;
  }

  get canvas() {
    return this.viewer.renderer.domElement;
  }

  private view: 'upper' | 'full' | 'kiosk' = 'upper';
  private statureM = 1.75;
  /**
   * 'upper' = knees to above raised hands (the kiosk camera's head-to-hips framing, with room for
   * a reach); 'full' = the whole body; 'kiosk' = the kiosk's own front preset (CameraRig).
   */
  frame(view: 'upper' | 'full' | 'kiosk', statureM = this.statureM) {
    this.view = view;
    this.statureM = statureM;
    const { camera, controls } = this.viewer;
    if (view === 'kiosk') {
      const pose = presetPose('front', statureM);
      camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
      controls.target.set(pose.target[0], pose.target[1], pose.target[2]);
    } else if (view === 'full') {
      camera.position.set(0, 1.0, 4.0);
      controls.target.set(0, 0.95, 0);
    } else {
      camera.position.set(0, 1.35, 2.7);
      controls.target.set(0, 1.3, 0);
    }
    controls.update();
  }

  /** Shows the avatar's body in the kiosk mannequin material (once per body). */
  setBody(avatar: LiveAvatar) {
    const { positions } = avatar.bodyArrays();
    this.viewer.body.display(Array.from(positions), Array.from(avatar.live.rig.faces));
    const mesh = this.viewer.body.children.find((c): c is Mesh => c instanceof Mesh);
    if (!mesh) throw new Error('The kiosk body layer has no mesh');
    this.bodyGeometry = mesh.geometry;
    this.bodyAvatar = avatar;
    this.bodyVersion = -1;
    this.updatedVersion = -1;
  }

  /** Shows a size's jacket with the kiosk's garment look (programs compiled before the draw). */
  async setJacket(asset: ClothAsset | null, force = false) {
    this.updatedVersion = -1;
    if (force) this.shownAsset = undefined;
    const ticket = ++this.jacketLoad;
    const garment = this.viewer.garment;
    if (!asset) {
      garment.reset();
      this.snapshot = undefined;
      this.assetKey = undefined;
      this.shownAsset = undefined;
      return;
    }
    if (this.shownAsset === asset) return;
    await garment.preview(asset);
    if (ticket !== this.jacketLoad) return;
    // preview() is the lab path: it ignores solver frames afterwards. Live frames take the same
    // path the kiosk's solver frames take (ClothClient.onFrame), keyed by the shown asset.
    (garment as unknown as { activeKey?: string }).activeKey = asset.key;
    const n = asset.panels.length;
    this.snapshot = {
      assetKey: asset.key,
      positions: new Float32Array(n * 3),
      strain: new Float32Array(n),
      gap: new Float32Array(n),
      compression: new Float32Array(n * 4),
      energy: 0,
      simulatedSeconds: 0,
      gapValid: false,
      strainValid: false,
    };
    // Same edges and rest lengths as ClothSolver: the live compression field drives the kiosk
    // surface's buckling relief (garmentSurface), so a bent elbow wrinkles like in the kiosk.
    const tri = uniqueEdges(asset.triangles);
    const edges = new Uint32Array(tri.length + asset.welds.length);
    edges.set(tri);
    edges.set(asset.welds, tri.length);
    const rest = asset.rest;
    this.restLengths = Float64Array.from({ length: edges.length / 2 }, (_, e) => {
      const a = edges[e * 2] * 3,
        b = edges[e * 2 + 1] * 3;
      return Math.hypot(rest[a] - rest[b], rest[a + 1] - rest[b + 1], rest[a + 2] - rest[b + 2]);
    });
    this.edges = edges;
    this.assetKey = asset.key;
    this.shownAsset = asset;
    this.updatedVersion = -1;
  }

  /** Copies the avatar's current body and jacket into the kiosk layers. */
  update(avatar: LiveAvatar) {
    if (this.updatedAvatar === avatar && this.updatedVersion === avatar.version) return;
    if (this.externalDrive) return;
    if (this.hidden) {
      this.skippedAvatar = avatar;
      return;
    }
    const geometry = this.bodyGeometry;
    if (geometry && (this.bodyAvatar !== avatar || this.bodyVersion !== avatar.bodyVersion)) {
      const { positions, normals, bounds } = avatar.bodyArrays();
      const position = geometry.getAttribute('position') as BufferAttribute;
      if (position.array.length === positions.length) {
        position.array.set(positions);
        position.needsUpdate = true;
        const normal = geometry.getAttribute('normal') as BufferAttribute | undefined;
        if (normal && normal.array.length === normals.length) {
          normal.array.set(normals);
          normal.needsUpdate = true;
        }
        // The avatar computed these exact positions' bounds already; avoid a second body scan.
        if (bounds) geometry.boundingSphere = bounds.clone();
        else geometry.computeBoundingSphere();
        this.bodyAvatar = avatar;
        this.bodyVersion = avatar.bodyVersion;
      }
    }
    const snapshot = this.snapshot;
    const jacket = avatar.jacketPositions();
    if (snapshot && jacket && avatar.jacketAsset?.key === this.assetKey) {
      if (jacket.length !== snapshot.positions.length) return;
      snapshot.positions.set(jacket);
      if (this.gapField) {
        const gap = this.gapField(snapshot.positions, avatar);
        snapshot.gapValid = !!gap && gap.length === snapshot.gap.length;
        if (gap && snapshot.gapValid) snapshot.gap.set(gap);
      }
      if (this.edges && this.restLengths)
        compressionField(snapshot.positions, this.edges, this.restLengths, snapshot.compression);
      this.viewer.garment.cloth.onFrame?.(snapshot);
    }
    this.dirty = true;
    this.updatedAvatar = avatar;
    this.updatedVersion = avatar.version;
  }

  dispose() {
    this.visibility?.disconnect();
    this.viewer.dispose();
  }
}
