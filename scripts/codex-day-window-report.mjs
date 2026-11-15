// Prompt19: numeric coordination checkpoint. No browser, network or body inputs.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { syncDay } from './codex-day-slot.mjs';
const root = resolve(import.meta.dirname, '..');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const atIndex = process.argv.indexOf('--at');
if (atIndex >= 0) {
  const deadline = Date.parse(process.argv[atIndex + 1]);
  if (!Number.isFinite(deadline)) throw new Error('ISO deadline required');
  while (Date.now() < deadline) await pause(Math.min(60000, deadline - Date.now()));
}
async function read(name, optional = false) {
  const path = resolve(root, name);
  if (optional && !existsSync(path)) return null;
  for (let i = 0; i < 5; i++)
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if (i === 4) throw error;
      await pause(1000);
    }
}
const frozen = await read('docs/validation/ar-eval-frozen-matrix.json');
const real = await read('docs/validation/ar-eval-real-window.json');
const set = await read('docs/validation/ar-eval-testset.json', true);
const n = (x) => (Number.isFinite(x) ? Number(x.toFixed(4)) : 'N/A');
const table = frozen.rows
  .map(
    (r) =>
      `${r.source}/s${+r.still}f${+r.finish}=[${[r.outline, r.rotation, r.scale, r.gluePxPerCameraFrame, r.mirrorJacketMmPerCameraFrame, r.finisherEdgePxPerCameraFrame, r.engagedFraction, r.rawLandmarkNoise].map(n).join(',')}]`,
  )
  .join(';');
const rows = real.rows
  .map(
    (r) =>
      `${r.source}:res${n(r.scoreboard.keypointResidualPx.value)}/uncovered${n(r.scoreboard.frontalUncoveredPct.value)}/instrumentedAR${n(r.scoreboard.arFps.value)}/onset${r.motionOnsets?.map((x) => (x.pass === null ? 'N/A' : x.pass ? 'PASS' : 'FAIL')).join(',')}`,
  )
  .join(';');
syncDay(
  `CX-DAY WINDOW REPORT: stable snapshot${frozen.snapshotHash}; exactFB7675-100 frozen8cases (columns edgepx/camera,rotationdeg,scale%,gluepx/camera,mirrormm/camera,finisheredge,engagedfraction,rawMPpx/camera): ${table}. Real rows ${rows}. Nominal still windows NOT TRULY STILL; sparse onset bounds cannot certify1camera-frame. Top moving layer: identical cropped shirt input produces raw-model jitter then large glue/AR motion; detector0%, not finisher-only drift. Parka still1 freezes outputs but does not establish full AnywearPASS. Proof12frames/case, delivered raw hashes1/case; opened sheets .cache/cx-day/frozen/sheets/cam-{parka,tshirt}-s1-f1-{views,ar-strip}.png. Testset attempted${set?.rows?.length ?? 0}/60, PASS${set?.rows?.filter((r) => r.pass).length ?? 0}; ${set?.complete ? 'allattempted' : 'IN PROGRESS'}, missing visual/metric rows blockPASS. Numeric sources docs/validation/ar-eval-{frozen-matrix,real-window,testset}.json. No AR/default/body/API change; catalogue and V4/pack continue. On waking read prompt20 and source-specific failures, not the old moving-window target.`,
);
console.log('Window report appended; no resources acquired.');
