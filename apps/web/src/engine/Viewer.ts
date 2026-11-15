import {
  NeutralToneMapping,
  CircleGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  WebGLRenderTarget,
  HalfFloatType,
  Vector2,
  PMREMGenerator,
  DoubleSide,
  FrontSide,
  Texture,
  ColorManagement,
  SRGBTransfer,
  type Material,
  type Object3D,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { msaaSamples } from './antialias';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import type { FitResponse, Landmarks, GarmentFitResponse } from '../api';
import { GarmentLayer } from './GarmentLayer';
import { FitAnnotationLayer } from './FitAnnotationLayer';
import type { GarmentMode } from './garmentMath';
import { BodyLayer } from './BodyLayer';
import { CameraRig, type Preset } from './CameraRig';
import { LandmarkLayer } from './LandmarkLayer';
import { MeasurementLayer } from './MeasurementLayer';
import { disposeObject } from './dispose';
import { settledMetrics } from './cloth/metrics';
import type { SizeFit } from '../api';
import type { ClothAsset } from '../api';
import type { SettledCloth } from './cloth/ClothClient';
import { recordTiming, timingEnabled } from './requestTiming';
import { ProgramWarmup, shadowDepthStandIn, standIn } from './programWarmup';
import type { Finish } from './garmentLook';
import { detailMaterialVariants } from './garmentDetails';
import { HoodLayer } from './hood/HoodLayer';
import { annotationStandIns } from './FitAnnotationLayer';
import { EdgeWall, TeethStrip, velcroTab, zipPull } from './interact/hardware';

/**
 * OutputPass sets its defines on its first render (three r181 OutputPass.render); the same
 * defines here let its program compile before that render. Only this viewer's settings.
 */
function outputPassDefines(renderer: WebGLRenderer) {
  const defines: Record<string, string> = {};
  if (ColorManagement.getTransfer(renderer.outputColorSpace) === SRGBTransfer)
    defines.SRGB_TRANSFER = '';
  if (renderer.toneMapping === NeutralToneMapping) defines.NEUTRAL_TONE_MAPPING = '';
  return defines;
}

export class Viewer {
  readonly body = new BodyLayer();
  readonly landmarks = new LandmarkLayer();
  readonly tapes = new MeasurementLayer();
  readonly garment = new GarmentLayer();
  readonly fitAnnotations = new FitAnnotationLayer();
  syncWith?: Viewer;
  onShoulderView?: () => void;
  onSettled?: (metrics: SizeFit, seconds: number, particles: number) => void;
  lastSimulation?: {
    asset: ClothAsset;
    state: SettledCloth;
    analytic: SizeFit;
    simulated: SizeFit;
  };
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(35, 1, 0.01, 50);
  readonly renderer = new WebGLRenderer({ antialias: true, alpha: false });
  readonly labels = new CSS2DRenderer();
  readonly controls: OrbitControls;
  readonly composer: EffectComposer;
  readonly ao: GTAOPass;
  /** Composer MSAA sample count; 0 = SMAA fallback (antialias.ts). */
  readonly msaa: number;
  quality: 'High' | 'Medium' = 'High';
  idleTurntable = true;
  private lastInteraction = 0;
  private currentMode: GarmentMode = 'normal';
  private frameSamples: number[] = [];
  private sampling = false;
  private environment;
  readonly rig: CameraRig;
  private observer: ResizeObserver;
  private lastTime = 0;
  private frame = 0;
  private sampleStart = 0;
  private frameCount = 0;
  private disposed = false;
  private timingLastAsset = '';
  /** Shader programs compiled ahead of their first draw and kept (programWarmup.ts). */
  readonly programs: ProgramWarmup;
  /** Stands in for the weave normal map in stand-ins (never uploaded: never drawn). */
  private readonly weavePlaceholder = new Texture();
  private ground: Mesh<CircleGeometry, MeshStandardMaterial>;
  /** An X-ray switch waiting for its programs (setMode). */
  private pendingMode?: { mode: GarmentMode; fit?: GarmentFitResponse };

  constructor(
    private container: HTMLElement,
    private onFps: (fps: number) => void,
  ) {
    this.scene.background = new Color('#ecebe8');
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    // Khronos PBR Neutral keeps product colours (Rattan stays tan, White stays white) and
    // compresses only true highlights, unlike ACES which washes light colours to cream.
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    const pmrem = new PMREMGenerator(this.renderer),
      room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room, 0.04);
    this.scene.environment = this.environment.texture;
    // Soft room IBL for fill and reflections; the directional key carries the form (look-dev).
    this.scene.environmentIntensity = 0.62;
    room.dispose();
    pmrem.dispose();
    // 4x MSAA on the composer's own (HalfFloat, as EffectComposer's default) targets; SMAA only
    // as the fallback (antialias.ts). Sized to the drawing buffer; resize() keeps it in step.
    this.msaa = msaaSamples(this.renderer.capabilities.maxSamples, location.search);
    const buffer = this.renderer.getDrawingBufferSize(new Vector2());
    this.composer = new EffectComposer(
      this.renderer,
      this.msaa
        ? new WebGLRenderTarget(buffer.x, buffer.y, { type: HalfFloatType, samples: this.msaa })
        : undefined,
    );
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.ao = new GTAOPass(this.scene, this.camera, 512, 512);
    // Look convention (agent L2): studio-soft contact shadows. The default 25 cm radius at full
    // blend turned every narrow garment gap (hood over the shoulders, sleeve beside the torso)
    // near black; the product photos are lit by large soft sources and show soft occlusion.
    this.ao.blendIntensity = 0.65;
    this.ao.updateGtaoMaterial({ radius: 0.1 });
    this.composer.addPass(this.ao);
    if (!this.msaa) this.composer.addPass(new SMAAPass());
    this.composer.addPass(new OutputPass());
    this.labels.domElement.className = 'scene-labels';
    container.append(this.renderer.domElement, this.labels.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.autoRotateSpeed = 0.25;
    this.controls.addEventListener('start', this.interacted);
    this.controls.addEventListener('end', this.interacted);
    this.controls.minDistance = 0.45;
    this.controls.maxDistance = 7;
    this.controls.maxPolarAngle = Math.PI * 0.52;
    this.controls.target.set(0, 0.9, 0);
    this.camera.position.set(0, 0.98, 3.2);
    this.rig = new CameraRig(this.camera, this.controls);
    this.scene.add(
      this.body,
      this.landmarks,
      this.tapes,
      this.garment,
      this.fitAnnotations,
      new HemisphereLight(0xffffff, 0x8a8885, 0.18),
    );
    this.landmarks.visible = false;
    // Neutral white lights: product colours are judged against the real jacket.
    const key = new DirectionalLight(0xffffff, 2.2);
    key.position.set(-2, 4, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = key.shadow.camera.bottom = -2;
    key.shadow.camera.right = key.shadow.camera.top = 2;
    key.shadow.normalBias = 0.001;
    key.shadow.radius = 4;
    const fill = new DirectionalLight(0xf4f6ff, 0.42);
    fill.position.set(3, 2, 1);
    const rim = new DirectionalLight(0xffffff, 1.1);
    rim.position.set(0, 3, -3);
    this.scene.add(key, fill, rim);
    const ground = new Mesh(
      new CircleGeometry(3, 96),
      new MeshStandardMaterial({ color: 0xe4e2de, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.008;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.ground = ground;
    this.programs = new ProgramWarmup(this.renderer, this.scene, this.camera);
    this.garment.programs = (finish, mode) => this.prewarm(finish, mode);
    void this.prewarmScene();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    window.addEventListener('keydown', this.onKey);
    this.resize();
    this.frame = requestAnimationFrame(this.animate);
  }
  private interacted = () => {
    this.lastInteraction = performance.now();
  };
  setQuality(quality: 'High' | 'Medium') {
    this.quality = quality;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, quality === 'High' ? 1.25 : 1));
    // The composer keeps its own pixel ratio (taken at construction): follow the renderer so the
    // multisampled targets shrink with Medium quality too.
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.ao.enabled = quality === 'High' && this.currentMode !== 'xray';
    this.resize();
  }
  async sampleFps(quality: 'High' | 'Medium', frames = 180) {
    this.setQuality(quality);
    this.idleTurntable = false;
    for (let i = 0; i < 30; i++)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    this.frameSamples = [];
    this.sampling = true;
    while (this.frameSamples.length < frames)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    this.sampling = false;
    const values = this.frameSamples.slice().sort((a, b) => a - b);
    return {
      quality,
      frames: values.length,
      p50: 1000 / values[Math.floor(values.length * 0.5)],
      p5: 1000 / values[Math.floor(values.length * 0.95)],
    };
  }
  private resize() {
    const { clientWidth: width, clientHeight: height } = this.container;
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.composer.setSize(width, height);
    this.ao.setSize(Math.ceil(width * 0.5), Math.ceil(height * 0.5));
    this.labels.setSize(width, height);
    this.tapes.resize(width, height);
  }
  private onKey = (event: KeyboardEvent) => {
    if (!this.container.getClientRects().length) return;
    if (event.target instanceof HTMLElement && /INPUT|SELECT|TEXTAREA/.test(event.target.tagName))
      return;
    const presets: Record<string, Preset> = {
      '1': 'front',
      '2': 'back',
      '3': 'shoulder',
      '4': 'side',
      '5': 'shoulders',
    };
    if (event.key in presets) this.rig.preset(presets[event.key]);
    if (event.key === '5') this.onShoulderView?.();
  };
  private animate = (time: number) => {
    const frameMs = time - this.lastTime;
    const dt = Math.min((time - this.lastTime) / 1000, 0.1);
    this.lastTime = time;
    if (!this.container.getClientRects().length) {
      this.frame = requestAnimationFrame(this.animate);
      this.sampleStart = time;
      this.frameCount = 0;
      return;
    }
    this.rig.update(dt);
    this.controls.autoRotate = this.idleTurntable && time - this.lastInteraction > 8000;
    this.controls.update();
    if (this.syncWith) {
      this.camera.position.copy(this.syncWith.camera.position);
      this.camera.quaternion.copy(this.syncWith.camera.quaternion);
      this.controls.target.copy(this.syncWith.controls.target);
    }
    this.garment.update(dt);
    const timingAsset = timingEnabled() ? this.garment.pickTarget?.asset.key : undefined;
    const firstRender = timingAsset !== undefined && timingAsset !== this.timingLastAsset;
    const renderStart = firstRender ? performance.now() : 0;
    this.composer.render();
    if (firstRender) {
      this.timingLastAsset = timingAsset;
      recordTiming({
        phase: 'first-render',
        category: 'garment',
        atMs: renderStart,
        values: {
          renderSubmitMs: performance.now() - renderStart,
          note: 'CPU first-frame render submission; not GPU completion time',
        },
      });
    }
    this.labels.render(this.scene, this.camera);
    this.frameCount++;
    if (this.sampling && frameMs > 0) this.frameSamples.push(frameMs);
    if (time - this.sampleStart >= 2000) {
      this.onFps(Math.round((this.frameCount * 1000) / (time - this.sampleStart)));
      this.frameCount = 0;
      this.sampleStart = time;
    }
    this.frame = requestAnimationFrame(this.animate);
  };
  async setBody(result: FitResponse, landmarks: Landmarks, signal?: AbortSignal) {
    await this.body.load(result.body_id, signal);
    if (signal?.aborted || this.disposed) return;
    this.landmarks.set(landmarks);
    this.tapes.set(landmarks, result.measurements);
    this.rig.height = result.measurements.stature.value_cm / 100;
    this.rig.preset('front');
    this.garment.reset();
    this.fitAnnotations.dispose();
  }
  setMode(mode: GarmentMode, fit?: GarmentFitResponse) {
    const finish = this.garment.finishShown;
    if (mode === 'xray' && finish && !this.programs.ready(`xray:${finish}`)) {
      // X-ray programs still compiling (cold GPU cache): the look stays on screen and the
      // switch happens once they are linked, instead of a draw that freezes the page until then.
      const request = { mode, fit };
      this.pendingMode = request;
      void this.prewarm(finish, mode).then(() => {
        if (this.pendingMode === request && !this.disposed) this.applyMode(mode, fit);
      });
      return;
    }
    this.applyMode(mode, fit);
  }
  private applyMode(mode: GarmentMode, fit?: GarmentFitResponse) {
    this.pendingMode = undefined;
    this.currentMode = mode;
    this.ao.enabled = this.quality === 'High' && mode !== 'xray';
    this.garment.setMode(mode, fit?.heatmap_tight_cm, fit?.heatmap_loose_cm);
  }
  /**
   * Compiles in the background and keeps every program the garment layer draws for `finish`
   * (programWarmup.ts). Batch `look`: the shell in the product look and its shadow caster, the
   * hardware details, the padded hood and the Feel screen's zip hardware (every variant: each
   * is small, and which ones a product has is only known from its asset). Batch `xray`: the
   * shell's two X-ray passes. Resolves once `look` is linked, and `xray` too for mode 'xray'.
   * The RenderPass target is bound: these draws go into composer targets (shadow maps and the
   * AO normal pass too; any non-XR target gives the same key).
   */
  prewarm(finish: Finish, mode: GarmentMode = 'normal'): Promise<void> {
    const target = this.composer.readBuffer;
    let shell: { look: Object3D[]; xray: Object3D[] } | undefined;
    const stand = () => (shell ??= this.garment.programStandIns(finish, this.weavePlaceholder));
    const look = this.programs.compile(`look:${finish}`, target, () => [
      ...stand().look,
      ...detailMaterialVariants().map((material) => standIn(material)),
      shadowDepthStandIn(FrontSide),
      standIn(HoodLayer.programTwin(finish, this.weavePlaceholder)),
      shadowDepthStandIn(DoubleSide),
      zipPull('coil-black').mesh,
      zipPull('metal-silver').mesh,
      new TeethStrip(2, 0x9da1a6).mesh,
      new EdgeWall(2, 0x111214).mesh,
      velcroTab(),
    ]);
    if (mode !== 'xray') return look;
    const xray = this.programs.compile(`xray:${finish}`, target, () => stand().xray);
    return Promise.all([look, xray]).then(() => undefined);
  }
  /**
   * The scene's own programs, compiled in the background at construction: mannequin, ground,
   * shadow caster, fit annotations, the AO pass and the output pass. Resolves once linked.
   */
  prewarmScene(): Promise<void> {
    // Scene draws: the mannequin, ground and annotations, and the AO pass's normal/depth render
    // (the whole scene with its lights, MeshNormalMaterial as override).
    const inScene: Material[] = [this.body.material, this.ground.material];
    // Full-screen pass quads: drawn as a bare mesh into composer targets (no lights).
    const quads: Material[] = [];
    let output: OutputPass | undefined;
    for (const pass of this.composer.passes) {
      if (pass instanceof GTAOPass) {
        inScene.push(pass.normalMaterial);
        quads.push(pass.gtaoMaterial, pass.pdMaterial, pass.copyMaterial, pass.blendMaterial);
      } else if (pass instanceof SMAAPass)
        quads.push(pass.materialEdges, pass.materialWeights, pass.materialBlend);
      else if (pass instanceof OutputPass) output = pass;
    }
    const target = this.composer.readBuffer;
    const batches = [
      this.programs.compile(
        'scene',
        target,
        () => [
          ...inScene.map((material) => standIn(material)),
          shadowDepthStandIn(FrontSide),
          ...annotationStandIns(),
        ],
        inScene,
      ),
      this.programs.compile(
        'passes',
        target,
        () => quads.map((material) => standIn(material)),
        quads,
        new Scene(),
      ),
    ];
    if (output) {
      // OutputPass draws to the canvas with a raw shader: its key is its defines, which it sets
      // on its first render; set the same ones now so that render reuses this program.
      const material = output.material;
      const build = () => {
        material.defines = outputPassDefines(this.renderer);
        return [standIn(material)];
      };
      batches.push(this.programs.compile('output', null, build, [material], new Scene()));
    }
    return Promise.all(batches).then(() => undefined);
  }
  async setGarment(fit: GarmentFitResponse, size: string, signal?: AbortSignal) {
    const metrics = fit.sizes[size];
    if (!metrics) throw new Error('Size unavailable');
    if (metrics.geometry_available) {
      const { asset, state } = await this.garment.simulate(fit.fit_id, size, signal);
      if (signal?.aborted) return;
      this.body.display(asset.body_positions, asset.body_triangles);
      const simulated = settledMetrics(asset, state.positions, metrics);
      this.lastSimulation = { asset, state, analytic: metrics, simulated };
      this.fitAnnotations.set(simulated, { [size]: simulated }, metrics);
      this.onSettled?.(simulated, state.elapsedMs / 1000, asset.rest.length / 3);
    } else this.garment.reset();
  }
  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    window.removeEventListener('keydown', this.onKey);
    this.controls.dispose();
    this.controls.removeEventListener('start', this.interacted);
    this.controls.removeEventListener('end', this.interacted);
    this.rig.dispose();
    this.body.dispose();
    this.landmarks.dispose();
    this.tapes.dispose();
    this.garment.dispose();
    this.fitAnnotations.dispose();
    this.programs.dispose();
    disposeObject(this.scene);
    this.renderer.dispose();
    this.composer.dispose();
    this.ao.dispose();
    this.environment.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }
}
