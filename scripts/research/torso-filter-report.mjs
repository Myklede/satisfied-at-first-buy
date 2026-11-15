// Reproduce the compact P29 report from the saved deterministic search tables.
import { readFileSync, writeFileSync } from 'node:fs';
const names = ['live5', 'camo-1', 'venue-khong-ao'];
const studies = names.map((n) =>
  JSON.parse(readFileSync('.cache/research/torso/' + n + '-search.json')),
);
const specs = {
  flex: { family: 'euro', cutoff: 2.4, beta: 0.03, dCutoff: 1, motionBypass: true },
  twist: { family: 'euro', cutoff: 2.4, beta: 0.03, dCutoff: 1, motionBypass: true },
  logScale: { family: 'slew', band: 0.002, slew: 1 },
  yaw: { family: 'raw' },
};
const get = (d, k) => {
  const row = d.channels[k].grid.find((r) => JSON.stringify(r.spec) === JSON.stringify(specs[k]));
  if (!row) throw new Error('Missing fixed recommendation ' + k);
  return row;
};
const fmt = (n, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : 'N/A');
const lag = (n) => (Number.isFinite(n) ? String(Math.round(n)) : 'N/A');
const first = studies[0],
  f = get(first, 'flex'),
  t = get(first, 'twist'),
  z = get(first, 'logScale'),
  y = get(first, 'yaw');
