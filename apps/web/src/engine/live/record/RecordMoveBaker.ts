// "Record a move" (contract.ts MoveBaker, agent V3): bakes TRUE cloth physics for a recorded pose
// sequence on the user's own body. The body service turns the poses into motion frames through the
// preset code path (POST /motion/{body_id}/custom/frames.bin); the frames are then baked by the
// existing motion bake: MotionClient's worker, bake.ts, the bit-identical WebAssembly kernels.
// Nothing about the preset bakes changes. Body data stays on this machine (loopback service, the
// worker's memory); the poses are never stored.
import type { AnatomicalPose } from '../../motion/rig.ts';
import type { BakeProgress } from '../../motion/bake.ts';
import { MotionClient, type MotionData } from '../../motion/MotionClient.ts';
import { parseFrames } from '../../motion/rig.ts';
import type { BakedMove, LiveTryOnOptions, MoveBaker } from '../contract.ts';
import type { StaticZone } from '../readouts.ts';
import {
  customMotionRequest,
  fetchCustomFrames,
  type CustomMotionRequest,
} from './customRequest.ts';
import { RecordedBakedMove } from './RecordedBakedMove.ts';
import { subdivisionFor } from './subdivision.ts';

const ID = /^[a-f0-9]{64}$/;

export type RecordMoveBakerDeps = {
  /**
   * The host's MotionClient for this body and jacket, if it has one loaded with this size (the
   * kiosk's "Try moves" client): it shares the workers and their relaxed cloth state. Otherwise the
   * baker creates its own and keeps it for the next recording.
   */
  clientFor?: (options: LiveTryOnOptions) => MotionClient | undefined;
  /** The static garment-fit zones of options.size (GarmentFitResponse.sizes[size].zones). */
  staticZones?: (options: LiveTryOnOptions) => Record<string, StaticZone> | null | undefined;
  /** Test seams. */
  fetchFrames?: (
    bodyId: string,
    request: CustomMotionRequest,
    signal?: AbortSignal,
  ) => Promise<ArrayBuffer>;
  createClient?: (bodyId: string, fitId: string, sizes: string[]) => MotionClient;
  /**
   * Called once the move's frames are known, before the simulation starts: how much work it is
   * and an estimate of the wait from this machine's measured step time (previous bakes), so the
   * screen can say "about 30 s" honestly. The estimate is not a measurement.
   */
  onPlan?: (plan: BakePlan) => void;
};

export type BakePlan = {
  /** Frames simulated (lead-in + the recorded window). */
  frames: number;
  /** Solver steps per default step (subdivision.ts) and total motion steps. */
  factor: number;
  steps: number;
  /** steps × the measured mean step time (ms) of this baker's previous bakes; null before any. */
  estimateMs: number | null;
  stepMs: number | null;
};

const aborted = () => new DOMException('The bake was cancelled', 'AbortError');

/**
 * The cloth simulation of this move failed its sanity gate (RecordedBakedMove.sleeves: a sleeve
 * came off the arm). Its numbers are physically impossible, so no BakedMove is returned; `move`
 * is kept for diagnostics only.
 */
export class PhysicsInvalidError extends Error {
  constructor(
    message: string,
    readonly move: RecordedBakedMove,
  ) {
    super(message);
    this.name = 'PhysicsInvalidError';
  }
}

/**
 * Honest progress: solver steps done / steps to do. The relax (skipped when the worker holds the
 * relaxed state already) and the motion are counted in solver steps (bake.ts: one per relax step,
 * `perFrame` per motion frame); the relax total is its cap until it ends, then what it took.
 */
export class BakeProgressMeter {
  private relaxDone = 0;
  private relaxTotal = 0;
  private motionDone = 0;
  constructor(
    private motionFrames: number,
    private perFrame = 2,
  ) {}
  update(p: BakeProgress) {
    if (p.phase === 'relax') {
      this.relaxDone = p.done;
      this.relaxTotal = p.total;
    } else {
      this.relaxTotal = this.relaxDone; // the relax is over (or was cached: 0)
      this.motionDone = p.done;
      this.motionFrames = p.total;
    }
    return this.fraction;
  }
  get fraction() {
    const total = this.relaxTotal + this.motionFrames * this.perFrame;
    return total > 0 ? Math.min(1, (this.relaxDone + this.motionDone * this.perFrame) / total) : 0;
  }
}

export class RecordMoveBaker implements MoveBaker {
  private own?: { key: string; client: MotionClient };
  /** The last bake's timings (also on the BakedMove). */
  lastTimings?: RecordedBakedMove['timings'];
  /** The last bake, valid or not (diagnostics; an invalid one is never returned by bake()). */
  lastMove?: RecordedBakedMove;
  /** Running mean solver step time (ms) measured on this machine by previous bakes. */
  private stepMs: number | null = null;

  constructor(private deps: RecordMoveBakerDeps = {}) {}

