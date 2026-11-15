// RecordMoveBaker.bake with a fake MotionClient (the real worker bake is covered by
// RecordedBakedMove.test.ts and the evaluation tools): request, progress, subdivision and the
// sleeve gate.
import { describe, expect, it, vi } from 'vitest';
import type { ClothAsset } from '../../cloth/ClothSolver.ts';
import type { BakedMotion, BakeProgress } from '../../motion/bake.ts';
import type { MotionClient } from '../../motion/MotionClient.ts';
import { anchorFrame, parseFrames, parseRig, type MotionAnchors } from '../../motion/rig.ts';
import { fixtureAvailable, fixtureBuffer, fixtureJson } from '../../motion/testFixture.ts';
import type { CustomMotionRequest } from './customRequest.ts';
import { BakeProgressMeter, PhysicsInvalidError, RecordMoveBaker } from './RecordMoveBaker.ts';

const NEEDED = ['rig.bin', 'anchors.json', 'frames-reach_up_both.bin', 'cloth-FB-S.json'];
const ID = 'd'.repeat(64);
const OPTIONS = { bodyId: ID, fitId: ID, productId: ID, size: 'S' };

describe('bake progress', () => {
  it('counts solver steps: relax (until it ends) then motion frames × steps per frame', () => {
    const meter = new BakeProgressMeter(100, 2);
    expect(meter.fraction).toBe(0);
    expect(meter.update({ phase: 'relax', done: 30, total: 60 })).toBeCloseTo(30 / 260);
    // The relax stopped early after 30 steps: its total becomes 30.
    expect(meter.update({ phase: 'motion', done: 50, total: 100 })).toBeCloseTo(130 / 230);
    expect(meter.update({ phase: 'motion', done: 100, total: 100 })).toBe(1);
    const cached = new BakeProgressMeter(100, 4);
    expect(cached.update({ phase: 'motion', done: 25, total: 100 })).toBeCloseTo(0.25);
  });
});

