// The AR jacket in the KIOSK's look (agent V2): the kiosk's own GarmentLayer (quilting relief,
// seams, decals and logos, hardware, padded hood) drawn in the AR renderer, fed every frame with
// the live avatar's skinned jacket positions. Same approach as V1's KioskMirrorView (whose Viewer
// we do not have here): GarmentLayer.preview(asset), then live frames through
// ClothClient.onFrame keyed by the shown asset, with the live compression field so bent joints
// buckle like the kiosk's surface. Programs are compiled in the background before the first
// draw (programWarmup.ts), in this renderer's own GL context.
import {
  DoubleSide,
  FrontSide,
  HalfFloatType,
  Texture,
  type BufferGeometry,
  type Mesh,
  type MeshPhysicalMaterial,
  WebGLRenderTarget,
  type Camera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import type { ClothAsset } from '../../../api';
import type { ClothSnapshot } from '../../cloth/ClothSolver';
import { compressionField } from '../../cloth/compression';
import { detailMaterialVariants } from '../../garmentDetails';
import { GarmentLayer, finishOf } from '../../GarmentLayer';
import { materials, type Finish } from '../../garmentLook';
import type { GarmentMode } from '../../garmentMath';
import { HoodLayer } from '../../hood/HoodLayer';
import { ProgramWarmup, shadowDepthStandIn, standIn } from '../../programWarmup';
import { uniqueEdges } from '../garmentSkin';
import { lowerCollarFront } from './collarFit';
import { readF3Flags } from './f3Flags';
import { drapeHood } from './hoodDrape';
import { flattenAcross, flattenFront } from './flatFront';
import { seamWeights, tubeSleeves, type Joints } from './sleeveTube';
import { readF4xFlags } from './f4x';
import {
  applyF4tCharts,
  f4tAlbedo,
  f4tCharts,
  F4T_SET,
  F4tSets,
  f4tUniforms,
  hexToLinear,
  installF4tShader,
  readF4tFlags,
} from './f4tex';
import { AR_LOOK } from './finish/config';
import { cameraAdaptation, readF4Flags } from './finish/f4';

/** What the AR needs from the live avatar beyond LivePosedScene (LiveAvatar has it). */
export type KioskJacketSource = {
  readonly jacketAsset?: ClothAsset;
  readonly version?: number;
  jacketPositions(): Float32Array | null;
};

export const isKioskJacketSource = (scene: object): scene is KioskJacketSource =>
  typeof (scene as Partial<KioskJacketSource>).jacketPositions === 'function' &&
  'jacketAsset' in scene;

export class ArKioskJacket {
  readonly layer = new GarmentLayer();
  /** True once an asset is shown (programs linked, geometry built). */
  ready = false;
  private readonly programs: ProgramWarmup;
  private readonly weave = new Texture();
  private readonly shadowKey = new WebGLRenderTarget(1, 1);
  /** The glue's offscreen target (HalfFloat, MSAA): the jacket's programs for it, compiled ahead. */
  private readonly glueKey = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
  private snapshot?: ClothSnapshot;
  private asset?: ClothAsset;
  /** The asset shown now (undefined until the first one is ready). */
  get shownAsset() {
    return this.ready ? this.asset : undefined;
  }
  private loading?: ClothAsset;
  /** An asset whose kiosk look could not be built (logged once): the caller's fallback draws. */
  private failed?: ClothAsset;
  /** F4X flags (f4x.ts), read once: ?f4xwarm=1 cold start, ?f4xlook=1 the AR material. */
  private readonly f4x = readF4xFlags();
  /**
   * Cold-start readout (performance.now ms): the first request of the shown asset, its programs
   * linked, and ready to draw. For the harness and the lab; never a product decision.
   */
  timing: { requestedAt?: number; programsAt?: number; readyAt?: number } = {};
  private edges?: Uint32Array;
  private restLengths?: Float64Array;
  private lastSource?: KioskJacketSource;
  private lastVersion?: number;
  /**
   * F3 (?f3collar=1, D7): lower the collar's front by this much (m) in the drawn jacket
   * (collarFit.ts); set by the compositor from the face each frame. 0 = the garment as built.
   */
  collarDrop = 0;
  private lastCollarDrop = 0;
  /** The front drop applied to the last copied positions (m, after the collar's cap). */
  collarDropApplied = 0;
  /**
   * F3 (?f3hood=1, lead's U3): the padded hood lies down on the upper back (hoodDrape.ts),
   * re-applied after every fit of the hood onto the shell.
   */
  hoodDown = readF3Flags().hood;
  /** F3 (?f3flat=1, belly bulge): the front hangs straight from the chest (flatFront.ts). */
  flatFront = readF3Flags().flat;
  /** Largest belly protrusion removed on the last copy (m; diagnostics). */
  flatRemoved = 0;
  /** F3 (?f3flatx=1): the front across its width as a broad flat plane (flatFront.ts). */
  flatAcross = readF3Flags().flatX;
  /** Largest raise of the front's flanks on the last copy (m; diagnostics). */
  flatXRaised = 0;
  /**
   * F3 (?f3shoulder=1, lead 23:2x/23:5x): the upper sleeves pulled in to one straight tube from
   * the seam (sleeveTube.ts): no balloon at mid upper arm, no wider cap over a narrower sleeve.
   */
  tubeSleeve = readF3Flags().tube;
  /** Largest pull on the last copy (m; diagnostics). */
  tubeRemoved = 0;
  private readonly seams = new WeakMap<object, Float32Array>();
  private readonly drapedHoods = new WeakSet<object>();
  /** Largest height the drape took off the hood on its last application (m; diagnostics). */
  hoodDraped = 0;
  /**
   * F4T (?f4tex=1, f4tex.ts): the real jackets' fabric from the user's local flat-lay photos on
   * the shell's own charts. `gain` = product colour -> photo-calibrated albedo, for the surfaces
   * no photo covers; undefined until (and unless) this machine has the shown jacket's set.
   */
  private readonly f4t = readF4tFlags();
  private readonly f4tUniforms = this.f4t.tex ? f4tUniforms() : undefined;
  private readonly f4tSets?: F4tSets;
  private f4tGain?: [number, number, number];

  constructor(renderer: WebGLRenderer, scene: Scene, camera: Camera) {
    this.programs = new ProgramWarmup(renderer, scene, camera);
    this.layer.programs = (finish, mode) => this.prewarm(finish, mode);
    // Before the first compile: the shell's program (and its precompiled twins) carry the charts.
    if (this.f4tUniforms) {
      installF4tShader(this.shellMaterial()!, this.f4tUniforms);
      this.f4tSets = new F4tSets(renderer);
    }
  }

  private shellMaterial() {
    return (this.layer as unknown as { material?: MeshPhysicalMaterial }).material;
  }

  /** The look programs for the canvas (tone mapped, sRGB) and the shadow casters' depth. */
  private prewarm(finish: Finish, mode: GarmentMode) {
    let shell: { look: import('three').Object3D[]; xray: import('three').Object3D[] } | undefined;
    const stand = () => (shell ??= this.layer.programStandIns(finish, this.weave));
    const lookSet = () => [
      ...stand().look,
      ...detailMaterialVariants().map((material) => standIn(material)),
      standIn(HoodLayer.programTwin(finish, this.weave)),
    ];
    const canvas = () => this.programs.compile(`look:${finish}`, null, lookSet);
    const casters = () =>
      this.programs.compile(`casters:${finish}`, this.shadowKey, () => [
        ...stand().look,
        shadowDepthStandIn(FrontSide),
        shadowDepthStandIn(DoubleSide),
      ]);
    const glue = () => this.programs.compile(`glue:${finish}`, this.glueKey, lookSet);
    void mode; // AR draws the product look only
    if (!this.f4x.warm) return Promise.all([canvas(), casters(), glue()]).then(() => undefined);
    // F4X cold start: the AR draws the jacket into the glue's offscreen target and the shadow
    // map; only the lab's glue-off path draws it straight to the canvas. Each set is ~6 programs
    // (two of ~105 k characters) and the driver takes them in the order submitted, so the
    // offscreen set goes first and decides `ready`; the canvas set follows (canvasReady).
    const offscreen = Promise.all([glue(), casters()]).then(() => undefined);
    void offscreen.then(canvas);
    return offscreen;
  }

  private idleWarmed = false;
  /**
   * F4X (?f4xwarm=1): with the shown jacket fully ready, compiles the other finishes' programs,
   * once, so a later jacket of another finish starts warm (the driver keeps linked programs for
   * the browser's life and in its disk cache: a second page finds them in milliseconds). The
   * caller invokes it only while nothing is drawn (nobody in view), so the compile never competes
   * with a frame.
   */
  prewarmIdle() {
    if (!this.f4x.warm || this.idleWarmed || !this.ready || !this.canvasReady) return;
    this.idleWarmed = true;
    for (const finish of Object.keys(materials) as Finish[]) void this.prewarm(finish, 'normal');
  }

  /** True when the programs of a draw straight to the canvas (glue off) are linked. */
  get canvasReady() {
    if (!this.f4x.warm) return true;
    return !!this.asset && this.programs.ready(`look:${finishOf(this.asset)}`);
  }

  /**
   * F4X (?f4xwarm=1): true while `asset`'s kiosk look is on its way (programs compiling, geometry
   * building), so the caller draws no jacket rather than a wrong one. False once it is shown, and
   * false when it failed or does not fit the source (the caller's own fallback draws then).
   */
  pending(asset: ClothAsset, canvas = false) {
    if (!this.f4x.warm || asset === this.failed) return false;
    if (this.loading === asset) return true;
    return this.ready && this.asset === asset && canvas && !this.canvasReady;
  }

  /** Shows `asset` (once per asset; resolves when it can be drawn without a stall). */
  async setAsset(asset: ClothAsset) {
    if (this.asset === asset || this.loading === asset || this.failed === asset) return;
    this.loading = asset;
    this.ready = false;
    this.timing = { requestedAt: performance.now() };
    // Same promise as show()'s own wait (ProgramWarmup caches each batch): only a timestamp.
    void this.layer.programs?.(finishOf(asset), 'normal').then(() => {
      if (this.loading === asset) this.timing.programsAt = performance.now();
    });
    try {
      await this.layer.preview(asset);
    } catch (error) {
      // Never leave the AR waiting on a look that cannot be built: the caller's fallback draws.
      if (this.loading === asset) {
        this.loading = undefined;
        this.failed = asset;
      }
      console.error('[ar] kiosk-look jacket failed', error);
      return;
    }
    if (this.loading !== asset) return;
    // F4T: the photo set is fetched and uploaded before the jacket counts as ready, so its first
    // drawn frame already wears it (no pop-in, no texture upload on a tracked frame). Flag off:
    // no await, the control flow is the old one.
    if (this.f4tUniforms) {
      // Never leave the jacket waiting on its photos: without them it is drawn as before.
      await this.loadF4t(asset).catch((error) => console.error('[ar] f4tex set failed', error));
      if (this.loading !== asset) return;
    }
    // preview() ignores solver frames afterwards; live frames take the kiosk solver's path.
    (this.layer as unknown as { activeKey?: string }).activeKey = asset.key;
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
    this.lastSource = undefined;
    this.lastVersion = undefined;
    this.asset = asset;
    this.loading = undefined;
    this.ready = true;
    this.timing.readyAt = performance.now();
  }

  /**
   * F4T: points the shell's chart samplers at the jacket's local photo set, if this machine has
   * one (else the coverage stays 0 = the drawn look). Never rejects: a set that cannot be read
   * is no set.
   */
  private async loadF4t(asset: ClothAsset) {
    const uniforms = this.f4tUniforms;
    if (!uniforms || !this.f4tSets) return;
    uniforms.gF4tOn.value.set(0, 0, 0);
    this.f4tGain = undefined;
    const mesh = (this.layer as unknown as { mesh?: Mesh<BufferGeometry> }).mesh;
    const arc = mesh?.geometry.getAttribute('_g_arc')?.array;
    const charts = arc ? f4tCharts(asset, arc) : null;
    if (this.f4t.debug)
      console.error(
        '[f4tex] charts ' +
          JSON.stringify({
            finish: asset.finish,
            colour: asset.colour,
            charts,
            details: asset.render_details,
            rest: asset.rest_measurements_cm,
            loft: asset.maximum_loft_m,
          }),
      );
    if (!charts) return;
    const set = await this.f4tSets.load(F4T_SET[finishOf(asset)]);
    if (this.f4t.debug) console.error('[f4tex] set ' + JSON.stringify(set?.meta ?? null));
    if (!set || this.loading !== asset) return;
    applyF4tCharts(uniforms, charts, set.meta);
    if (set.front) uniforms.gF4tFront.value = set.front;
    if (set.back) uniforms.gF4tBack.value = set.back;
    if (set.sleeve) uniforms.gF4tSleeve.value = set.sleeve;
    // The look's camera adaptation (F4X, ?f4light=1) multiplies the drawn jacket afterwards.
    const adapt = readF4Flags().light ? cameraAdaptation(asset.colour).gain : [1, 1, 1];
    const albedo = f4tAlbedo(asset.colour, set.meta.chroma, adapt);
    const base = hexToLinear(asset.colour);
    uniforms.gF4tAlbedo.value.set(albedo[0], albedo[1], albedo[2]);
    uniforms.gF4tOn.value.set(set.front ? 1 : 0, set.back ? 1 : 0, set.sleeve ? 1 : 0);
    this.f4tGain = [albedo[0] / base[0], albedo[1] / base[1], albedo[2] / base[2]];
    this.hideDrawnUnderPhotos(!!set.front, !!set.back);
    if (this.f4t.debug) console.error('[f4tex] albedo ' + JSON.stringify({ albedo, adapt }));
  }

  /**
   * F4T: where a torso photo is the albedo, the features the shell draws there itself are the
   * photo's own now. The drawn pockets (relief and roughness a few cm from the photographed
   * ones: look job 05c482 showed two pockets side by side) and the drawn torso logos (their
   * roughness patch) are switched off; the sleeve lettering (decal region 3) stays. The shell
   * sets both again on its next show(), and loadF4t runs after every show().
   */
  private hideDrawnUnderPhotos(front: boolean, back: boolean) {
    const layer = this.layer as unknown as {
      uniforms?: { gPockets?: { value: number } };
      decalUniforms?: { gDecalA?: { value: { x: number }[] } };
    };
    if (front && layer.uniforms?.gPockets) layer.uniforms.gPockets.value = 0;
    for (const a of layer.decalUniforms?.gDecalA?.value ?? [])
      if ((front && a.x > 0.5 && a.x < 1.5) || (back && a.x > 1.5 && a.x < 2.5)) a.x = 0;
  }

  /**
   * F4T: the uncovered surfaces (collar, chart edges, the padded hood) in the photo-calibrated
   * albedo: the product colour times `gain`, set every frame (absolute, never compounding).
   */
  private applyF4tGain() {
    const [r, g, b] = this.f4tGain ?? [1, 1, 1];
    this.shellMaterial()?.color.setRGB(r, g, b);
    this.layer.hood?.mesh.material.color.setRGB(r, g, b);
  }

  /**
   * Copies the avatar's skinned jacket in. False when the shown asset is not the avatar's, or
   * (`canvas`: the draw goes straight to the canvas) while that pass's programs still compile.
   */
  update(source: KioskJacketSource, dt: number, canvas = false) {
    const snapshot = this.snapshot;
    const positions = source.jacketPositions();
    if (!this.ready || !snapshot || !positions || source.jacketAsset !== this.asset) return false;
    if (canvas && !this.canvasReady) return false;
    if (positions.length !== snapshot.positions.length) return false;
    // A source version certifies unchanged geometry; still run time-based hood/zip animation.
    if (
      source !== this.lastSource ||
      source.version === undefined ||
      source.version !== this.lastVersion ||
      this.collarDrop !== this.lastCollarDrop
    ) {
      snapshot.positions.set(positions);
      this.collarDropApplied =
        this.collarDrop > 0 && this.asset
          ? lowerCollarFront(
              snapshot.positions,
              this.asset.panels,
              this.asset.paths,
              this.collarDrop,
            )
          : 0;
      this.lastCollarDrop = this.collarDrop;
      if (this.flatFront && this.asset)
        this.flatRemoved = flattenFront(snapshot.positions, this.asset.panels, this.asset.paths);
      if (this.flatAcross && this.asset)
        this.flatXRaised = flattenAcross(snapshot.positions, this.asset.panels, this.asset.paths);
      const joints = (source as { joints?: Joints }).joints;
      if (this.tubeSleeve && this.asset && joints) {
        const asset = this.asset;
        let seam = this.seams.get(asset);
        if (!seam) {
          seam = seamWeights(asset.panels, asset.triangles, asset.initial);
          this.seams.set(asset, seam);
        }
        this.tubeRemoved = tubeSleeves(snapshot.positions, asset.panels, joints, seam);
      }
      if (this.edges && this.restLengths)
        compressionField(snapshot.positions, this.edges, this.restLengths, snapshot.compression);
      this.layer.cloth.onFrame?.(snapshot);
      this.lastSource = source;
      this.lastVersion = source.version;
    }
    this.layer.update(dt);
    if (this.hoodDown) this.drapeHood();
    if (this.f4x.look) this.applyArLook();
    if (this.f4tUniforms) this.applyF4tGain();
    return true;
  }

  /**
   * F4X (?f4xlook=1): the shell's material as the venue camera sees the real jacket
   * (finish/config.ts AR_LOOK: absolute values per finish, set every frame, never compounding).
   * Uniform values only: sheen keeps its on/off state, so the program key (and the precompiled
   * program) is the kiosk's.
   */
  private applyArLook() {
    const material = this.shellMaterial();
    if (!material || !this.asset) return;
    const finish = finishOf(this.asset);
    const look = AR_LOOK[finish];
    material.roughness = look.roughness;
    material.specularIntensity = look.specularIntensity;
    material.envMapIntensity = look.envMapIntensity;
    // USE_SHEEN is in the program key: a finish with sheen keeps a non-zero one.
    material.sheen = materials[finish].sheen > 0 ? Math.max(1e-3, look.sheen) : 0;
    material.sheenRoughness = look.sheenRoughness;
  }

  /**
   * Drapes the hood ONCE per hood instance, in its baked rest shape (the shape every fit onto the
   * shell starts from): the hood lies down for good, so each later fit already yields the draped
   * hood and nothing runs per frame (the per-fit version cost ≈ 2 fps on the kiosk, F2 19:23).
   */
  private drapeHood() {
    const hood = this.layer.hood;
    if (!hood || this.drapedHoods.has(hood)) return;
    this.drapedHoods.add(hood);
    const internals = hood as unknown as { base?: Float32Array; refresh?: () => void };
    const g = hood.mesh.geometry;
    const sigma = g.getAttribute('_sigma'),
      attach = g.getAttribute('_attach');
    if (!internals.base || !sigma || !attach) return;
    this.hoodDraped = drapeHood(
      internals.base,
      sigma.array as ArrayLike<number>,
      attach.array as ArrayLike<number>,
    );
    internals.refresh?.call(hood);
  }

  dispose() {
    this.layer.dispose();
    this.programs.dispose();
    this.shadowKey.dispose();
    this.glueKey.dispose();
    this.weave.dispose();
    this.f4tSets?.dispose();
  }
}
