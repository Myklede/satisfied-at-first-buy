// The ONLY place the kiosk touches the 3D engine (apps/web/src/engine, owned by agent C).
// If the engine API changes after the merge, update this adapter only.
//
// Engine APIs used (all public, read-only use):
//   new Viewer(container, onFps) / dispose()
//   viewer.setBody(fit, landmarks, signal)       viewer.setGarment(fit, size, signal)
//   viewer.setMode(mode, fit)                    viewer.rig.preset(preset)
//   viewer.garment.preload(fitId, sizes, current, signal)   viewer.garment.reset()
//   viewer.idleTurntable, viewer.controls.autoRotateSpeed, viewer.syncWith
//   viewer.onShoulderView, viewer.lastSimulation?.state.{elapsedMs, meanStepMs}
//   viewer.fitAnnotations.dispose()
//   viewer.renderer (WebGLRenderer: info, getContext()), viewer.scene, viewer.camera
//   viewer.prewarm(finish, mode), viewer.prewarmScene() (programs before the first draw)
//   viewer.fitAnnotations.configure({ format, seamOnly }) / .visible
//   viewer.body.display(positions, triangles)    viewer.garment.pickTarget (shell on screen)
//   viewer.lastSimulation?.simulated (metrics measured on the shown shell)
//   viewer.tapes.visible
//   Hand pull (M4): viewer.garment (GarmentLayer.pickTarget / cloth), viewer.camera,
//   viewer.controls (target, enabled, 'start' event), engine/hand/HandPullController
import { Box3, Mesh, Vector3 } from 'three';
import { api, type FitResponse, type GarmentFitResponse, type SizeFit } from '../api';
import type { LengthFormat } from '../engine/fitLabelText';
import type { Preset } from '../engine/CameraRig';
import type { GarmentMode } from '../engine/garmentMath';
import { Viewer } from '../engine/Viewer';
import { HandPullController } from '../engine/hand/HandPullController';
import { isGarmentFinish } from './shaderWarm';

export type { GarmentMode, Preset };

export interface RenderStats {
  geometries: number;
  textures: number;
  programs: number;
  calls: number;
  triangles: number;
}

export class GarmentView {
  private viewer: Viewer;
  fps = 0;
  private pull?: HandPullController;
  private tween = 0;
  private dressCover?: HTMLCanvasElement;
  private coverTimer?: ReturnType<typeof setTimeout>;
  private motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  private turntableRequested = true;
  private dressGeneration = 0;

  constructor(
    private container: HTMLElement,
    onShoulderView?: () => void,
  ) {
    this.viewer = new Viewer(container, (fps) => {
      this.fps = fps;
    });
    this.motionPreference.addEventListener('change', this.motionChanged);
    this.motionChanged();
    this.viewer.tapes.visible = false;
    this.viewer.onShoulderView = onShoulderView;
    // Kiosk annotations: one large seam label, no cuff/hem chips (review 03 M3).
    this.viewer.fitAnnotations.configure({ seamOnly: true });
  }

  /** Label units follow the kiosk's toggle (same text as the cards). */
  setLabelFormat(format: LengthFormat) {
    this.viewer.fitAnnotations.configure({ format });
  }

  showLabels(on: boolean) {
    this.viewer.fitAnnotations.visible = on;
  }

  async showBody(body: FitResponse, signal?: AbortSignal) {
    const landmarks = await api.landmarks(body.body_id, signal);
    await this.viewer.setBody(body, landmarks, signal);
  }

