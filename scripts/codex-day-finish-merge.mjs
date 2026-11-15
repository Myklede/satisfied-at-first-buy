// Merge numeric V4 evidence into its explicitly prescribed committed baseline.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const baseline = JSON.parse(
  execFileSync('git', ['show', '82b4426:docs/validation/ar-finish-v4.json'], { encoding: 'utf8' }),
);
const meta = JSON.parse(readFileSync('.cache/cx-day/finish/meta.json', 'utf8'));
if (!meta.complete || !meta.sourceStable) throw new Error('Incomplete or mixed-source measurement');
const report = JSON.parse(readFileSync(meta.output, 'utf8'));
const frames = JSON.parse(readFileSync('.cache/cx-day/finish/frames-index.json', 'utf8'));
const reviewArgument = process.argv.indexOf('--reviewed-frame-dir');
const reviewedDir = reviewArgument < 0 ? null : process.argv[reviewArgument + 1];
if (reviewedDir !== frames.directory.replaceAll('\\', '/'))
  throw new Error('Open the new close-up pair and supply its --reviewed-frame-dir first');
const log = readFileSync('.cache/cx-day/finish/eval.log', 'utf8');
if ((log.match(/CX-DAY selected exact style FB7675-100/g) ?? []).length !== 2)
  throw new Error('Exact-style proof missing');
for (const video of Object.values(report.videos)) {
  video.requestedLegacyAlias = video.product;
  video.selectedStyle = 'FB7675-100';
  video.stillValidity =
    'Nominal windows are not truly still (TRY-M raw proof). Edge proxy is not the verified contour metric; no stationarity acceptance.';
}
const preserved = ['calibration_cam_parka', 'light_sign_check', 'studies', 'after_worker_packing'];
const merged = { ...baseline, ...report, measurement: meta, preservedBaseline: '82b4426' };
for (const key of preserved) merged[key] = baseline[key];
merged.visualReview = {
  path: `${reviewedDir}/look-v4-cam-tshirt-12.5-after.png`,
  opened: true,
  result:
    'FAIL: shoulder extensions and wrist fill remain visible. Before/after opened locally; independent coverage is unavailable at this close-up. No shoulder-band acceptance.',
};
merged.note =
  'Measurement only. Coverage values are fractions (multiply by 100 for percent). Timing is instrumented V4 lab, not kiosk acceptance. Five valid stale-mask samples; cam-tshirt 3.5s unavailable (no mask at t-lag). Historical baseline blocks preserved verbatim.';
const serialized = JSON.stringify(merged, null, 2) + '\n';
if (/data:image|data:video|[?&](?:h|w)=\d|base64,/i.test(serialized))
  throw new Error('Private pixel or body URL detected');
writeFileSync('docs/validation/ar-finish-v4.json', serialized);
console.log('Merged stable V4 numeric report; four 82b4426 blocks preserved.');
