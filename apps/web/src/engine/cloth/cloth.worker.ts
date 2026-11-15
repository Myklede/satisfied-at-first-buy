import {
  ClothSolver,
  type ClothAsset,
  type FrameBuffers,
  type SnapshotOptions,
} from './ClothSolver';
import { PullDriver, type PullFrame } from '../hand/pullDriver';
import { HAND_PULL } from '../hand/config';
import { InteractDriver, type GrabKind, type InteractFrame } from '../interact/InteractDriver';

type Message =
  | {
      kind: 'settle';
      asset: ClothAsset;
      sdf?: ArrayBuffer;
      restore?: { positions: Float32Array; energy: number; simulatedSeconds: number };
      options: SnapshotOptions;
    }
  | { kind: 'grab' | 'move'; ids: number[]; positions: number[] }
  | { kind: 'release' | 'step' | 'snapshot' }
  | { kind: 'mode'; options: SnapshotOptions }
  | { kind: 'recycle'; buffers: FrameBuffers }
  // Hand pull (M4). 'feel' saves (on) or restores (off) the shown shape around a session.
  | { kind: 'feel'; on: boolean }
  | { kind: 'relax'; seconds: number }
  | { kind: 'live'; on: boolean }
  | { kind: 'pull-begin'; ids: number[]; weights: number[]; centre: number[]; frameTime: number }
  | { kind: 'pull-move'; displacement: number[]; frameTime: number }
  | { kind: 'pull-end'; frameTime: number }
  // Interactive zip and hood (agent Z): a second solver on the split asset; the base solver is
  // left untouched and shown again on 'interact-stop'.
  | { kind: 'interact-start'; hood: boolean }
  | { kind: 'interact-activate' }
  | { kind: 'interact-slider'; arc: number; frameTime: number }
  | {
      kind: 'interact-grab';
      grab: GrabKind;
      ids: number[];
      weights: number[];
      frameTime: number;
    }
  | { kind: 'interact-move'; displacement: number[]; frameTime: number }
  | { kind: 'interact-release'; frameTime: number }
  | { kind: 'interact-hood-off' }
  | { kind: 'interact-stop' }
  | { kind: 'irecycle'; positions: Float32Array };