const lines = [
  '# P29 torso stabiliser study',
  '',
  'First usable settings were sent to F1 before 22:40; the constants below supersede that provisional line.',
  'Offline original live5 RTMO: 1,422 frames. Replay: ' +
    first.totalReplayFrames +
    ' poses; ' +
    first.matchedFrames +
    ' valid matched four-point torsos, median spacing ' +
    first.cadenceMedianMs +
    ' ms.',
  'Old CFR videoMs is mapped by frame index through live5.timestamps.json (29.08 fps); max correction ' +
    fmt(first.clockMap?.maxCorrectionMs, 0) +
    ' ms.',
  'Map PTS matches all 1,422 original RTMO frames to <.01 ms; nearest source-time match <=25 ms, visibility >=.65, torso in-frame.',
  'live5 replay HEAD ' +
    first.sourceHead +
    '. All per-frame arrays stay in ignored .cache/research/torso/.',
  '',
  '## One recommended design (experimental, not a jelly PASS)',
  '',
  'Rollout: keep f1torso OFF. The design below is a research candidate; its measured gain does not establish a rendered improvement.',
  'Use one near-rigid torso transform plus separate causal controllers; preserve the app confidence/dropout gates.',
  'Replace the added 200 ms sustain / 250 ms glide stage; do not stack it with these settings.',
  '',
  '- Flexion and twist: added One Euro minCutoff=2.4 Hz, beta=.03 Hz/(deg/s), dCutoff=1 Hz; current-frame motion bypass below.',
  '- Bypass/reset the added stage when MP root-yaw speed >20 deg/s, lean >15 deg/s, log-height >.2/s or width/height ratio >.3/s.',
  '- Lateral: keep the existing pipeline, no extra stage; sparse hidden-axis data do not justify extra latency.',
  '- Relative depth/scale: log-size backlash +/- .002, slew <=1 log-unit/s beyond the band; depth uses the opposite sign.',
  '- Yaw and root XY: add NO new filter/hold. Keep the existing continuous-angle/confidence guards; zero added turn lag is the hard gate.',
  '- Reset after >500 ms without valid data. Do not filter individual mesh controls independently.',
  '',
  'Do not infer depth from shoulder narrowing during a turn. Keep session body scale and yaw separate.',
  'A fixed frontal four-point 2D similarity is not a full-perspective torso model: reject it near profile.',
  '',
  '## What was actually measured',
  '',
  'Image signals: shoulder angle/span, hip-to-shoulder lean, torso height/log-size, span/height yaw magnitude proxy.',
  'World trunk equations/limits follow anatomicalPose.ts; baseline flex/lateral Euro=.8/.01/1, twist=.5/.005/1.',
  'These world reconstructions omit calibration/confidence holds and are not final app DOFs. Raw hip-line yaw has no trunk baseline.',
  'Quiet world samples are selected only by RTMO image motion: <.05 shoulder widths/s, lean <5 deg/s, yaw proxy <12 deg/s.',
  'HF RMS = residual minus its centred +/-180 ms local median. World HF is angle variation during 2D-quiet periods;',
  'it is NOT error against fabricated RTMO 3D truth. Full residual/angle variation is also retained in JSON.',
  'Depth units below are log-percent (100*ln ratio), not centimetres. RTMO is a reference, not ground truth.',
  'Image midpoint raw HF RMS X/Y = ' +
    fmt(first.channels.x.grid.find((r) => r.spec.family === 'raw').jitter) +
    '/' +
    fmt(first.channels.y.grid.find((r) => r.spec.family === 'raw').jitter) +
    ' native px; no added XY stage leaves these unchanged.',
  '',
  '| Fixed design, live5 | Raw HF RMS | Filtered HF RMS | Reduction | Worst added T90 ms |',
  '| --- | ---: | ---: | ---: | ---: |',
  ...['flex', 'twist', 'logScale', 'yaw'].map((k) => {
    const r = get(first, k);
    return (
      '| ' +
      k +
      ' | ' +
      fmt(r.rawJitter) +
      ' | ' +
      fmt(r.jitter) +
      ' | ' +
      fmt(r.reductionPct, 1) +
      '% | ' +
      lag(r.worstAddedLagMs) +
      ' |'
    );
  }),
  '',
  '| live5 source window | Quiet samples | Flex deg raw -> filtered | Twist deg raw -> filtered | Added T90 flex/twist/yaw/scale ms |',
  '| --- | ---: | --- | --- | --- |',
  ...first.config.windows.map(([name, a, b], i) => {
    const x = f.windows[i],
      q = t.windows[i],
      n = x.quietSamples;
    return (
      '| ' +
      a / 1000 +
      '-' +
      b / 1000 +
      ' s (' +
      name +
      ') | ' +
      n +
      ' | ' +
      (n < 12 ? 'N/A (<12 quiet)' : fmt(x.rawJitter) + ' -> ' + fmt(x.jitter)) +
      ' | ' +
      (n < 12 ? 'N/A (<12 quiet)' : fmt(q.rawJitter) + ' -> ' + fmt(q.jitter)) +
      ' | ' +
      [x.addedLagMs, q.addedLagMs, y.windows[i].addedLagMs, z.windows[i].addedLagMs]
        .map(lag)
        .join('/') +
      ' |'
    );
  }),
  '',
  'T90 above is ADDED latency relative to the replay input, not true camera-to-jacket latency. World event endpoints',
  'use an MP low-frequency surrogate only; independent 3D turn/lean T90 is unobservable here. JSON also reports 2D reference crossings,',
  'correlation and censored events. Small/contradictory motions are N/A; an uncrossed event never becomes zero lag.',
  'At ' +
    first.cadenceMedianMs +
    ' ms replay spacing, zero extra samples cannot certify <=1 camera frame at 30 fps.',
  '',
  '## Five candidate families (live5 valid-view shoulder roll)',
  '',
  'Each row is the lowest HF RMS in its grid under <=180 ms added/step T90 and <=5% synthetic step overshoot, where feasible.',
  '',
  '| Family | HF deg RMS | Reduction | Worst added/step T90 ms | Step overshoot % | Budget |',
  '| --- | ---: | ---: | ---: | ---: | --- |',
  ...Object.entries(first.channels.roll.bestFamilies).map(
    ([family, r]) =>
      '| ' +
      family +
      ' | ' +
      fmt(r.jitter) +
      ' | ' +
      fmt(r.reductionPct, 1) +
      '% | ' +
      lag(r.worstAddedLagMs) +
      ' | ' +
      fmt(r.stepOvershootPct, 1) +
      ' | ' +
      (r.worstAddedLagMs === null
        ? 'censored'
        : r.worstAddedLagMs <= first.config.maxRecommendedLagMs &&
            r.stepOvershootPct <= first.config.maxStepOvershootPct
          ? 'pass'
          : 'FAIL') +
      ' |',
  ),
  '',
  'Rigid = four-point similarity projection + Euro, not an extra 3D measurement. Its cross-clip roll events can be censored',
  'or have model-shape bias, so its low HF number does not make it a general replacement for F3 rendering.',
  '',
  '## Fixed-constant cross-clip checks (no retuning)',
  '',
  '| Clip | Matched / median spacing | Flex cut / added T90 | Twist cut / added T90 | Scale cut / added T90 | Yaw cut / added T90 |',
  '| --- | --- | --- | --- | --- | --- |',
  ...studies.map(
    (d) =>
      '| ' +
      d.clip +
      ' | ' +
      d.matchedFrames +
      ' / ' +
      d.cadenceMedianMs +
      ' ms | ' +
      ['flex', 'twist', 'logScale', 'yaw']
        .map((k) => {
          const r = get(d, k);
          return fmt(r.reductionPct, 1) + '% / ' + lag(r.worstAddedLagMs) + ' ms';
        })
        .join(' | ') +
      ' |',
  ),
  '',
  'Camo/venue use their own motion, not live5 scene labels. These are post-selection transfer checks, not an untouched test set.',
  'Yaw holds were rejected for rollout: the 4 deg/100/33 winner censored Camo/venue events; even faster holds add a pose interval.',
  'Reject the earlier +/- .01 scale band: 15.2% live5 HF reduction costs 267 ms added T90; +/- .002 gives only 1.0% at 0 sampled ms.',
  'Recommended monotonic step controls have zero overshoot; sampled event-range exceedance remains in JSON and can include real subsequent motion.',
  'The old 6 deg/200/250 hold took 750 ms to reach 90% of a 15 deg step at 50 ms sampling.',
  '',
  '## Limits / reproduction',
  '',
  'This does not prove the skinned jacket stops wobbling. It cannot separate hidden-axis real bends from world-model drift.',
  'Jelly below the HF band, skinning/arm weights, free-form glue, solver bias and view changes still need F1/F3/F5 rendering checks.',
  'The 180 ms budget and quiet thresholds are declared research choices, not the user quality gate. Keep the change behind f1torso.',
  '',
  '```powershell',
  'node scripts/research/rtmo-tracks.mjs --clip live5',
  'node scripts/research/torso-filter-sim.mjs live5',
  'node scripts/research/torso-filter-sim.mjs camo-1',
  'node scripts/research/torso-filter-sim.mjs venue-khong-ao',
  'node scripts/research/torso-filter-report.mjs',
  'node --test scripts/research/torso-filter-sim.test.mjs scripts/research/rtmo-control.test.mjs',
  '```',
  '',
  'Node simulation is single-threaded; RTMO is capped at two. Timing controls/heavy (read-only checks) and sync USER TEST holds pause work.',
  'No camera, browser, app/package edit, new dependency or committed pixel. Source/file SHA and full grids are local artifacts.',
];
if (lines.length > 100) throw new Error('Report exceeds100 lines: ' + lines.length);
writeFileSync('docs/look/torso-stabiliser-study.md', lines.join('\n') + '\n');
writeFileSync(
  '.cache/research/torso/recommendation.json',
  JSON.stringify(
    { specs, live5: Object.fromEntries(Object.keys(specs).map((k) => [k, get(first, k)])) },
    null,
    2,
  ),
);
console.log('Saved ' + lines.length + ' report lines');
