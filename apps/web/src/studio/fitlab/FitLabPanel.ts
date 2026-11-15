// Fit Lab side panel for the Studio page (agent FL; prompt 31, redesigned per prompt 33).
//
// Look first: the person's own body (from height and weight, or the kiosk's reference body,
// labelled) wearing the jacket they are considering, with trousers (P). Scrolling in (R) moves the
// camera closer and turns the shell see-through; a TIGHT zone tints the glass lightly red there,
// good/loose read from the visible gap. S/M/L switch instantly (sizes.ts: all three shells are
// preloaded). Only the selected size's verdict is shown (U's size picker), with on-image notes (U).
//
// Our engine, end to end, nothing invented:
//   body     POST /body/fit (the kiosk's request: kioskApi.fitBody);
//   verdict  POST /fit/garment per jacket (the kiosk's request: t-shirt layer, 'regular');
//   3D       LiveTryOnEngine with only its kiosk-look mirror, posed from the Studio's Perception
//            (PerceptionSource, no second tracker); the S/M/L shells skinned to the same pose.
import { Vector3, type Mesh, type Scene } from 'three';
import { api, type GarmentFitResponse, type GarmentSpec } from '../../api';
import type { GarmentLayer } from '../../engine/GarmentLayer';
import type { LiveAvatar } from '../../engine/live/LiveAvatar';
import { LiveTryOnEngine } from '../../engine/live/LiveTryOnEngine';
import { liveNeutral } from '../../engine/live/livePose';
import type { LiveTryOnState } from '../../engine/live/contract';
import { skinVertices } from '../../engine/motion/rig';
import type { Viewer } from '../../engine/Viewer';
import { fitBody, type ScanMeasurementsRequest } from '../../kiosk/kioskApi';
import { isGarmentFinish } from '../../kiosk/shaderWarm';
import type {
  FitLabPanel,
  GarmentState,
  JacketId,
  Perception,
  SizeLabel,
  StudioBus,
} from '../contract';
import {
  DEFAULT_FRAME_SIZE,
  JACKET_STYLES,
  KIOSK_LAYER_PRESET,
  KIOSK_PREFERENCE,
  KIOSK_SHAPE_REFERENCE,
  PANEL_QUALITY,
  REFERENCE_PERSON,
  STUDIO_SIZES,
} from './config';
import {
  rankNotes,
  selectedVerdict,
  ZIP_TOP_MAX,
  zoneStates,
  type FitZone,
  type SelectedVerdict,
  type ZoneState,
} from './fitZones';
import type {
  Annotation,
  AnnotationLayer,
  ScrollReveal,
  ScrollRevealOptions,
  SeeThrough,
  SizePicker,
  TightZone,
  ZoneId,
} from './look/types';
import { applyProductLook, disposeProductLook } from './look/productLook';
import { createTrousersFromRest, trousersHeights, type Trousers } from './look/trousers';
import { PerceptionSource, type FrameSize } from './perceptionSource';
import { loadPerson, parsePerson, savePerson } from './personStore';
import { maxAnisotropy, renderRatio, SHARP, StillDetector } from './sharpness';
import { MeshAnchors, SizeShells, writeFitZones } from './sizes';
import { createAnnotationLayer } from './ui/annotations';
import { mountScrollHint } from './ui/scrollHint';
import { enableOrbit, type FitLabOrbit } from './look/orbit';
import { createSizePicker } from './ui/sizePicker';
import { SliceView } from './ui/sliceView';
import type { CtPickable, CtStack, CtStackLayer } from './look/ctTypes';
import { buildVerdict, type FitLabVerdict } from './verdict';
import './fitlab.css';

/** Kept for the contract's setMode: 'look' = reveal 0; 'xray' / 'heatmap' / 'fit' = see-through. */
export type FitLabMode = 'fit' | 'xray' | 'heatmap' | 'look';

/** The person whose body the Fit Lab builds. Omit for the kiosk's reference body. */
export interface FitLabPerson {
  height_cm: number;
  weight_kg: number;
  sex: 'female' | 'male';
  /** Webcam scan values (kiosk ScanScreen → scan_measurements), when a scan was taken. */
  scan?: ScanMeasurementsRequest;
}

export interface FitLabOptions {
  person?: FitLabPerson;
  /** The SharedCamera's pixel size, for the engine's in-frame checks (default 1280x720). */
  frameSize?: () => FrameSize;
  /** Mirror the panel image like a mirror (default true, as the kiosk's live mirror). */
  mirror?: boolean;
  /** Initial reveal 0..1 (default 0: the Look). */
  reveal?: number;
}

/** What agent ZB needs to attach the interactive zip/hood to this panel (FL -> ZB). */
export interface FitLabInteractHost {
  viewer: Viewer;
  garmentLayer: GarmentLayer;
  /** Same layer under engine/interact InteractHost's name, so the host is an InteractHost. */
  garment: GarmentLayer;
  camera: Viewer['camera'];
  /** Element holding the Viewer canvas (pointer events). */
  container: HTMLElement;
  canvas: HTMLCanvasElement;
  /** The posed avatar (body + skinned jacket) the panel shows; undefined before it loads. */
  avatar: LiveAvatar | undefined;
  /** True while the canvas is CSS-mirrored (scaleX(-1)): screen x is flipped vs the canvas. */
  mirrored: boolean;
}

/** One-line state for the Studio shell (optional). */
export interface FitLabStatus {
  phase: 'loading' | LiveTryOnState['phase'];
  message: string;
  bodyBasis: string;
  poseHz: number;
  error: string | null;
}

type Fits = Map<
  JacketId,
  { product: GarmentSpec; fit: GarmentFitResponse; verdict: FitLabVerdict }
>;

