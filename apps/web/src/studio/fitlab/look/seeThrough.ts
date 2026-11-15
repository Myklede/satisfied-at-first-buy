// R (prompt 33): one Look -> see-through rendering for the Fit Lab, driven by `reveal` 0..1.
//
//   reveal 0  the product look: the jacket's own material, untouched (opaque, its colour, quilting,
//             logos). The body sits under it, as worn.
//   reveal 1  see-through: the real jacket stays as a faint film (its quilting, seams and colour
//             still read), plus a crisp glass layer drawn on the same geometry: a thin dark
//             silhouette line (screen-space width from fwidth), a fresnel rim and a very low fill.
//             The body turns a cool neutral matte clay, so the cream / product-tinted glass and the
//             light stage separate from it at a glance. Only tight / snug zones (FL's per-vertex `fitZone`) get a
//             soft coral tint, faded in near reveal 1; good and loose zones are never coloured.
//
// Draw order (transparent queue, by renderOrder): body (opaque) -> glass back faces (0.9) -> the
// real jacket film, back then front faces (1, three's two-pass double-sided transparency) -> glass
// front faces (1.1). Nothing on the shell writes depth while see-through, so the coincident layers
// never z-fight; the body's depth hides the far glass behind it.
//
// No program surprises: the jacket film uses exactly the shell's X-ray programs (transparent,
// back + front pass), which Viewer.prewarm(finish, 'xray') compiles in the background; the jacket
// stays opaque until they are linked. The glass is one small ShaderMaterial (skinning chunks
// included, so it also follows SkinnedMesh shells). The body is restyled in place (uniform-only
// values), so it costs no compile either.
//
// Engine objects are only borrowed: dispose() removes every glass mesh and restores each material
// value, shadow flag, layer mask and onBeforeRender it changed.
import {
  BackSide,
  Color,
  FrontSide,
  InstancedMesh,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  ShaderMaterial,
  SkinnedMesh,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import type { Finish } from '../../../engine/garmentLook';
import type { Viewer } from '../../../engine/Viewer';
import {
  FIT_ZONE_ATTRIBUTE,
  ZONE_INDEX,
  type SeeThrough,
  type SeeThroughParts,
  type TightZone,
} from './types';

/** Look conventions of the see-through (visual only; no fit number depends on them). */
export const SEE_THROUGH = {
  /** The jacket fades into glass between these reveal values (spec: around 0.3–0.5). */
  fadeStart: 0.25,
  fadeEnd: 0.55,
  /** Opacity of the real jacket left at reveal 1: quilting, seams and colour stay faintly legible. */
  film: 0.2, // user 06:25: the jacket read too faint in see-through; keep its form legible
  /** Tight-zone tint fades in over this reveal range (only as reveal approaches 1). */
  tintStart: 0.55,
  tintEnd: 0.95,
  /** Coral (#E5484D) opacity over the glass at severity 0 (just snug) and 1 (clearly tight). */
  tintMin: 0.2,
  tintMax: 0.4,
  coral: '#E5484D',
  /** Body: look colour is the mannequin's own; see-through turns cool neutral matte clay, so the
   *  cream / product-tinted glass separates from it at a glance (lead, 03:45). */
  clay: '#a9adb2',
  clayRoughness: 0.92,
  claySpecular: 0.1,
  clayEnv: 0.45,
  /** Glass front faces: fill, fresnel rim, silhouette line (ndv threshold + opacity). */
  front: { fill: 0.24, rim: 0.8, edge: 1.0, edgeNdv: 0.14, lines: 0.75, sheen: 0.4 },
  /** Glass back faces (the far side and the lining seen through openings): quieter. */
  back: { fill: 0.1, rim: 0.35, edge: 0.5, edgeNdv: 0.1, lines: 0.35, sheen: 0 },
  glass: '#fbfaf7',
  rim: '#dde3ea', // light cool grey: a white rim vanished on the light panel background
  edgeColour: '#33404c',
} as const;

const HIDDEN_LAYER = 31;

/** Shader features a geometry supports (fit zones, quilting chart, vertex colour). */
export function glassDefines(geometry: BufferGeometry): Record<string, string> {
  const d: Record<string, string> = {};
  if (geometry.getAttribute(FIT_ZONE_ATTRIBUTE)) d.HAS_FITZONE = '';
  if (
    geometry.getAttribute('_quilt_uv') &&
    geometry.getAttribute('_quilt_params') &&
    geometry.getAttribute('_g_seam')
  )
    d.HAS_QUILT = '';
  if (geometry.getAttribute('color')?.itemSize === 3) d.HAS_TINT = '';
  return d;
}
const definesKey = (d: Record<string, string>) => Object.keys(d).sort().join(',');

/** A GarmentLayer (duck-typed, so the module and its tests do not construct the engine layer). */
type ShellLayer = Object3D & { finishShown?: Finish };
const isGarmentLayer = (o: Object3D | null): o is ShellLayer =>
  !!o && typeof (o as { programStandIns?: unknown }).programStandIns === 'function';

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The blend weights at a reveal value (pure; tested). */
export function revealCurves(reveal: number) {
  const r = Number.isFinite(reveal) ? Math.min(1, Math.max(0, reveal)) : 0;
  const glass = smooth(SEE_THROUGH.fadeStart, SEE_THROUGH.fadeEnd, r);
  return {
    reveal: r,
    /** 0 = product look, 1 = full glass. */
    glass,
    /** Opacity of the real jacket material (1 = opaque look). */
    film: 1 - glass * (1 - SEE_THROUGH.film),
    /** Tight-zone tint strength 0..1. */
    tint: smooth(SEE_THROUGH.tintStart, SEE_THROUGH.tintEnd, r),
    /** Body: 0 = mannequin as is, 1 = see-through clay. */
    clay: smooth(0.05, 0.5, r),
  };
}

/**
 * Per-zone coral opacity (index = ZONE_INDEX): 0 for zones not listed (good / loose are never
 * passed), else tintMin..tintMax by severity; the strongest entry per zone wins (pure; tested).
 */
export function zoneTint(zones: readonly TightZone[]): Float32Array {
  const out = new Float32Array(Object.keys(ZONE_INDEX).length);
  for (const z of zones) {
    const i = ZONE_INDEX[z.zone];
    if (i === undefined || !Number.isFinite(z.severity)) continue;
    const s = Math.min(1, Math.max(0, z.severity));
    out[i] = Math.max(
      out[i],
      SEE_THROUGH.tintMin + (SEE_THROUGH.tintMax - SEE_THROUGH.tintMin) * s,
    );
  }
  return out;
}

const VERTEX = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
#ifdef HAS_FITZONE
attribute float ${FIT_ZONE_ATTRIBUTE};
#endif
#ifdef HAS_QUILT
// The shell's own quilting chart (FabricSurface / garmentSurface): V along the chamber rows,
// q = (pitch across, pitch along, row offset, kind: 0 plain, 1 rows, 2 rows + columns) and the
// edge-graph distance to the nearest seam (m). Same inputs as the kiosk shader's stitch lines.
attribute vec2 _quilt_uv;
attribute vec4 _quilt_params;
attribute float _g_seam;
varying vec2 vQuilt;
varying float vQuiltPitch;
varying float vSeam;
#endif
#ifdef HAS_TINT
attribute vec3 color;
#endif
uniform float uZone[6];
varying vec3 vN;
varying vec3 vView;
varying float vTight;
varying vec3 vTintColour;
void main() {
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  vN = transformedNormal;
  vView = -mvPosition.xyz;
  vTight = 0.0;
#ifdef HAS_FITZONE
  // -1 = no zone. Interpolated across the boundary triangles: a soft edge between zones.
  if (${FIT_ZONE_ATTRIBUTE} > -0.5) vTight = uZone[int(clamp(${FIT_ZONE_ATTRIBUTE} + 0.5, 0.0, 5.0))];
#endif
#ifdef HAS_QUILT
  // Phase in rows (integers = stitch lines); 0 pitch = not quilted.
  bool quilted = _quilt_params.w > 0.5 && _quilt_params.y > 0.005;
  vQuilt = vec2(quilted ? (_quilt_uv.y - _quilt_params.z) / _quilt_params.y : 0.25, 0.0);
  vQuiltPitch = quilted ? _quilt_params.y : 0.0;
  vSeam = _g_seam;
#endif
#ifdef HAS_TINT
  vTintColour = color;
#else
  vTintColour = vec3(1.0);
#endif
}`;

const FRAGMENT = /* glsl */ `
uniform vec3 uGlass;
uniform vec3 uRim;
uniform vec3 uEdgeColour;
uniform vec3 uCoral;
uniform float uFill;
uniform float uRimAmount;
uniform float uEdge;
uniform float uEdgeNdv;
uniform float uLines;
uniform float uSheen;
uniform float uStrength;
uniform float uTint;
varying vec3 vN;
varying vec3 vView;
varying float vTight;
varying vec3 vTintColour;
#ifdef HAS_QUILT
varying vec2 vQuilt;
varying float vQuiltPitch;
varying float vSeam;
#endif
// Thin line on a distance field d (any unit): ~1.2 px wide whatever the zoom.
float thinLine(float d) {
  float w = fwidth(d) + 1e-6;
  return 1.0 - smoothstep(0.35 * w, 1.35 * w, abs(d));
}
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(vView);
  float ndv = clamp(abs(dot(n, v)), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 2.2);
  if (dot(n, v) < 0.0) n = -n;
  // Glass body: the product colour as a light tint, a strong fresnel rim, a soft sheen.
  vec3 tint = mix(uGlass, vTintColour, 0.75);
  vec3 col = mix(tint, uRim, fres);
  float a = uFill + uRimAmount * fres;
  vec3 h = normalize(normalize(vec3(-0.35, 0.65, 0.68)) + v);
  float sheen = pow(max(dot(n, h), 0.0), 48.0) * uSheen;
  col = mix(col, vec3(1.0), sheen / max(a + sheen, 1e-4));
  a += sheen * (1.0 - a);
#ifdef HAS_QUILT
  // Quilting stitch rows and seams: thin lines in a darker shade of the product colour.
  float stitch = vQuiltPitch > 0.0 ? thinLine((fract(vQuilt.x + 0.5) - 0.5) * vQuiltPitch) : 0.0;
  float seam = thinLine(vSeam);
  float line = max(stitch, seam) * uLines;
  col = mix(col, vTintColour * 0.42, line / max(a + line * (1.0 - a), 1e-4));
  a = line + a * (1.0 - line);
#endif
  // Tight zones: coral layered over the glass ("over" compositing, straight alpha).
  float t = clamp(vTight * uTint, 0.0, 1.0);
  float aT = t + a * (1.0 - t);
  col = aT > 0.0 ? (uCoral * t + col * a * (1.0 - t)) / aT : col;
  a = aT;
  // Crisp silhouette line: ndv near 0, its width held to ~1.5 px by the screen derivative.
  float aa = fwidth(ndv) * 1.5 + 1e-4;
  float edge = (1.0 - smoothstep(uEdgeNdv, uEdgeNdv + aa, ndv)) * uEdge;
  col = mix(col, uEdgeColour, edge);
  a = edge + a * (1.0 - edge);
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0) * uStrength);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

