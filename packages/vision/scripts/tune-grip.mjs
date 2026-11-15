// Tune the grab classifier on recordings in test-data/hands (labelled first; unlabelled as a
// regression set). Leave-one-recording-out, per-pose confusion table. Numbers only, offline.
//
//   node packages/vision/scripts/tune-grip.mjs [--current]
//
// --current: only evaluate the current defaults (no grid search).
// Loads the TypeScript sources through Vite's SSR loader (no build step, no extra dependency).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(pkgDir, 'test-data', 'hands');

const server = await createServer({
  configFile: false,
  root: pkgDir,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
  // Only local TS sources are loaded (SSR); skip the browser dependency pre-scan.
  optimizeDeps: { noDiscovery: true, entries: [] },
});
try {
  const hr = await server.ssrLoadModule('/src/handRecording.ts');
  const gt = await server.ssrLoadModule('/src/gripTuning.ts');
  const files = fs.existsSync(dataDir)
    ? fs.readdirSync(dataDir).filter((f) => f.endsWith('.json'))
    : [];
  const recordings = [];
  for (const f of files) {
    const rec = hr.parseHandRecording(JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')));
    if (rec.meta.invalid) {
      console.log(`skip ${f}: invalid (${rec.meta.invalidReason ?? ''})`);
      continue;
    }
    recordings.push({ name: f.replace(/^hands-|\.json$/g, ''), rec });
  }
  const labelled = recordings.filter((r) => r.rec.frames.some((x) => x.grab !== undefined));
  console.log(`${recordings.length} recordings (${labelled.length} labelled) in ${dataDir}`);
  if (!recordings.length) process.exit(0);

  const fmtT = (t) =>
    `release ${t.releaseMs ?? 'default'} enter ${t.enterFrames ?? 'default'} ` +
    `startMaxSpeed ${t.startMaxSpeed ?? 'default'} lateral ${t.grabModel?.lateralCurlCentre} ` +
    `index ${t.grabModel?.indexCurlCentre} thumbPalm ${t.grabModel?.thumbPalmOffset} ` +
    `fist ${t.grabModel?.fistCurlCentre} gain ${t.grabModel?.curlGain} dwell ${t.dwellMs ?? 'default'} ` +
    `clearRun ${t.clearMinFrames ?? 'default'} clearFist ${t.grabModel?.clearFistIndex}/${t.grabModel?.clearFistMrp} ` +
    `contactGap ${t.grabModel?.clearContactGap}`;
  const describe = (name, s) =>
    `${name}: cost ${s.cost.toFixed(2)} ${s.labelled ? 'LABELLED' : 'unlabelled'} starts ${s.starts} ` +
    `splits ${s.splits} other-hand ${s.otherHandGrabs}` +
    (s.evaluation
      ? ` missed ${s.evaluation.missed}/${s.evaluation.episodes} false ${s.evaluation.falseGrabs} ` +
        `grabLat ${s.evaluation.grabLatencyMs.map((x) => x.toFixed(0)).join(',')} ` +
        `relLat ${s.evaluation.releaseLatencyMs.map((x) => x.toFixed(0)).join(',')}`
      : '');

  let chosen = {};
  if (!process.argv.includes('--current')) {
    const report = gt.tune(recordings);
    chosen = report.grid[report.best.index];
    console.log(`\nBest on all: ${fmtT(chosen)} (total cost ${report.best.total.toFixed(2)})`);
    console.log('Leave-one-recording-out (params chosen without the held-out file):');
    for (const l of report.leaveOneOut)
      console.log(`  ${fmtT(report.grid[l.chosen])} -> ${describe(l.heldOut, l.heldOutScore)}`);
  }
  console.log(
    `\nPer recording with ${process.argv.includes('--current') ? 'current defaults' : 'best'}:`,
  );
  for (const r of recordings)
    console.log('  ' + describe(r.name, gt.scoreRecording(r.rec, chosen)));
  if (labelled.length) {
    console.log('\nPer-pose confusion (labelled recordings):');
    console.log(JSON.stringify(gt.poseTable(recordings, chosen), null, 1));
  } else {
    console.log('\nNo labelled recordings yet: record with the lab "Labelled pose" mode.');
  }
} finally {
  await server.close();
}