/** R's modules, loaded when present (they land in parallel; the Look works without them). */
const seeThroughModules = import.meta.glob<{
  createSeeThrough?: (viewer: Viewer) => SeeThrough;
}>('./look/seeThrough.ts');
const scrollRevealModules = import.meta.glob<{
  createScrollReveal?: (
    opts: ScrollRevealOptions & {
      controls?: { target: Vector3; update(): unknown };
      ctStage?: boolean;
      ctAim?: () => { x: number; y: number; z: number } | null;
      onCtPhase?: (phase: number) => void;
    },
  ) => ScrollReveal & { ctPhase?(): number };
}>('./look/scrollReveal.ts');
/** CT stage layers (CL: 3D cut caps; VX: scanner + gap callouts), loaded when present. */
// v2 contract (look/ctTypes.ts): CL's caps are a CtStackLayer that may also be CtPickable; VX's
// scanner takes CL's pickable for hover, glow, info card and ruler.
type CtCapFactory = (scene: Scene) => CtStackLayer & Partial<CtPickable>;
type CtScannerFactory = (
  scene: Scene,
  host: HTMLElement,
  cap?: CtPickable,
  requestRender?: () => void,
) => CtStackLayer;
const ctCapModules = import.meta.glob<{ createCtCap?: CtCapFactory }>('./look/ctCap.ts');
const ctScannerModules = import.meta.glob<{ createCtScanner?: CtScannerFactory }>(
  './look/ctScanner.ts',
);
/** CS: layers in the CT stack (hem to collar) and the stack's minimum refresh interval (ms). */
const CT_STACK_LAYERS = 7;
const CT_STACK_REFRESH_MS = 250;
async function optional<M, T>(
  mods: Record<string, () => Promise<M>>,
  pick: (m: M) => T | undefined,
) {
  const load = Object.values(mods)[0];
  return load ? pick(await load()) : undefined;
}

/** Contract zone ids (look/types.ts) from the fit zones (the cuff is the 'sleeve' zone). */
const ZONE_ID: Record<FitZone, ZoneId> = {
  collar: 'collar',
  shoulder: 'shoulder',
  chest: 'chest',
  hem: 'hem',
  bicep: 'bicep',
  sleeve: 'cuff',
};

/**
 * Tint strength for R (display only): snug (positive ease the engine still flags) 0.35; tight
 * from 0.55, +1 per 8 cm of negative ease, capped at 1.
 */
export function tightSeverity(state: ZoneState): number {
  if (state.tone === 'snug') return 0.35;
  const ease = state.valueCm ?? 0;
  return Math.min(1, 0.55 + Math.max(0, -ease) / 8);
}

/** How far above the jacket's hem the trousers continue, hidden inside the shell (m; display). */
export const TROUSER_TUCK_M = 0.04;

/** Collar pulse when the zip reaches the top (display only). */
export const COLLAR_PULSE_MS = 1600;

/** Annotation fade from the reveal (show from about 0.5). */
export function annotationVisibility(reveal: number) {
  const t = Math.min(1, Math.max(0, (reveal - 0.35) / 0.25));
  return t * t * (3 - 2 * t);
}

export class FitLab implements FitLabPanel {
  private bus?: StudioBus;
  private engine?: LiveTryOnEngine;
  private source?: PerceptionSource;
  private perception?: Perception;
  private root?: HTMLDivElement;
  private stage?: HTMLDivElement;
  private canvasHost?: HTMLDivElement;
  private ui = {} as Record<'basis' | 'status' | 'picker', HTMLElement>;
  private fits: Fits = new Map();
  private shown?: { jacket: JacketId; size: SizeLabel };
  private queue: Promise<void> = Promise.resolve();
  private offBus?: () => void;
  private offState?: () => void;
  private disposed = false;
  private bodyBasis = '';
  private bodyId?: string;
  private status: FitLabStatus = {
    phase: 'loading',
    message: '',
    bodyBasis: '',
    poseHz: 0,
    error: null,
  };
  private statusListeners = new Set<(s: FitLabStatus) => void>();
  private person?: FitLabPerson;
  private mirrorWanted = true;
  // Redesign parts.
  private shells?: SizeShells;
  private seeThrough?: SeeThrough;
  private scroll?: ScrollReveal;
  private annotations?: AnnotationLayer;
  private picker?: SizePicker;
  private hint?: { hide(): void; dispose(): void };
  /** OR: drag-to-rotate (camera only; the wheel stays the reveal's). */
  private orbit?: FitLabOrbit;
  private trousers?: Trousers;
  private trousersFor?: object;
  private reveal = 0;
  private zip = 0;
  private states: ZoneState[] = [];
  private raf = 0;
  private lastAnn = 0;
  private bodyMesh?: object;
  private bodyVersion = -1;
  private meshAnchors = new MeshAnchors();
  private pulseStart = -Infinity;
  /** CT slice (agent CT): cross-section card; `?ct=0` turns it off. */
  private ct?: SliceView;
  /** CS: CT stage (wheel past the see-through): phase 0..1, its layers and the clip plane. */
  private ctPhase = 0;
  private ctLayers: CtStackLayer[] = [];
  private ctCap?: CtStackLayer & Partial<CtPickable>;
  private ctStack: CtStack | null = null;
  private ctStackAt = -Infinity;
  private ctAimAt = new Vector3();
  private offCtSlice?: () => void;
  private shellBySize = new Map<SizeLabel, GarmentLayer>();

  constructor(private options: FitLabOptions = {}) {
    // An explicit person wins; else the values entered on this machine (localStorage), else the
    // kiosk's reference body.
    this.person = options.person ?? loadPerson() ?? undefined;
    this.mirrorWanted = options.mirror ?? true;
    this.reveal = options.reveal ?? 0;
  }

