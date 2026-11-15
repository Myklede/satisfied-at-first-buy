// Main-thread side of the interactive zip and detachable hood (agent Z). Plain DOM + Three.js.
//
// Input: mouse/touch (pointer events on the viewer) and the webcam pinch (HandPullController
// forwards a pinch that starts on the zip pull, the hood, or an opened front). Output: slider
// and grab messages to the cloth worker's split solver (InteractDriver), the split mesh drawn
// with the garment's own material, and the zip hardware.
//
// The measured shell is never edited: while nothing is open, the jacket on screen is the
// GarmentLayer's own mesh and solver. The split mesh replaces it only while the zip is open or
// the hood is off. Once everything is closed again and the split cloth has come to rest, the
// view cross-fades back to the measured shell (INTERACT.restoreBlendS, a visual blend between
// two simulated states, not physics) and the split solver stops.
import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Plane,
  Quaternion,
  Raycaster,
  Vector2,
  Vector3,
  type Material,
  type Object3D,
  type PerspectiveCamera,
} from 'three';
import type { GarmentLayer } from '../GarmentLayer';
import type { ClothAsset } from '../cloth/ClothSolver';
import type { InteractMessage, InteractReady } from '../cloth/ClothClient';
import { smoothNormals } from '../cloth/normals';
import { HAND_PULL } from '../hand/config';
import {
  ndcToPixels,
  percentile,
  selectPatch,
  vertexAdjacency,
  type Adjacency,
  type Ndc,
} from '../hand/mapping';
import { HOOD_DEFAULT, INTERACT, type HoodDefault } from './config';
import { EdgeWall, TeethStrip, velcroTab, zipPull, type ZipLook } from './hardware';
import type { GrabKind, InteractFrame } from './InteractDriver';
import type { HoodState } from './zipMath';
import {
  approach,
  clampSlider,
  hoodFreeWeight,
  hoodFrontier,
  sliderFromCursor,
  snapSlider,
} from './zipMath';
import { PANEL } from './seam';

export interface InteractHost {
  garment: GarmentLayer;
  camera: PerspectiveCamera;
  /** Element holding the viewer canvas (pointer events, cursor style). */
  container: HTMLElement;
}

export type HandleKind = 'pull' | 'hood' | 'fabric';

/**
 * Agent H's padded hood (engine/hood/HoodLayer), when GarmentLayer draws it instead of the
 * shell's thin hood panel. Structural, so this file builds whether or not it has landed.
 */
interface PaddedHood {
  visible: boolean;
  mesh: Mesh;
  setState(state: 'down' | 'detached', t: number): void;
  setRigidTransform(matrix: Matrix4 | null): void;
  /** H: the rigid pose standing the free bowl on its zip edge at `target`, opening up. */
  restingTransform?(target: Vector3, facing?: Vector3): Matrix4;
}

/** Rigid-pose blend: positions lerped, rotations slerped (scale kept from `a`). */
function blendPose(a: Matrix4, b: Matrix4, t: number) {
  const pa = new Vector3(),
    pb = new Vector3(),
    qa = new Quaternion(),
    qb = new Quaternion(),
    sa = new Vector3(),
    sb = new Vector3();
  a.decompose(pa, qa, sa);
  b.decompose(pb, qb, sb);
  return new Matrix4().compose(pa.lerp(pb, t), qa.slerp(qb, t), sa.lerp(sb, t));
}
export type InputSource = 'mouse' | 'pinch';

export interface InteractUiState {
  /** The split solver is prepared (handles can be grabbed). */
  ready: boolean;
  hasHood: boolean;
  /** Fraction of the zip open from the top (0 closed, 1 open through the hem). */
  zipOpen: number;
  hood: HoodState | null;
  hooked: boolean;
  /** The jacket on screen is the opened (split) one: fit numbers do not apply. */
  open: boolean;
  hover: HandleKind | null;
  dragging: HandleKind | null;
  /** Why the zip/hood is unavailable on this jacket (the hand pull still works), else null. */
  error: string | null;
  /** The camera shows the back three-quarter (hood) view. */
  hoodView: boolean;
  /** Fraction of the hood's zip open (0 on, 1 off). */
  hoodProgress: number;
}

export interface InteractStats {
  fpsP50: number;
  fpsP5: number;
  frames: number;
  /** Input (pointer event / camera frame) → first render frame drawing the cloth it moved (ms). */
  latencyP50: number;
  latencyP95: number;
  latencySamples: number;
  stepP50: number;
  stepP95: number;
  deliveredHz: number;
  grabs: Record<string, number>;
  maxGapM: number;
  restores: number;
  particles: number;
}

interface Drag {
  kind: HandleKind;
  source: InputSource;
  hand?: string;
  point: Vector3;
  plane: Plane;
  toCamera: Vector3;
  /** Pull: slider arc at grab start. */
  slider: number;
  /**
   * Bringing a detached hood back: the screen points (px) of the grab and of the collar's zip
   * track, and the hood's offset at grab start (m). The drag is read as how far the hand went
   * from the grab point toward the collar on screen, and the hood moves that fraction of its
   * offset home. A screen drag cannot undo the depth part of the offset (the hood rests beside
   * the hip, nearer or farther than the collar); this mapping can.
   */
  back?: { from: { x: number; y: number }; to: { x: number; y: number }; offset: number[] };
}

const SAMPLE_LIMIT = 2000;
/** Drag.hand of a programmatic hood hold (holdHood); webcam pinches use 'left' / 'right'. */
const HOLD_HAND = 'studio-bridge';
function push(list: number[], value: number) {
  list.push(value);
  if (list.length > SAMPLE_LIMIT) list.shift();
}

export class InteractController {
  onUi?: (state: InteractUiState) => void;
  onError?: (message: string) => void;
  /** Any mouse/touch input on the viewer (keeps the Feel screen's no-hand timer awake). */
  onActivity?: () => void;
  readonly hasHood: boolean;
  readonly look: ZipLook;
  private asset: ClothAsset;
  private original: Mesh<BufferGeometry, Material>;
  private topo?: InteractReady;
  private preparing?: Promise<InteractReady>;
  private split?: Mesh<BufferGeometry, Material>;
  private splitAdjacency?: Adjacency;
  private active = false;
  private restoring?: { from: Float32Array; started: number };
  private last?: InteractFrame;
  /** Slider shown (m): predicted at render rate while dragging, else the solver's. */
  private slider = 0;
  private sliderTarget = 0;
  private drag?: Drag;
  private hover: HandleKind | null = null;
  private hoverAt?: Ndc;
  private hoverDirty = false;
  private readonly raycaster = new Raycaster();
  private readonly pull: ReturnType<typeof zipPull>;
  /**
   * Hover/grab glow round the zip pull: a DOM ring over the canvas (a 3D sprite was drawn into
   * the ambient-occlusion pass as an opaque quad: a grey square at the collar).
   */
  private readonly glow: HTMLDivElement;
  private glowOpacity = 0;
  private glowAt = new Vector3();
  private readonly teeth: TeethStrip[] = [];
  /** Padded depth of the two open front edges (EdgeWall). */
  private readonly walls: EdgeWall[] = [];
  private readonly hoodTeeth: TeethStrip[] = [];
  private readonly tabs: Mesh[] = [];
  private hidden: Object3D[] = [];
  private raf = 0;
  private lastRaf = 0;
  private disposed = false;
  private lastUi = '';
  private pendingLatency: number[] = [];
  private placket?: { ids: Int32Array; base: Float32Array; pair: Int32Array };
  private samples = {
    frameMs: [] as number[],
    latency: [] as number[],
    step: [] as number[],
    interval: [] as number[],
  };
  private counters = { grabs: {} as Record<string, number>, maxGap: 0, restores: 0, particles: 0 };
  private cameraTween = 0;
  private hoodView = false;
  private failure?: string;

