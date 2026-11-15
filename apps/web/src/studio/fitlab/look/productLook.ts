// Fit Lab product look (agent LK, prompt 33, 2026-11-15): the APPEARANCE fixes the live AR jacket
// carries (engine/live/ar/ArKioskJacket.ts) on the Fit Lab's own GarmentLayers (the three
// preloaded S/M/L shells, sizes.ts, and the physics shell, Viewer.garment):
// - F4T real fabric (ar/f4tex.ts): the user's local flat-lay photos (logos, zip tape, stitching,
//   wrinkles) on the shell's material charts. Local, gitignored textures
//   (apps/web/public/local-textures/<style>/, scripts/f4t-textures.py); without them the shell
//   keeps its drawn look, silently.
// - F4X material response (ar/finish/config.ts AR_LOOK): roughness, specular, environment, sheen.
//   NOT the camera adaptation / venue white balance (finish/f4.ts, f4light): those correct the
//   live camera's picture, and the Fit Lab is a studio render. So the F4T albedo is the product
//   colour itself (f4tAlbedo with adaptGain 1 and chroma strength 0, its default): the puffer's
//   measured #cdb89f, the parka's white.
// - The padded hood lying down (ar/hoodDrape.ts), as the AR's ?f3hood=1.
// Geometry that changes the FIT shape (flattenFront / flattenAcross / tubeSleeves, the rigid and
// glue code) is deliberately NOT brought in: the see-through gap and the fit numbers come from the
// engine's real garment geometry.
// The material is patched in place (uniforms + an onBeforeCompile wrapper), never replaced, so
// R's see-through (look/seeThrough.ts), which fades and restores the shell's own material, keeps
// working on it. `?productlook=0` turns everything off (A/B).
import type { MeshPhysicalMaterial } from 'three';
import type { ClothAsset } from '../../../api';
import { finishOf, type GarmentLayer } from '../../../engine/GarmentLayer';
import { materials } from '../../../engine/garmentLook';
import { AR_LOOK } from '../../../engine/live/ar/finish/config';
import {
  applyF4tCharts,
  f4tAlbedo,
  f4tCharts,
  F4T_SET,
  F4tSets,
  f4tUniforms,
  installF4tShader,
  type F4tUniforms,
} from '../../../engine/live/ar/f4tex';
import { shapeHood } from './hoodShape';

export type ProductLookFlags = { on: boolean; fabric: boolean; material: boolean; hood: boolean };

/** `?productlook=0` all off; `?productlook=nofabric|nomaterial|nohood` one part off (A/B). */
export function readProductLookFlags(search?: string): ProductLookFlags {
  const s = search ?? (typeof location !== 'undefined' && location?.search ? location.search : '');
  const v = new URLSearchParams(s).get('productlook') ?? '';
  const on = v !== '0';
  return {
    on,
    fabric: on && v !== 'nofabric',
    material: on && v !== 'nomaterial',
    hood: on && v !== 'nohood',
  };
}

/** The GarmentLayer internals the AR jacket reaches too (ArKioskJacket.ts, same casts). */
type LayerInternals = {
  material?: MeshPhysicalMaterial;
  mesh?: { geometry: { getAttribute(name: string): { array: ArrayLike<number> } | undefined } };
  shownAsset?: ClothAsset;
  uniforms?: { gPockets?: { value: number } };
  decalUniforms?: { gDecalA?: { value: { x: number }[] } };
};

type LayerState = {
  uniforms: F4tUniforms;
  /** Asset key whose charts are applied (re-applied after a new show(): size switch, physics). */
  key?: string;
};

/**
 * The shell material's AR response (ArKioskJacket.applyArLook, copied: that one reads the AR's
 * private asset): absolute values per finish, so applying twice never compounds. Sheen keeps its
 * on/off state (USE_SHEEN is in the program key).
 */
export function applyArMaterial(material: MeshPhysicalMaterial, asset: Pick<ClothAsset, 'finish'>) {
  const finish = finishOf(asset);
  const look = AR_LOOK[finish];
  material.roughness = look.roughness;
  material.specularIntensity = look.specularIntensity;
  material.envMapIntensity = look.envMapIntensity;
  material.sheen = materials[finish].sheen > 0 ? Math.max(1e-3, look.sheen) : 0;
  material.sheenRoughness = look.sheenRoughness;
}

/**
 * Where a torso photo is the albedo, the drawn pockets and torso logos are switched off (the
 * photo carries its own); the sleeve lettering stays. Copied from ArKioskJacket
 * .hideDrawnUnderPhotos. The shell sets both again on its next show(); apply() runs after it.
 */
function hideDrawnUnderPhotos(layer: LayerInternals, front: boolean, back: boolean) {
  if (front && layer.uniforms?.gPockets) layer.uniforms.gPockets.value = 0;
  for (const a of layer.decalUniforms?.gDecalA?.value ?? [])
    if ((front && a.x > 0.5 && a.x < 1.5) || (back && a.x > 1.5 && a.x < 2.5)) a.x = 0;
}