  /**
   * Dresses one size and resolves once its cloth has settled. Returns the settle wall time and
   * the metrics measured on the settled shell. `onVisible` fires as soon as the jacket shell is
   * on screen (before it settles), so the kiosk can show the result without waiting.
   */
  async dress(
    fit: GarmentFitResponse,
    size: string,
    signal?: AbortSignal,
    onVisible?: (ms: number) => void,
  ) {
    const started = performance.now();
    const generation = ++this.dressGeneration;
    const initialDress = !this.viewer.garment.pickTarget;
    if (initialDress && !signal?.aborted) {
      // React reveals the stage and the viewer's ResizeObserver resizes its canvas a few frames
      // after the body is shown. Snapshot the body only once both have happened (bounded wait;
      // if layout never settles the jacket simply appears without the dissolve).
      const settled = await this.awaitLayout();
      if (generation !== this.dressGeneration || signal?.aborted)
        throw new DOMException('Garment dressing cancelled', 'AbortError');
      if (settled) this.coverBody();
    }
    const onAbort = () => {
      if (generation === this.dressGeneration) this.removeCover();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    let watching = true;
    const watch = () => {
      if (!watching || signal?.aborted || generation !== this.dressGeneration) return;
      const target = this.viewer.garment.pickTarget;
      if (target) {
        // The shell is built on the asset's posed body (arms lowered into the sleeves). Show
        // that body with it at once; the engine does the same after the settle. Without this
        // the default-pose arms stick out of the sleeves until the cloth settles (review 03 M3).
        this.viewer.body.display(target.asset.body_positions, target.asset.body_triangles);
        watching = false;
        if (initialDress) this.revealDress();
        onVisible?.(performance.now() - started);
        return;
      }
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
    try {
      await this.viewer.setGarment(fit, size, signal);
      // A cached size morphs in and settles at once: it is visible when setGarment resolves.
      if (watching && !signal?.aborted && generation === this.dressGeneration) {
        if (initialDress) this.revealDress();
        onVisible?.(performance.now() - started);
      }
    } finally {
      watching = false;
      signal?.removeEventListener('abort', onAbort);
      if (initialDress && generation === this.dressGeneration) this.revealDress();
    }
    return {
      timing: this.viewer.garment.lastSwitchTiming,
      wallMs: performance.now() - started,
      solverMeanStepMs: this.viewer.lastSimulation?.state.meanStepMs ?? null,
      shown: this.viewer.lastSimulation?.simulated as SizeFit | undefined,
    };
  }

  /** Background precompute of the other sizes (engine's own cache and worker). */
  precompute(fit: GarmentFitResponse, sizes: string[], current: string, signal?: AbortSignal) {
    return this.viewer.garment.preload(fit.fit_id, sizes, current, signal);
  }

  /** Removes the garment and its fit annotation labels (never leave another body's labels). */
  clearGarment() {
    this.dressGeneration++;
    this.removeCover();
    this.viewer.garment.reset();
    this.viewer.fitAnnotations.dispose();
  }

  setMode(mode: GarmentMode, fit?: GarmentFitResponse) {
    this.viewer.setMode(mode, fit);
  }

  preset(preset: Preset) {
    this.viewer.rig.preset(preset);
  }

  enterResult() {
    this.viewer.rig.enterResult();
  }

  /** Resolves true once the container is laid out and the WebGL canvas has its size (<= 600 ms). */
  private async awaitLayout() {
    const canvas = this.viewer.renderer.domElement;
    const deadline = performance.now() + 600;
    for (;;) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const width = this.container.clientWidth;
      if (width > 0 && Math.abs(canvas.clientWidth - width) <= 1) return true;
      if (performance.now() > deadline) return false;
    }
  }

  /** DOM dissolve only: never changes the garment's geometry, material, opacity or shader. */
  private coverBody() {
    this.removeCover();
    if (this.motionPreference.matches) return;
    const source = this.viewer.renderer.domElement;
    if (!source.width || !source.height || !this.container.clientWidth) return;
    const cover = document.createElement('canvas');
    cover.width = source.width;
    cover.height = source.height;
    cover.className = 'k-dress-cover';
    cover.setAttribute('aria-hidden', 'true');
    const context = cover.getContext('2d');
    if (!context) return;
    // WebGL does not preserve its drawing buffer: capture synchronously after this render.
    this.viewer.composer.render();
    context.drawImage(source, 0, 0);
    this.container.append(cover);
    // Establish the initial opacity even if a cached dress resolves before the next paint.
    void getComputedStyle(cover).opacity;
    this.dressCover = cover;
  }

  private revealDress() {
    if (!this.dressCover || this.coverTimer !== undefined) return;
    if (this.motionPreference.matches) return this.removeCover();
    this.dressCover.classList.add('k-revealing');
    this.coverTimer = setTimeout(() => this.removeCover(), 480);
  }

  private removeCover() {
    clearTimeout(this.coverTimer);
    this.coverTimer = undefined;
    this.dressCover?.remove();
    this.dressCover = undefined;
  }

  private motionChanged = () => {
    this.viewer.idleTurntable = this.turntableRequested && !this.motionPreference.matches;
    if (this.motionPreference.matches) {
      this.removeCover();
      this.viewer.rig.update(0);
    }
  };

  turntable(on: boolean, speed = 0.6) {
    this.turntableRequested = on;
    this.motionChanged();
    this.viewer.controls.autoRotateSpeed = speed;
  }

  followCamera(leader: GarmentView | null) {
    this.viewer.syncWith = leader?.viewer;
    this.viewer.controls.enabled = !leader;
  }

  /**
   * Shader programs ahead of their first draw, compiled in the background (never blocks the
   * page; engine/programWarmup.ts): when the jacket this view will show is known, the programs
   * of its finish in the product look (shell, hardware, hood), or with `xray` its X-ray passes
   * too. Programs submitted together share the GPU process's compile threads (about two at a
   * time) and finish together, so callers submit what is needed first on its own.
   * The engine draws a jacket, or switches to X-ray, only once its programs are linked.
   */
  prepareShaders(finish: string | undefined, xray = false): Promise<void> {
    if (!isGarmentFinish(finish)) return Promise.resolve();
    return this.viewer.prewarm(finish, xray ? 'xray' : 'normal');
  }

  /** Resolves once the scene's own programs (body, ground, passes, labels) are linked. */
  sceneShaders() {
    return this.viewer.prewarmScene();
  }

  stats(): RenderStats {
    const info = this.viewer.renderer.info;
    return {
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      calls: info.render.calls,
      triangles: info.render.triangles,
    };
  }

  /**
   * Diagnostics (soak "dressed" check): vertex count of the largest visible garment mesh in
   * the scene, 0 when no jacket is on the body. Geometry only; no body data.
   */
  garmentVertices(): number {
    let vertices = 0;
    if (!this.viewer.garment.visible) return 0;
    this.viewer.garment.traverseVisible((object) => {
      if (object instanceof Mesh)
        vertices = Math.max(vertices, object.geometry.getAttribute('position')?.count ?? 0);
    });
    return vertices;
  }

  gpuRenderer(): string {
    const gl = this.viewer.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(
      ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    );
  }

  /** True when a garment is shown and can be pulled (its cloth state is live in the worker). */
  canPull() {
    return !!this.viewer.garment.pickTarget;
  }

  /**
   * Feel the fabric: product look, camera on the jacket front, orbit off, and a hand-pull
   * controller bound to this view. Call endHandPull() to undo.
   */
  startHandPull() {
    if (this.pull) return this.pull;
    const target = this.viewer.garment.pickTarget;
    if (!target) throw new Error('No garment to pull');
    this.viewer.setMode('normal');
    this.turntable(false);
    this.viewer.controls.enabled = false;
    this.viewer.fitAnnotations.visible = false;
    this.frameFront(target.asset.initial);
    this.pull = new HandPullController({
      garment: this.viewer.garment,
      camera: this.viewer.camera,
      container: this.container,
    });
    return this.pull;
  }

  /** Mouse/touch orbit during feel mode (e.g. when the camera failed). */
  allowOrbit(on: boolean) {
    this.viewer.controls.enabled = on;
  }

  endHandPull() {
    this.pull?.dispose();
    this.pull = undefined;
    cancelAnimationFrame(this.tween);
    this.viewer.controls.enabled = true;
    this.viewer.fitAnnotations.visible = true;
  }

  /** Frames the garment front so the jacket fills ~85 % of the view height (smooth 0.6 s). */
  private frameFront(positions: ArrayLike<number>) {
    const box = new Box3();
    const v = new Vector3();
    for (let i = 0; i < positions.length; i += 3)
      box.expandByPoint(v.set(positions[i], positions[i + 1], positions[i + 2]));
    const centre = box.getCenter(new Vector3()),
      size = box.getSize(new Vector3()),
      camera = this.viewer.camera,
      controls = this.viewer.controls,
      half = Math.tan(((camera.fov / 2) * Math.PI) / 180),
      fitHeight = size.y / 0.85 / 2 / half,
      fitWidth = size.x / 0.85 / 2 / (half * camera.aspect),
      distance = Math.max(fitHeight, fitWidth);
    const toTarget = centre.clone(),
      toPosition = new Vector3(centre.x, centre.y, box.max.z + distance);
    // Cancel any rig preset in flight (same 'start' event the rig listens to).
    controls.dispatchEvent({ type: 'start' });
    const fromTarget = controls.target.clone(),
      fromPosition = camera.position.clone(),
      started = performance.now();
    cancelAnimationFrame(this.tween);
    const step = () => {
      const t = this.motionPreference.matches
          ? 1
          : Math.min(1, (performance.now() - started) / 600),
        e = t * t * (3 - 2 * t);
      controls.target.lerpVectors(fromTarget, toTarget, e);
      camera.position.lerpVectors(fromPosition, toPosition, e);
      controls.update();
      if (t < 1) this.tween = requestAnimationFrame(step);
    };
    this.tween = requestAnimationFrame(step);
  }

  dispose() {
    this.dressGeneration++;
    this.motionPreference.removeEventListener('change', this.motionChanged);
    this.removeCover();
    this.endHandPull();
    this.viewer.dispose();
  }
}
