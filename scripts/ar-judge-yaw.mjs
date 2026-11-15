// F5: drawn-yaw timeline checks for look-lane jobs (frames.json): cadence, held frames during a
// turn, largest single-frame step, and rest stability. Usage: node scripts/ar-judge-yaw.mjs <out-dir>...
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function yawStats(frames) {
  const f = frames.filter((x) => Number.isFinite(x.yawDeg)).sort((a, b) => a.videoMs - b.videoMs);
  if (f.length < 3) return null;
  const dur = (f.at(-1).videoMs - f[0].videoMs) / 1000;
  let maxStep = 0,
    maxStepAt = null,
    maxStepPer33 = 0,
    held = 0,
    run = 0;
  for (let k = 1; k < f.length; k++) {
    const d = Math.abs(f[k].yawDeg - f[k - 1].yawDeg);
    const dt = Math.max(20, f[k].videoMs - f[k - 1].videoMs); // duplicate timestamps would explode the rate
    if (d > maxStep) {
      maxStep = d;
      maxStepAt = f[k].videoMs / 1000;
    }
    maxStepPer33 = Math.max(maxStepPer33, (d * 33.3) / dt);
    // held = mid-turn (10..80 deg) frames whose yaw does not move (<= 1 deg) for 3+ frames in a row
    const mid = Math.abs(f[k].yawDeg) >= 10 && Math.abs(f[k].yawDeg) <= 80;
    run = mid && d <= 1 ? run + 1 : 0;
    if (run >= 2) held++;
  }
  // frames the drawn yaw sat still (<= 1 deg) right before the largest step (a hold-then-snap)
  let holdBefore = 0;
  const kStep = f.findIndex((x) => x.videoMs / 1000 === maxStepAt);
  for (let k = kStep - 1; k > 0 && Math.abs(f[k].yawDeg - f[k - 1].yawDeg) <= 1; k--) holdBefore++;
  const ys = f.map((x) => x.yawDeg),
    ds = f.map((x) => x.depthM).filter(Number.isFinite);
  const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
  const sd = (v) => Math.sqrt(mean(v.map((x) => (x - mean(v)) ** 2)));
  return {
    frames: f.length,
    fps: +(f.length / dur).toFixed(1),
    heldFrames: held,
    holdBeforeMaxStep: maxStep >= 20 ? holdBefore : 0,
    maxStepDeg: +maxStep.toFixed(1),
    maxStepAt,
    maxStepPer33msDeg: +maxStepPer33.toFixed(1),
    yawSd: +sd(ys).toFixed(2),
    depthRangeCm: ds.length ? +((Math.max(...ds) - Math.min(...ds)) * 100).toFixed(1) : null,
  };
}

if (process.argv[1]?.endsWith('ar-judge-yaw.mjs'))
  for (const dir of process.argv.slice(2)) {
    const j = JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8'));
    console.log(dir.split(/[\\/]/).at(-1), JSON.stringify(j.window), JSON.stringify(yawStats(j.frames)));
  }
