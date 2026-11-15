import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  FrontSide,
  Group,
  Mesh,
  MeshDepthMaterial,
  MeshPhysicalMaterial,
  RGBADepthPacking,
  Float32BufferAttribute,
  Color,
  CanvasTexture,
  Vector3,
  type Object3D,
  type Side,
  type Texture,
} from 'three';
import { standIn, twin } from './programWarmup';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { disposeObject } from './dispose';
import { morphProgress, type GarmentMode } from './garmentMath';
import { api, type ClothAsset } from '../api';
import { ClothClient, type SettledCloth } from './cloth/ClothClient';
import { smoothNormals } from './cloth/normals';
import type { ClothSnapshot } from './cloth/ClothSolver';
import { FabricSurface } from './cloth/fabric';
import {
  garmentUniformValues,
  garmentVertexDeclaration,
  garmentVertexDisplacement,
  garmentFragmentDeclaration,
  garmentNormal,
  garmentColour,
  type GarmentUniforms,
} from './garmentShader';
import { garmentCoordinates } from './garmentSurface';
import { look, materials, type Finish } from './garmentLook';
import { weaveNormalTexture } from './garmentMaterials';
import { GarmentDetails } from './garmentDetails';
import { HoodLayer } from './hood/HoodLayer';
import { indexWithoutHood } from './hood/hoodFit';
import {
  buildDecalAtlas,
  decalColour,
  decalFragmentDeclaration,
  decalUniformValues,
  sleeveDecalFrame,
} from './garmentDecals';

/** Logo mask atlas, shared by every garment layer (built on first use, never mutated). */
let decalAtlas: CanvasTexture | undefined;

/** Placeholder asset used only to enumerate the shader's uniform names before any load. */
function emptyAsset(): ClothAsset {
  // Only `panels`, `finish` and `maximum_loft_m` are read by garmentUniformValues.
  return { panels: [], finish: 'satin_matte', maximum_loft_m: 0 } as unknown as ClothAsset;
}

/** The shell finish an asset is drawn with (unknown values draw as satin, as before). */
export function finishOf(asset: Pick<ClothAsset, 'finish'>): Finish {
  return asset.finish === 'glossy_ripstop' ? 'glossy_ripstop' : 'satin_matte';
}

/** Ripstop nylon vs satin-matte polyester (Part E); values are look conventions. */
function applyFinish(material: MeshPhysicalMaterial, finish: Finish, weave: Texture) {
  const m = materials[finish];
  material.roughness = m.roughness;
  material.metalness = 0;
  material.specularIntensity = m.specularIntensity;
  material.envMapIntensity = m.envMapIntensity;
  material.clearcoat = m.clearcoat;
  material.clearcoatRoughness = m.clearcoatRoughness;
  material.sheen = m.sheen;
  material.sheenRoughness = m.sheenRoughness;
  material.sheenColor.set(0xffffff);
  material.anisotropy = m.anisotropy;
  material.normalMap = weave;
  material.normalScale.set(m.normalScale, m.normalScale);
}

/**
 * Program stand-ins of a garment shell `material` and its shadow `caster` for `finish` (see
 * GarmentLayer.programStandIns): twins in exactly the states the shell is drawn in.
 */
export function garmentStandIns(
  material: MeshPhysicalMaterial,
  caster: MeshDepthMaterial,
  finish: Finish,
  weave: Texture,
): { look: Object3D[]; xray: Object3D[] } {
  const shell = twin(material);
  applyFinish(shell, finish, weave);
  shell.side = DoubleSide;
  shell.transparent = false;
  const xray = (side: Side) => {
    const pass = twin(shell);
    pass.transparent = true;
    pass.side = side;
    return standIn(pass);
  };
  const depth = twin(caster);
  depth.side = DoubleSide; // WebGLShadowMap: the depth side of a DoubleSide caster
  return { look: [standIn(shell), standIn(depth)], xray: [xray(BackSide), xray(FrontSide)] };
}

const settledCache = new Map<string, { asset: ClothAsset; state: SettledCloth }>();
let foregroundShows = 0;
/** GarmentLayer.seedAsset (Fit Lab hook): assets the page already holds, by `fitId:size`. */
const seededAssets = new Map<string, ClothAsset>();

function wrappedSnapshot(asset: ClothAsset): ClothSnapshot {
  const n = asset.panels.length;
  return {
    assetKey: asset.key,
    positions: new Float32Array(asset.initial),
    gap: new Float32Array(n),
    strain: new Float32Array(n),
    compression: new Float32Array(n * 4),
    energy: 0,
    simulatedSeconds: 0,
    gapValid: false,
    strainValid: false,
  };
}

