// The padded hood (agent H): a baked Blender GLB (scripts/blender/hood_build.py) drawn instead of
// the shell's own thin hood panel. It never goes through free per-particle cloth: its shape is a
// blend of baked rest shapes, fitted onto the shell's hood seam by a similarity transform plus a
// small seam blend, then an optional rigid transform (agent Z, once the hood is off).
//
// Use:
//   const hood = await HoodLayer.load(hoodKind);         // null when that kind has no baked hood
//   garmentLayer.add(hood);                              // same frame as the shell mesh
//   hood.fitTo(asset, shownPositions, shownNormals);     // after every shell show / cloth frame
//   garmentMesh.geometry.setIndex(indexWithoutHood(asset)) // the hook L2 owns (docs/requests)
//   hood.setState('detached', 0.4); hood.setRigidTransform(matrix);   // agent Z

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  Group,
  Quaternion,
  Vector3,
  type Texture,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { disposeObject } from '../dispose';
import { look, materials, type Finish } from '../garmentLook';
import { weaveNormalTexture } from '../garmentMaterials';
import { HOOD } from './hoodConfig';
import {
  applySimilarity,
  arcParams,
  fitSimilarity,
  keyWeights,
  liftedAt,
  sampleAt,
  shellSeamIds,
  svd3,
  type ShellSeamSource,
  type Similarity,
  type Vec3,
} from './hoodFit';

export type HoodState = 'down' | 'detached';

/** Value noise for the hood's crinkle (same construction as garmentShader gNoise3, in 2D). */
const HOOD_NOISE = /* glsl */ `
float hHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float hNoise(vec2 x) {
  vec2 i = floor(x), f = fract(x); f = f * f * (3. - 2. * f);
  return mix(mix(hHash(i), hHash(i + vec2(1, 0)), f.x), mix(hHash(i + vec2(0, 1)), hHash(i + vec2(1, 1)), f.x), f.y);
}
`;

/** What the baked GLB says about itself (node extras written by hood_build.py). */
export interface HoodInfo {
  style: string;
  states: string[];
  removable: boolean;
  reference: Record<string, string | number>;
}

const ZONE = { outer: 0, lining: 1, binding: 2, velcro: 3, zip: 4 } as const;

/** Shell geometry the hood follows: the asset's topology plus the positions shown right now. */
export interface ShellView extends ShellSeamSource {
  key: string;
  /** Rest (wrapped) positions: the seam is found on these once per asset (topology only). */
  initial: readonly number[];
  colour: string;
  finish: string;
}

export class HoodLayer extends Group {
  readonly info: HoodInfo;
  readonly mesh: Mesh<BufferGeometry, MeshPhysicalMaterial>;
  /** Last seam fit (diagnostics: scale asked for vs clamped, residual). */
  lastFit?: Similarity & { residualMaxM: number };
  private readonly base: Float32Array;
  private readonly keys: Float32Array[]; // absolute positions of peel25, peel50, peel75, detached
  private readonly sigma: Float32Array;
  private readonly blend: Float32Array;
  private readonly edge: Float32Array;
  /** Hood seam: one representative vertex list per column (attach row), ordered by sigma. */
  private readonly seamColumns: { sigma: number; ids: number[] }[];
  private readonly downSeam: Vec3[];
  private progress = 0;
  private rigid?: Matrix4;
  private shell?: { fit: Similarity; residual: Vec3[]; residualSigma: number[] };
  private colourKey = '';
  private seamIds?: { key: string; ids: number[] };

