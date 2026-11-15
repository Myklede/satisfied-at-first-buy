// Shader programs compiled before their first draw, without blocking the main thread, and kept.
//
// Why (agent M, docs/requests/M-to-lead.md §2; agent S, docs/STATUS-kiosk.md "S"): on
// ANGLE/D3D11 with a cold GPU shader cache, the first draw of each garment program (a ~105 k
// character fragment shader) waited synchronously for the driver: 5–8 s per program, 20 s for
// the X-ray switch. WebGLRenderer.compile() only submits compile + link; with
// KHR_parallel_shader_compile the driver works in the background and COMPLETION_STATUS_KHR says
// when it is done (WebGLProgram.isReady). A draw after that finds the program linked.
//
// Two rules make a precompiled program the one the real draw uses:
// - Same program key. WebGLPrograms.getParameters reads the renderer's current render target
//   (tone mapping and output colour space are off/linear inside the composer's targets), the
//   scene's lights and environment, the material and the mesh. So the compile binds the target
//   the draw will use, takes lights/environment from the real scene, and compiles a material in
//   exactly the state it will be drawn in (stand-ins: clones or factory twins of the real ones).
// - Kept alive. A program is destroyed when the last material using it is disposed, and the
//   details, hood, hardware and motion cloth materials are rebuilt per asset or motion. The
//   stand-ins here are never drawn and never disposed before the renderer, so they pin every
//   program for the renderer's life.
import {
  BackSide,
  BufferGeometry,
  DoubleSide,
  FrontSide,
  Group,
  Mesh,
  MeshDepthMaterial,
  RGBADepthPacking,
  type Camera,
  type Material,
  type Object3D,
  type Scene,
  type Side,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';

/** WebGLShadowMap's depth side for a caster drawn with `side` (three r181 `shadowSide`). */
const SHADOW_SIDE: Record<Side, Side> = {
  [FrontSide]: BackSide,
  [BackSide]: FrontSide,
  [DoubleSide]: DoubleSide,
};

const NO_GEOMETRY = new BufferGeometry();

/** The part of three's per-material renderer state read here (WebGLRenderer.getProgram). */
interface MaterialPrograms {
  programs?: Map<string, { isReady(): boolean }>;
}

/**
 * A mesh that only carries a material to compile and keep; never added to a drawn scene. Its
 * geometry matters only through attributes in the program key (tangent, colour size, morphs):
 * pass the real geometry when it has any of those.
 */
export function standIn(material: Material, geometry: BufferGeometry = NO_GEOMETRY): Mesh {
  return new Mesh(geometry, material);
}

/**
 * Shadow-pass stand-in for casters without a customDepthMaterial: WebGLShadowMap draws them
 * with its own `MeshDepthMaterial({ depthPacking: RGBADepthPacking })`, side mirrored.
 */
export function shadowDepthStandIn(casterSide: Side): Mesh {
  return standIn(
    new MeshDepthMaterial({ depthPacking: RGBADepthPacking, side: SHADOW_SIDE[casterSide] }),
  );
}

/** Same as `material.clone()`, keeping onBeforeCompile (clone drops it; it is in the key). */
export function twin<M extends Material>(material: M): M {
  const copy = material.clone() as M;
  copy.onBeforeCompile = material.onBeforeCompile;
  return copy;
}

export class ProgramWarmup {
  /** Stand-ins, kept for the renderer's life (never added to the drawn scene). */
  private readonly keep = new Group();
  /** Materials created for stand-ins (disposed with this); shared ones are left alone. */
  private readonly owned = new Set<Material>();
  private readonly batches = new Map<string, { promise: Promise<void>; ready: boolean }>();
  private disposed = false;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
    private readonly camera: Camera,
  ) {}

  /**
   * Compiles the stand-ins of batch `key` once (later calls return the same promise), with
   * `target` bound as the renderer's render target: the target the real draw renders into.
   * Resolves when every program of every stand-in material is linked; never rejects.
   * `shared` materials belong to the caller (not disposed here). `lights` is the scene whose
   * lights and environment the real draw uses: the viewer's scene by default; an empty scene
   * for full-screen pass quads (drawn as a bare mesh: no lights, so no shadow-map code).
   */
  compile(
    key: string,
    target: WebGLRenderTarget | null,
    objects: () => Object3D[],
    shared: readonly Material[] = [],
    lights: Scene = this.scene,
  ): Promise<void> {
    const known = this.batches.get(key);
    if (known) return known.promise;
    const batch = { promise: Promise.resolve(), ready: false };
    this.batches.set(key, batch);
    batch.promise = this.run(objects(), target, new Set(shared), lights).then(() => {
      batch.ready = true;
    });
    return batch.promise;
  }

  /** True once batch `key` is compiled and linked. */
  ready(key: string) {
    return this.batches.get(key)?.ready ?? false;
  }

  private run(
    objects: Object3D[],
    target: WebGLRenderTarget | null,
    shared: Set<Material>,
    lights: Scene,
  ) {
    if (this.disposed) return Promise.resolve();
    const group = new Group();
    for (const object of objects) group.add(object);
    this.keep.add(group);
    const materials = new Set<Material>();
    group.traverse((object) => {
      const material = (object as Mesh).material as Material | Material[] | undefined;
      for (const m of Array.isArray(material) ? material : material ? [material] : []) {
        materials.add(m);
        if (!shared.has(m)) this.owned.add(m);
      }
    });
    const renderer = this.renderer;
    const previous = renderer.getRenderTarget(),
      face = renderer.getActiveCubeFace(),
      level = renderer.getActiveMipmapLevel();
    renderer.setRenderTarget(target);
    try {
      // Submits compile + link for every program and returns at once (no first use yet).
      renderer.compile(group, this.camera, lights);
    } finally {
      renderer.setRenderTarget(previous, face, level);
    }
    const programs: { isReady(): boolean }[] = [];
    for (const material of materials) {
      const state = renderer.properties.get(material) as MaterialPrograms;
      programs.push(...(state.programs?.values() ?? []));
    }
    // Poll COMPLETION_STATUS_KHR (isReady) without blocking. All side passes of a transparent
    // double-sided material are checked, not only its last one (compileAsync checks the last).
    return new Promise<void>((resolve) => {
      const poll = () => {
        if (this.disposed || programs.every((program) => program.isReady())) resolve();
        else setTimeout(poll, 16);
      };
      poll();
    });
  }

  dispose() {
    this.disposed = true;
    for (const material of this.owned) material.dispose();
    this.owned.clear();
    this.keep.clear();
  }
}