type Side = 'front' | 'back';

interface GlassUniforms {
  [name: string]: { value: unknown };
  uZone: { value: Float32Array };
  uStrength: { value: number };
  uTint: { value: number };
}

function glassMaterial(
  side: Side,
  shared: {
    uZone: { value: Float32Array };
    uStrength: { value: number };
    uTint: { value: number };
  },
  defines: Record<string, string>,
) {
  const p = SEE_THROUGH[side];
  const uniforms: GlassUniforms = {
    uZone: shared.uZone,
    uStrength: shared.uStrength,
    uTint: shared.uTint,
    uGlass: { value: new Color(SEE_THROUGH.glass) },
    uRim: { value: new Color(SEE_THROUGH.rim) },
    uEdgeColour: { value: new Color(SEE_THROUGH.edgeColour) },
    uCoral: { value: new Color(SEE_THROUGH.coral) },
    uFill: { value: p.fill },
    uRimAmount: { value: p.rim },
    uEdge: { value: p.edge },
    uEdgeNdv: { value: p.edgeNdv },
    uLines: { value: p.lines },
    uSheen: { value: p.sheen },
  };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: side === 'front' ? FrontSide : BackSide,
    defines: { ...defines },
  });
  material.name = `fitlab-glass-${side}`;
  return material;
}