  private constructor(mesh: Mesh<BufferGeometry, MeshPhysicalMaterial>, info: HoodInfo) {
    super();
    this.name = `hood-${info.style}`;
    this.info = info;
    this.mesh = mesh;
    const g = mesh.geometry;
    const position = g.getAttribute('position') as BufferAttribute;
    this.base = Float32Array.from(position.array);
    // Morph targets (positions, relative deltas in glTF) become absolute key shapes.
    const names = (mesh.morphTargetDictionary ?? {}) as Record<string, number>;
    const deltas = g.morphAttributes.position ?? [];
    this.keys = HOOD.keyNames
      .filter((name) => names[name] !== undefined)
      .map((name) => {
        const delta = deltas[names[name]].array;
        const out = new Float32Array(this.base.length);
        for (let i = 0; i < out.length; i++)
          out[i] = this.base[i] + (g.morphTargetsRelative ? delta[i] : delta[i] - this.base[i]);
        return out;
      });
    if (info.removable && this.keys.length !== HOOD.keyNames.length)
      throw new Error(`Hood ${info.style}: detach keys missing from the baked GLB`);
    g.morphAttributes = {};
    mesh.morphTargetInfluences = undefined;
    mesh.morphTargetDictionary = undefined;
    this.sigma = attributeArray(g, '_sigma');
    this.blend = attributeArray(g, '_blend');
    this.edge = attributeArray(g, '_edge');
    const attach = attributeArray(g, '_attach');
    const byColumn = new Map<number, number[]>();
    attach.forEach((a, i) => {
      if (a < 0.5) return;
      const key = Math.round(this.sigma[i] * 1e5);
      byColumn.set(key, [...(byColumn.get(key) ?? []), i]);
    });
    this.seamColumns = [...byColumn.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([key, ids]) => ({ sigma: key / 1e5, ids }));
    if (this.seamColumns.length < 3) throw new Error(`Hood ${info.style}: no attach seam`);
    this.downSeam = this.seamColumns.map(({ ids }) => mean(this.base, ids));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    mesh.frustumCulled = false;
    this.add(mesh);
  }