describe.skipIf(!fixtureAvailable(...NEEDED))('RecordMoveBaker (reference body frames)', () => {
  const rig = parseRig(fixtureBuffer('rig.bin'));
  const anchors = fixtureJson<MotionAnchors>('anchors.json');
  const buffer = fixtureBuffer('frames-reach_up_both.bin');
  const frames = parseFrames(buffer, rig.drivers.length);
  const asset = fixtureJson<ClothAsset>('cloth-FB-S.json');
  const N = asset.initial.length / 3;
  const ring = (k: string) => asset.paths[k].slice(0, -1);

  /** A bake whose cuff rings sit on the wrist joints, except `lose` (side, from frame). */
  function fakeBake(lose?: { side: 0 | 1; from: number }): BakedMotion {
    const F = frames.count;
    const positions = new Float32Array(F * N * 3);
    for (let f = 0; f < F; f++) {
      const j = anchorFrame(frames, 'joints', f);
      ([ring('cuff_L'), ring('cuff_R')] as number[][]).forEach((ids, s) => {
        const away = lose && lose.side === s && f >= lose.from ? 0.5 : 0;
        for (const i of ids)
          positions.set([j[s * 3], j[s * 3 + 1] - away, j[s * 3 + 2]], (f * N + i) * 3);
      });
    }
    return {
      motionId: 'custom',
      size: 'S',
      fps: 30,
      frameCount: F,
      particles: N,
      positions,
      metrics: Array.from({ length: F }, () => ({ cuffBeyondWristCm: { L: 3, R: 3 } })),
      summary: {},
      checks: {},
      timings: { totalMs: 1234, relaxCached: true, steps: (F - 1) * 2 },
    } as unknown as BakedMotion;
  }

  function setup(bake: BakedMotion) {
    const bakeCustom = vi.fn(
      async (
        _size: string,
        _frames: ArrayBuffer,
        options: { onProgress?: (p: BakeProgress) => void; maxFrames?: number } = {},
      ) => {
        options.onProgress?.({ phase: 'motion', done: 57, total: frames.count - 1 });
        return bake;
      },
    );
    const client = {
      sizes: ['S'],
      load: async () => ({ rig, anchors, presets: [], assets: { S: asset } }),
      bakeCustom,
      dispose: vi.fn(),
    } as unknown as MotionClient;
    const requests: CustomMotionRequest[] = [];
    const baker = new RecordMoveBaker({
      createClient: () => client,
      fetchFrames: async (_id, request) => {
        requests.push(request);
        return buffer;
      },
    });
    return { baker, bakeCustom, requests, client };
  }
  const poses = [
    { t: 5000, pose: { shoulder_R_elevation: 40 } },
    { t: 5033, pose: { shoulder_R_elevation: 42 } },
  ];

  it('bakes a valid move: request in seconds, honest progress, default step for preset speeds', async () => {
    const { baker, bakeCustom, requests } = setup(fakeBake());
    const progress: number[] = [];
    const move = await baker.bake(
      poses,
      OPTIONS,
      (p) => progress.push(p),
      new AbortController().signal,
    );
    expect(requests[0].poses.map((p) => p.t)).toEqual([0, 0.033]);
    expect(progress[0]).toBe(0);
    expect(progress[1]).toBeCloseTo(57 / (frames.count - 1));
    expect(progress[progress.length - 1]).toBe(1);
    const custom = bakeCustom.mock.calls[0][2] as { config?: unknown; maxFrames?: number };
    expect(custom.config).toBeUndefined(); // reach_up_both: no subdivision
    // Simulated up to the end of the recorded window (hold.end_s), not the lead-out.
    expect(custom.maxFrames).toBe(Math.round(frames.motion.hold.end_s * 30) + 1);
    expect(move.frameCount).toBe(frames.count);
    expect(baker.lastTimings).toMatchObject({ bakeMs: 1234, relaxCached: true });
    expect(baker.lastTimings!.subdivision!.factor).toBe(1);
  });

  it('announces the work and an estimate from the measured step time of earlier bakes', async () => {
    const plans: { steps: number; estimateMs: number | null; factor: number }[] = [];
    const bake = fakeBake();
    (bake.timings as { meanStepMs: number }).meanStepMs = 40;
    const { baker } = setup(bake);
    (baker as unknown as { deps: { onPlan: (p: never) => void } }).deps.onPlan = (p) =>
      plans.push(p);
    await baker.bake(poses, OPTIONS, () => undefined, new AbortController().signal);
    await baker.bake(poses, OPTIONS, () => undefined, new AbortController().signal);
    const simulated = Math.round(frames.motion.hold.end_s * 30) + 1;
    expect(plans[0]).toMatchObject({ factor: 1, steps: (simulated - 1) * 2, estimateMs: null });
    expect(plans[1].estimateMs).toBeCloseTo((simulated - 1) * 2 * 40);
  });

  it('rejects a move whose simulated sleeve came off the arm, with the reason', async () => {
    const { baker } = setup(fakeBake({ side: 0, from: 40 }));
    const error = await baker
      .bake(poses, OPTIONS, () => undefined, new AbortController().signal)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PhysicsInvalidError);
    expect((error as Error).message).toMatch(/left sleeve came off the arm 1\.3 s into the move/);
    expect(baker.lastMove!.sleeves).toMatchObject({ valid: false, frame: 40, side: 'L' });
    expect(baker.lastMove!.readouts(50)).toEqual({
      zones: [],
      exposureCm: null,
      sleeveRideUpCm: null,
    });
  });

  it('does nothing once aborted, and checks the ids', async () => {
    const { baker, bakeCustom } = setup(fakeBake());
    await expect(baker.bake(poses, OPTIONS, () => undefined, AbortSignal.abort())).rejects.toThrow(
      /cancelled/,
    );
    await expect(
      baker.bake(poses, { ...OPTIONS, bodyId: 'x' }, () => undefined, new AbortController().signal),
    ).rejects.toThrow(/Invalid/);
    expect(bakeCustom).not.toHaveBeenCalled();
  });
});