/** A mesh drawn on the same geometry (child of `of`, identity transform, same skeleton). */
function overlay(of: Mesh, material: ShaderMaterial, renderOrder: number): Mesh {
  let mesh: Mesh;
  if (of instanceof SkinnedMesh) {
    const skinned = new SkinnedMesh(of.geometry, material);
    skinned.bindMode = of.bindMode;
    skinned.bind(of.skeleton, of.bindMatrix);
    mesh = skinned;
  } else mesh = new Mesh(of.geometry, material);
  mesh.name = `${material.name}-overlay`;
  mesh.userData.fitlabGlass = true;
  mesh.renderOrder = renderOrder;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = of.frustumCulled;
  mesh.matrixAutoUpdate = false; // identity under its parent
  return mesh;
}

interface ShellRecord {
  mesh: Mesh;
  /** 'shell' = a GarmentLayer's cloth mesh (faded through its own material); 'other' = hood,
   *  hardware: hidden (layer mask) once the glass dominates. */
  kind: 'shell' | 'other';
  front?: Mesh;
  back?: Mesh;
  castShadow: boolean;
  layers: number;
  onBeforeRender: Mesh['onBeforeRender'];
  wrapped?: Mesh['onBeforeRender'];
}

interface SavedShellMaterial {
  transparent: boolean;
  opacity: number;
  depthWrite: boolean;
}

