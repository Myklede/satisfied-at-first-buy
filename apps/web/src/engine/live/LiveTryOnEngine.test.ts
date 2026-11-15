import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClothAsset } from '../../api';
import { fixtureAvailable, fixtureBuffer, fixtureJson } from '../motion/testFixture';
import type { BakedMove, LiveFrame, LiveSource, LiveTryOnState, MoveBaker } from './contract';
import { createLiveTryOn, hipsHidden, type StaticFit } from './LiveTryOnEngine';

const raf = globalThis.requestAnimationFrame;
beforeAll(() => {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 16) as unknown as number) as typeof raf;
  globalThis.cancelAnimationFrame = ((id: number) =>
    clearTimeout(id)) as typeof cancelAnimationFrame;
});
afterAll(() => {
  globalThis.requestAnimationFrame = raf;
});

const DOFS = [
  'trunk_flexion',
  'trunk_lateral',
  'trunk_twist',
  'shoulder_L_plane',
  'shoulder_L_elevation',
  'shoulder_L_axial',
  'shoulder_R_plane',
  'shoulder_R_elevation',
  'shoulder_R_axial',
  'elbow_L_flexion',
  'elbow_R_flexion',
  'hip_L_flexion',
  'hip_R_flexion',
  'knee_L_flexion',
  'knee_R_flexion',
];