  /** Load the baked hood of a hood kind (render_details.hood_kind); null when there is none. */
  static async load(hoodKind: number, signal?: AbortSignal): Promise<HoodLayer | null> {
    const url = HOOD.assets[hoodKind];
    if (!url) return null;
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Hood asset unavailable (${response.status})`);
    return HoodLayer.parse(await response.arrayBuffer());
  }

  /** A baked hood from GLB bytes (tests read the file directly). */
  static async parse(glb: ArrayBuffer): Promise<HoodLayer> {
    const gltf = await new GLTFLoader().parseAsync(glb, '');
    let source: Mesh | undefined;
    let info: HoodInfo | undefined;
    gltf.scene.traverse((object) => {
      if (object instanceof Mesh) source = object;
      const extra = (object.userData as { hood?: string }).hood;
      if (typeof extra === 'string') info = JSON.parse(extra) as HoodInfo;
    });
    if (!source || !info) {
      disposeObject(gltf.scene);
      throw new Error('Hood asset is not a baked hood');
    }
    const geometry = (source.geometry as BufferGeometry).clone();
    // Double-sided like the jacket: the puffer's down pouch is laid out by mirroring the hood
    // below the zip, which flips its triangle winding (front faces culled = see-through shell);
    // three.js flips the normal for back-facing fragments, so shading stays right.
    const mesh = new Mesh(
      geometry,
      new MeshPhysicalMaterial({ vertexColors: true, side: DoubleSide }),
    );
    mesh.morphTargetDictionary = source.morphTargetDictionary;
    disposeObject(gltf.scene);
    return new HoodLayer(mesh, info);
  }

  /**
   * Fit the hood onto the shell shown now: `positions` are the shell mesh's current vertex
   * positions (the static wrap, or a cloth frame), `normals` its vertex normals (the displayed
   * collar sits up to one loft outside them). Call again whenever the shell moves.
   */
  fitTo(shell: ShellView, positions: ArrayLike<number>, normals: ArrayLike<number>) {
    // The seam is topology: found once per asset on its rest shape, so a deformed frame (hand
    // pull, motion) can never break the walk.
    if (this.seamIds?.key !== shell.key)
      this.seamIds = { key: shell.key, ids: shellSeamIds(shell, shell.initial) };
    const ids = this.seamIds.ids;
    const offset = shell.maximum_loft_m * HOOD.seamLoftFraction;
    const line: Vec3[] = ids.map((i) => [
      positions[i * 3] + (normals[i * 3] || 0) * offset,
      positions[i * 3 + 1] + (normals[i * 3 + 1] || 0) * offset,
      positions[i * 3 + 2] + (normals[i * 3 + 2] || 0) * offset,
    ]);
    if (line.some((p) => !p.every(Number.isFinite)))
      throw new Error('Hood seam has non-finite positions');
    const arc = arcParams(line);
    const target = this.seamColumns.map(({ sigma }) => sampleAt(line, arc, sigma));
    const fit = fitSimilarity(this.downSeam, target);
    const residual = this.downSeam.map((p, k) => {
      const q = applySimilarity(fit, p);
      return [target[k][0] - q[0], target[k][1] - q[1], target[k][2] - q[2]] as Vec3;
    });
    this.shell = { fit, residual, residualSigma: this.seamColumns.map((c) => c.sigma) };
    this.lastFit = { ...fit, residualMaxM: Math.max(...residual.map((r) => Math.hypot(...r))) };
    this.refresh();
  }

  /**
   * Blend between the baked shapes: `setState('detached', t)` is t of the way from down (on
   * the collar) to detached (the free-standing bowl); `setState('down', t)` is t of the way
   * back. The zip opens from the wearer's right, like Z's hood_zip.
   */
  setState(state: HoodState, t: number) {
    const amount = Math.min(1, Math.max(0, t));
    const progress = state === 'detached' ? amount : 1 - amount;
    if (progress > 0 && !this.info.removable)
      throw new Error('This hood is sewn in; it cannot come off');
    this.progress = progress;
    this.refresh();
  }

  /** Detach progress (0 on the collar .. 1 off). */
  get detachProgress() {
    return this.progress;
  }

  /**
   * Rigid transform for the lifted part (agent Z: the hood follows the hand once it is off).
   * It moves each column by how far it has lifted, so the still-zipped part stays on the collar.
   */
  /**
   * A natural resting pose for the detached hood (agent Z): the rigid transform that stands the
   * free bowl on its zip edge at `target` (garment-local, e.g. a table or the floor beside the
   * feet), the zip edge level, the opening up and turned toward `facing` (horizontal). Pass it
   * to `setRigidTransform` with the hood fully detached. Computed from the current fit, so call
   * it after `fitTo`.
   */
  restingTransform(target: Vector3, facing = new Vector3(0, 0, 1)): Matrix4 {
    const shell = this.shell;
    if (!shell || !this.info.removable) throw new Error('Only a fitted removable hood can rest');
    const bowl = this.keys[this.keys.length - 1];
    const at = (v: number) => {
      const q = applySimilarity(shell.fit, [bowl[v * 3], bowl[v * 3 + 1], bowl[v * 3 + 2]]);
      return new Vector3(q[0], q[1], q[2]);
    };
    // Zip edge (attach row) and face edge of the free bowl.
    const base = this.seamColumns.flatMap(({ ids }) => ids).map(at);
    const rim: Vector3[] = [];
    for (let v = 0; v < this.edge.length; v++) if (this.edge[v] < 0.004) rim.push(at(v));
    const centre = base.reduce((a, p) => a.add(p), new Vector3()).divideScalar(base.length);
    const rimCentre = rim.reduce((a, p) => a.add(p), new Vector3()).divideScalar(rim.length);
    // Zip edge plane normal (least-squares, through the smallest-spread direction).
    const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const p of base) {
      const d = [p.x - centre.x, p.y - centre.y, p.z - centre.z];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cov[r * 3 + c] += d[r] * d[c];
    }
    const { v } = svd3(cov);
    const normal = new Vector3(v[2], v[5], v[8]).normalize();
    // Into the bowl: away from the zip edge toward the hood's body.
    const body = new Vector3();
    for (let i = 0; i < bowl.length / 3; i++) body.add(at(i));
    body.divideScalar(bowl.length / 3).sub(centre);
    if (normal.dot(body) < 0) normal.negate();
    const stand = new Quaternion().setFromUnitVectors(normal, new Vector3(0, 1, 0));
    const opening = rimCentre.clone().sub(centre).applyQuaternion(stand).setY(0);
    const want = facing.clone().setY(0);
    const yaw =
      opening.lengthSq() > 1e-12 && want.lengthSq() > 1e-12
        ? new Quaternion().setFromUnitVectors(opening.normalize(), want.normalize())
        : new Quaternion();
    const turn = yaw.multiply(stand);
    return new Matrix4()
      .makeTranslation(target.x, target.y, target.z)
      .multiply(new Matrix4().makeRotationFromQuaternion(turn))
      .multiply(new Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z));
  }

  setRigidTransform(matrix: Matrix4 | null) {
    this.rigid = matrix ?? undefined;
    this.refresh();
  }

  private refresh() {
    const shell = this.shell;
    if (!shell) return;
    const g = this.mesh.geometry;
    const position = g.getAttribute('position') as BufferAttribute;
    const out = position.array as Float32Array;
    const weights = this.info.removable
      ? keyWeights(HOOD.keyPositions, this.progress)
      : [1, ...this.keys.map(() => 0)];
    const shapes = [this.base, ...this.keys];
    const p = new Vector3();
    for (let v = 0; v < out.length / 3; v++) {
      let x = 0,
        y = 0,
        z = 0;
      for (let k = 0; k < shapes.length; k++) {
        const w = weights[k];
        if (!w) continue;
        x += shapes[k][v * 3] * w;
        y += shapes[k][v * 3 + 1] * w;
        z += shapes[k][v * 3 + 2] * w;
      }
      const fitted = applySimilarity(shell.fit, [x, y, z]);
      const sigma = this.sigma[v];
      const lifted = this.info.removable ? liftedAt(sigma, this.progress) : 0;
      const r = interpolate(shell.residualSigma, shell.residual, sigma);
      const w = this.blend[v] * (1 - lifted);
      p.set(fitted[0] + r[0] * w, fitted[1] + r[1] * w, fitted[2] + r[2] * w);
      if (this.rigid && lifted > 0) {
        const q = p.clone().applyMatrix4(this.rigid);
        p.lerp(q, lifted);
      }
      out[v * 3] = p.x;
      out[v * 3 + 1] = p.y;
      out[v * 3 + 2] = p.z;
    }
    position.needsUpdate = true;
    g.computeVertexNormals();
    g.computeBoundingSphere();
  }

  /**
   * Same fabric as the jacket: colour, gloss and weave of its finish; trims per style. Cheap when
   * nothing changed (colour + finish key). Needs a DOM (the weave map is a canvas).
   */
  setLook(shell: Pick<ShellView, 'colour' | 'finish'>) {
    const finish: Finish = shell.finish === 'glossy_ripstop' ? 'glossy_ripstop' : 'satin_matte';
    const key = `${shell.colour}:${finish}`;
    if (key === this.colourKey) return;
    this.colourKey = key;
    const material = this.mesh.material;
    material.normalMap?.dispose();
    const g = this.mesh.geometry;
    // The weave map tiles every look.weaveTileM of material (UV are material metres).
    const uv = g.getAttribute('uv') as BufferAttribute | undefined;
    if (uv && !g.userData.weaveScaled) {
      for (let i = 0; i < uv.array.length; i++) (uv.array as Float32Array)[i] /= look.weaveTileM;
      uv.needsUpdate = true;
      g.userData.weaveScaled = true;
    }
    const trim = HOOD.trim[this.info.style] ?? { lining: null, binding: null };
    const shellColour = new Color(shell.colour);
    const lining = trim.lining ? new Color(trim.lining) : shellColour.clone();
    const binding = trim.binding ? new Color(trim.binding) : shellColour.clone();
    const zone = attributeArray(g, '_zone');
    const colours = new Float32Array(zone.length * 3);
    const metal = new Float32Array(zone.length);
    zone.forEach((z, i) => {
      const c =
        z === ZONE.lining
          ? lining
          : z === ZONE.binding
            ? binding
            : z === ZONE.velcro
              ? new Color(HOOD.velcro)
              : z === ZONE.zip
                ? new Color(HOOD.zip)
                : shellColour;
      colours.set([c.r, c.g, c.b], i * 3);
      metal[i] = z === ZONE.zip ? 1 : 0;
    });
    g.setAttribute('color', new BufferAttribute(colours, 3));
    g.setAttribute('_metal', new BufferAttribute(metal, 1));
    applyHoodLook(
      material,
      finish,
      weaveNormalTexture(finish === 'glossy_ripstop'),
      binding,
      !!trim.binding,
    );
  }

  /**
   * A material with the program key of a hood of `finish` (programWarmup stand-in, never drawn):
   * the same construction as parse() + setLook(). The normal map is only a placeholder.
   */
  static programTwin(finish: Finish, normalMap: Texture) {
    const material = new MeshPhysicalMaterial({ vertexColors: true, side: DoubleSide });
    applyHoodLook(material, finish, normalMap, new Color(), false);
    return material;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.normalMap?.dispose();
    this.mesh.material.dispose();
    this.removeFromParent();
  }
}

/**
 * The hood's material for `finish`: the jacket's fabric values and weave map, and the hood
 * shader (one source for every hood; uniforms carry the trim colours).
 */
function applyHoodLook(
  material: MeshPhysicalMaterial,
  finish: Finish,
  normalMap: Texture,
  edgeColour: Color,
  bindingOn: boolean,
) {
  const m = materials[finish];
  material.roughness = m.roughness;
  material.specularIntensity = m.specularIntensity;
  material.envMapIntensity = m.envMapIntensity;
  material.clearcoat = m.clearcoat;
  material.clearcoatRoughness = m.clearcoatRoughness;
  material.sheen = m.sheen;
  material.sheenRoughness = m.sheenRoughness;
  material.sheenColor.set(0xffffff);
  material.normalMap = normalMap;
  material.normalScale.set(m.normalScale, m.normalScale);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.hBinding = { value: edgeColour };
    shader.uniforms.hBindingM = { value: bindingOn ? 0.012 : -1 };
    // The jacket's crinkle (garmentLook crinkleScaleM / crinkleStrength, same finish) plus a
    // soft, larger wrinkle field, so the shell is not plastic-smooth. Fixed to the material:
    // hUv is UV in material metres divided by look.weaveTileM.
    shader.uniforms.hCrinkleScale = { value: look.crinkleScaleM[finish] / look.weaveTileM };
    shader.uniforms.hCrinkle = { value: look.crinkleStrength[finish] * HOOD.crinkleGain };
    shader.uniforms.hWrinkle = { value: HOOD.wrinkle };
    shader.vertexShader =
      'attribute float _quilt; attribute float _seamd; attribute float _edge; attribute float _zone; attribute float _metal;\n' +
      'varying float hQuilt; varying float hSeam; varying float hEdge; varying float hZone; varying float hMetal; varying vec2 hUv;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nhQuilt = _quilt; hSeam = _seamd; hEdge = _edge; hZone = _zone; hMetal = _metal; hUv = uv;',
      );
    shader.fragmentShader =
      'uniform vec3 hBinding; uniform float hBindingM; uniform float hCrinkleScale; uniform float hCrinkle; uniform float hWrinkle;\n' +
      'varying float hQuilt; varying float hSeam; varying float hEdge; varying float hZone; varying float hMetal; varying vec2 hUv;\n' +
      HOOD_NOISE +
      shader.fragmentShader
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
        if (hZone < 2.5) {
          // Height field on the material; its screen-space gradient tilts the normal.
          vec2 m = hUv;
          float h = hCrinkle * .3 * (hNoise(m / hCrinkleScale) + .5 * hNoise(m / hCrinkleScale * 2.31 + 11.))
                  + hWrinkle * (hNoise(m * .35 + 3.) - .5);
          vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
          vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);
          float det = dot(sx, r1);
          if (abs(det) > 1e-20) normal = normalize(normal - (dFdx(h) * r1 + dFdy(h) * r2) / det * .04);
        }`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
        {
          bool fabric = hZone < 2.5;
          // Crisp binding edge from the material distance to the face edge (zones are per vertex).
          if (fabric && hBindingM > 0.) {
            float aa = fwidth(hEdge);
            diffuseColor.rgb = mix(diffuseColor.rgb, hBinding, 1. - smoothstep(hBindingM - aa, hBindingM + aa, hEdge));
          }
          float thread = 0.;
          if (fabric && hQuilt >= 0.) {
            float d = abs(fract(hQuilt + .5) - .5);
            float aa = fwidth(hQuilt);
            thread = max(thread, 1. - smoothstep(.006, .006 + aa, d));
          }
          if (fabric) {
            float aa = fwidth(hSeam);
            thread = max(thread, 1. - smoothstep(.05, .05 + aa, hSeam));
            // Self-colour binding (puffer): one stitch line 1 cm in from the edge.
            if (hBindingM < 0.) {
              float ae = fwidth(hEdge);
              thread = max(thread, 1. - smoothstep(.0008, .0008 + ae * 1.5, abs(hEdge - .01)));
            }
          }
          diffuseColor.rgb *= 1. - ${HOOD.stitchDarken.toFixed(3)} * thread;
        }`,
        )
        .replace(
          '#include <metalnessmap_fragment>',
          '#include <metalnessmap_fragment>\nmetalnessFactor = max(metalnessFactor, hMetal);',
        );
  };
  material.needsUpdate = true;
}

function attributeArray(g: BufferGeometry, name: string): Float32Array {
  const a = g.getAttribute(name) as BufferAttribute | undefined;
  if (!a) throw new Error(`Hood asset has no ${name} attribute`);
  return Float32Array.from(a.array as ArrayLike<number>);
}

function mean(points: Float32Array, ids: number[]): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (const i of ids) for (let k = 0; k < 3; k++) c[k] += points[i * 3 + k] / ids.length;
  return c;
}

function interpolate(at: readonly number[], values: readonly Vec3[], s: number): Vec3 {
  if (s <= at[0]) return values[0];
  if (s >= at[at.length - 1]) return values[values.length - 1];
  let i = 1;
  while (i < at.length - 1 && at[i] < s) i++;
  const t = (s - at[i - 1]) / (at[i] - at[i - 1] || 1);
  const a = values[i - 1],
    b = values[i];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