  private client(options: LiveTryOnOptions) {
    const host = this.deps.clientFor?.(options);
    if (host && host.sizes.includes(options.size)) return host;
    const key = `${options.bodyId}|${options.fitId}|${options.size}`;
    if (this.own?.key !== key) {
      this.own?.client.dispose();
      const create =
        this.deps.createClient ??
        ((bodyId: string, fitId: string, sizes: string[]) =>
          new MotionClient(bodyId, fitId, sizes));
      this.own = { key, client: create(options.bodyId, options.fitId, [options.size]) };
    }
    return this.own.client;
  }

  /**
   * Optional warm-up while the user is still being tracked: loads the motion data and garment
   * and relaxes the cloth on the neutral body (a 2-frame neutral move), so a recording's bake
   * only simulates the move itself. Every recording starts at the same neutral frame, so the
   * worker reuses the relaxed state bit for bit (bake.ts relaxCache). The relax is also done at
   * the half step that most fast moves get (subdivision.ts), which has its own relaxed state.
   */
  async warm(options: LiveTryOnOptions, signal?: AbortSignal) {
    const client = this.client(options);
    const data = await client.load();
    const fetchFrames = this.deps.fetchFrames ?? fetchCustomFrames;
    const neutral = {
      fps: 30,
      poses: [
        { t: 0, pose: {} },
        { t: 1 / 30, pose: {} },
      ],
    };
    const frames = await fetchFrames(options.bodyId, neutral, signal);
    await client.bakeCustom(options.size, frames, { signal });
    const dt = data.assets[options.size]?.config.dt;
    if (dt) await client.bakeCustom(options.size, frames, { signal, config: { dt: dt / 2 } });
  }

  async bake(
    poses: { t: number; pose: AnatomicalPose }[],
    options: LiveTryOnOptions,
    onProgress: (fraction: number) => void,
    signal: AbortSignal,
  ): Promise<BakedMove> {
    const started = performance.now();
    if (!ID.test(options.bodyId) || !ID.test(options.fitId))
      throw new Error('Invalid body or fit ID');
    if (signal.aborted) throw aborted();
    // `t` in ms (LiveFrame clock), as the live engine records it.
    const request = customMotionRequest(poses);
    onProgress(0);
    const client = this.client(options);
    const fetchFrames = this.deps.fetchFrames ?? fetchCustomFrames;
    let loadMs = 0,
      framesMs = 0;
    const timed = <T>(promise: Promise<T>, done: (ms: number) => void) =>
      promise.then((value) => {
        done(performance.now() - started);
        return value;
      });
    const [data, buffer]: [MotionData, ArrayBuffer] = await Promise.all([
      timed(client.load(), (ms) => (loadMs = ms)),
      timed(fetchFrames(options.bodyId, request, signal), (ms) => (framesMs = ms)),
    ]);
    if (signal.aborted) throw aborted();
    const frames = parseFrames(buffer, data.rig.drivers.length);
    const asset = data.assets[options.size];
    if (!asset) throw new Error(`Size ${options.size} is not loaded`);
    // Simulate up to the end of the recorded window only: the neutral lead-out after it is
    // never played back (the live engine plays frames recorded.start..end).
    const simulated = Math.min(frames.count, Math.round(frames.motion.hold.end_s * frames.fps) + 1);
    // A move faster than the presets is baked with smaller solver steps (subdivision.ts).
    const subdivision = subdivisionFor(frames, asset.config.dt, simulated);
    const meter = new BakeProgressMeter(simulated - 1, 2 * subdivision.factor);
    const steps = (simulated - 1) * 2 * subdivision.factor;
    this.deps.onPlan?.({
      frames: simulated,
      factor: subdivision.factor,
      steps,
      estimateMs: this.stepMs === null ? null : steps * this.stepMs,
      stepMs: this.stepMs,
    });
    const bake = await client.bakeCustom(options.size, buffer, {
      signal,
      onProgress: (p) => onProgress(meter.update(p)),
      config: subdivision.config,
      maxFrames: simulated,
    });
    onProgress(1);
    const timings = {
      loadMs,
      framesMs,
      bakeMs: bake.timings.totalMs,
      relaxCached: bake.timings.relaxCached,
      relaxMs: bake.timings.relaxMs,
      motionMs: bake.timings.motionMs,
      meanStepMs: bake.timings.meanStepMs,
      totalMs: performance.now() - started,
      steps: bake.timings.steps,
      simulatedFrames: simulated,
      subdivision,
    };
    this.lastTimings = timings;
    if (bake.timings.steps > 0 && Number.isFinite(bake.timings.meanStepMs))
      this.stepMs =
        this.stepMs === null
          ? bake.timings.meanStepMs
          : 0.5 * this.stepMs + 0.5 * bake.timings.meanStepMs;
    const move = new RecordedBakedMove({
      bake,
      frames,
      rig: data.rig,
      anchors: data.anchors,
      asset,
      staticZones: this.deps.staticZones?.(options) ?? null,
      timings,
    });
    this.lastMove = move;
    if (!move.sleeves.valid) throw new PhysicsInvalidError(move.sleeves.reason!, move);
    return move;
  }

  dispose() {
    this.own?.client.dispose();
    this.own = undefined;
  }
}

/** Factory for the live engine (V1 injects it as LiveTryOnDeps.moveBaker). */
export function createMoveBaker(deps: RecordMoveBakerDeps = {}) {
  return new RecordMoveBaker(deps);
}
