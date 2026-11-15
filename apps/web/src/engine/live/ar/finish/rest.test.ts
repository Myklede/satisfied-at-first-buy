import { describe, expect, it, vi } from 'vitest';
import { Texture, WebGLRenderTarget, type WebGLRenderer } from 'three';
import { ArFinish } from './ArFinish';
import { VideoProbe } from './probe';
import type { ArFinisher } from '../ArCompositor';
import type { ClassMaskResult } from './segmenterClient';

type Input = Parameters<ArFinisher['apply']>[1];

function input(x: number): Input {
  return {
    warped: new WebGLRenderTarget(64, 48),
    jacket: new WebGLRenderTarget(64, 48),
    video: new Texture(),
    frame: { width: 64, height: 48 },
    personMask: { width: 2, height: 2, data: new Float32Array([x, x, x, x]) },
    landmarks: Array.from({ length: 33 }, (_, i) => ({
      x: (i % 2 ? 15 : 45) + x,
      y: i < 11 ? 5 : i < 13 ? 15 : 35,
      visibility: 1,
    })),
    hands: [],
    exposure: 0.92,
  };
}

// Rendering itself needs a browser. This test exercises the real CPU orchestration with the
// renderer's draw-only seam replaced; it never constructs a WebGL context or runs a model.
function renderer() {
  return {
    setRenderTarget: vi.fn(),
    setClearColor: vi.fn(),
    clear: vi.fn(),
    render: vi.fn(),
  } as unknown as WebGLRenderer;
}

describe('finisher consumes the shared rest decision', () => {
  it('holds the class mask and its mapping together, then consumes the latest reply on release', () => {
    vi.stubGlobal('HTMLVideoElement', class {});
    const probe = vi.spyOn(VideoProbe.prototype, 'read').mockReturnValue(null);
    const result = (id: number): ClassMaskResult => ({
      id,
      sentAt: performance.now(),
      arrivedAt: performance.now(),
      workerMs: 10,
      tag: null,
      timing: { bitmapMs: 0, queueMs: 0, inferMs: 10, packMs: 0, replyMs: 0 },
      rect: { x: id, y: 0, w: 40, h: 40 },
      anchor: null,
      mask: { width: 2, height: 2, data: new Uint8Array(4).fill(4) },
      packed: { width: 2, height: 2, data: new Uint8Array(16).fill(id) },
    });
    const first = result(1),
      latest = result(2);
    const segmenter = { request: () => false, latest: first, dispose: () => {} };
    const f = new ArFinish(),
      a = input(0.1),
      r = renderer();
    a.video.image = { width: 64, height: 48 };
    const internal = f as unknown as {
      segmenter: typeof segmenter;
      classResult: ClassMaskResult;
      classTexture: { version: number };
    };
    internal.segmenter = segmenter;
    f.setStillState({ still: false });
    f.apply(r, a);
    expect(f.stats.usedClasses).toBe(true);
    const version = internal.classTexture.version;
    segmenter.latest = latest;
    first.sentAt = -100000; // Stillness must not flicker into the age fallback.
    f.setStillState({ still: true });
    f.apply(r, a);
    expect(internal.classResult).toBe(first);
    expect(internal.classTexture.version).toBe(version);
    expect(f.stats.usedClasses).toBe(true);
    f.setStillState({ still: false });
    f.apply(r, a);
    expect(internal.classResult).toBe(latest);
    expect(internal.classTexture.version).toBeGreaterThan(version);
    f.dispose();
    a.warped.dispose();
    a.jacket.dispose();
    a.video.dispose();
    probe.mockRestore();
    vi.unstubAllGlobals();
  });

  it('ignores a pending colour readback that arrives after rest engages', async () => {
    let resolvePixels: ((pixels: Uint8Array) => void) | undefined;
    const pending = new Promise<Uint8Array>((resolve) => {
      resolvePixels = resolve;
    });
    const probe = vi
      .spyOn(VideoProbe.prototype, 'read')
      .mockImplementation((_renderer, name) => (name === 'frame' ? pending : null));
    const f = new ArFinish({ classes: false });
    const r = renderer(),
      a = input(0.1);
    f.setStillState({ still: false });
    f.apply(r, a);
    const lift = f.match.lift;
    f.setStillState({ still: true });
    f.apply(r, a);
    resolvePixels!(new Uint8Array(96 * 72 * 4).fill(120));
    await pending;
    expect(f.match.lift).toBe(lift);
    f.dispose();
    a.warped.dispose();
    a.jacket.dispose();
    a.video.dispose();
    probe.mockRestore();
  });

  it('holds geometry and mask bytes, skips probes, and releases in the first moving frame', () => {
    const probe = vi.spyOn(VideoProbe.prototype, 'read').mockReturnValue(null);
    const f = new ArFinish({ classes: false });
    const r = renderer();
    const a = input(0.1),
      b = input(0.9);
    f.setStillState({ still: false });
    f.apply(r, a);
    const geometry = f.geometry;
    // Inspect the actual uploaded bytes (the public geometry plus shader texture are the
    // production output). The cast exposes only this private field for this regression test.
    const internals = f as unknown as { personOut: Uint8Array };
    const bytes = internals.personOut.slice();
    const reads = probe.mock.calls.length;
    f.setStillState({ still: true });
    for (let i = 0; i < 30; i++) f.apply(r, b);
    expect(f.still).toBe(1);
    expect(f.geometry).toBe(geometry);
    expect(internals.personOut).toEqual(bytes);
    expect(probe.mock.calls.length).toBe(reads);
    f.setStillState({ still: false });
    f.apply(r, b);
    expect(f.still).toBe(0);
    expect(f.geometry).not.toBe(geometry);
    expect(internals.personOut).not.toEqual(bytes);
    f.dispose();
    a.warped.dispose();
    a.jacket.dispose();
    a.video.dispose();
    b.warped.dispose();
    b.jacket.dispose();
    b.video.dispose();
    probe.mockRestore();
  });

  it('resets held geometry on a source-size change', () => {
    const probe = vi.spyOn(VideoProbe.prototype, 'read').mockReturnValue(null);
    const f = new ArFinish({ classes: false });
    const r = renderer(),
      a = input(0.1);
    f.apply(r, a);
    const previous = f.geometry;
    f.setStillState({ still: true });
    a.frame = { width: 128, height: 96 };
    f.apply(r, a);
    expect(f.still).toBe(0);
    expect(f.geometry).not.toBe(previous);
    f.dispose();
    a.warped.dispose();
    a.jacket.dispose();
    a.video.dispose();
    probe.mockRestore();
  });
});