  constructor(private host: InteractHost) {
    const target = host.garment.pickTarget;
    if (!target) throw new Error('No garment on screen');
    this.asset = target.asset;
    this.original = target.mesh;
    const d = this.asset.render_details ?? {};
    // hood_kind 2 = removable (product data); 1 = sewn in, no interaction.
    this.hasHood = d.hood_kind === 2;
    this.look = d.front_kind === 2 ? 'metal-silver' : 'coil-black';
    this.pull = zipPull(this.look);
    this.glow = document.createElement('div');
    Object.assign(this.glow.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '56px',
      height: '56px',
      marginLeft: '-28px',
      marginTop: '-28px',
      borderRadius: '50%',
      background:
        'radial-gradient(circle, rgba(255,255,255,0.9) 0%, rgba(120,220,255,0.55) 35%, rgba(120,220,255,0) 70%)',
      mixBlendMode: 'screen',
      pointerEvents: 'none',
      zIndex: '4',
      opacity: '0',
      willChange: 'transform, opacity',
    } satisfies Partial<CSSStyleDeclaration>);
    host.container.append(this.glow);
    host.garment.add(this.pull.group);
    // The shell's own top puller (garmentDetails) is replaced by the interactive one.
    this.hideShellPuller();
    host.container.addEventListener('pointerdown', this.onPointerDown, { capture: true });
    host.container.addEventListener('pointermove', this.onPointerMove, { capture: true });
    host.container.addEventListener('pointerup', this.onPointerUp, { capture: true });
    host.container.addEventListener('pointercancel', this.onPointerUp, { capture: true });
    host.container.addEventListener('pointerleave', this.onPointerLeave);
    host.garment.cloth.onInteract = (message) => this.onFrame(message);
    this.raf = requestAnimationFrame(this.animate);
  }

  /** Builds the split solver in the worker (call once the cloth is live). */
  prepare() {
    this.preparing ??= this.host.garment.cloth.interactStart(this.hasHood).then((topo) => {
      if (this.disposed) return topo;
      this.topo = topo;
      // Open front edges: the parka's edge is its black zip tape (shader: tape at 0.34 loft),
      // the puffer's its own shell fabric.
      for (let s = 0; s < 2; s++) {
        const wall = new EdgeWall(
          topo.zip.a.length,
          this.look === 'coil-black' ? 0x111214 : this.asset.colour,
        );
        this.walls.push(wall);
        this.host.garment.add(wall.mesh);
      }
      if (this.look === 'metal-silver') {
        // CF zip teeth on both open edges; the hood's zip track on the collar and on the hood.
        for (let s = 0; s < 2; s++) this.teeth.push(new TeethStrip(topo.zip.a.length, 0x9da1a6));
        for (const t of this.teeth) this.host.garment.add(t.mesh);
        if (topo.hood)
          for (let s = 0; s < 2; s++) {
            const strip = new TeethStrip(topo.hood.a.length, 0x9da1a6);
            this.hoodTeeth.push(strip);
            this.host.garment.add(strip.mesh);
          }
        if (topo.hood)
          for (let s = 0; s < 2; s++) {
            const tab = velcroTab();
            this.tabs.push(tab);
            this.host.garment.add(tab);
          }
      }
      this.applyHoodDefault(HOOD_DEFAULT);
      this.emitUi();
      return topo;
    });
    this.preparing.catch((error: unknown) => {
      this.failure = error instanceof Error ? error.message : String(error);
      this.onError?.(this.failure);
      this.emitUi();
    });
    return this.preparing;
  }

  get isOpen() {
    return this.active;
  }

  get isDragging() {
    return !!this.drag;
  }

  /** H's padded hood when it is drawn (else the shell's own hood panel is the hood). */
  private paddedHood(): PaddedHood | undefined {
    const hood = (this.host.garment as unknown as { hood?: PaddedHood }).hood;
    return hood?.visible && hood.mesh && typeof hood.setRigidTransform === 'function'
      ? hood
      : undefined;
  }

  /** Is a pinch/pointer at `vp` over something this controller handles? */
  hit(vp: Ndc): { kind: HandleKind; point: Vector3; face?: number[] } | undefined {
    if (!this.topo || this.restoring) return undefined;
    const { clientWidth: w, clientHeight: h } = this.host.container;
    // Zip pull: screen distance to its slider (generous radius: it is small).
    const at = this.pullWorld(new Vector3());
    if (at) {
      const s = at.clone().project(this.host.camera),
        dx = ((s.x - vp.x) * w) / 2,
        dy = ((s.y - vp.y) * h) / 2;
      if (s.z < 1 && Math.hypot(dx, dy) <= INTERACT.pullPickPx) return { kind: 'pull', point: at };
    }
    const mesh = this.shownMesh();
    mesh.updateMatrixWorld();
    this.raycaster.setFromCamera(new Vector2(vp.x, vp.y), this.host.camera);
    const padded = this.hasHood ? this.paddedHood() : undefined;
    if (padded) {
      padded.mesh.updateMatrixWorld();
      // H moves the hood's vertices on the CPU; the raycast's early-out uses the bounding
      // sphere, which would still be the hood's place on the collar.
      padded.mesh.geometry.computeBoundingSphere();
      // The raycast also tests the bounding box when one exists (three r15x+).
      if (padded.mesh.geometry.boundingBox) padded.mesh.geometry.computeBoundingBox();
      // Pick both faces: a hood set down opening-up shows its lining (back faces) to the camera.
      this.hoodProxy.geometry = padded.mesh.geometry;
      this.hoodProxy.matrixWorld.copy(padded.mesh.matrixWorld);
      const h = this.raycaster.intersectObject(this.hoodProxy, false)[0],
        shell = this.raycaster.intersectObject(mesh, false)[0];
      if (h && (!shell || h.distance <= shell.distance)) {
        const any = this.topo.panels.indexOf(PANEL.hood);
        return { kind: 'hood', point: h.point.clone(), face: [any, any, any] };
      }
    }
    const hit = this.raycaster.intersectObject(mesh, false)[0];
    if (!hit?.face) return undefined;
    const face = [hit.face.a, hit.face.b, hit.face.c],
      panels = this.active && this.topo ? this.topo.panels : this.asset.panels;
    if (this.hasHood && face.some((i) => panels[i] === PANEL.hood))
      return { kind: 'hood', point: hit.point.clone(), face };
    if (this.active) return { kind: 'fabric', point: hit.point.clone(), face };
    return undefined;
  }

  /** Starts a drag if `vp` is on a handle. Returns false when nothing was grabbed. */
  begin(vp: Ndc, source: InputSource, frameTime: number, hand?: string): boolean {
    if (this.disposed || this.drag) return false;
    const hit = this.hit(vp);
    if (!hit || !this.topo) return false;
    const cloth = this.host.garment.cloth,
      toCamera = this.host.camera.position.clone().sub(hit.point).normalize(),
      // The hit face is in the numbering of the mesh it was found on (shell before activation).
      onSplit = this.active && !!this.split;
    this.ensureActive();
    this.drag = {
      kind: hit.kind,
      source,
      hand,
      point: hit.point,
      plane: new Plane().setFromNormalAndCoplanarPoint(toCamera, hit.point),
      toCamera,
      slider: this.slider,
    };
    this.backFraction = 0;
    const hoodNow = this.last?.hood;
    if (hit.kind === 'hood' && (hoodNow === 'detached' || hoodNow === 'attaching')) {
      const edges = this.hoodEdges(),
        { clientWidth: w, clientHeight: h } = this.host.container;
      if (edges)
        this.drag.back = {
          from: ndcToPixels(vp, w, h),
          to: ndcToPixels(edges.collar, w, h),
          offset: [...(this.last?.hoodHand ?? [0, 0, 0])],
        };
    }
    this.counters.grabs[`${hit.kind}:${source}`] =
      (this.counters.grabs[`${hit.kind}:${source}`] ?? 0) + 1;
    if (hit.kind !== 'pull') {
      const positions = this.splitPositions();
      this.splitAdjacency ??= vertexAdjacency(this.topo.triangles, this.topo.source.length);
      // Seeds in split numbering: the face's vertices as the split mesh draws them.
      const seeds = onSplit ? hit.face! : hit.face!.map((i) => this.toSplit(i, hit.kind));
      const patch = selectPatch(
        positions,
        this.splitAdjacency,
        seeds,
        [hit.point.x, hit.point.y, hit.point.z],
        INTERACT.hoodPatchM,
      );
      const kind: GrabKind = hit.kind === 'hood' ? 'hood' : 'fabric';
      const keep = patch.ids
        .map((id, j) => [id, patch.weights[j]] as const)
        .filter(([id]) => (kind === 'hood') === (this.topo!.panels[id] === PANEL.hood));
      cloth.interactGrab(
        kind,
        keep.map(([id]) => id),
        keep.map(([, w]) => w),
        frameTime,
      );
    }
    this.emitUi();
    return true;
  }

  /** Moves the drag to `vp` (+ hand depth for a pinch, as the hand pull maps it). */
  move(vp: Ndc, frameTime: number, depthDelta = 0) {
    const drag = this.drag;
    if (!drag || !this.topo) return;
    const cloth = this.host.garment.cloth;
    if (drag.kind === 'pull') {
      const { clientWidth: w, clientHeight: h } = this.host.container,
        track = this.trackScreen(w, h),
        cursor = ndcToPixels(vp, w, h);
      const arc = sliderFromCursor(
        track,
        this.topo.zip.arc,
        cursor,
        this.sliderTarget,
        INTERACT.sliderWindowM,
      );
      this.sliderTarget = clampSlider(arc, this.topo.zip.length);
      cloth.interactSlider(this.sliderTarget, frameTime);
      return;
    }
    if (drag.back) {
      const { clientWidth: w, clientHeight: h } = this.host.container,
        c = ndcToPixels(vp, w, h),
        b = drag.back,
        ax = b.to.x - b.from.x,
        ay = b.to.y - b.from.y,
        len2 = ax * ax + ay * ay,
        s =
          len2 > 1
            ? Math.max(0, Math.min(1, ((c.x - b.from.x) * ax + (c.y - b.from.y) * ay) / len2))
            : 0;
      this.backFraction = s;
      cloth.interactMove(
        b.offset.map((o) => -o * s),
        frameTime,
      );
      return;
    }
    this.raycaster.setFromCamera(new Vector2(vp.x, vp.y), this.host.camera);
    const onPlane = this.raycaster.ray.intersectPlane(drag.plane, new Vector3());
    if (!onPlane) return;
    const depth = Math.max(
      -HAND_PULL.depthMaxM,
      Math.min(HAND_PULL.depthMaxM, depthDelta * HAND_PULL.depthScale),
    );
    const d = onPlane.sub(drag.point).addScaledVector(drag.toCamera, depth);
    cloth.interactMove([d.x, d.y, d.z], frameTime);
  }

  end(frameTime: number) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = undefined;
    if (drag.kind !== 'pull') this.host.garment.cloth.interactRelease(frameTime);
    else if (this.topo) {
      // Let go within the last few cm of either stop: the slider runs to the stop (UX; a hand
      // rarely lands exactly on the collar top, and only a fully closed zip is the measured shell).
      const length = this.topo.zip.length,
        snapped = snapSlider(this.sliderTarget, length);
      if (snapped !== this.sliderTarget) {
        this.sliderTarget = snapped;
        this.host.garment.cloth.interactSlider(snapped, frameTime);
      }
    }
    this.host.container.style.cursor = '';
    this.emitUi();
  }

  // ---- Studio bridge hooks (agent ZB, 2026-11-15; additive, unused by the kiosk) ----
  // The Studio maps a pinch on the person's OWN body (camera image, pose landmarks) to the hood,
  // so it holds the hood by its zip edge without a screen hit and moves it in metres.

  /** The hood's zip-edge offset from the collar now (m, scene frame; [0,0,0] = on). */
  hoodHandOffset(): number[] {
    return [...(this.last?.hoodHand ?? [0, 0, 0])];
  }

  /** Holds the hood by its zip edge (as a pinch on the hood would). False when not possible. */
  holdHood(frameTime = performance.now()): boolean {
    if (this.disposed || this.drag || !this.hasHood || !this.topo?.hood || this.failure)
      return false;
    this.ensureActive();
    const panels = this.topo.panels,
      ids: number[] = [];
    for (let i = 0; i < panels.length && ids.length < 64; i++)
      if (panels[i] === PANEL.hood) ids.push(i);
    if (!ids.length) return false;
    const at = new Vector3();
    this.drag = {
      kind: 'hood',
      source: 'pinch',
      hand: HOLD_HAND,
      point: at,
      plane: new Plane(new Vector3(0, 0, 1), 0),
      toCamera: new Vector3(0, 0, 1),
      slider: this.slider,
    };
    this.backFraction = 0;
    this.counters.grabs['hood:bridge'] = (this.counters.grabs['hood:bridge'] ?? 0) + 1;
    this.host.garment.cloth.interactGrab(
      'hood',
      ids,
      ids.map(() => 1),
      frameTime,
    );
    this.emitUi();
    return true;
  }

  /** Moves a hood held with holdHood() by `displacement` (m, scene frame) from where it was held. */
  moveHood(displacement: readonly number[], frameTime = performance.now()) {
    if (this.drag?.kind !== 'hood' || this.drag.hand !== HOLD_HAND) return;
    if (displacement.length !== 3 || !displacement.every(Number.isFinite)) return;
    this.host.garment.cloth.interactMove([...displacement], frameTime);
  }

  /** Hover affordance (mouse or the hand cursor); raycast at most once per render frame. */
  setHover(vp: Ndc | null) {
    this.hoverAt = vp ?? undefined;
    this.hoverDirty = true;
  }

  /** Set when a session starts with the hood off: it appears set down, without the drop. */
  private startOff = false;

  /**
   * The hood's state at the start of this Feel session (HOOD_DEFAULT; the harness can call it
   * with 'off-resting'). 'off-resting' takes the hood off and sets it down by the right foot.
   * Only the split (interaction) view changes; the measured shell stays as it is.
   */
  applyHoodDefault(mode: HoodDefault) {
    if (mode !== 'off-resting' || !this.hasHood || !this.topo || this.drag) return;
    this.ensureActive();
    this.startOff = true;
    this.host.garment.cloth.interactHoodOff();
  }

  /** Programmatic slider (harness / buttons): 0 closed .. 1 fully open. */
  setZipOpen(fraction: number, frameTime = performance.now()) {
    if (!this.topo) return;
    this.ensureActive();
    this.sliderTarget = clampSlider(
      fraction * (this.topo.zip.length + INTERACT.zipEndM),
      this.topo.zip.length,
    );
    this.host.garment.cloth.interactSlider(this.sliderTarget, frameTime);
  }

  /** Camera to the back three-quarter view (the hood lies on the back) or back to the front. */
  viewHood(on: boolean) {
    if (on === this.hoodView) return;
    this.hoodView = on;
    // 150° round to the wearer's left-back, a little higher and farther back: the hood and
    // collar from behind, and the floor beside the feet where a hood taken off is set down.
    this.orbit(on ? 150 : 0, on ? 0.3 : 0, on ? INTERACT.hoodViewZoom : 1);
  }

  /** Horizontal camera distance of the kiosk's front framing (orbit's zoom 1). */
  private frontRadius?: number;

  /**
   * Camera round the jacket centre: `degrees` about the vertical (0 = the kiosk's front view,
   * + = toward the wearer's left), at `rise` (0..1) of the way from the centre to the collar,
   * `zoom` × the front framing's distance.
   */
  orbit(degrees: number, rise = 0, zoom = 1) {
    const camera = this.host.camera,
      p = this.asset.initial;
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      minX = Math.min(minX, p[i]);
      maxX = Math.max(maxX, p[i]);
      minY = Math.min(minY, p[i + 1]);
      maxY = Math.max(maxY, p[i + 1]);
      minZ = Math.min(minZ, p[i + 2]);
      maxZ = Math.max(maxZ, p[i + 2]);
    }
    // Same centre the kiosk frames the jacket on (GarmentView.frameFront: the box centre).
    const centre = new Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
      offset = camera.position.clone().sub(centre),
      radius = Math.hypot(offset.x, offset.z),
      toRadius = (this.frontRadius ??= radius) * zoom,
      from = Math.atan2(offset.x, offset.z),
      to = (degrees * Math.PI) / 180,
      fromY = camera.position.y,
      toY = centre.y + (maxY - centre.y) * rise,
      started = performance.now();
    cancelAnimationFrame(this.cameraTween);
    const step = () => {
      const t = Math.min(1, (performance.now() - started) / 700),
        e = t * t * (3 - 2 * t),
        a = from + (to - from) * e,
        r = radius + (toRadius - radius) * e;
      camera.position.set(
        centre.x + Math.sin(a) * r,
        fromY + (toY - fromY) * e,
        centre.z + Math.cos(a) * r,
      );
      camera.lookAt(centre);
      if (t < 1) this.cameraTween = requestAnimationFrame(step);
    };
    this.cameraTween = requestAnimationFrame(step);
  }

  get inHoodView() {
    return this.hoodView;
  }

  state(): InteractUiState {
    const length = this.topo?.zip.length ?? 1;
    return {
      ready: !!this.topo,
      hasHood: this.hasHood,
      zipOpen: Math.min(1, this.slider / length),
      hood: this.last?.hood ?? (this.hasHood ? 'attached' : null),
      hooked: !!this.last?.hooked && this.active,
      open: this.active,
      hover: this.hover,
      dragging: this.drag?.kind ?? null,
      error: this.failure ?? null,
      hoodView: this.hoodView,
      hoodProgress: this.last?.hoodProgress ?? 0,
    };
  }

  /** NDC of the zip pull on screen (harness), or null when not on screen. */
  pullScreen(): Ndc | null {
    const at = this.pullWorld(new Vector3());
    if (!at) return null;
    const s = at.project(this.host.camera);
    return s.z < 1 ? { x: s.x, y: s.y } : null;
  }

  /** The zip track on screen (NDC), top first (harness: drag along it). */
  zipTrackNdc(): Ndc[] {
    if (!this.topo) return [];
    const v = new Vector3(),
      out: Ndc[] = [];
    for (let k = 0; k < this.topo.zip.a.length; k++) {
      this.trackPoint(k, v).project(this.host.camera);
      out.push({ x: v.x, y: v.y });
    }
    return out;
  }

  /**
   * Harness: screen NDC of the collar's zip track (hood line, collar side) and of the hood's
   * zip edge, as shown now (centroids).
   */
  hoodEdges(): { collar: Ndc; hood: Ndc } | null {
    const topo = this.topo;
    if (!topo?.hood) return null;
    const mesh = this.shownMesh(),
      p = mesh.geometry.getAttribute('position'),
      at = (ids: Int32Array) => {
        const v = new Vector3();
        for (const i of ids) v.add(new Vector3(p.getX(i), p.getY(i), p.getZ(i)));
        v.divideScalar(ids.length).project(this.host.camera);
        return { x: v.x, y: v.y };
      };
    // The hood's edge = the collar track moved by the hand's hood move (the same measure the
    // unzip progress uses), whichever hood is drawn (H's padded one or the shell stopgap).
    const hand = this.last?.hoodHand ?? [0, 0, 0],
      c = new Vector3();
    for (const i of topo.hood.a) c.add(new Vector3(p.getX(i), p.getY(i), p.getZ(i)));
    c.divideScalar(topo.hood.a.length).add(new Vector3(hand[0], hand[1], hand[2]));
    c.project(this.host.camera);
    return { collar: at(topo.hood.a), hood: { x: c.x, y: c.y } };
  }

  /** NDC of a visible hood point (harness): the hood vertex nearest the camera ray centre. */
  /** Harness diagnostics when the hood cannot be found on screen (numbers only). */
  hoodDebug() {
    const hood = (this.host.garment as unknown as { hood?: PaddedHood }).hood,
      out: Record<string, unknown> = {
        hasHood: this.hasHood,
        padded: !!hood,
        visible: hood?.visible,
      };
    if (hood?.mesh) {
      const p = hood.mesh.geometry.getAttribute('position'),
        v = new Vector3(),
        box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      hood.mesh.updateMatrixWorld();
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(hood.mesh.matrixWorld).project(this.host.camera);
        box.minX = Math.min(box.minX, v.x);
        box.maxX = Math.max(box.maxX, v.x);
        box.minY = Math.min(box.minY, v.y);
        box.maxY = Math.max(box.maxY, v.y);
      }
      const cx = (box.minX + box.maxX) / 2,
        cy = (box.minY + box.maxY) / 2;
      out.box = box;
      out.centreHit = this.hit({ x: cx, y: cy })?.kind ?? null;
      out.count = p.count;
      out.restoring = !!this.restoring;
      out.topo = !!this.topo;
    }
    return out;
  }

  hoodScreen(): Ndc | null {
    if (!this.hasHood) return null;
    // H's padded hood when drawn (its pick mesh), else the shell's hood panel.
    const padded = this.paddedHood(),
      mesh = padded?.mesh ?? this.shownMesh(),
      panels = this.active && this.topo ? this.topo.panels : this.asset.panels,
      position = mesh.geometry.getAttribute('position'),
      v = new Vector3();
    let best: Ndc | null = null,
      bestZ = Infinity,
      cx = 0,
      cy = 0,
      n = 0;
    mesh.updateMatrixWorld();
    for (let i = 0; i < position.count; i++) {
      if (!padded && panels[i] !== PANEL.hood) continue;
      v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld).project(this.host.camera);
      cx += v.x;
      cy += v.y;
      n++;
    }
    if (!n) return null;
    cx /= n;
    cy /= n;
    // Confirm with a ray: the nearest hood hit on a small grid round the hood's projected
    // centre (a padded bowl's centre can be its open inside).
    for (let gy = -4; gy <= 4; gy++)
      for (let gx = -4; gx <= 4; gx++) {
        const q = { x: cx + gx * 0.035, y: cy + gy * 0.035 },
          hit = this.hit(q);
        if (hit?.kind !== 'hood') continue;
        const z = hit.point.clone().project(this.host.camera).z + Math.hypot(gx, gy) * 1e-4;
        if (z < bestZ) {
          bestZ = z;
          best = q;
        }
      }
    return best;
  }

  /** FNV-1a of the measured shell's shown positions (bit-identity check after a restore). */
  shellHash() {
    const p = this.original.geometry.getAttribute('position').array as Float32Array,
      bytes = new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
    let hash = 2166136261;
    for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  stats(): InteractStats {
    const fps = this.samples.frameMs.map((ms) => 1000 / ms),
      interval = percentile(this.samples.interval, 50);
    return {
      fpsP50: percentile(fps, 50),
      fpsP5: percentile(fps, 5),
      frames: fps.length,
      latencyP50: percentile(this.samples.latency, 50),
      latencyP95: percentile(this.samples.latency, 95),
      latencySamples: this.samples.latency.length,
      stepP50: percentile(this.samples.step, 50),
      stepP95: percentile(this.samples.step, 95),
      deliveredHz: interval > 0 ? 1000 / interval : NaN,
      grabs: { ...this.counters.grabs },
      maxGapM: this.counters.maxGap,
      restores: this.counters.restores,
      particles: this.counters.particles,
    };
  }

  resetStats() {
    for (const list of Object.values(this.samples)) list.length = 0;
    this.counters = { grabs: {}, maxGap: 0, restores: 0, particles: 0 };
  }

  // ---------------------------------------------------------------- internals

  private shownMesh() {
    return this.active && this.split ? this.split : this.original;
  }

  /** Original vertex → split vertex for a grab of `kind` (hood grabs use the hood's copies). */
  private toSplit(i: number, kind: HandleKind) {
    const topo = this.topo!;
    if (kind === 'hood' && topo.hood) {
      const k = topo.hood.a.indexOf(i);
      if (k >= 0) return topo.hood.b[k];
    }
    return i;
  }

  /** Split positions now: the split mesh's, or the shell's expanded (before activation). */
  private splitPositions(): ArrayLike<number> {
    if (this.active && this.split) return this.split.geometry.getAttribute('position').array;
    return this.expandedShell();
  }

  /** The measured shell's shown positions in split numbering (duplicates = their source). */
  private expandedShell() {
    const topo = this.topo!,
      src = this.original.geometry.getAttribute('position').array,
      out = new Float32Array(topo.source.length * 3);
    for (let i = 0; i < topo.source.length; i++) {
      const k = topo.source[i] * 3;
      out[i * 3] = src[k];
      out[i * 3 + 1] = src[k + 1];
      out[i * 3 + 2] = src[k + 2];
    }
    return out;
  }

  private ensureActive() {
    if (this.restoring) {
      // A new grab during the cross-fade: the split solver restarts from the shell.
      this.restoring = undefined;
      this.active = false;
    }
    if (this.active) return;
    this.buildSplitMesh();
    this.host.garment.cloth.interactActivate();
    this.slider = this.sliderTarget = 0;
    this.last = undefined;
    this.active = true;
    // Show the split mesh at once, at the shell's state (identical until the first frame).
    const position = this.split!.geometry.getAttribute('position');
    (position.array as Float32Array).set(this.expandedShell());
    position.needsUpdate = true;
    this.swapMeshes(true);
  }

  private buildSplitMesh() {
    if (this.split || !this.topo) return;
    const topo = this.topo,
      source = topo.source,
      m = source.length,
      from = this.original.geometry,
      geometry = new BufferGeometry();
    for (const [name, attribute] of Object.entries(from.attributes)) {
      const size = attribute.itemSize,
        src = attribute.array as ArrayLike<number>,
        out = new Float32Array(m * size);
      for (let i = 0; i < m; i++)
        for (let c = 0; c < size; c++) out[i * size + c] = src[source[i] * size + c];
      geometry.setAttribute(name, new Float32BufferAttribute(out, size));
    }
    // With H's padded hood drawn, the shell's thin hood panel stays hidden on the split mesh too.
    const tri = Array.from(topo.triangles),
      hidden = this.paddedHood()
        ? tri
            .filter((_, k) => k % 3 === 0)
            .flatMap((_, t) => {
              const c = tri.slice(t * 3, t * 3 + 3);
              return c.some((i) => topo.panels[i] === PANEL.hood) ? [] : c;
            })
        : tri;
    geometry.setIndex(hidden);
    geometry.computeBoundingSphere();
    const mesh = new Mesh(geometry, this.original.material);
    mesh.customDepthMaterial = this.original.customDepthMaterial;
    mesh.onBeforeRender = this.original.onBeforeRender;
    mesh.castShadow = this.original.castShadow;
    mesh.receiveShadow = this.original.receiveShadow;
    mesh.renderOrder = this.original.renderOrder;
    mesh.visible = false;
    mesh.name = 'garment-split';
    this.split = mesh;
    this.host.garment.add(mesh);
    this.buildPlacketRemap();
  }

  /**
   * DQ4920-206 storm placket (shader: centred on the CF, |L| < width / 2). It is sewn to the
   * wearer's LEFT front (Puffer1: the placket's stitched edge and the black tabs travel with the
   * left front, the zip shows on the right front). On the split mesh the right front's chart
   * arc L is pushed past the placket edge above the slider, so the right front shows its zip
   * edge instead of half a placket. Visual approximation: the left front keeps the placket's
   * left half only (the right half overhanging the zip is not modelled when open).
   */
  private buildPlacketRemap() {
    const topo = this.topo!,
      split = this.split!,
      flap = this.asset.render_details?.storm_flap_width_m ?? 0;
    if (this.look !== 'metal-silver' || !(flap > 0)) return;
    const arc = split.geometry.getAttribute('_g_arc'),
      rest = split.geometry.getAttribute('_g_rest');
    if (!arc || !rest) return;
    const ids: number[] = [],
      base: number[] = [],
      pair: number[] = [];
    const centre = new Set<number>([PANEL.frontL, PANEL.frontR, PANEL.yoke, PANEL.collar]);
    const dupOf = new Map<number, number>();
    topo.zip.b.forEach((b) => dupOf.set(b, 1));
    for (let i = 0; i < topo.source.length; i++) {
      const s = topo.source[i];
      if (!centre.has(this.asset.panels[s])) continue;
      const right =
        dupOf.has(i) || (i < this.asset.panels.length && this.asset.initial[s * 3] < -1e-6);
      if (!right || (dupOf.has(i) === false && topo.zip.a.includes(i))) continue;
      const L = arc.getX(i);
      if (!(L < 2 * flap)) continue;
      // Nearest zip pair (rest shape) gives the vertex's height along the zip.
      let best = 0,
        bestD = Infinity;
      for (let k = 0; k < topo.zip.a.length; k++) {
        const a = topo.zip.a[k];
        const d = Math.hypot(
          rest.getX(i) - rest.getX(a),
          rest.getY(i) - rest.getY(a),
          rest.getZ(i) - rest.getZ(a),
        );
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      ids.push(i);
      base.push(L);
      pair.push(best);
    }
    this.placket = {
      ids: Int32Array.from(ids),
      base: Float32Array.from(base),
      pair: Int32Array.from(pair),
    };
  }

  private updatePlacket() {
    const pl = this.placket,
      topo = this.topo;
    if (!pl || !topo || !this.split) return;
    const arc = this.split.geometry.getAttribute('_g_arc'),
      e = (this.asset.render_details?.storm_flap_width_m ?? 0) / 2,
      zipArc = topo.zip.arc,
      blend = 0.015;
    for (let j = 0; j < pl.ids.length; j++) {
      const s = zipArc[pl.pair[j]],
        open = Math.max(0, Math.min(1, (this.slider - s) / blend + 0.5)),
        L = pl.base[j];
      arc.setX(pl.ids[j], L + open * e * (1 - L / (4 * e)));
    }
    arc.needsUpdate = true;
  }

  private resetPaddedHood() {
    this.restMatrix = undefined;
    this.drop = undefined;
    this.shownHoodMatrix.identity();
    const padded = this.paddedHood();
    if (!padded) return;
    padded.setRigidTransform(null);
    padded.setState('detached', 0);
  }

  private swapMeshes(split: boolean) {
    if (this.split) this.split.visible = split;
    this.original.visible = !split;
    this.onSplitShown?.(split && this.split ? this.split : null, this.original);
  }

  /**
   * Studio (agent ZB, additive): called when the split (opened) mesh replaces the measured shell
   * on screen (mesh) or gives way to it again (null), so a view that styles the shell (the Fit
   * Lab's see-through) can style the split mesh too. Its geometry carries every shell attribute
   * (fitZone included), copied through the split's source map.
   */
  onSplitShown?: (split: Mesh | null, original: Mesh) => void;

  /** The mesh drawing the jacket now (the split one while opened). */
  get shownJacket(): Mesh {
    return this.shownMesh();
  }

  private hideShellPuller() {
    // The detail nearest the CF collar top (its translation) within 6 cm.
    const cf = this.asset.initial;
    let top = -1;
    for (let i = 0; i < this.asset.panels.length; i++)
      if (
        Math.abs(cf[i * 3]) < 1e-6 &&
        cf[i * 3 + 2] > 0 &&
        (top < 0 || cf[i * 3 + 1] > cf[top * 3 + 1])
      )
        top = i;
    if (top < 0) return;
    const at = new Vector3(cf[top * 3], cf[top * 3 + 1], cf[top * 3 + 2]),
      v = new Vector3();
    for (const child of this.host.garment.details.children) {
      v.setFromMatrixPosition(child.matrix);
      if (child.visible && v.distanceTo(at) < 0.06) {
        child.visible = false;
        this.hidden.push(child);
      }
    }
  }

  /** Zip pair midpoints (world) from the shown mesh; zip.a are shell ids (same in the shell). */
  private trackPoint(k: number, out: Vector3) {
    const topo = this.topo!,
      p = this.shownMesh().geometry.getAttribute('position'),
      a = topo.zip.a[k];
    if (this.active && this.split) {
      const b = topo.zip.b[k];
      return out.set(
        (p.getX(a) + p.getX(b)) / 2,
        (p.getY(a) + p.getY(b)) / 2,
        (p.getZ(a) + p.getZ(b)) / 2,
      );
    }
    return out.set(p.getX(a), p.getY(a), p.getZ(a));
  }

  private trackScreen(w: number, h: number) {
    const topo = this.topo!,
      n = topo.zip.a.length,
      out = new Float32Array(n * 2),
      v = new Vector3();
    for (let k = 0; k < n; k++) {
      this.trackPoint(k, v).project(this.host.camera);
      const px = ndcToPixels({ x: v.x, y: v.y }, w, h);
      out[k * 2] = px.x;
      out[k * 2 + 1] = px.y;
    }
    return out;
  }

  /** World position of the zip pull's slider (top centre), or undefined before prepare. */
  private pullWorld(out: Vector3) {
    if (!this.topo) return undefined;
    const arc = this.topo.zip.arc,
      n = arc.length,
      s = Math.min(this.slider, arc[n - 1]);
    let k = 0;
    while (k + 2 < n && arc[k + 1] < s) k++;
    const t =
      arc[k + 1] > arc[k] ? Math.max(0, Math.min(1, (s - arc[k]) / (arc[k + 1] - arc[k]))) : 0;
    const a = this.trackPoint(k, new Vector3()),
      b = this.trackPoint(k + 1, new Vector3());
    return out.copy(a).lerp(b, t);
  }

  /** Lift (m) of hardware above the inner (fit) surface: the drawn relief at the zip. */
  private lift() {
    const loft = this.asset.maximum_loft_m;
    // Parka zip tape sits at 0.34 loft (shader); the puffer pull lies on the placket (~0.8 loft).
    return this.look === 'metal-silver' ? 0.85 * loft + 0.003 : 0.36 * loft + 0.002;
  }

  private placePull() {
    const topo = this.topo;
    if (!topo) {
      this.pull.group.visible = false;
      return;
    }
    const at = this.pullWorld(new Vector3())!;
    const arc = topo.zip.arc,
      n = arc.length;
    let k = 0;
    while (k + 2 < n && arc[k + 1] < Math.min(this.slider, arc[n - 1])) k++;
    const normal = new Vector3(),
      mesh = this.shownMesh(),
      nAttr = mesh.geometry.getAttribute('normal');
    normal.set(nAttr.getX(topo.zip.a[k]), nAttr.getY(topo.zip.a[k]), nAttr.getZ(topo.zip.a[k]));
    if (this.active) {
      const b = topo.zip.b[k];
      normal.add(new Vector3(nAttr.getX(b), nAttr.getY(b), nAttr.getZ(b)));
    }
    if (normal.lengthSq() < 1e-12) normal.set(0, 0, 1);
    normal.normalize();
    const down = this.trackPoint(Math.min(n - 1, k + 1), new Vector3()).sub(
      this.trackPoint(k, new Vector3()),
    );
    if (down.lengthSq() < 1e-12) down.set(0, -1, 0);
    down.addScaledVector(normal, -down.dot(normal)).normalize();
    const right = new Vector3().crossVectors(down, normal).normalize(),
      up = down.clone().negate();
    const position = at.addScaledVector(normal, this.lift());
    this.pull.group.matrix.makeBasis(right, up, normal).setPosition(position);
    this.pull.group.matrixWorldNeedsUpdate = true;
    this.pull.group.visible = true;
    this.glowAt.copy(position).addScaledVector(down, 0.012);
  }

  private onFrame(message: InteractMessage) {
    if (!this.active || !this.split || this.restoring) return;
    const geometry = this.split.geometry,
      position = geometry.getAttribute('position'),
      normal = geometry.getAttribute('normal');
    if (position.array.length !== message.positions.length) return;
    (position.array as Float32Array).set(message.positions);
    position.needsUpdate = true;
    smoothNormals(position.array, geometry.index!.array, normal.array as Float32Array);
    normal.needsUpdate = true;
    geometry.computeBoundingSphere();
    this.host.garment.details.update(position.array, this.topo!.triangles, normal.array);
    this.drivePaddedHood(message.frame);
    const f = message.frame;
    this.last = f;
    if (!this.drag || this.drag.kind !== 'pull') this.slider = this.sliderTarget = f.slider;
    push(this.samples.step, f.stepMs);
    if (message.intervalMs > 0) push(this.samples.interval, message.intervalMs);
    if (message.frameTime > 0) this.pendingLatency.push(message.frameTime);
    this.counters.maxGap = Math.max(this.counters.maxGap, f.maxGapM);
    this.counters.particles = Math.max(this.counters.particles, f.particles);
    if (f.restful && !this.drag && this.sliderTarget === 0) this.startRestore();
  }

  /** Never drawn: H's hood geometry with a two-sided material, for picking only. */
  private readonly hoodProxy = new Mesh(
    new BufferGeometry(),
    new MeshBasicMaterial({ side: DoubleSide }),
  );

  /** H's floor pose for a hood taken off, and the eased drop to it. */
  private restMatrix?: Matrix4;
  private drop?: { from: Matrix4; started: number };
  private shownHoodMatrix = new Matrix4();
  /** Bringing the hood back: fraction of the way from its grab point to the collar on screen. */
  private backFraction = 0;

  private applyHoodMatrix(padded: PaddedHood, m: Matrix4) {
    this.shownHoodMatrix.copy(m);
    padded.setRigidTransform(m.equals(new Matrix4()) ? null : m);
  }

  /** On the floor beside the right foot (−X), from the shown body (garment-local). */
  private floorTarget() {
    const b = this.asset.body_positions;
    let floor = Infinity;
    for (let i = 1; i < b.length; i += 3) floor = Math.min(floor, b[i]);
    let x = 0,
      z = 0,
      n = 0;
    for (let i = 0; i < b.length; i += 3)
      if (b[i + 1] < floor + 0.06 && b[i] < 0) {
        x += b[i];
        z += b[i + 2];
        n++;
      }
    return new Vector3((n ? x / n : -0.1) - INTERACT.hoodFloorSideM, floor, n ? z / n : 0);
  }

  /**
   * H's authored hood (docs/requests/H-to-Z.md): its baked peel keys blend with the unzip
   * progress; near full detach the hand's move blends in (hoodFreeWeight), so the held hood
   * moves rigidly with the hand. Let go fully off, it is set down standing on its zip edge on
   * the floor beside the right foot, opening up (H's restingTransform; lead's UX direction, not
   * physics: an eased drop, no fall simulated). Picked up from there, it travels from that pose
   * to the hand's as the drag goes toward the collar.
   */
  private drivePaddedHood(f: InteractFrame) {
    const padded = this.paddedHood();
    if (!padded || !f.hoodMatrix) return;
    padded.setState('detached', f.hoodProgress);
    const [x, y, z] = f.hoodHand,
      free = hoodFreeWeight(f.hoodProgress),
      held = new Matrix4().makeTranslation(x * free, y * free, z * free);
    if (f.hooked && !this.drag && padded.restingTransform) {
      if (!this.restMatrix)
        try {
          this.restMatrix = padded.restingTransform(this.floorTarget(), new Vector3(0, 0, 1));
          // A session that starts with the hood off shows it already set down (no drop).
          this.drop = this.startOff
            ? undefined
            : { from: this.shownHoodMatrix.clone(), started: performance.now() };
          if (this.startOff && this.restMatrix) this.applyHoodMatrix(padded, this.restMatrix);
          this.startOff = false;
        } catch {
          this.restMatrix = undefined; // H cannot rest it (not fitted): it stays where let go
        }
      if (this.restMatrix) return; // animate() runs the drop and holds the pose
    }
    if (this.restMatrix && this.drag?.kind === 'hood') {
      this.drop = undefined;
      this.applyHoodMatrix(padded, blendPose(this.restMatrix, held, this.backFraction));
      return;
    }
    if (f.hood === 'attached') this.restMatrix = undefined;
    this.applyHoodMatrix(padded, held);
  }

  private stepDrop(now: number) {
    const d = this.drop,
      padded = this.paddedHood();
    if (!d || !this.restMatrix || !padded) return;
    const t = Math.min(1, (now - d.started) / 1000 / INTERACT.hoodDropS),
      e = t * t * (3 - 2 * t);
    this.applyHoodMatrix(padded, blendPose(d.from, this.restMatrix, e));
    if (t >= 1) this.drop = undefined;
  }

  private startRestore() {
    if (!this.split || this.restoring) return;
    this.restoring = {
      from: Float32Array.from(this.split.geometry.getAttribute('position').array as Float32Array),
      started: performance.now(),
    };
    // The split solver stops; the worker re-sends the base solver's (unchanged) state.
    this.host.garment.cloth.interactStop();
    this.counters.restores++;
  }

  private stepRestore(now: number) {
    const r = this.restoring;
    if (!r || !this.split || !this.topo) return;
    const t = Math.min(1, (now - r.started) / 1000 / INTERACT.restoreBlendS),
      e = t * t * (3 - 2 * t),
      target = this.expandedShell(),
      geometry = this.split.geometry,
      position = geometry.getAttribute('position'),
      p = position.array as Float32Array;
    // Visual cross-fade between two simulated states (not physics); see the file header.
    for (let i = 0; i < p.length; i++) p[i] = r.from[i] + (target[i] - r.from[i]) * e;
    position.needsUpdate = true;
    smoothNormals(p, geometry.index!.array, geometry.getAttribute('normal').array as Float32Array);
    geometry.getAttribute('normal').needsUpdate = true;
    this.host.garment.details.update(p, this.topo.triangles, geometry.getAttribute('normal').array);
    if (t < 1) return;
    this.restoring = undefined;
    this.active = false;
    this.slider = this.sliderTarget = 0;
    this.swapMeshes(false);
    this.resetPaddedHood();
    const o = this.original.geometry;
    this.host.garment.details.update(
      o.getAttribute('position').array,
      undefined,
      o.getAttribute('normal').array,
    );
    for (const t of [...this.teeth, ...this.hoodTeeth, ...this.walls]) t.mesh.visible = false;
    this.emitUi();
  }

  private updateHardware(time: number) {
    const topo = this.topo;
    this.placePull();
    // Glow: hover / grab affordance; a slow, faint pulse otherwise so the pull is discoverable.
    const pulse = 0.5 + 0.5 * Math.sin(time / 450);
    const target =
      this.drag?.kind === 'pull'
        ? 0.85
        : this.hover === 'pull'
          ? 0.75
          : this.topo
            ? 0.12 + 0.12 * pulse
            : 0;
    this.glowOpacity += (target - this.glowOpacity) * 0.25;
    const s = this.glowAt.clone().project(this.host.camera),
      { clientWidth: w, clientHeight: h } = this.host.container,
      q = ndcToPixels({ x: s.x, y: s.y }, w, h),
      shown = this.pull.group.visible && s.z < 1 ? this.glowOpacity : 0;
    this.glow.style.transform = `translate(${q.x}px, ${q.y}px)`;
    this.glow.style.opacity = shown.toFixed(3);
    if (!topo || !this.active || !this.split) return;
    const p = this.split.geometry.getAttribute('position').array as Float32Array,
      n = this.split.geometry.getAttribute('normal').array as Float32Array,
      lift = this.asset.maximum_loft_m * 0.3 + 0.001;
    const gather = (ids: Int32Array, from: Float32Array) => {
      const pts = new Float32Array(ids.length * 3),
        nor = new Float32Array(ids.length * 3);
      ids.forEach((id, k) => {
        for (let c = 0; c < 3; c++) {
          pts[k * 3 + c] = from[id * 3 + c];
          nor[k * 3 + c] = n[id * 3 + c];
        }
      });
      return [pts, nor] as const;
    };
    {
      const open = topo.zip.arc.findIndex((a) => a >= this.slider),
        upTo = open < 0 ? topo.zip.arc.length : open + 1,
        loft = this.asset.maximum_loft_m,
        high = (this.look === 'coil-black' ? 0.34 : 0.75) * loft;
      for (const [s, ids] of [topo.zip.a, topo.zip.b].entries()) {
        if (!this.walls[s]) continue;
        const [pts, nor] = gather(ids, p),
          across = new Float32Array(pts.length),
          away = s === 0 ? -1 : 1;
        for (let k = 0; k < ids.length; k++) {
          const i = k * 3,
            prev = Math.max(0, k - 1) * 3,
            next = Math.min(ids.length - 1, k + 1) * 3,
            tx = pts[next] - pts[prev],
            ty = pts[next + 1] - pts[prev + 1],
            tz = pts[next + 2] - pts[prev + 2];
          let ax = nor[i + 1] * tz - nor[i + 2] * ty,
            ay = nor[i + 2] * tx - nor[i] * tz,
            az = nor[i] * ty - nor[i + 1] * tx;
          const l = Math.hypot(ax, ay, az) || 1,
            sign = ax * away >= 0 ? 1 : -1;
          ax = (ax / l) * sign;
          ay = (ay / l) * sign;
          az = (az / l) * sign;
          across[i] = ax;
          across[i + 1] = ay;
          across[i + 2] = az;
        }
        this.walls[s].update(pts, nor, across, upTo, 0.001, high);
      }
    }
    if (this.teeth.length === 2) {
      const open = topo.zip.arc.findIndex((a) => a >= this.slider);
      const upTo = open < 0 ? topo.zip.arc.length : open + 1;
      for (const [s, ids] of [topo.zip.a, topo.zip.b].entries()) {
        const [pts, nor] = gather(ids, p);
        this.teeth[s].update(pts, nor, topo.zip.arc, upTo, 0.006, lift);
      }
      this.updatePlacket();
    }
    if (topo.hood && this.hoodTeeth.length === 2) {
      const progress = this.last?.hoodProgress ?? 0,
        s = hoodFrontier(progress, topo.hood.length),
        open = topo.hood.arc.findIndex((a) => a >= s),
        upTo = open < 0 ? topo.hood.arc.length : open;
      for (const [side, ids] of [topo.hood.a, topo.hood.b].entries()) {
        const [pts, nor] = gather(ids, p);
        this.hoodTeeth[side].update(pts, nor, topo.hood.arc, upTo, 0.006, 0.002);
      }
    }
  }

  private placeTabs() {
    const topo = this.topo;
    if (!topo?.hood || this.tabs.length !== 2) return;
    const mesh = this.shownMesh(),
      p = mesh.geometry.getAttribute('position'),
      nAttr = mesh.geometry.getAttribute('normal'),
      ids = this.active ? topo.hood.b : topo.hood.a,
      ends = [ids[0], ids[ids.length - 1]];
    ends.forEach((id, j) => {
      const at = new Vector3(p.getX(id), p.getY(id), p.getZ(id)),
        normal = new Vector3(nAttr.getX(id), nAttr.getY(id), nAttr.getZ(id)).normalize(),
        up = new Vector3(0, 1, 0).addScaledVector(normal, -normal.y).normalize(),
        right = new Vector3().crossVectors(up, normal).normalize();
      at.addScaledVector(normal, this.asset.maximum_loft_m * 0.6 + 0.002);
      this.tabs[j].matrix.makeBasis(right, up, normal).setPosition(at);
      this.tabs[j].matrixWorldNeedsUpdate = true;
    });
  }

  private animate = (time: number) => {
    if (this.disposed) return;
    // A view may swap the shell's material (e.g. the Fit Lab's see-through): the split mesh
    // follows it, so the opened jacket is drawn the same way (agent ZB, additive).
    if (this.split && this.split.material !== this.original.material) {
      this.split.material = this.original.material;
      this.split.onBeforeRender = this.original.onBeforeRender;
    }
    const dt = this.lastRaf ? Math.min(0.1, (time - this.lastRaf) / 1000) : 0;
    if (this.lastRaf && this.active) push(this.samples.frameMs, time - this.lastRaf);
    this.lastRaf = time;
    const now = performance.now();
    for (const t of this.pendingLatency) push(this.samples.latency, now - t);
    this.pendingLatency = [];
    // The pull follows the hand at render rate (the solver's slider obeys the same speed limit).
    if (this.drag?.kind === 'pull')
      this.slider = approach(this.slider, this.sliderTarget, INTERACT.sliderSpeed * dt);
    if (this.restoring) this.stepRestore(now);
    this.stepDrop(now);
    if (this.hoverDirty && !this.drag) {
      this.hoverDirty = false;
      const hit = this.hoverAt ? this.hit(this.hoverAt) : undefined;
      this.hover = hit?.kind === 'fabric' ? null : (hit?.kind ?? null);
    }
    this.host.container.style.cursor = this.drag ? 'grabbing' : this.hover ? 'grab' : '';
    this.tintHood(this.hasHood && (this.hover === 'hood' || this.drag?.kind === 'hood'));
    this.updateHardware(time);
    this.placeTabs();
    this.emitUi();
    this.raf = requestAnimationFrame(this.animate);
  };

  /** The hood is tinted (hover/grab affordance): the hand pull keeps the shader's grab on. */
  tinting = false;
  private tinted?: Mesh;
  /**
   * Hover/grab affordance on the hood: the garment shader's own grab highlight (a soft green
   * tint, `_grab.x`) on the hood's particles of the mesh on screen.
   */
  private tintHood(on: boolean) {
    const mesh = on ? this.shownMesh() : undefined;
    if (mesh === this.tinted) return;
    const paint = (target: Mesh, value: number) => {
      const attribute = target.geometry.getAttribute('_grab');
      if (!attribute) return;
      const panels = target === this.split && this.topo ? this.topo.panels : this.asset.panels,
        data = attribute.array as Float32Array;
      for (let i = 0; i < panels.length; i++) if (panels[i] === PANEL.hood) data[i * 2] = value;
      attribute.needsUpdate = true;
    };
    if (this.tinted) paint(this.tinted, 0);
    if (mesh) paint(mesh, 0.4);
    this.tinted = mesh;
    this.tinting = !!mesh;
  }

  private emitUi() {
    const state = this.state(),
      key = JSON.stringify({
        ...state,
        zipOpen: Math.round(state.zipOpen * 100),
        hoodProgress: Math.round(state.hoodProgress * 20),
      });
    if (key === this.lastUi) return;
    this.lastUi = key;
    this.onUi?.(state);
  }

  // ---------------------------------------------------------------- pointer input

  private pointerNdc(event: PointerEvent): Ndc {
    const r = this.host.container.getBoundingClientRect();
    return {
      x: ((event.clientX - r.left) / r.width) * 2 - 1,
      y: 1 - ((event.clientY - r.top) / r.height) * 2,
    };
  }

  private pointerId?: number;
  private onPointerDown = (event: PointerEvent) => {
    this.onActivity?.();
    if (event.button !== 0 || this.drag) return;
    const vp = this.pointerNdc(event);
    if (!this.begin(vp, 'mouse', performance.now())) return;
    // Ours: the orbit controls (enabled when the camera failed) must not also take it.
    event.stopPropagation();
    event.preventDefault();
    this.pointerId = event.pointerId;
    this.host.container.setPointerCapture?.(event.pointerId);
    // A release outside the canvas (over the Feel screen's text) must still end the drag.
    window.addEventListener('pointerup', this.onPointerUp, { capture: true });
    window.addEventListener('pointercancel', this.onPointerUp, { capture: true });
  };
  private onPointerMove = (event: PointerEvent) => {
    this.onActivity?.();
    const vp = this.pointerNdc(event);
    if (this.drag?.source === 'mouse' && event.pointerId === this.pointerId) {
      event.stopPropagation();
      this.move(vp, performance.now());
    } else if (!this.drag) this.setHover(vp);
  };
  private onPointerUp = (event: PointerEvent) => {
    if (this.drag?.source !== 'mouse' || event.pointerId !== this.pointerId) return;
    event.stopPropagation();
    window.removeEventListener('pointerup', this.onPointerUp, { capture: true });
    window.removeEventListener('pointercancel', this.onPointerUp, { capture: true });
    if (this.host.container.hasPointerCapture?.(event.pointerId))
      this.host.container.releasePointerCapture(event.pointerId);
    this.pointerId = undefined;
    this.end(performance.now());
  };
  private onPointerLeave = () => {
    if (!this.drag) this.setHover(null);
  };

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.cameraTween);
    const c = this.host.container;
    c.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
    c.removeEventListener('pointermove', this.onPointerMove, { capture: true });
    c.removeEventListener('pointerup', this.onPointerUp, { capture: true });
    c.removeEventListener('pointercancel', this.onPointerUp, { capture: true });
    c.removeEventListener('pointerleave', this.onPointerLeave);
    c.style.cursor = '';
    window.removeEventListener('pointerup', this.onPointerUp, { capture: true });
    window.removeEventListener('pointercancel', this.onPointerUp, { capture: true });
    const cloth = this.host.garment.cloth;
    cloth.onInteract = undefined;
    if (this.active) cloth.interactStop();
    this.swapMeshes(false);
    this.resetPaddedHood();
    if (this.split) {
      this.host.garment.remove(this.split);
      this.split.geometry.dispose();
    }
    const o = this.original.geometry;
    this.host.garment.details.update(
      o.getAttribute('position').array,
      undefined,
      o.getAttribute('normal').array,
    );
    for (const child of this.hidden) child.visible = true;
    this.host.garment.remove(this.pull.group);
    this.glow.remove();
    this.pull.mesh.geometry.dispose();
    this.pull.material.dispose();
    for (const t of [...this.teeth, ...this.hoodTeeth, ...this.walls]) {
      this.host.garment.remove(t.mesh);
      t.dispose();
    }
    for (const tab of this.tabs) {
      this.host.garment.remove(tab);
      tab.geometry.dispose();
      (tab.material as Material).dispose();
    }
  }
}