export type PullMessage = PullFrame & {
  /**
   * Camera frame time (main-thread performance.now) of a hand input applied for the first time
   * in this frame; 0 when the frame only continues the previous input.
   */
  frameTime: number;
  /** Worker loop interval since the previous live frame (ms). */
  intervalMs: number;
};
let solver: ClothSolver | undefined;
let options: SnapshotOptions = {};
const cache = new Map<string, { positions: Float64Array; seconds: number; energy: number }>();
const fields = new Map<string, Float32Array>();
const pool: FrameBuffers[] = [];
let driver: PullDriver | undefined;
let interact: InteractDriver | undefined;
/** The split solver runs (zip/hood in play); off = the base solver and the hand pull. */
let interactOn = false;
/** Positions buffer of the interaction frames (split asset), recycled by the main thread. */
const interactPool: Float32Array[] = [];
let feelShape: Float64Array | undefined;
let live = false;
let liveTimer: ReturnType<typeof setTimeout> | undefined;
let nextTick = 0;
let lastTick = 0;
let inputTime = 0;
/** Input time already reported: each hand input is timed once, on the first frame using it. */
let reportedTime = 0;
function frame(stepMs?: number, pull?: PullMessage) {
  if (!solver) return;
  let buffers = pool.pop();
  if (!buffers || buffers.positions.length !== solver.positions.length) {
    buffers = {
      positions: new Float32Array(solver.positions.length),
      gap: new Float32Array(solver.positions.length / 3),
      strain: new Float32Array(solver.positions.length / 3),
      compression: new Float32Array((solver.positions.length / 3) * 4),
    };
  }
  const result = solver.snapshot(options, buffers);
  self.postMessage(
    { kind: 'frame', ...result, stepMs, pull },
    {
      transfer: [
        result.positions.buffer,
        result.gap.buffer,
        result.strain.buffer,
        result.compression.buffer,
      ],
    },
  );
}
/** One interaction frame (split solver) to the main thread. */
function interactFrame(result: InteractFrame, intervalMs: number) {
  const active = interact!,
    p = active.solver.positions;
  let positions = interactPool.pop();
  if (!positions || positions.length !== p.length) positions = new Float32Array(p.length);
  for (let i = 0; i < p.length; i++) positions[i] = p[i];
  const fresh = inputTime !== reportedTime ? inputTime : 0;
  reportedTime = inputTime;
  self.postMessage(
    { kind: 'iframe', positions, frame: result, frameTime: fresh, intervalMs },
    { transfer: [positions.buffer] },
  );
}
/** Live loop (hand pull): steps the local region at HAND_PULL.liveHz; idle frames cost nothing. */
function liveTick() {
  liveTimer = undefined;
  if (!live || !solver) return;
  const now = performance.now(),
    period = 1000 / HAND_PULL.liveHz;
  try {
    if (interact && interactOn) interactFrame(interact.tick(), now - lastTick);
    const result = interact && interactOn ? null : driver?.tick();
    if (result) {
      const fresh = inputTime !== reportedTime ? inputTime : 0;
      reportedTime = inputTime;
      frame(result.stepMs, { ...result, frameTime: fresh, intervalMs: now - lastTick });
    }
  } catch (error) {
    live = false;
    self.postMessage({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  lastTick = now;
  // Fixed-rate schedule; if a frame overran, continue from now (no catch-up burst).
  nextTick = Math.max(nextTick + period, performance.now());
  liveTimer = setTimeout(liveTick, Math.max(0, nextTick - performance.now()));
}
function setLive(on: boolean) {
  live = on;
  if (on && !liveTimer) {
    nextTick = lastTick = performance.now();
    liveTimer = setTimeout(liveTick, 0);
  }
  if (!on && liveTimer) {
    clearTimeout(liveTimer);
    liveTimer = undefined;
  }
}
async function relax(seconds: number) {
  const active = solver!;
  driver?.stop();
  const started = performance.now(),
    times: number[] = [];
  const startTime = active.elapsed;
  while (active.elapsed - startTime < seconds) {
    const t = performance.now();
    active.step();
    times.push(performance.now() - t);
    frame(times[times.length - 1]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (solver !== active) throw new Error('Cloth relaxation superseded');
    if (!Number.isFinite(active.energy)) throw new Error('Cloth solver became non-finite');
    if (active.elapsed - startTime > 0.5 && active.energy < active.asset.config.kineticEpsilon)
      break;
  }
  self.postMessage({
    kind: 'relaxed',
    elapsedMs: performance.now() - started,
    frames: times.length,
    simulatedSeconds: active.elapsed - startTime,
    energy: active.energy,
    meanStepMs: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null,
  });
}
self.onmessage = async (event: MessageEvent<Message>) => {
  try {
    const m = event.data;
    if (m.kind === 'recycle') {
      if (pool.length < 2) pool.push(m.buffers);
      return;
    }
    if (m.kind === 'irecycle') {
      if (interactPool.length < 3) interactPool.push(m.positions);
      return;
    }
    if (m.kind === 'mode') {
      options = m.options;
      frame();
      return;
    }
    if (m.kind === 'settle') {
      const started = performance.now();
      options = m.options;
      const id = m.asset.sdf.sdf_id;
      if (m.sdf) {
        fields.set(id, new Float32Array(m.sdf));
        if (fields.size > 4) fields.delete(fields.keys().next().value!);
      }
      const sdf = fields.get(id);
      if (!sdf) throw new Error('Collision field missing from worker');
      setLive(false);
      driver = undefined;
      interact = undefined;
      interactOn = false;
      feelShape = undefined;
      solver = new ClothSolver(m.asset, sdf);
      // No-relax assets (03c fallback): the computed wrap is the displayed state.
      // Skip the constructor's grid-SDF projection so the exact mesh-space wrap is kept.
      if (m.asset.config.maxSeconds === 0) {
        solver.positions.set(m.asset.initial);
        solver.previous.set(m.asset.initial);
        solver.energy = 0;
      }
      const cached = cache.get(m.asset.key);
      const times: number[] = [];
      if (m.restore) {
        solver.positions.set(m.restore.positions);
        solver.energy = m.restore.energy;
        solver.elapsed = m.restore.simulatedSeconds;
        solver.frameIndex = Math.round(solver.elapsed / m.asset.config.dt);
      } else if (cached) {
        solver.positions.set(cached.positions);
        solver.elapsed = cached.seconds;
        solver.frameIndex = Math.round(cached.seconds / m.asset.config.dt);
        solver.energy = cached.energy;
      } else {
        const active = solver;
        while (solver.elapsed < m.asset.config.maxSeconds) {
          const t = performance.now();
          solver.step();
          times.push(performance.now() - t);
          frame(times[times.length - 1]);
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (solver !== active) throw new Error('Cloth relaxation superseded');
          if (!Number.isFinite(solver.energy)) throw new Error('Cloth solver became non-finite');
          if (solver.elapsed > 0.5 && solver.energy < m.asset.config.kineticEpsilon) break;
        }
        if (m.asset.fabric_surface !== 'neutral') solver.polishContacts();
        cache.set(m.asset.key, {
          positions: solver.positions.slice(),
          seconds: solver.elapsed,
          energy: solver.energy,
        });
        if (cache.size > 64) cache.delete(cache.keys().next().value!);
      }
      const result = solver.snapshot(options);
      self.postMessage(
        {
          kind: 'settled',
          ...result,
          elapsedMs: performance.now() - started,
          cached: !!cached || !!m.restore,
          meanStepMs: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null,
          stopReason:
            cached || m.restore
              ? 'cache'
              : solver.energy < m.asset.config.kineticEpsilon
                ? 'kinetic'
                : 'time_limit',
        },
        {
          transfer: [
            result.positions.buffer,
            result.strain.buffer,
            result.gap.buffer,
            result.compression.buffer,
          ],
        },
      );
    } else if (solver) {
      if (m.kind === 'feel') {
        if (m.on) {
          feelShape = solver.positions.slice();
          driver = new PullDriver(solver);
        } else {
          setLive(false);
          driver?.stop();
          driver = undefined;
          interact = undefined;
          interactOn = false;
          if (feelShape) {
            solver.positions.set(feelShape);
            solver.previous.set(feelShape);
            solver.velocity.fill(0);
            feelShape = undefined;
          }
          frame();
        }
      } else if (m.kind === 'relax') await relax(m.seconds);
      else if (m.kind === 'live') setLive(m.on);
      else if (m.kind === 'pull-begin') {
        if (!driver) throw new Error('Feel mode is not active');
        driver.begin(m.ids, m.weights, m.centre);
        inputTime = m.frameTime;
      } else if (m.kind === 'pull-move') {
        driver?.setRequest(m.displacement);
        inputTime = m.frameTime;
      } else if (m.kind === 'pull-end') {
        driver?.end();
        inputTime = m.frameTime;
      } else if (m.kind === 'interact-start') {
        if (!driver) throw new Error('Feel mode is not active');
        const started = performance.now();
        if (!interact || interact.hasHood !== m.hood) {
          interact = new InteractDriver(solver, { hood: m.hood });
          interactOn = false;
        }
        {
          const split = interact.split;
          self.postMessage({
            kind: 'interact-ready',
            buildMs: performance.now() - started,
            assetKey: split.asset.key,
            triangles: Int32Array.from(split.asset.triangles),
            source: split.source,
            zip: split.zip,
            hood: split.hood ?? null,
            panels: Int32Array.from(split.asset.panels),
          });
        }
      } else if (m.kind === 'interact-activate') {
        if (!driver || !interact) throw new Error('The zip is not prepared');
        if (!interactOn) {
          // Starts from the base solver's state now (the shown, measured shell).
          driver.stop();
          interact.reset(solver);
          interactOn = true;
        }
      } else if (m.kind === 'interact-slider') {
        interact?.setSlider(m.arc);
        inputTime = m.frameTime;
      } else if (m.kind === 'interact-grab') {
        interact?.grabBegin(m.grab, m.ids, m.weights);
        inputTime = m.frameTime;
      } else if (m.kind === 'interact-move') {
        interact?.grabMove(m.displacement);
        inputTime = m.frameTime;
      } else if (m.kind === 'interact-release') {
        interact?.grabEnd();
        inputTime = m.frameTime;
      } else if (m.kind === 'interact-hood-off') {
        interact?.setHoodOff();
      } else if (m.kind === 'interact-stop') {
        // Back to the measured shell: the base solver never moved while the split one ran.
        interactOn = false;
        frame();
      } else if (m.kind === 'grab' || m.kind === 'move') solver[m.kind](m.ids, m.positions);
      else if (m.kind === 'release') solver.release();
      else if (m.kind === 'step') {
        const started = performance.now();
        solver.step();
        frame(performance.now() - started);
      } else frame();
    }
  } catch (error) {
    self.postMessage({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
