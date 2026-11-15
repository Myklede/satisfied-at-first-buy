import {
  BackSide,
  DoubleSide,
  FrontSide,
  Mesh,
  MeshDepthMaterial,
  MeshPhysicalMaterial,
  PerspectiveCamera,
  RGBADepthPacking,
  Scene,
  WebGLRenderTarget,
  type Material,
  type Object3D,
  type WebGLRenderer,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import { ProgramWarmup, shadowDepthStandIn, standIn, twin } from './programWarmup';
import { finishOf, garmentStandIns } from './GarmentLayer';

/**
 * The parts of WebGLRenderer that ProgramWarmup uses. compile() records the render target bound
 * during the call and gives each material `programs` whose readiness the test controls.
 */
function fakeRenderer(programsPerMaterial = 1) {
  let target: WebGLRenderTarget | null = null;
  const state = new Map<Material, { programs: Map<string, { isReady(): boolean }> }>();
  const ready = { value: false };
  const calls: { target: WebGLRenderTarget | null; lights: Scene; materials: Material[] }[] = [];
  const renderer = {
    info: { programs: [] as unknown[] },
    properties: { get: (material: Material) => state.get(material) ?? {} },
    getRenderTarget: () => target,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    setRenderTarget: (next: WebGLRenderTarget | null) => {
      target = next;
    },
    compile: (group: Object3D, _camera: unknown, lights: Scene) => {
      const materials: Material[] = [];
      group.traverse((object) => {
        if (object instanceof Mesh) materials.push(object.material as Material);
      });
      for (const material of materials) {
        const programs = new Map<string, { isReady(): boolean }>();
        for (let i = 0; i < programsPerMaterial; i++)
          programs.set(`${material.uuid}:${i}`, { isReady: () => ready.value });
        state.set(material, { programs });
      }
      calls.push({ target, lights, materials });
      return new Set(materials);
    },
  };
  return { renderer: renderer as unknown as WebGLRenderer, calls, ready, target: () => target };
}

describe('ProgramWarmup', () => {
  it('compiles with the given render target bound, then restores the previous one', async () => {
    const fake = fakeRenderer();
    const scene = new Scene();
    const warm = new ProgramWarmup(fake.renderer, scene, new PerspectiveCamera());
    const composer = new WebGLRenderTarget(4, 4);
    const previous = new WebGLRenderTarget(2, 2);
    fake.renderer.setRenderTarget(previous);
    fake.ready.value = true;
    await warm.compile('look', composer, () => [standIn(new MeshPhysicalMaterial())]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].target).toBe(composer);
    expect(fake.calls[0].lights).toBe(scene);
    expect(fake.target()).toBe(previous);
  });

  it('uses the given lights scene (bare full-screen quads have none)', async () => {
    const fake = fakeRenderer();
    fake.ready.value = true;
    const warm = new ProgramWarmup(fake.renderer, new Scene(), new PerspectiveCamera());
    const empty = new Scene();
    await warm.compile('passes', null, () => [standIn(new MeshPhysicalMaterial())], [], empty);
    expect(fake.calls[0].lights).toBe(empty);
  });

  it('resolves only when every program of every material is linked', async () => {
    vi.useFakeTimers();
    try {
      // Two programs per material: a transparent double-sided material has one per side pass.
      const fake = fakeRenderer(2);
      const warm = new ProgramWarmup(fake.renderer, new Scene(), new PerspectiveCamera());
      let done = false;
      void warm
        .compile('xray', null, () => [standIn(new MeshPhysicalMaterial())])
        .then(() => (done = true));
      await vi.advanceTimersByTimeAsync(200);
      expect(done).toBe(false);
      expect(warm.ready('xray')).toBe(false);
      fake.ready.value = true;
      await vi.advanceTimersByTimeAsync(50);
      expect(done).toBe(true);
      expect(warm.ready('xray')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('compiles a batch once per key', async () => {
    const fake = fakeRenderer();
    fake.ready.value = true;
    const warm = new ProgramWarmup(fake.renderer, new Scene(), new PerspectiveCamera());
    const build = vi.fn(() => [standIn(new MeshPhysicalMaterial())]);
    const a = warm.compile('look:satin_matte', null, build);
    const b = warm.compile('look:satin_matte', null, build);
    expect(a).toBe(b);
    await a;
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('keeps stand-ins alive until disposed, and never disposes shared materials', async () => {
    const fake = fakeRenderer();
    fake.ready.value = true;
    const warm = new ProgramWarmup(fake.renderer, new Scene(), new PerspectiveCamera());
    const own = new MeshPhysicalMaterial(),
      shared = new MeshPhysicalMaterial();
    const ownDispose = vi.spyOn(own, 'dispose'),
      sharedDispose = vi.spyOn(shared, 'dispose');
    await warm.compile('scene', null, () => [standIn(own), standIn(shared)], [shared]);
    expect(ownDispose).not.toHaveBeenCalled();
    warm.dispose();
    expect(ownDispose).toHaveBeenCalledTimes(1);
    expect(sharedDispose).not.toHaveBeenCalled();
  });

  it('stops waiting once disposed (renderer gone: resolves, never throws)', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeRenderer();
      const warm = new ProgramWarmup(fake.renderer, new Scene(), new PerspectiveCamera());
      let done = false;
      void warm
        .compile('look', null, () => [standIn(new MeshPhysicalMaterial())])
        .then(() => {
          done = true;
        });
      warm.dispose();
      await vi.advanceTimersByTimeAsync(50);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('stand-ins', () => {
  it('twin keeps onBeforeCompile, so the program key (its source text) is the same', () => {
    const material = new MeshPhysicalMaterial({ sheen: 0.4, vertexColors: true });
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = '// patched\n' + shader.fragmentShader;
    };
    const copy = twin(material);
    expect(copy).not.toBe(material);
    expect(copy.onBeforeCompile).toBe(material.onBeforeCompile);
    expect(copy.customProgramCacheKey()).toBe(material.customProgramCacheKey());
    expect(copy.sheen).toBe(0.4);
    expect(copy.vertexColors).toBe(true);
  });

  it('shadow casters use the depth side WebGLShadowMap gives them', () => {
    const side = (caster: typeof FrontSide | typeof BackSide | typeof DoubleSide) => {
      const material = shadowDepthStandIn(caster).material as MeshDepthMaterial;
      expect(material.depthPacking).toBe(RGBADepthPacking);
      return material.side;
    };
    expect(side(FrontSide)).toBe(BackSide);
    expect(side(BackSide)).toBe(FrontSide);
    expect(side(DoubleSide)).toBe(DoubleSide);
  });

  it('garment stand-ins: opaque look, X-ray as two transparent side passes, caster', () => {
    // As GarmentLayer's own materials: double-sided vertex-coloured shell with a shader patch,
    // currently in X-ray (the stand-ins must not copy the live mode), and its depth caster.
    const material = new MeshPhysicalMaterial({ vertexColors: true, side: DoubleSide });
    material.transparent = true;
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = '// garment\n' + shader.fragmentShader;
    };
    const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
    depth.onBeforeCompile = (shader) => {
      shader.vertexShader = '// garment depth\n' + shader.vertexShader;
    };
    const weave = new WebGLRenderTarget(1, 1).texture;
    const { look, xray } = garmentStandIns(material, depth, 'glossy_ripstop', weave);
    const shell = (look[0] as Mesh).material as MeshPhysicalMaterial;
    expect(shell.transparent).toBe(false);
    expect(shell.side).toBe(DoubleSide);
    expect(shell.normalMap).toBe(weave);
    expect(shell.vertexColors).toBe(true);
    expect(material.transparent).toBe(true); // the live material is untouched
    const caster = (look[1] as Mesh).material as MeshDepthMaterial;
    expect(caster.side).toBe(DoubleSide);
    expect(caster.depthPacking).toBe(RGBADepthPacking);
    expect(caster.customProgramCacheKey()).toBe(depth.customProgramCacheKey());
    const passes = xray.map((o) => (o as Mesh).material as MeshPhysicalMaterial);
    expect(passes.map((m) => m.side)).toEqual([BackSide, FrontSide]);
    expect(passes.every((m) => m.transparent)).toBe(true);
    // Same shader patch as the shell (onBeforeCompile is part of the program key).
    for (const m of [shell, ...passes])
      expect(m.customProgramCacheKey()).toBe(material.customProgramCacheKey());
    // The finishes differ in program-relevant parameters (anisotropy / clearcoat / sheen).
    const satin = (garmentStandIns(material, depth, 'satin_matte', weave).look[0] as Mesh)
      .material as MeshPhysicalMaterial;
    expect([satin.anisotropy > 0, satin.clearcoat > 0, satin.sheen > 0]).not.toEqual([
      shell.anisotropy > 0,
      shell.clearcoat > 0,
      shell.sheen > 0,
    ]);
  });

  it('finishOf: the shell finish of an asset', () => {
    expect(finishOf({ finish: 'glossy_ripstop' })).toBe('glossy_ripstop');
    expect(finishOf({ finish: 'satin_matte' })).toBe('satin_matte');
  });
});