async function backgroundIdle(signal?: AbortSignal) {
  while (foregroundShows > 0 && !signal?.aborted)
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
}

export interface SizeSwitchTiming {
  cached: boolean;
  assetMs: number;
  geometryMs: number;
  morphMs: number;
  shownMs: number;
  /** Wait for the shader programs to be linked before the first draw (programWarmup). */
  programsMs?: number;
  workerReadyMs?: number;
  workerCancelled?: boolean;
}

export function sameTopology(a: BufferGeometry, b: BufferGeometry) {
  const ai = a.index,
    bi = b.index;
  return (
    a.getAttribute('position').count === b.getAttribute('position').count &&
    ai !== null &&
    bi !== null &&
    ai.count === bi.count &&
    ai.array.every((value, i) => value === bi.array[i])
  );
}

export class GarmentLayer extends Group {
  lastSwitchTiming?: SizeSwitchTiming;
  private mesh?: Mesh<BufferGeometry, MeshPhysicalMaterial>;
  private generation = 0;
  private mode: GarmentMode = 'normal';
  private uniforms: {
    fitMode: { value: number };
    tight: { value: number };
    loose: { value: number };
    grabFade: { value: number };
    grabActive: { value: number };
    tensionScale: { value: number };
    gNormalOut: { value: number };
  } & {
    [K in keyof GarmentUniforms]: { value: number };
  } = {
    fitMode: { value: 0 },
    tight: { value: 0.5 },
    loose: { value: 3 },
    // Hand pull (M4): tension map around the grab (fades after release) and patch highlight.
    grabFade: { value: 0 },
    grabActive: { value: 0 },
    tensionScale: { value: 0.05 },
    // 1 while the AO pass renders its normal/depth buffer (see show()).
    gNormalOut: { value: 0 },
    ...(Object.fromEntries(
      Object.keys(garmentUniformValues(emptyAsset(), 0)).map((k) => [k, { value: 0 }]),
    ) as { [K in keyof GarmentUniforms]: { value: number } }),
  };
  private surface?: FabricSurface;
  private activeKey?: string;
  private shownAsset?: ClothAsset;
  private transition?: {
    target: BufferGeometry;
    from: Record<string, Float32Array>;
    elapsed: number;
  };
  readonly cloth = new ClothClient();
  private backgroundCloth?: ClothClient;
  private preloadGeneration = 0;
  private morphDone?: () => void;
  private material = new MeshPhysicalMaterial({
    roughness: 0.6,
    metalness: 0,
    vertexColors: true,
    side: DoubleSide,
    allowOverride: false, // see the AO note in show()
  });
  /**
   * Shadow caster with the same outward relief as the shown surface (L2). The default depth
   * material cast the shadow of the undisplaced inner (fit) surface, up to one loft inside the
   * drawn jacket, so the drawn surface fell into its own shadow along the sleeves: the hard
   * vertical line down each sleeve.
   */
  private depthMaterial = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  private fabric?: CanvasTexture;
  private finish?: Finish;
  /** Logos and lettering (garmentDecals): atlas sampler + per-decal placement arrays. */
  private decalUniforms = {
    gDecalTex: { value: (decalAtlas ??= buildDecalAtlas()) },
    gDecalSleeve: { value: new Vector3() },
    ...Object.fromEntries(
      Object.entries(decalUniformValues({})).map(([k, v]) => [k, { value: v }]),
    ),
  };
  /** Render-only hardware (pullers, toggles) bound to garment triangles. */
  readonly details = new GarmentDetails();
  /**
   * Agent H: the padded hood (baked GLB) drawn instead of the shell's thin hood panel 7, fitted
   * onto the shell's hood seam on every shown shell / cloth frame. Undefined while loading, when
   * the jacket has no hood, or if its asset failed (the shell's own hood is drawn then).
   */
  hood?: HoodLayer;
  private hoodKind = 0;
  private hoodIndex?: { key: string; full: number[]; hidden: number[] };
  private shellHoodForced = false;
  /**
   * Padded hood health (counted, never a console error): fits done, fallbacks to the shell's
   * own hood (asset load or fit impossible) and the last fallback's reason.
   */
  readonly hoodStats = { fits: 0, fallbacks: 0, lastFallback: '' };
  /** Asset whose hood fit failed: the shell's own hood is drawn for it (no refit per frame). */
  private hoodFailedKey?: string;
  /**
   * Set by the Viewer: resolves once every program this layer draws for `finish` in `mode` is
   * compiled and linked (programWarmup). show() waits for it before the shell is drawn, so a
   * cold GPU shader cache costs a wait behind the dressing message instead of a frozen page.
   */
  programs?: (finish: Finish, mode: GarmentMode) => Promise<void>;
  constructor() {
    super();
    this.add(this.details);
    this.cloth.onFrame = (state) => {
      if (!this.mesh || this.transition || state.assetKey !== this.activeKey) return;
      const geometry = this.mesh.geometry;
      const position = geometry.getAttribute('position');
      if (position.count !== state.positions.length / 3) return;
      position.array.set(state.positions);
      position.needsUpdate = true;
      if (state.gapValid) {
        const gap = geometry.getAttribute('_inner_gap_cm');
        gap.array.set(state.gap);
        gap.needsUpdate = true;
      }
      if (state.strainValid) {
        const strain = geometry.getAttribute('_strain');
        strain.array.set(state.strain);
        strain.needsUpdate = true;
      }
      const normal = geometry.getAttribute('normal');
      if (this.surface) this.surface.update(position.array, state.compression);
      if (this.surface) this.details.update(position.array, undefined, normal.array);
      else if (normal.array instanceof Float32Array && geometry.index) {
        smoothNormals(position.array, geometry.index.array, normal.array);
        normal.needsUpdate = true;
      }
      geometry.computeBoundingSphere();
      this.fitHood();
    };
    this.depthMaterial.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader =
        garmentVertexDeclaration +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n' + garmentVertexDisplacement,
        );
    };
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms, this.decalUniforms);
      shader.vertexShader =
        garmentVertexDeclaration +
        'attribute float _inner_gap_cm; attribute float _strain; attribute float _hardware; attribute vec2 _grab; varying float fitGap; varying float fitElastic; varying float fitStrain; varying float fitMetal; varying vec2 fitGrab;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n' +
            garmentVertexDisplacement +
            '\nfitGap = _inner_gap_cm; fitElastic = _elastic_gather; fitStrain = _strain; fitMetal=_hardware; fitGrab = _grab;',
        );
      shader.fragmentShader =
        'uniform float gNormalOut; uniform float fitMode; uniform float tight; uniform float loose; uniform float grabFade; uniform float grabActive; uniform float tensionScale; varying float fitGap; varying float fitElastic; varying float fitStrain; varying float fitMetal; varying vec2 fitGrab;\n' +
        shader.fragmentShader
          .replace(
            '#include <common>',
            '#include <common>\n' + garmentFragmentDeclaration + decalFragmentDeclaration,
          )
          .replace(
            '#include <normal_fragment_maps>',
            '#include <normal_fragment_maps>\n' +
              garmentNormal +
              // AO normal/depth pass: the view-space relief normal, as MeshNormalMaterial writes
              // it; the lighting after this is skipped (uniform branch, costs nothing otherwise).
              '\nif (gNormalOut > .5) { gl_FragColor = vec4(normalize(normal) * .5 + .5, 1.); return; }',
          )
          .replace(
            '#include <clearcoat_normal_fragment_begin>',
            '#include <clearcoat_normal_fragment_begin>\n#ifdef USE_CLEARCOAT\nclearcoatNormal = gClearN;\n#endif',
          )
          .replace(
            '#include <metalnessmap_fragment>',
            '#include <metalnessmap_fragment>\nmetalnessFactor = max(metalnessFactor, max(fitMetal, gMetal));',
          )
          .replace(
            '#include <roughnessmap_fragment>',
            '#include <roughnessmap_fragment>\nroughnessFactor = gRough >= 0. ? gRough : mix(roughnessFactor, .28, max(fitMetal, gMetal));',
          )
          .replace(
            '#include <lights_physical_fragment>',
            '#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\nmaterial.clearcoat *= gCoat;\n#endif',
          )
          .replace(
            '#include <aomap_fragment>',
            `#include <aomap_fragment>
          reflectedLight.indirectDiffuse *= gAO;
          reflectedLight.indirectSpecular *= mix(1., gAO, .85);
          reflectedLight.directDiffuse *= mix(1., gAO, .6);
          reflectedLight.directSpecular *= mix(1., gAO, .7);`,
          )
          .replace(
            '#include <color_fragment>',
            `#include <color_fragment>
        ${garmentColour}
        ${decalColour}
        if (fitMode > 1.5 && fitMode < 2.5) {
          float t = clamp((fitGap-tight)/(loose-tight), 0.0, 1.0);
          vec3 red = vec3(.95,.2,.16), green = vec3(.2,.8,.4), blue = vec3(.2,.48,.96);
          diffuseColor.rgb = t < .5 ? mix(red,green,t*2.0) : mix(green,blue,t*2.0-1.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.56,.62,.63), smoothstep(.1,.5,fitElastic));
        } else if (fitMode > 2.5) {
          float strain = clamp(fitStrain / .03,0.0,1.0);
          diffuseColor.rgb=mix(vec3(.12,.3,.8),vec3(1.,.12,.04),strain);
        }
        if (grabFade > .001 && fitMode < .5) {
          // Live tension map (CLO style) near the hand: blue = relaxed, red = at the clamp.
          float s = clamp(fitStrain / tensionScale, 0.0, 1.0);
          vec3 tension = mix(vec3(.16,.42,.95), vec3(1.,.16,.05), s);
          diffuseColor.rgb = mix(diffuseColor.rgb, tension, grabFade * fitGrab.y * (.3 + .6 * s));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.24,.86,.46), grabActive * fitGrab.x * .55);
        }`,
          )
          .replace(
            '#include <dithering_fragment>',
            `
        if (fitMode > .5 && fitMode < 1.5) {
          float rim = pow(1.0-abs(dot(normalize(normal),normalize(vViewPosition))), 2.0);
          gl_FragColor.rgb += vec3(.25,.7,.6)*rim;
          gl_FragColor.a = .3 + .35*rim;
        }
        #include <dithering_fragment>`,
          );
    };
  }
  setMode(mode: GarmentMode, tightCm = 0.5, looseCm = 3) {
    this.cloth.setMode(mode);
    this.mode = mode;
    this.uniforms.fitMode.value =
      mode === 'normal' ? 0 : mode === 'xray' ? 1 : mode === 'heatmap' ? 2 : 3;
    this.uniforms.tight.value = tightCm;
    this.uniforms.loose.value = looseCm;
    const transparent = mode === 'xray';
    if (this.material.transparent !== transparent) this.material.needsUpdate = true;
    this.material.transparent = transparent;
    this.material.depthWrite = !transparent;
    this.material.opacity = transparent ? 0.3 : 1;
    // Opaque hardware would hide the body in X-ray; it belongs to the product look only.
    this.details.visible = mode === 'normal';
    if (this.mesh) this.mesh.castShadow = !transparent;
    this.showHood();
  }
  /** Finish of the shell material now (undefined before the first shown asset). */
  get finishShown(): Finish | undefined {
    return this.finish;
  }
  /**
   * Stand-ins with the program keys this layer draws for `finish` (programWarmup; never drawn):
   * `look` = the shell in the product look and its shadow caster; `xray` = the shell in X-ray,
   * whose transparent double-sided material WebGLRenderer draws in two passes (back faces,
   * then front faces), one program each. `weave` only marks the normal map as present.
   */
  programStandIns(finish: Finish, weave: Texture) {
    return garmentStandIns(this.material, this.depthMaterial, finish, weave);
  }
  /**
   * Fit Lab hook (agent FL, prompt 33; unused = unchanged): cloth assets the page already holds
   * (the Fit Lab's preloaded S/M/L shells), so simulate() does not fetch them again (a re-fetch
   * can wait seconds when the service has evicted and rebuilds the asset).
   */
  static seedAsset(fitId: string, size: string, asset: ClothAsset) {
    seededAssets.set(`${fitId}:${size}`, asset);
    if (seededAssets.size > 12) seededAssets.delete(seededAssets.keys().next().value!);
  }
  async simulate(fitId: string, size: string, signal?: AbortSignal) {
    foregroundShows++;
    try {
      const generation = ++this.generation;
      const started = performance.now();
      const key = `${fitId}:${size}`;
      const cached = settledCache.get(key);
      const timing: SizeSwitchTiming = {
        cached: !!cached,
        assetMs: 0,
        geometryMs: 0,
        morphMs: 0,
        shownMs: 0,
      };
      this.lastSwitchTiming = timing;
      const asset =
        cached?.asset ?? seededAssets.get(key) ?? (await api.cloth(fitId, size, signal));
      timing.assetMs = performance.now() - started;
      if (signal?.aborted || generation !== this.generation)
        throw new Error('Cloth request cancelled');
      // Collision field (16 MB) downloads while the jacket geometry is built (shared cache).
      if (!cached) api.sdf(asset).catch(() => undefined); // errors surface from settle()
      const preview: ClothSnapshot = cached?.state ?? wrappedSnapshot(asset);
      // Initialise physics while the render thread morphs. The displayed static shell does
      // not depend on worker setup; hand pulling continues to await ClothClient.ready().
      const settling = this.cloth.settle(asset, cached?.state);
      void settling.catch(() => undefined); // surfaced below, including after a slow morph
      void settling.then(
        () => {
          timing.workerReadyMs = performance.now() - started;
        },
        (error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError')
            timing.workerCancelled = true;
        },
      );
      await this.show(asset, preview, !!cached, timing);
      timing.shownMs = performance.now() - started;
      if (signal?.aborted || generation !== this.generation)
        throw new Error('Cloth request cancelled');
      const keep = (state: SettledCloth) => {
        settledCache.set(key, { asset, state });
        if (settledCache.size > 64) settledCache.delete(settledCache.keys().next().value!);
      };
      if (asset.config.maxSeconds === 0) {
        // Static shell (no relax): the computed wrap shown above is the displayed state. The
        // worker's solver (collision field, hand pull, tension/gap maps) builds in the
        // background; physics calls wait for it (ClothClient.ready).
        settling.then(
          (state) => {
            keep(state);
            if (generation !== this.generation) return;
            this.cloth.onFrame?.(state);
          },
          (error: unknown) => {
            if (!(error instanceof DOMException && error.name === 'AbortError'))
              console.error('Cloth physics did not load', error);
          },
        );
        const state: SettledCloth = {
          ...preview,
          energy: 0,
          elapsedMs: performance.now() - started,
          cached: !!cached,
          meanStepMs: null,
          stopReason: 'static',
        };
        // Cache the actual shown shell now, even if the judge switches away before its
        // worker is ready. Maps remain explicitly invalid until that worker computes them.
        keep(state);
        return { asset, state };
      }
      const state = await settling;
      if (signal?.aborted || generation !== this.generation)
        throw new Error('Cloth request cancelled');
      this.cloth.onFrame?.(state);
      keep(state);
      return { asset, state };
    } finally {
      foregroundShows--;
    }
  }
  async preview(asset: ClothAsset) {
    const n = asset.panels.length;
    const state: ClothSnapshot = {
      assetKey: asset.key,
      positions: new Float32Array(asset.initial),
      gap: new Float32Array(n),
      strain: new Float32Array(n),
      compression: new Float32Array(n * 4),
      energy: 0,
      simulatedSeconds: 0,
      gapValid: false,
      strainValid: false,
    };
    await this.show(asset, state, false);
    this.activeKey = undefined; // Lab inspection: ignore frames from a previous relaxation.
    return state;
  }
  private async show(
    asset: ClothAsset,
    state: ClothSnapshot,
    morph: boolean,
    timing?: SizeSwitchTiming,
  ) {
    const finish = finishOf(asset);
    if (this.programs) {
      // Never draw a program that is still compiling: its first use would block the page until
      // the driver is done (5–8 s per garment program on a cold cache, docs/STATUS-kiosk.md S).
      const generation = this.generation,
        waitStarted = performance.now();
      await this.programs(finish, this.mode);
      if (timing) timing.programsMs = performance.now() - waitStarted;
      if (generation !== this.generation) return;
    }
    const buildStarted = performance.now();
    this.activeKey = asset.key;
    this.shownAsset = asset;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(state.positions, 3));
    geometry.setIndex(asset.triangles);
    // Same hood kind still shown: start without panel 7 so a size morph keeps its topology.
    if (this.hood?.visible && (asset.render_details?.hood_kind ?? 0) === this.hoodKind)
      geometry.setIndex(Array.from(indexWithoutHood(asset)));
    geometry.setAttribute('_inner_gap_cm', new Float32BufferAttribute(state.gap, 1));
    geometry.setAttribute('_elastic_gather', new Float32BufferAttribute(asset.elastic, 1));
    geometry.setAttribute('_strain', new Float32BufferAttribute(state.strain, 1));
    geometry.setAttribute(
      '_grab',
      new Float32BufferAttribute(new Float32Array((state.positions.length / 3) * 2), 2),
    );
    geometry.setAttribute(
      '_hardware',
      new Float32BufferAttribute(
        asset.panels.map((p) => (p === 8 ? 1 : 0)),
        1,
      ),
    );
    const colours = new Float32Array(asset.panels.length * 3);
    const base = new Color(asset.colour);
    for (let i = 0; i < asset.panels.length; i++) colours.set([base.r, base.g, base.b], i * 3);
    geometry.setAttribute('color', new Float32BufferAttribute(colours, 3));
    geometry.computeVertexNormals();
    const surface = new FabricSurface(asset, geometry, state.compression);
    surface.update(state.positions);
    this.surface = surface;
    // Seam-free material charts for the look-dev shader (computed on the shown wrap).
    const coordinates = garmentCoordinates(asset, asset.initial);
    geometry.setAttribute('_quilt_uv', new Float32BufferAttribute(coordinates.quiltUv, 2));
    geometry.setAttribute('_g_arc', new Float32BufferAttribute(coordinates.arc, 4));
    geometry.setAttribute('_g_seam', new Float32BufferAttribute(coordinates.seam, 1));
    geometry.setAttribute('_g_rest', new Float32BufferAttribute(asset.rest, 3));
    // Weave micro-normal and anisotropy tangent in material metres, one tile per weaveTileM.
    geometry.setAttribute(
      'uv',
      new Float32BufferAttribute(
        coordinates.weaveUv.map((v) => v / look.weaveTileM),
        2,
      ),
    );
    for (const [name, value] of Object.entries(
      garmentUniformValues(asset, coordinates.collarHeight),
    ))
      this.uniforms[name as keyof GarmentUniforms].value = value;
    const sleeveFrame = sleeveDecalFrame(asset, asset.initial);
    this.decalUniforms.gDecalSleeve.value.set(
      sleeveFrame.outer,
      sleeveFrame.circumference,
      sleeveFrame.flip,
    );
    for (const [name, value] of Object.entries(decalUniformValues(asset.render_details ?? {})))
      (this.decalUniforms as Record<string, { value: unknown }>)[name].value = value;
    geometry.computeBoundingSphere();
    this.details.build(asset, coordinates, state.positions);
    if (timing) timing.geometryMs = performance.now() - buildStarted;
    this.morphDone?.();
    this.morphDone = undefined;
    this.transition?.target.dispose();
    this.transition = undefined;
    let finished: Promise<void> | undefined;
    if (morph && this.mesh && sameTopology(this.mesh.geometry, geometry)) {
      const from: Record<string, Float32Array> = {};
      for (const name of Object.keys(geometry.attributes))
        from[name] = Float32Array.from(this.mesh.geometry.getAttribute(name).array);
      this.transition = { target: geometry, from, elapsed: 0 };
      finished = new Promise<void>((resolve) => {
        this.morphDone = resolve;
      });
    } else {
      if (this.mesh) {
        this.mesh.geometry.dispose();
        this.remove(this.mesh);
      }
      this.mesh = new Mesh(geometry, this.material);
      this.mesh.customDepthMaterial = this.depthMaterial;
      // The AO pass (Viewer GTAO) renders its normal/depth buffer with one override material
      // for the whole scene: the garment there was its undisplaced inner (fit) surface, up to one
      // loft inside the drawn jacket, so the AO saw the torso behind the drawn sleeve and
      // darkened it up to the inner sleeve's outline: the hard vertical line down each sleeve
      // (L2, A/B: gone with the AO pass off, unchanged with every shadow caster off). The garment
      // keeps its own material in that pass and writes its displaced depth and relief normal.
      this.mesh.onBeforeRender = (_renderer, scene) => {
        this.uniforms.gNormalOut.value =
          'overrideMaterial' in scene && scene.overrideMaterial ? 1 : 0;
      };
    }
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1;
    this.add(this.mesh);
    if (finish !== this.finish) {
      this.fabric?.dispose();
      this.fabric = weaveNormalTexture(finish === 'glossy_ripstop');
      applyFinish(this.material, finish, this.fabric);
      this.material.needsUpdate = true;
      this.finish = finish;
    }
    this.setMode(this.mode);
    void this.syncHood(asset);
    if (finished) {
      const morphStarted = performance.now();
      await finished;
      if (timing) timing.morphMs = performance.now() - morphStarted;
    }
  }
  /** The displayed garment mesh (vertices = cloth particles) and its asset, for hand picking. */
  get pickTarget() {
    if (!this.mesh || !this.shownAsset || this.transition || !this.activeKey) return undefined;
    return { mesh: this.mesh, asset: this.shownAsset };
  }
  /**
   * Hand pull highlight (M4): `patch` = grabbed particles and weights (green while grabbing);
   * `near` = per-particle 0..1 weight of the tension map around the grab. Null clears both.
   */
  setGrabHighlight(
    patch: { ids: readonly number[]; weights: readonly number[] } | null,
    near?: Float32Array,
  ) {
    const attribute = this.mesh?.geometry.getAttribute('_grab');
    if (!attribute) return;
    const data = attribute.array as Float32Array;
    if (!patch) data.fill(0);
    else {
      for (let i = 0; i < data.length; i += 2) data[i] = 0;
      patch.ids.forEach((id, j) => {
        data[id * 2] = patch.weights[j];
      });
      if (near) for (let i = 0; i < near.length; i++) data[i * 2 + 1] = near[i];
    }
    attribute.needsUpdate = true;
  }
  /** Tension-map opacity (1 while pulling, fading after release) and patch highlight on/off. */
  setGrabFade(fade: number, active: boolean, tensionScale?: number) {
    this.uniforms.grabFade.value = Math.max(0, Math.min(1, fade));
    this.uniforms.grabActive.value = active ? 1 : 0;
    if (tensionScale !== undefined) this.uniforms.tensionScale.value = tensionScale;
  }
  async preload(fitId: string, sizes: string[], current: string, signal?: AbortSignal) {
    const generation = ++this.preloadGeneration;
    const origin = sizes.indexOf(current);
    const order = sizes
      .slice()
      .sort(
        (a, b) =>
          Math.abs(sizes.indexOf(a) - origin) - Math.abs(sizes.indexOf(b) - origin) ||
          sizes.indexOf(b) - sizes.indexOf(a),
      );
    for (const size of order) {
      await backgroundIdle(signal);
      if (signal?.aborted || generation !== this.preloadGeneration) return;
      const key = `${fitId}:${size}`;
      if (size === current || settledCache.has(key)) continue;
      const asset = await api.cloth(fitId, size, signal);
      await backgroundIdle(signal);
      if (signal?.aborted || generation !== this.preloadGeneration) return;
      let state: SettledCloth;
      if (asset.config.maxSeconds === 0) {
        const snapshotStarted = performance.now();
        state = {
          ...wrappedSnapshot(asset),
          elapsedMs: 0,
          cached: false,
          meanStepMs: null,
          stopReason: 'static',
        };
        state.elapsedMs = performance.now() - snapshotStarted;
      } else {
        this.backgroundCloth ??= new ClothClient();
        state = await this.backgroundCloth.settle(asset);
      }
      settledCache.set(key, { asset, state });
      if (settledCache.size > 64) settledCache.delete(settledCache.keys().next().value!);
    }
  }
  async load(fitId: string, size: string, signal?: AbortSignal) {
    this.surface = undefined;
    this.activeKey = undefined;
    this.uniforms.gLoft.value = 0;
    if (!/^[a-f0-9]{64}$/.test(fitId) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,23}$/.test(size))
      throw new Error('Invalid garment identifier');
    const generation = ++this.generation;
    const response = await fetch(`/api/fit/${fitId}/${size}/garment.glb`, {
      signal,
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`Garment geometry unavailable (${response.status})`);
    const gltf = await new GLTFLoader().parseAsync(await response.arrayBuffer(), '');
    if (signal?.aborted || generation !== this.generation) {
      disposeObject(gltf.scene);
      return;
    }
    let source: Mesh | undefined;
    gltf.scene.traverse((object) => {
      if (object instanceof Mesh) source = object;
    });
    if (
      !source ||
      !source.geometry.getAttribute('_gap_cm') ||
      !source.geometry.getAttribute('_inner_gap_cm')
    ) {
      disposeObject(gltf.scene);
      throw new Error('Garment has no computed gap attribute');
    }
    const geometry = source.geometry.clone();
    disposeObject(gltf.scene);
    this.transition?.target.dispose();
    this.transition = undefined;
    if (this.mesh && sameTopology(this.mesh.geometry, geometry)) {
      const from: Record<string, Float32Array> = {};
      for (const name of Object.keys(geometry.attributes)) {
        const attribute = this.mesh.geometry.getAttribute(name);
        if (attribute instanceof BufferAttribute) from[name] = Float32Array.from(attribute.array);
      }
      this.transition = { target: geometry, from, elapsed: 0 };
    } else {
      if (this.mesh) {
        this.mesh.geometry.dispose();
        this.remove(this.mesh);
      }
      this.mesh = new Mesh(geometry, this.material);
      this.mesh.renderOrder = 1;
      this.mesh.receiveShadow = true;
      this.add(this.mesh);
    }
    this.setMode(this.mode, this.uniforms.tight.value, this.uniforms.loose.value);
  }
  update(dt: number) {
    const transition = this.transition;
    if (!transition || !this.mesh) return;
    transition.elapsed += dt * 1000;
    const t = morphProgress(transition.elapsed);
    for (const [name, from] of Object.entries(transition.from)) {
      const attribute = this.mesh.geometry.getAttribute(name);
      const target = transition.target.getAttribute(name);
      if (!(attribute instanceof BufferAttribute) || !(target instanceof BufferAttribute)) continue;
      for (let i = 0; i < from.length; i++)
        attribute.array[i] = from[i] + (target.array[i] - from[i]) * t;
      attribute.needsUpdate = true;
    }
    this.mesh.geometry.computeBoundingSphere();
    this.details.update(
      this.mesh.geometry.getAttribute('position').array,
      undefined,
      this.mesh.geometry.getAttribute('normal').array,
    );
    this.fitHood();
    if (t === 1) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = transition.target;
      this.transition = undefined;
      this.morphDone?.();
      this.morphDone = undefined;
    }
  }
  /** Load the padded hood for this jacket's hood kind (render_details.hood_kind) and fit it. */
  private async syncHood(asset: ClothAsset) {
    const kind = asset.render_details?.hood_kind ?? 0;
    if (kind !== this.hoodKind) {
      this.hoodKind = kind;
      this.hood?.dispose();
      this.hood = undefined;
      if (kind) {
        try {
          const hood = await HoodLayer.load(kind);
          if (!hood || this.hoodKind !== kind) hood?.dispose();
          else {
            this.hood = hood;
            this.add(hood);
          }
        } catch (error) {
          // The shell's own hood stays drawn (showHood keeps the full index); counted.
          this.hoodFallback('load', error);
        }
      }
    }
    this.fitHood();
  }

  /** Refit the hood onto the shell shown now (static wrap, cloth frame or size morph). */
  private fitHood() {
    const asset = this.shownAsset;
    if (!this.hood || !this.mesh || !asset || this.hoodFailedKey === asset.key) return;
    const g = this.mesh.geometry;
    try {
      this.hood.setLook(asset);
      this.hood.fitTo(asset, g.getAttribute('position').array, g.getAttribute('normal').array);
      this.hoodStats.fits++;
    } catch (error) {
      // A fit that is truly impossible: the shell's own hood for this asset, counted.
      this.hoodFailedKey = asset.key;
      this.hoodFallback('fit', error);
    }
    this.showHood();
  }

  private hoodFallback(stage: string, error: unknown) {
    this.hoodStats.fallbacks++;
    this.hoodStats.lastFallback = `${stage}: ${error instanceof Error ? error.message : String(error)}`;
  }

  /**
   * Draw the shell's own hood (panel 7) instead of the padded one, e.g. while agent Z's cloth
   * interaction still moves the shell hood (until it drives `hood.setState`).
   */
  useShellHood(on: boolean) {
    this.shellHoodForced = on;
    this.showHood();
  }

  /** Normal view: the padded hood, shell panel 7 hidden. Fit maps / X-ray: the shell's hood. */
  private showHood() {
    const asset = this.shownAsset;
    if (!this.mesh || !asset) return;
    const on =
      !!this.hood &&
      this.mode === 'normal' &&
      !this.shellHoodForced &&
      this.hoodFailedKey !== asset.key;
    if (this.hood) this.hood.visible = on;
    if (this.hoodIndex?.key !== asset.key)
      this.hoodIndex = {
        key: asset.key,
        full: asset.triangles,
        hidden: Array.from(indexWithoutHood(asset)),
      };
    const want = on ? this.hoodIndex.hidden : this.hoodIndex.full;
    const index = this.mesh.geometry.index;
    if (!index || index.count !== want.length) this.mesh.geometry.setIndex(want);
  }

  reset() {
    this.hood?.dispose();
    this.hood = undefined;
    this.hoodKind = 0;
    this.hoodIndex = undefined;
    this.hoodFailedKey = undefined;
    this.details.clear();
    this.surface = undefined;
    this.activeKey = undefined;
    this.shownAsset = undefined;
    this.preloadGeneration++;
    this.morphDone?.();
    this.morphDone = undefined;
    this.generation++;
    this.transition?.target.dispose();
    this.transition = undefined;
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.remove(this.mesh);
      this.mesh = undefined;
    }
  }
  dispose() {
    this.reset();
    this.cloth.dispose();
    this.backgroundCloth?.dispose();
    this.fabric?.dispose();
    this.material.dispose();
    this.depthMaterial.dispose();
  }
}