type BodyMaterial = MeshStandardMaterial | MeshPhysicalMaterial;
interface SavedBodyMaterial {
  color: Color;
  roughness: number;
  metalness: number;
  envMapIntensity: number;
  specularIntensity?: number;
  clearcoat?: number;
  sheen?: number;
}

/** The Fit Lab's see-through controller for the panel's Viewer (FL wires it, prompt 33). */
export function createSeeThrough(viewer: Pick<Viewer, 'prewarm'>): SeeThrough {
  let parts: SeeThroughParts = { shells: [], body: [] };
  let curves = revealCurves(0);
  const shared = {
    uZone: { value: new Float32Array(6) },
    uStrength: { value: 0 },
    uTint: { value: 0 },
  };
  const shells = new Map<Mesh, ShellRecord>();
  const shellMaterials = new Map<Material, SavedShellMaterial>();
  const bodyMaterials = new Map<BodyMaterial, SavedBodyMaterial>();
  const glassMaterials = new Set<ShaderMaterial>();
  /** Finish -> X-ray programs linked (the film may only go transparent once they are). */
  const programs = new Map<Finish, 'pending' | 'ready'>();
  let disposed = false;
  let timer = 0;
  const clay = new Color(SEE_THROUGH.clay);

  const layersOf = (): ShellLayer[] => {
    const out: ShellLayer[] = [];
    for (const root of parts.shells)
      root.traverseAncestors((a) => {
        if (isGarmentLayer(a)) out.push(a);
      });
    for (const root of parts.shells)
      root.traverse((o) => {
        if (isGarmentLayer(o)) out.push(o);
      });
    return out;
  };

  /** Film (transparent) allowed only once every shown finish has its X-ray programs linked. */
  const filmReady = (all = false) => {
    let ready = true;
    // On the first setParts every finish is compiled in the background (ProgramWarmup), so a
    // jacket switch to the other finish is see-through at once instead of after a cold compile.
    const finishes: (Finish | undefined)[] = all
      ? ['glossy_ripstop', 'satin_matte']
      : layersOf().map((l) => l.finishShown);
    for (const finish of finishes) {
      if (!finish) continue;
      const state = programs.get(finish);
      if (state === 'ready') continue;
      ready = false;
      if (!state) {
        programs.set(finish, 'pending');
        void viewer.prewarm(finish, 'xray').then(
          () => {
            programs.set(finish, 'ready');
            if (!disposed) apply();
          },
          (error: unknown) => {
            programs.delete(finish);
            console.error('[fitlab see-through] X-ray programs did not compile', error);
          },
        );
      }
    }
    return ready;
  };

  // A garment cloth mesh: the GarmentLayer's shell, or ZB's opened (split) jacket that carries the
  // shell's attributes and material. Both fade through that material.
  const isShell = (mesh: Mesh) =>
    !Array.isArray(mesh.material) && !!mesh.geometry.getAttribute('_quilt_uv');

  /** Collects the jacket and body meshes now (GarmentLayer and BodyLayer replace theirs). */
  const scan = () => {
    const seen = new Set<Mesh>();
    for (const root of parts.shells)
      root.traverse((o) => {
        if (o instanceof Mesh && !o.userData.fitlabGlass) seen.add(o);
      });
    // Release first: a replaced mesh may share the material the new one is about to style.
    for (const [mesh, record] of shells) if (!seen.has(mesh)) release(record);
    for (const mesh of seen) if (!shells.has(mesh)) track(mesh);
    const bodies = new Set<BodyMaterial>();
    for (const root of parts.body)
      root.traverse((o) => {
        if (!(o instanceof Mesh)) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material])
          if (m instanceof MeshStandardMaterial) bodies.add(m);
      });
    for (const [m, saved] of bodyMaterials)
      if (!bodies.has(m)) {
        restoreBody(m, saved);
        bodyMaterials.delete(m);
      }
    for (const m of bodies)
      if (!bodyMaterials.has(m))
        bodyMaterials.set(m, {
          color: m.color.clone(),
          roughness: m.roughness,
          metalness: m.metalness,
          envMapIntensity: m.envMapIntensity,
          ...(m instanceof MeshPhysicalMaterial
            ? { specularIntensity: m.specularIntensity, clearcoat: m.clearcoat, sheen: m.sheen }
            : {}),
        });
  };

  const track = (mesh: Mesh) => {
    const kind = isShell(mesh) ? 'shell' : 'other';
    const record: ShellRecord = {
      mesh,
      kind,
      castShadow: mesh.castShadow,
      layers: mesh.layers.mask,
      onBeforeRender: mesh.onBeforeRender,
    };
    if (!(mesh instanceof InstancedMesh)) {
      const defines = glassDefines(mesh.geometry);
      const back = glassMaterial('back', shared, defines);
      const front = glassMaterial('front', shared, defines);
      glassMaterials.add(back).add(front);
      record.back = overlay(mesh, back, mesh.renderOrder - 0.1);
      record.front = overlay(mesh, front, mesh.renderOrder + 0.1);
      const sync = (glass: Mesh) => {
        const prior = glass.onBeforeRender;
        glass.onBeforeRender = (...args) => {
          prior.apply(glass, args);
          // GarmentLayer swaps the geometry at the end of a size morph; follow it (next frame).
          if (glass.geometry !== mesh.geometry) glass.geometry = mesh.geometry;
          const material = glass.material as ShaderMaterial;
          const want = glassDefines(mesh.geometry as BufferGeometry);
          if (definesKey(want) !== definesKey(material.defines as Record<string, string>)) {
            material.defines = want;
            material.needsUpdate = true;
          }
        };
      };
      sync(record.back);
      sync(record.front);
      mesh.add(record.back, record.front);
    }
    if (kind === 'shell') {
      const material = mesh.material as Material;
      if (!shellMaterials.has(material))
        shellMaterials.set(material, {
          transparent: material.transparent,
          opacity: material.opacity,
          depthWrite: material.depthWrite,
        });
      // GarmentLayer.setMode (on every shown size) resets transparency and the shadow flag:
      // re-assert the see-through state right before each draw of this mesh.
      const wrapped: Mesh['onBeforeRender'] = (...args) => {
        record.onBeforeRender.apply(mesh, args);
        styleShell(record);
      };
      record.wrapped = wrapped;
      mesh.onBeforeRender = wrapped;
    }
    shells.set(mesh, record);
    styleShell(record);
  };

  const release = (record: ShellRecord) => {
    const { mesh } = record;
    for (const glass of [record.back, record.front]) {
      if (!glass) continue;
      mesh.remove(glass);
      glassMaterials.delete(glass.material as ShaderMaterial);
      (glass.material as ShaderMaterial).dispose();
    }
    if (record.wrapped && mesh.onBeforeRender === record.wrapped)
      mesh.onBeforeRender = record.onBeforeRender;
    mesh.castShadow = record.castShadow;
    mesh.layers.mask = record.layers;
    if (record.kind === 'shell') {
      const material = mesh.material as Material;
      const saved = shellMaterials.get(material);
      if (saved) restoreShell(material, saved);
    }
    shells.delete(mesh);
  };

  let film = true; // last allowed state of the transparent film

  const styleShell = (record: ShellRecord) => {
    const { glass } = curves;
    const { mesh } = record;
    const on = glass > 0.001;
    // The glass stays in the scene at strength 0 in the Look: its program compiles with the first
    // frames after setParts, so the first scroll is immediate (alpha 0 draws change nothing).
    if (record.back) record.back.visible = true;
    if (record.front) record.front.visible = true;
    if (record.kind === 'other') {
      // Hood and hardware: hidden from the camera once the glass dominates (their glass stays).
      mesh.layers.mask = glass >= 0.5 ? 1 << HIDDEN_LAYER : record.layers;
      mesh.castShadow = glass >= 0.5 ? false : record.castShadow;
      return;
    }
    const material = mesh.material as Material;
    const saved = shellMaterials.get(material);
    if (!saved) return;
    if (!on || !film) {
      restoreShell(material, saved);
      mesh.castShadow = record.castShadow;
      return;
    }
    if (!material.transparent) {
      material.transparent = true;
      material.needsUpdate = true;
    }
    material.depthWrite = false;
    material.opacity = curves.film;
    // The jacket's shadow would darken the body inside: off once it is mostly glass.
    mesh.castShadow = glass < 0.4 && record.castShadow;
  };

  const restoreShell = (material: Material, saved: SavedShellMaterial) => {
    if (material.transparent !== saved.transparent) {
      material.transparent = saved.transparent;
      material.needsUpdate = true;
    }
    material.opacity = saved.opacity;
    material.depthWrite = saved.depthWrite;
  };

  const restoreBody = (m: BodyMaterial, s: SavedBodyMaterial) => {
    m.color.copy(s.color);
    m.roughness = s.roughness;
    m.metalness = s.metalness;
    m.envMapIntensity = s.envMapIntensity;
    if (m instanceof MeshPhysicalMaterial) {
      if (s.specularIntensity !== undefined) m.specularIntensity = s.specularIntensity;
      if (s.clearcoat !== undefined) m.clearcoat = s.clearcoat;
      if (s.sheen !== undefined) m.sheen = s.sheen;
    }
  };

  const styleBody = () => {
    const k = curves.clay;
    for (const [m, s] of bodyMaterials) {
      // Only uniform values change: no program recompile.
      m.color.copy(s.color).lerp(clay, k);
      m.roughness = s.roughness + (SEE_THROUGH.clayRoughness - s.roughness) * k;
      m.metalness = s.metalness * (1 - k);
      m.envMapIntensity = s.envMapIntensity + (SEE_THROUGH.clayEnv - s.envMapIntensity) * k;
      if (m instanceof MeshPhysicalMaterial) {
        if (s.specularIntensity !== undefined)
          m.specularIntensity =
            s.specularIntensity + (SEE_THROUGH.claySpecular - s.specularIntensity) * k;
        if (s.clearcoat !== undefined) m.clearcoat = s.clearcoat * (1 - k);
        if (s.sheen !== undefined) m.sheen = s.sheen * (1 - k);
      }
    }
  };

  const apply = () => {
    if (disposed) return;
    scan();
    film = curves.glass <= 0.001 || filmReady();
    shared.uStrength.value = curves.glass;
    shared.uTint.value = curves.tint;
    for (const record of shells.values()) styleShell(record);
    styleBody();
    // While see-through, rescan a few times a second: size switches, physics and BodyLayer.display
    // replace meshes between setReveal calls.
    if (curves.glass > 0.001 && !timer) timer = setInterval(apply, 300) as unknown as number;
    else if (curves.glass <= 0.001 && timer) {
      clearInterval(timer);
      timer = 0;
    }
  };

  return {
    setParts(next) {
      parts = { shells: [...next.shells], body: [...next.body], trousers: next.trousers };
      filmReady(true);
      // Trousers are not the product: they stay opaque and keep P's material at every reveal.
      apply();
    },
    setReveal(t) {
      curves = revealCurves(t);
      apply();
    },
    setTightZones(zones) {
      shared.uZone.value.set(zoneTint(zones));
    },
    dispose() {
      if (disposed) return;
      clearInterval(timer);
      timer = 0;
      for (const record of [...shells.values()]) release(record);
      for (const [m, s] of bodyMaterials) restoreBody(m, s);
      bodyMaterials.clear();
      for (const m of glassMaterials) m.dispose();
      glassMaterials.clear();
      shellMaterials.clear();
      disposed = true;
    },
  };
}