  /**
   * Resolves once the verdict for every size is computed (body fit + garment fits, a few seconds),
   * so verdict() is ready for Decart. The 3D body and jacket keep loading in the background
   * (whenReady()); their errors show in the panel and in onStatus, never block the page.
   */
  async mount(host: HTMLElement, deps: { bus: StudioBus; perception: Perception }): Promise<void> {
    if (this.root) throw new Error('FitLab is already mounted');
    this.bus = deps.bus;
    this.perception = deps.perception;
    this.zip = deps.bus.get().zip;
    this.buildDom(host);
    try {
      const start = await this.load();
      if (!start) return;
      this.ready = this.start3d(deps.perception, start).catch((error: unknown) => this.fail(error));
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  /** Resolves when the 3D view is running (or failed: see onStatus). */
  whenReady(): Promise<void> {
    return this.ready;
  }
  private ready: Promise<void> = Promise.resolve();

  private fail(error: unknown) {
    if (this.disposed) return;
    const message = error instanceof Error ? error.message : String(error);
    console.error('[fitlab]', error);
    this.setStatus({ phase: 'error', message, error: message });
  }

  /** Contract: 'look' = the Look (reveal 0); any other mode = full see-through (reveal 1). */
  setMode(mode: FitLabMode): void {
    this.setReveal(mode === 'look' ? 0 : 1);
  }

  /** Reveal 0..1 (0 = the Look, 1 = see-through, close). Animated through R's scroll when present. */
  setReveal(t: number, animate = true) {
    if (this.scroll) this.scroll.set(t, animate);
    else this.onReveal(t);
  }

  private onReveal(t: number) {
    this.reveal = t;
    this.still.touch(performance.now());
    this.seeThrough?.setReveal(t);
    if (t > 0.05) this.hint?.hide();
  }

  verdict(): FitLabVerdict | null {
    const jacket = this.bus?.get().jacket;
    return (jacket && this.fits.get(jacket)?.verdict) ?? null;
  }

  /** Both jackets' verdicts (once loaded). */
  verdicts(): FitLabVerdict[] {
    return [...this.fits.values()].map((f) => f.verdict);
  }

  /** The selected size's one-word verdict and line (what the size picker shows). */
  selected(): (SelectedVerdict & { size: SizeLabel }) | null {
    const state = this.bus?.get();
    const v = this.verdict();
    if (!state || !v) return null;
    return { size: state.size, ...selectedVerdict(v.sizes[state.size].label, this.states) };
  }

  /** The selected size's zone states, worst first (engine numbers; collar coupled to the zip). */
  fitNotes(): ZoneState[] {
    return rankNotes(this.states);
  }

  /** ZB's hook: the panel's Viewer, garment layer and pointer element (null before load). */
  interactHost(): FitLabInteractHost | null {
    const view = this.engine?.kioskView;
    if (!view || !this.canvasHost) return null;
    return {
      viewer: view.viewer,
      garmentLayer: view.viewer.garment,
      garment: view.viewer.garment,
      camera: view.viewer.camera,
      container: this.canvasHost,
      canvas: view.canvas,
      avatar: this.engine?.posedScene,
      mirrored: !this.physics && (this.engine?.mirrorDisplay ?? false),
    };
  }

  /** Freeze pose following (e.g. while ZB's zip is grabbed); the avatar holds its last pose. */
  pauseLive(on: boolean) {
    this.source?.setPaused(on);
  }

  /** Mirror the panel image (presentation only; the pose is never mirrored). */
  setMirrorDisplay(on: boolean) {
    this.mirrorWanted = on;
    if (!this.physics) this.engine?.setMirrorDisplay(on);
  }

  /**
   * Rebuild for another person (null = the kiosk's reference body): body fit through the kiosk's
   * fitBody path, then the verdict, then the 3D body and the S/M/L shells. Entered values are kept
   * in this browser's localStorage only.
   */
  setPerson(person: FitLabPerson | null): Promise<void> {
    this.person = person ?? undefined;
    savePerson(
      person && !person.scan
        ? { height_cm: person.height_cm, weight_kg: person.weight_kg, sex: person.sex }
        : null,
    );
    const run = this.queue.then(async () => {
      if (this.disposed || !this.root) return;
      if (this.physics) this.exitPhysics();
      const start = await this.load();
      if (!start) return;
      const engine = this.engine,
        source = this.source;
      if (!engine || !source) {
        if (this.perception && !engine)
          this.ready = this.start3d(this.perception, start).catch((e: unknown) => this.fail(e));
        return;
      }
      const state = this.bus!.get();
      const f = this.fits.get(state.jacket);
      if (!f) return;
      this.shells?.dispose();
      this.shown = { jacket: state.jacket, size: state.size };
      await engine.start(source, {
        bodyId: start.bodyId,
        fitId: f.fit.fit_id,
        productId: f.product.product_id,
        size: state.size,
      });
      this.afterBody();
    });
    this.queue = run.catch((e: unknown) => this.fail(e));
    return run;
  }

  // ---------------------------------------------------------------- physics (ZB)

  private physics = false;
  private physicsAbort?: AbortController;
  private physicsLoad: Promise<void> = Promise.resolve();
  private physicsListeners = new Set<(on: boolean) => void>();

  /**
   * ZB: real cloth on the static body for the zip/hood, as the kiosk's Feel screen. Pauses the
   * live pose, turns the mirror flip off (pointer x = canvas x), hides the S/M/L preview shells
   * and runs Viewer.setGarment for the current jacket and size (the cloth solver in the worker).
   * Resolves once the shell is settled and garmentLayer.pickTarget exists.
   */
  async enterPhysics(): Promise<void> {
    // Pending bus jacket/size changes land first, so physics runs on the size on screen (ZB).
    await this.queue;
    return this.enterPhysicsNow();
  }

  private enterPhysicsNow(): Promise<void> {
    if (this.physics) return this.physicsLoad;
    const view = this.engine?.kioskView;
    const shown = this.shown;
    const f = shown && this.fits.get(shown.jacket);
    if (!view || !shown || !f) return Promise.reject(new Error('The Fit Lab 3D view is not ready'));
    this.physics = true;
    this.source?.setPaused(true);
    view.externalDrive = true;
    this.engine?.setMirrorDisplay(false);
    this.shells?.setVisible(false);
    this.physicsAbort = new AbortController();
    const signal = this.physicsAbort.signal;
    this.emitPhysics(true);
    this.setStatus({ message: 'Physics: real cloth on the static body (zip / hood)' });
    this.physicsLoad = view.viewer.setGarment(f.fit, shown.size, signal).then(() => {
      if (signal.aborted) return;
      // The solver's shell gets the same zone attribute as the preview shells (ZB's opened split
      // jacket copies it through its source map), so the see-through tints it and notes anchor.
      const target = view.viewer.garment.pickTarget;
      if (target) writeFitZones(target.mesh.geometry, target.asset);
      void applyProductLook(view.viewer.garment);
      this.sharpenTextures();
      this.styleParts();
    });
    return this.physicsLoad;
  }

  /** Back to the live, pose-following preview (ZB calls it once everything is closed again). */
  exitPhysics(): void {
    if (!this.physics) return;
    this.physics = false;
    this.interactMesh = undefined;
    this.physicsAbort?.abort();
    const view = this.engine?.kioskView;
    const avatar = this.engine?.posedScene;
    if (view && avatar) {
      view.externalDrive = false;
      view.viewer.garment.reset();
      view.setBody(avatar);
      void view.setJacket(avatar.jacketAsset ?? null, true).then(() => {
        avatar.version++;
      });
    }
    this.shells?.setVisible(true);
    if (avatar) this.shells?.select(this.shown?.size ?? 'M', avatar);
    this.engine?.setMirrorDisplay(this.mirrorWanted);
    this.source?.setPaused(false);
    this.styleParts();
    this.emitPhysics(false);
    this.setStatus({ message: '' });
  }

  /**
   * ZB hook: the opened (split) jacket mesh while the zip is open or the hood is off; null when the
   * measured shell is back. It joins the see-through parts (its geometry carries fitZone).
   */
  setInteractMesh(mesh: Mesh | null): void {
    this.interactMesh = mesh ?? undefined;
    this.styleParts();
  }
  private interactMesh?: Mesh;

  isPhysics(): boolean {
    return this.physics;
  }

  /** Called with true on enterPhysics and false on exitPhysics (also when a jacket change exits). */
  onPhysics(fn: (on: boolean) => void): () => void {
    this.physicsListeners.add(fn);
    return () => this.physicsListeners.delete(fn);
  }

  private emitPhysics(on: boolean) {
    for (const fn of this.physicsListeners) fn(on);
  }

  onStatus(fn: (s: FitLabStatus) => void): () => void {
    this.statusListeners.add(fn);
    fn(this.status);
    return () => this.statusListeners.delete(fn);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.physicsAbort?.abort();
    this.physicsListeners.clear();
    this.offBus?.();
    this.offState?.();
    this.source?.stop();
    this.scroll?.dispose();
    this.seeThrough?.dispose();
    this.annotations?.dispose();
    this.offCtSlice?.();
    for (const layer of this.ctLayers) layer.dispose();
    this.ctLayers = [];
    this.ct?.dispose();
    this.picker?.dispose();
    this.hint?.dispose();
    this.orbit?.dispose();
    this.trousers?.removeFromParent();
    this.trousers?.dispose();
    this.shells?.dispose();
    disposeProductLook();
    this.engine?.dispose();
    this.engine = undefined;
    this.root?.remove();
    this.root = undefined;
    this.statusListeners.clear();
  }

  // ---------------------------------------------------------------- loading

  private async load(): Promise<{ bodyId: string } | null> {
    const person = this.person;
    this.bodyBasis = person
      ? person.scan
        ? 'Your scanned body'
        : `Your body · ${person.height_cm} cm, ${person.weight_kg} kg`
      : `Reference body · ${REFERENCE_PERSON.height_cm} cm, ${REFERENCE_PERSON.weight_kg} kg (not you yet)`;
    this.ui.basis.textContent = this.bodyBasis;
    this.ui.basis.classList.toggle('fl-reference', !person);
    this.setStatus({ phase: 'loading', message: 'Building your body…', bodyBasis: this.bodyBasis });

    // Same requests as the kiosk warm-up (KioskApp.tsx): density and layer from the service.
    const [capabilities, options, products] = await Promise.all([
      api.capabilities(),
      api.garmentOptions(),
      api.products(),
    ]);
    const layer = options.layer_presets_cm[KIOSK_LAYER_PRESET];
    if (layer === undefined) throw new Error(`Missing under-layer preset ${KIOSK_LAYER_PRESET}`);
    const input = person ?? REFERENCE_PERSON;
    const { body } = await fitBody({
      height_cm: input.height_cm,
      weight_kg: input.weight_kg,
      sex: input.sex,
      shape_reference: KIOSK_SHAPE_REFERENCE,
      density_kg_m3: capabilities.default_density_kg_m3,
      known_measurements: {},
      ...(person?.scan ? { scan_measurements: person.scan } : {}),
    });
    if (this.disposed) return null;
    this.setStatus({ message: 'Fitting every size…' });
    const jackets = Object.keys(JACKET_STYLES) as JacketId[];
    await Promise.all(
      jackets.map(async (jacket) => {
        const product = products.find((p) => p.style === JACKET_STYLES[jacket]);
        if (!product) throw new Error(`Jacket ${jacket} is not in the catalogue.`);
        const fit = await api.garmentFit({
          body_id: body.body_id,
          product_id: product.product_id,
          layer_cm: layer,
          preference: KIOSK_PREFERENCE,
        });
        const verdict = buildVerdict(jacket, fit, { layerCm: layer, preference: KIOSK_PREFERENCE });
        this.fits.set(jacket, { product, fit, verdict });
      }),
    );
    if (this.disposed) return null;
    this.bodyId = body.body_id;
    this.refreshZones();
    this.setStatus({ message: 'Loading the 3D body…' });
    return { bodyId: body.body_id };
  }

  private async start3d(perception: Perception, { bodyId }: { bodyId: string }) {
    const bus = this.bus!;
    // The pose-driven mirror: LiveTryOnEngine with only its kiosk-look mirror attached.
    const engine = new LiveTryOnEngine({
      mirrorLook: 'kiosk',
      mirrorDisplay: this.mirrorWanted,
      warmBaker: false,
      dynamics: false,
      loadFit: async (o) =>
        [...this.fits.values()].find((f) => f.fit.fit_id === o.fitId)?.fit ?? null,
    });
    this.engine = engine;
    engine.attachMirrorView(this.canvasHost!);
    const view = engine.kioskView;
    if (!view) throw new Error('The Fit Lab 3D view could not start');
    view.viewer.setQuality(PANEL_QUALITY);
    view.viewer.setRenderScale(renderRatio('fast'), false);
    this.measureRender(view.viewer);
    view.frame('full');
    // OR: drag rotates (rotate only, damped, polar band); the wheel stays the reveal's (R), which
    // keeps the orbit direction. ZB's grabs stop the pointerdown before it reaches the controls.
    this.orbit = enableOrbit(view.viewer.controls, this.canvasHost!);
    view.viewer.idleTurntable = false;
    this.shells = new SizeShells(view.viewer);
    // Each new shell (first load, a jacket switch, a new body) is styled as soon as it exists,
    // so a new jacket is never left opaque in the see-through.
    this.shells.onBuilt = (shell) => {
      // LK: the product look (photo fabric, AR material, hood drape) on the shell's own material.
      void applyProductLook(shell.layer);
      this.shellBySize.set(shell.size, shell.layer);
      this.styleParts();
      this.sharpenTextures();
      this.clipTrousers();
    };
    this.offState = engine.onState((s) =>
      this.setStatus({ phase: s.phase, message: s.phase === 'tracking' ? '' : s.message }),
    );
    this.source = new PerceptionSource(
      perception,
      this.options.frameSize ?? (() => DEFAULT_FRAME_SIZE),
    );
    const state = bus.get();
    const current = this.fits.get(state.jacket);
    if (!current) throw new Error(`No fit for jacket ${state.jacket}`);
    this.shown = { jacket: state.jacket, size: state.size };
    this.offBus = bus.subscribe((next) => this.follow(next));
    this.startLoop();
    // Compile the jacket's look AND X-ray programs (the see-through film uses the X-ray passes)
    // before the engine dresses: its kiosk look gives up after 20 s and falls back to the light
    // stage, which a cold shader cache plus the see-through materials can exceed.
    const finish = current.product.visual?.finish.value;
    if (isGarmentFinish(finish)) {
      this.setStatus({ message: 'Preparing the jacket…' });
      await view.viewer.prewarm(finish, 'xray');
    }
    await engine.start(this.source, {
      bodyId,
      fitId: current.fit.fit_id,
      productId: current.product.product_id,
      size: state.size,
    });
    await this.startLook(view.viewer);
    this.afterBody();
  }

  /** R's see-through + scroll reveal and U's annotations (once the body exists). */
  private async startLook(viewer: Viewer) {
    const [createSeeThrough, createScrollReveal] = await Promise.all([
      optional(seeThroughModules, (m) => m.createSeeThrough),
      optional(scrollRevealModules, (m) => m.createScrollReveal),
    ]);
    if (this.disposed) return;
    if (createSeeThrough) this.seeThrough = createSeeThrough(viewer);
    if (createScrollReveal)
      this.scroll = createScrollReveal({
        element: this.canvasHost!,
        camera: viewer.camera,
        // The Viewer updates its OrbitControls every frame: the reveal must aim through them.
        controls: viewer.controls,
        framing: () => this.framing(),
        onReveal: (t) => this.onReveal(t),
        ctStage: new URLSearchParams(location.search).get('ct') !== '0',
        ctAim: () => this.ctAim(),
        onCtPhase: (p) => this.onCtPhase(p),
      });
    this.annotations = createAnnotationLayer();
    this.annotations.mount(this.stage!);
    if (new URLSearchParams(location.search).get('ct') !== '0') {
      this.startSlice(viewer);
      void this.startCtStage(viewer);
    }
    if (!createSeeThrough || !createScrollReveal)
      console.warn('[fitlab] see-through / scroll reveal not available yet (R): Look only');
  }

  /** CT slice: the cross-section of the meshes on screen (see-through only). */
  private startSlice(viewer: Viewer) {
    const view = this.engine?.kioskView;
    if (!view) return;
    const physicsMesh = () =>
      this.interactMesh?.visible ? this.interactMesh : viewer.garment.pickTarget?.mesh;
    this.ct = new SliceView(this.stage!, {
      scene: viewer.scene,
      camera: viewer.camera,
      canvas: view.canvas,
      reveal: () => this.reveal,
      selected: () => {
        if (this.physics) {
          const mesh = physicsMesh();
          const target = viewer.garment.pickTarget;
          // The solver's own shell: its welds close the zipped seam (ZB's opened split has none).
          const welds = target && mesh === target.mesh ? target.asset.welds : undefined;
          return mesh ? { mesh, solver: true, welds } : null;
        }
        const target = this.shells?.current()?.layer.pickTarget;
        return target ? { mesh: target.mesh, solver: false, welds: target.asset.welds } : null;
      },
      ghosts: () =>
        [...this.shellBySize.entries()].flatMap(([size, layer]) => {
          const target = layer.parent ? layer.pickTarget : undefined;
          return target ? [{ size, mesh: target.mesh, welds: target.asset.welds }] : [];
        }),
      size: () => this.shown?.size ?? 'M',
      body: () =>
        (viewer.body.children.find((c) => (c as { isMesh?: boolean }).isMesh) as Mesh) ?? null,
      states: () => this.states,
      anchorY: (zone) => {
        const mesh = this.physics ? physicsMesh() : undefined;
        const at = mesh
          ? this.meshAnchors.anchor(mesh, zone, new Vector3())
          : this.shells?.anchor(zone, new Vector3());
        return at ? at.y : null;
      },
      mirrored: () => !this.physics && (this.engine?.mirrorDisplay ?? false),
      redraw: () => viewer.controls.dispatchEvent({ type: 'change' }),
    });
  }

  /** CS: the CT stage layers (CL's caps, VX's scanner), whichever exist. */
  private async startCtStage(viewer: Viewer) {
    const [cap, scanner] = await Promise.all([
      optional(ctCapModules, (m) => m.createCtCap),
      optional(ctScannerModules, (m) => m.createCtScanner),
    ]).catch((e: unknown) => {
      console.warn('[fitlab] CT stage layers failed to load', e);
      return [undefined, undefined];
    });
    if (this.disposed) return;
    try {
      if (cap) this.ctCap = cap(viewer.scene);
      if (this.ctCap) this.ctLayers.push(this.ctCap);
    } catch (e) {
      console.warn('[fitlab] CT cap layer failed', e);
    }
    try {
      const pick = this.ctCap?.pick ? (this.ctCap as CtPickable) : undefined;
      // VX's 4th arg: hover glow / pulses redraw the draw-on-change panel at once.
      const redraw = () => viewer.controls.dispatchEvent({ type: 'change' });
      if (scanner) this.ctLayers.push(scanner(viewer.scene, this.stage!, pick, redraw));
    } catch (e) {
      console.warn('[fitlab] CT scanner layer failed', e);
    }
    this.offCtSlice = this.ct?.onSlice(() => {
      if (this.ctPhase > 0) this.updateCt(viewer);
    });
    if (this.ctPhase > 0) this.updateCt(viewer);
  }

  /** CS: CT phase from the wheel (called before the camera is placed). */
  private onCtPhase(p: number) {
    const was = this.ctPhase;
    this.ctPhase = p;
    // The camera may look down on the cut only in the CT stage; OR's band is back at phase 0.
    this.orbit?.relax(p > 0);
    const viewer = this.engine?.kioskView?.viewer;
    if (!viewer || (p === 0 && was === 0)) return;
    if (was === 0) this.ctStack = null; // a fresh stack on each entry into the stage
    this.still.touch(performance.now());
    this.updateCt(viewer);
  }

  /** CS: the CT camera aims between the body (close framing) and the stack's middle layer. */
  private ctAim(): { x: number; y: number; z: number } | null {
    const n = this.ctStack?.slices.length ?? 0;
    const mid = n ? this.ctCap?.layerCentre?.(Math.floor(n / 2), this.ctAimAt) : null;
    if (!mid) return null;
    return mid.add(this.framing().closeCenter).multiplyScalar(0.5);
  }

  /** CS: CT's layer stack (hem to collar), re-cut at most every CT_STACK_REFRESH_MS. */
  private refreshStack(force: boolean) {
    const now = performance.now();
    if (!force && now - this.ctStackAt < CT_STACK_REFRESH_MS) return;
    const ct = this.ct as (SliceView & { stack?(n: number): CtStack | null }) | undefined;
    if (!ct?.stack) return;
    this.ctStackAt = now;
    try {
      this.ctStack = ct.stack(CT_STACK_LAYERS);
    } catch (e) {
      console.warn('[fitlab] CT stack failed', e);
    }
  }

  /** CS: layers for the current phase and stack (no clipping in v2); asks for one redraw. */
  private updateCt(viewer: Viewer) {
    const p = this.ctPhase;
    if (p > 0) this.refreshStack(this.ctStack == null);
    this.ct?.setCtFade(p);
    const stack = this.ctStack;
    for (const layer of this.ctLayers) {
      try {
        layer.update(p, stack, viewer.camera);
      } catch (e) {
        console.warn('[fitlab] CT stage layer update failed', e);
      }
    }
    viewer.controls.dispatchEvent({ type: 'change' });
  }

  /** CT slice cost (ms per re-slice: last and mean), for checks. */
  sliceStats() {
    return this.ct ? { ...this.ct.stats } : null;
  }

  /** Body built or rebuilt: S/M/L shells, trousers, framing, styling. */
  private afterBody() {
    const avatar = this.engine?.posedScene;
    const shown = this.shown;
    const f = shown && this.fits.get(shown.jacket);
    if (!avatar || !shown || !f || !this.shells) return;
    // Idle display: until a person is tracked the avatar would stand in the rig's display A-pose
    // (27 deg arms); show the engine's own arms-down stand instead (the same pose its
    // nobody-tracked fallback eases to). Display only: verdicts come from the measured shell.
    if (!this.physics)
      avatar.applyPose(liveNeutral(avatar.live.rig.neutralPose), performance.now());
    const shells = this.shells;
    const garment = this.engine?.kioskView?.viewer.garment;
    // The S/M/L shells are built only once the engine's own jacket is on screen: by then the
    // kiosk look's shader programs are linked, so the three previews do not compete with the
    // engine's first draw (it falls back to the light stage if that takes over 20 s).
    void waitFor(() => !!garment?.pickTarget || this.disposed, 60_000)
      .then(() => shells.load(avatar, f.fit.fit_id, STUDIO_SIZES, this.shown?.size ?? shown.size))
      .then(() => this.styleParts())
      .catch((e: unknown) => this.fail(e));
    this.buildTrousers(avatar);
    this.clipTrousers();
    this.scroll?.set(this.reveal, false);
    this.onReveal(this.reveal);
    this.styleParts();
  }

  private buildTrousers(avatar: LiveAvatar) {
    if (this.trousersFor === avatar) return;
    this.trousers?.removeFromParent();
    this.trousers?.dispose();
    this.trousers = undefined;
    this.trousersFor = avatar;
    const view = this.engine?.kioskView;
    if (!view) return;
    try {
      const rig = avatar.live.rig;
      const neutral = skinVertices(
        rig,
        avatar.neutral.drivers,
        new Float32Array(rig.vertexCount * 3),
      );
      const joints = avatar.fkJoints(rig.neutralPose);
      this.trousers = createTrousersFromRest(neutral, rig.faces, trousersHeights(joints));
      const body = view.viewer.body;
      (body.parent ?? view.viewer.scene).add(this.trousers);
      this.trousers.position.copy(body.position);
      this.trousers.quaternion.copy(body.quaternion);
      this.trousers.scale.copy(body.scale);
      this.bodyVersion = -1;
    } catch (e) {
      console.warn('[fitlab] trousers unavailable', e);
    }
  }

  /** Hands every part to the see-through controller (shells, body, trousers). */
  private styleParts() {
    const view = this.engine?.kioskView;
    if (!view || !this.seeThrough) return;
    this.seeThrough.setParts({
      shells: this.physics
        ? [view.viewer.garment, ...(this.interactMesh ? [this.interactMesh] : [])]
        : (this.shells?.layers() ?? []),
      body: [view.viewer.body],
      trousers: this.trousers ? [this.trousers] : undefined,
    });
    this.seeThrough.setReveal(this.reveal);
    this.pushTight();
  }

  /** Framing for the reveal: full body (Look) to a close view of the chest and collar. */
  private framing() {
    const avatar = this.engine?.posedScene;
    const camera = this.engine?.kioskView?.viewer.camera;
    let top = 1.75;
    if (avatar) {
      const p = avatar.bodyArrays().positions;
      top = 0;
      for (let i = 1; i < p.length; i += 3) top = Math.max(top, p[i]);
    }
    const half = Math.tan((((camera?.fov ?? 35) / 2) * Math.PI) / 180);
    const aspect = Math.min(1, camera?.aspect ?? 0.7);
    // Full body with a 6 % margin, limited by the panel's width when it is narrower than tall.
    const fullBodyDistance = (top * 1.06) / 2 / half / Math.max(aspect, 0.55);
    return {
      fullBodyCenter: new Vector3(0, top * 0.5, 0),
      fullBodyDistance,
      closeCenter: new Vector3(0, top * 0.74, 0),
      closeDistance: (top * 0.4) / half,
    };
  }

  /** Follows the bus: size = instant switch; jacket = load that jacket's S/M/L; zip = collar. */
  private follow(next: GarmentState) {
    const prevTop = this.zip <= ZIP_TOP_MAX;
    this.zip = next.zip;
    const sizeChanged = !!this.shown && next.size !== this.shown.size;
    const jacketChanged = !!this.shown && next.jacket !== this.shown.jacket;
    if (this.shown && sizeChanged && !jacketChanged) {
      this.shown = { ...this.shown, size: next.size };
      if (!this.physics) this.shells?.select(next.size, this.engine?.posedScene);
      this.clipTrousers();
      this.picker?.setSelected(next.size);
    }
    if (prevTop !== next.zip <= ZIP_TOP_MAX || sizeChanged || jacketChanged)
      this.refreshZones(next);
    if (!prevTop && next.zip <= ZIP_TOP_MAX) this.pulseStart = performance.now();
    if (!jacketChanged && !(sizeChanged && this.physics)) return;
    this.queue = this.queue.then(async () => {
      if (!this.engine || this.disposed || !this.shown) return;
      if (this.physics) this.exitPhysics();
      this.shown = { jacket: next.jacket, size: next.size };
      const avatar = this.engine.posedScene;
      const f = this.fits.get(next.jacket);
      if (avatar && f && this.shells) {
        this.picker?.setSelected(next.size);
        await this.shells.load(avatar, f.fit.fit_id, STUDIO_SIZES, next.size);
        this.styleParts();
      }
    });
  }

  // ---------------------------------------------------------------- per frame

  private startLoop() {
    const anchor = new Vector3();
    const mirrorRight = new Vector3();
    const mirrorRel = new Vector3();
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      const view = this.engine?.kioskView;
      const avatar = this.engine?.posedScene;
      if (!view) return;
      // The engine's own single-size jacket is used only for physics; the S/M/L shells show live.
      view.viewer.garment.visible = this.physics || !this.shells?.ready;
      if (avatar && !this.physics) this.shells?.update(avatar);
      this.syncTrousers(view.viewer);
      this.adaptQuality(view.viewer);
      const sincePulse = performance.now() - this.pulseStart;
      if (sincePulse >= 0 && sincePulse < COLLAR_PULSE_MS + 100) this.pushTight();
      const now = performance.now();
      this.ct?.tick(now);
      if (!this.annotations || now - this.lastAnn < 50) return;
      this.lastAnn = now;
      // CS: the on-image notes point at parts the CT stage clips away: fade them out.
      const visible = annotationVisibility(this.reveal) * Math.max(0, 1 - this.ctPhase / 0.3);
      const items: Annotation[] = [];
      // In physics the notes anchor on the solver's shell, or ZB's opened jacket while it shows.
      const physicsMesh = this.physics
        ? this.interactMesh?.visible
          ? this.interactMesh
          : view.viewer.garment.pickTarget?.mesh
        : undefined;
      if (visible > 0.01) {
        const mirrored = this.engine?.mirrorDisplay ?? false;
        for (const s of rankNotes(this.states)) {
          if (items.length >= 5) break;
          const show = s.tone !== 'none' || (s.zone === 'collar' && s.severity === -0.5);
          if (!show) continue;
          const at = physicsMesh
            ? this.meshAnchors.anchor(physicsMesh, s.zone, anchor)
            : this.shells?.anchor(s.zone, anchor);
          if (!at) continue;
          // A CSS-mirrored canvas flips the image about the camera's vertical plane: reflect the
          // anchor through that plane (the camera can orbit, so not simply x -> -x).
          const point = at.clone();
          if (mirrored && !this.physics) {
            const cam = view.viewer.camera;
            const right = mirrorRight.set(1, 0, 0).applyQuaternion(cam.quaternion);
            const side = mirrorRel.subVectors(point, cam.position).dot(right);
            point.addScaledVector(right, -2 * side);
          }
          const [title, detail] = splitCallout(s);
          items.push({
            id: s.zone,
            anchor: point,
            title,
            detail,
            tone: s.tone === 'none' ? 'info' : s.tone,
          });
        }
      }
      const canvas = view.canvas;
      this.annotations.update(
        view.viewer.camera,
        { width: canvas.clientWidth, height: canvas.clientHeight },
        items,
        visible,
      );
    };
    this.raf = requestAnimationFrame(tick);
  }

  /**
   * Trousers end just inside the shown jacket's hem (display only): under a long parka their
   * fabric ease would poke through the shell around the hips. Faces whose rest points all lie
   * below TROUSER_TUCK_M above the hem stay; the rest is hidden (covered by the jacket anyway).
   */
  private clipTrousers() {
    const trousers = this.trousers;
    const hem = this.shells?.hemY();
    if (!trousers || hem == null) return;
    const maxY = hem + TROUSER_TUCK_M;
    const { indices, restPositions } = trousers.data;
    const keep: number[] = [];
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t],
        b = indices[t + 1],
        c = indices[t + 2];
      if (
        restPositions[a * 3 + 1] <= maxY &&
        restPositions[b * 3 + 1] <= maxY &&
        restPositions[c * 3 + 1] <= maxY
      )
        keep.push(a, b, c);
    }
    trousers.geometry.setIndex(keep);
  }

  // ---------------------------------------------------------------- sharpness

  private still = new StillDetector();
  private sharpMode: 'fast' | 'full' = 'fast';
  private sharpAo = false;
  private renderMs = 0;

  /** Fast ratio while the camera moves; full ratio (+ AO in the Look) once still for 300 ms. */
  private adaptQuality(viewer: Viewer) {
    const now = performance.now();
    const mode = this.still.update(viewer.camera.position, viewer.camera.quaternion, now);
    const ao = mode === 'full' && !this.physics && this.reveal <= SHARP.aoMaxReveal;
    if (mode === this.sharpMode && ao === this.sharpAo) return;
    this.sharpMode = mode;
    this.sharpAo = ao;
    viewer.setRenderScale(renderRatio(mode), ao);
    // KioskMirrorView draws on change: one redraw at the new quality even if nothing moves.
    viewer.controls.dispatchEvent({ type: 'change' });
  }

  /** Max anisotropic filtering on every jacket texture (shells, physics shell, their decals). */
  private sharpenTextures() {
    const viewer = this.engine?.kioskView?.viewer;
    if (!viewer) return;
    const layers = [viewer.garment, ...(this.shells?.layers() ?? [])];
    const decals = layers
      .map(
        (l) =>
          (l as unknown as { decalUniforms?: Record<string, { value?: unknown }> }).decalUniforms,
      )
      .filter((u): u is Record<string, { value?: unknown }> => !!u);
    maxAnisotropy(layers, viewer.renderer.capabilities.getMaxAnisotropy(), decals);
  }

  /** CPU time of the panel's composer draw (exponential mean), for renderStats(). */
  private measureRender(viewer: Viewer) {
    const composer = viewer.composer;
    const draw = composer.render.bind(composer);
    composer.render = (delta?: number) => {
      const t0 = performance.now();
      draw(delta);
      this.renderMs = this.renderMs * 0.9 + (performance.now() - t0) * 0.1;
    };
  }

  /** Panel render diagnostics: pixel ratio, AO, draws per second, CPU ms per draw. */
  renderStats() {
    const view = this.engine?.kioskView;
    return {
      pixelRatio: view?.viewer.renderer.getPixelRatio() ?? null,
      mode: this.sharpMode,
      ao: this.sharpAo,
      drawFps: view?.drawFps ?? 0,
      renderMs: Math.round(this.renderMs * 100) / 100,
    };
  }

  private syncTrousers(viewer: Viewer) {
    const trousers = this.trousers;
    if (!trousers) return;
    const mesh = viewer.body.children.find((c) => (c as { isMesh?: boolean }).isMesh) as
      | Parameters<Trousers['syncFromBody']>[0]
      | undefined;
    if (!mesh) return;
    const version = this.engine?.posedScene?.bodyVersion ?? 0;
    if (mesh === this.bodyMesh && version === this.bodyVersion && !this.physics) return;
    if (trousers.syncFromBody(mesh)) {
      this.bodyMesh = mesh;
      this.bodyVersion = version;
    }
  }

  // ---------------------------------------------------------------- selected-size verdict

  /** The engine's zone states for the jacket and size on the bus (collar coupled to the zip). */
  private refreshZones(state: GarmentState | undefined = this.bus?.get()) {
    if (!state) return;
    const f = this.fits.get(state.jacket);
    const size = f?.fit.sizes[state.size];
    if (!f || !size) return;
    this.states = zoneStates(size, f.product, state.size, state.zip <= ZIP_TOP_MAX);
    const v = selectedVerdict(f.verdict.sizes[state.size].label, this.states);
    this.picker?.setVerdict({ word: v.word, tone: v.tone, line: v.line });
    this.pushTight();
  }

  private pushTight(now = performance.now()) {
    // The zip reaching the top pulses the collar for COLLAR_PULSE_MS (display only).
    const t = now - this.pulseStart;
    const pulse =
      t >= 0 && t < COLLAR_PULSE_MS ? Math.abs(Math.sin((t / COLLAR_PULSE_MS) * 3 * Math.PI)) : 0;
    const zones: TightZone[] = this.states
      .filter((s) => s.tone === 'tight' || s.tone === 'snug')
      .map((s) => {
        const severity = tightSeverity(s);
        return {
          zone: ZONE_ID[s.zone],
          severity: s.zone === 'collar' ? Math.min(1, severity + (1 - severity) * pulse) : severity,
        };
      });
    this.seeThrough?.setTightZones(zones);
  }

  // ---------------------------------------------------------------- DOM

  private buildDom(host: HTMLElement) {
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = '') => {
      const e = document.createElement(tag);
      e.className = cls;
      if (text) e.textContent = text;
      return e;
    };
    const root = el('div', 'fl-root');
    const head = el('div', 'fl-head');
    head.append(el('span', 'fl-title', 'Fit Lab'));
    this.ui.basis = el('span', 'fl-basis');
    head.append(this.ui.basis, this.personControl());
    const stage = el('div', 'fl-stage');
    const canvasHost = el('div', 'fl-canvas-host');
    this.ui.status = el('div', 'fl-status');
    stage.append(canvasHost, this.ui.status);
    this.ui.picker = el('div', 'fl-picker-host');
    root.append(head, stage, this.ui.picker);
    host.append(root);
    this.root = root;
    this.stage = stage;
    this.canvasHost = canvasHost;
    this.hint = mountScrollHint(stage);
    const state = this.bus!.get();
    this.picker = createSizePicker();
    this.picker.mount(this.ui.picker, {
      sizes: STUDIO_SIZES,
      selected: state.size,
      onSelect: (size) => this.bus?.set({ size }, 'ui'),
    });
  }

  /** Compact 'Your body' form: height, weight, sex (kiosk ranges); Apply / Reference body. */
  private personControl(): HTMLElement {
    const box = document.createElement('details');
    box.className = 'fl-person';
    const p = this.person;
    box.innerHTML =
      '<summary>Your body</summary>' +
      '<form class="fl-person-form">' +
      `<label>Height <input name="h" inputmode="decimal" size="4" value="${p?.height_cm ?? ''}"> cm</label>` +
      `<label>Weight <input name="w" inputmode="decimal" size="4" value="${p?.weight_kg ?? ''}"> kg</label>` +
      '<select name="s"><option value="">Body shape…</option><option value="female">Female</option><option value="male">Male</option></select>' +
      '<button type="submit">Apply</button><button type="button" name="ref">Reference body</button>' +
      '<div class="fl-person-error"></div>' +
      '<div class="fl-person-note">Kept on this computer only; sent only to the local body service.</div>' +
      '</form>';
    const form = box.querySelector('form')!;
    const sex = form.elements.namedItem('s') as HTMLSelectElement;
    if (p) sex.value = p.sex;
    const error = form.querySelector<HTMLElement>('.fl-person-error')!;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const h = (form.elements.namedItem('h') as HTMLInputElement).value;
      const w = (form.elements.namedItem('w') as HTMLInputElement).value;
      const r = parsePerson(h, w, sex.value);
      if (!r.ok) {
        error.textContent = r.error;
        return;
      }
      error.textContent = '';
      box.open = false;
      void this.setPerson(r.person);
    });
    form.querySelector<HTMLButtonElement>('button[name="ref"]')!.addEventListener('click', () => {
      error.textContent = '';
      box.open = false;
      void this.setPerson(null);
    });
    return box;
  }

  private setStatus(patch: Partial<FitLabStatus>) {
    this.status = {
      ...this.status,
      ...patch,
      bodyBasis: this.bodyBasis,
      poseHz: this.source?.rateHz ?? 0,
    };
    if (this.ui.status) {
      this.ui.status.textContent = this.status.message;
      this.ui.status.classList.toggle('fl-error', this.status.phase === 'error');
    }
    for (const fn of this.statusListeners) fn(this.status);
  }

  /** The body id the panel shows (diagnostics). */
  get body() {
    return this.bodyId;
  }
}

/** Resolves when ready() is true (checked every animation frame) or after ms milliseconds. */
function waitFor(ready: () => boolean, ms: number): Promise<void> {
  const until = performance.now() + ms;
  return new Promise((resolve) => {
    const tick = () =>
      ready() || performance.now() > until ? resolve() : requestAnimationFrame(tick);
    tick();
  });
}

/** "Collar tight zipped: 35.0 vs neck ~36.5 cm (−1.5 cm)" → title / detail. */
function splitCallout(s: ZoneState): [string, string] {
  const text = s.callout || s.note;
  const at = text.indexOf(': ');
  return at > 0 ? [text.slice(0, at), text.slice(at + 2)] : [text, ''];
}