export class ProductLook {
  private readonly flags: ProductLookFlags;
  private readonly sets = new F4tSets();
  private readonly layers = new WeakMap<GarmentLayer, LayerState>();
  /** Hood instances already draped (the drape edits a hood's baked rest shape once). */
  private readonly draped = new WeakSet<object>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(flags = readProductLookFlags()) {
    this.flags = flags;
  }

  /**
   * Applies the product look to `layer`'s shown jacket. Call after every show of a new asset
   * (a built size shell; the physics shell after setGarment). Idempotent per asset; never
   * rejects (a missing texture set = the drawn look).
   */
  async apply(layer: GarmentLayer): Promise<void> {
    if (!this.flags.on || this.disposed) return;
    const internals = layer as unknown as LayerInternals;
    const material = internals.material;
    const asset = internals.shownAsset;
    if (!material || !asset) return;
    if (this.flags.material) applyArMaterial(material, asset);
    if (this.flags.hood) this.watchHood(layer);
    if (!this.flags.fabric) return;
    let state = this.layers.get(layer);
    if (!state) {
      state = { uniforms: f4tUniforms() };
      // The debug-faces flag of f4tex is the AR's page flag; never on in the Fit Lab.
      state.uniforms.gF4tFaces.value = 0;
      installF4tShader(material, state.uniforms);
      this.layers.set(layer, state);
    }
    if (state.key === asset.key) {
      // Same asset (restyle): the shell may have re-run show(); hide the drawn pockets again.
      const u = state.uniforms.gF4tOn.value;
      hideDrawnUnderPhotos(internals, u.x > 0, u.y > 0);
      return;
    }
    state.key = asset.key;
    const uniforms = state.uniforms;
    uniforms.gF4tOn.value.set(0, 0, 0);
    try {
      const arc = internals.mesh?.geometry.getAttribute('_g_arc')?.array;
      const charts = arc ? f4tCharts(asset, arc) : null;
      if (!charts) return;
      const set = await this.sets.load(F4T_SET[finishOf(asset)]);
      if (!set || this.disposed || state.key !== asset.key) return;
      applyF4tCharts(uniforms, charts, set.meta);
      if (set.front) uniforms.gF4tFront.value = set.front;
      if (set.back) uniforms.gF4tBack.value = set.back;
      if (set.sleeve) uniforms.gF4tSleeve.value = set.sleeve;
      // Studio render: no camera adaptation, product colour as the albedo (strength 0).
      const albedo = f4tAlbedo(asset.colour, set.meta.chroma, [1, 1, 1], 0);
      uniforms.gF4tAlbedo.value.set(albedo[0], albedo[1], albedo[2]);
      uniforms.gF4tOn.value.set(set.front ? 1 : 0, set.back ? 1 : 0, set.sleeve ? 1 : 0);
      hideDrawnUnderPhotos(internals, !!set.front, !!set.back);
    } catch (e) {
      console.warn('[fitlab] product fabric unavailable; drawn look kept', e);
    }
  }

  /**
   * The padded hood loads after the shell (GarmentLayer.syncHood): polls briefly for it, then
   * drapes it once per hood instance in its baked rest shape (ArKioskJacket.drapeHood, copied:
   * that one is bound to the AR's layer), so every later fit onto the shell yields the draped
   * hood and nothing runs per frame.
   */
  private watchHood(layer: GarmentLayer, tries = 40) {
    const hood = layer.hood;
    if (!hood) {
      if (tries <= 0 || this.disposed) return;
      const t = setTimeout(() => {
        this.timers.delete(t);
        this.watchHood(layer, tries - 1);
      }, 250);
      this.timers.add(t);
      return;
    }
    if (this.draped.has(hood)) return;
    this.draped.add(hood);
    const internals = hood as unknown as { base?: Float32Array; refresh?: () => void };
    const g = hood.mesh.geometry;
    const sigma = g.getAttribute('_sigma'),
      attach = g.getAttribute('_attach');
    if (!internals.base || !sigma || !attach) return;
    const kind = (layer as unknown as { hoodKind?: number }).hoodKind;
    shapeHood(kind, internals.base, sigma.array as ArrayLike<number>, attach.array as ArrayLike<number>);
    internals.refresh?.call(hood);
  }

  dispose() {
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.sets.dispose();
  }
}

let shared: ProductLook | undefined;

/** One-line hook for the panel: the product look on `layer` (shared texture sets). */
export function applyProductLook(layer: GarmentLayer): Promise<void> {
  shared ??= new ProductLook();
  return shared.apply(layer);
}

/** Releases the shared texture sets (the panel's dispose). */
export function disposeProductLook() {
  shared?.dispose();
  shared = undefined;
}