/** A source that emits a raised right arm at 30 Hz once started; lost frames on demand. */
class FakeSource implements LiveSource {
  readonly kind = 'recording' as const;
  readonly video = null;
  lost = false;
  private timer?: ReturnType<typeof setInterval>;
  private listeners = new Set<(f: LiveFrame) => void>();
  private t = 0;
  start() {
    this.timer = setInterval(() => {
      this.t += 33;
      const pose: Record<string, number> = Object.fromEntries(DOFS.map((d) => [d, 0]));
      pose.shoulder_R_elevation = 120;
      pose.shoulder_L_elevation = 10;
      const frame: LiveFrame = {
        t: this.t,
        width: 640,
        height: 480,
        landmarks2d: this.lost ? null : [],
        world: this.lost ? null : [],
        pose: this.lost ? null : pose,
        confidence: this.lost ? {} : Object.fromEntries(DOFS.map((d) => [d, 0.9])),
        mask: null,
      };
      for (const l of this.listeners) l(frame);
    }, 33);
    return Promise.resolve();
  }
  stop() {
    clearInterval(this.timer);
  }
  onFrame(cb: (f: LiveFrame) => void) {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
}

const until = async (
  get: () => LiveTryOnState,
  test: (s: LiveTryOnState) => boolean,
  ms = 5000,
) => {
  const end = Date.now() + ms;
  while (!test(get())) {
    if (Date.now() > end) throw new Error(`timeout in phase ${get().phase}: ${get().message}`);
    await new Promise((r) => setTimeout(r, 20));
  }
  return get();
};

const fit: StaticFit = {
  sizes: {
    M: {
      zones: {
        chest: { value_cm: 10, status: 'fit' },
        sleeve: { value_cm: 4.5, status: 'too_big' },
        bicep: { value_cm: 10.4, status: 'fit' },
      },
    },
  },
};
const options = {
  bodyId: 'a'.repeat(64),
  fitId: 'b'.repeat(64),
  productId: 'c'.repeat(64),
  size: 'M',
};

describe.skipIf(!fixtureAvailable('rig.bin', 'cloth-FB-M.json'))('LiveTryOnEngine', () => {
  const deps = () => ({
    loadRig: () => Promise.resolve(fixtureBuffer('rig.bin')),
    loadCloth: () => Promise.resolve(fixtureJson<ClothAsset>('cloth-FB-M.json')),
    loadFit: () => Promise.resolve(fit),
  });

  it('tracks a source, poses the true sides, reports static-fit and preview zones, recovers from loss', async () => {
    const engine = createLiveTryOn(deps());
    const source = new FakeSource();
    await engine.start(source, options);
    const tracking = await until(
      () => engine.currentState,
      (s) => s.phase === 'tracking' && s.zones.some((z) => z.basis === 'preview'),
    );
    expect(tracking.zones.filter((z) => z.basis === 'static-fit').map((z) => z.zone)).toEqual([
      'chest',
      'bicep',
      'sleeve',
    ]);
    expect(tracking.zones.every((z) => z.basis !== 'physics')).toBe(true);
    // True pose, no mirror swap: the subject's RIGHT wrist (-X in the scene) is raised.
    const joints = engine.posedScene!.joints;
    expect(joints.rWrist[1]).toBeGreaterThan(joints.rShoulder[1]);
    expect(joints.lWrist[1]).toBeLessThan(joints.lShoulder[1]);
    expect(joints.rWrist[0]).toBeLessThan(0);
    source.lost = true;
    await until(
      () => engine.currentState,
      (s) => s.phase === 'lost',
    );
    source.lost = false;
    await until(
      () => engine.currentState,
      (s) => s.phase === 'tracking',
    );
    engine.dispose();
  });

  it('records a move: without a baker it says so; with one it plays physics back', async () => {
    const engine = createLiveTryOn(deps());
    const source = new FakeSource();
    await engine.start(source, options);
    await until(
      () => engine.currentState,
      (s) => s.phase === 'tracking',
    );
    await engine.recordMove(1);
    expect(engine.currentState.message).toMatch(/Physics bake not available yet/);
    engine.dispose();

    let baked: { t: number; pose: Record<string, number> }[] = [];
    const baker: MoveBaker = {
      bake(poses, _o, onProgress) {
        baked = poses;
        onProgress(1);
        const move: BakedMove = {
          fps: 30,
          frameCount: 10,
          applyFrame: () => undefined,
          readouts: () => ({
            zones: [{ zone: 'chest', valueCm: 3, status: 'fit', basis: 'physics' }],
            exposureCm: { front: 0, back: 0, sides: 0 },
            sleeveRideUpCm: { left: 0, right: 2 },
          }),
          dispose: () => undefined,
        };
        return Promise.resolve(move);
      },
    };
    const withBaker = createLiveTryOn({ ...deps(), moveBaker: baker, warmBaker: false });
    const source2 = new FakeSource();
    await withBaker.start(source2, options);
    await until(
      () => withBaker.currentState,
      (s) => s.phase === 'tracking',
    );
    await withBaker.recordMove(1);
    const playback = await until(
      () => withBaker.currentState,
      (s) => s.phase === 'playback' && s.zones.some((z) => z.basis === 'physics'),
    );
    expect(playback.sleeveRideUpCm).toEqual({ left: 0, right: 2 });
    expect(baked.length).toBeGreaterThan(20);
    // The recorded poses are the TRUE pose (right arm up), not mirrored.
    expect(baked[5].pose.shoulder_R_elevation).toBe(120);
    // A size change invalidates the baked move: back to live, nothing to replay.
    await withBaker.setSize('L');
    expect(withBaker.currentState.phase).toBe('tracking');
    withBaker.replayLast();
    expect(withBaker.currentState.phase).toBe('tracking');
    withBaker.dispose();
    // ~5 s of real recording time by design; the 5 s default timed out on the loaded machine.
  }, 30000);
});

describe('hipsHidden (?f1close=1 neutral stand)', () => {
  const frame = (hips: { x: number; y: number; visibility: number }[]): LiveFrame => ({
    t: 0,
    width: 960,
    height: 540,
    landmarks2d: Array.from({ length: 33 }, (_, i) =>
      i === 23 ? hips[0] : i === 24 ? hips[1] : { x: 480, y: 270, visibility: 0.9 },
    ),
    world: null,
    pose: {},
    confidence: {},
    mask: null,
  });
  it('hips in the frame are seen; past or at the bottom edge, or not visible, are hidden', () => {
    const inside = { x: 500, y: 420, visibility: 0.95 };
    expect(hipsHidden(frame([inside, { ...inside, x: 420 }]))).toBe(false);
    // Live parka replay 66.87 s: one hip at y 534 (inside, 6 px from the edge), one at 589.
    expect(
      hipsHidden(
        frame([
          { ...inside, y: 534 },
          { ...inside, y: 589 },
        ]),
      ),
    ).toBe(true);
    expect(hipsHidden(frame([inside, { ...inside, visibility: 0.3 }]))).toBe(true);
    expect(hipsHidden({ ...frame([inside, inside]), landmarks2d: null })).toBe(true);
  });
});
