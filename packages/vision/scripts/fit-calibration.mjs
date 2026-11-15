// Fits the body-scan calibration (value = a·raw + b, residual σ) from paired records in
// packages/vision/calibration/pairs/*.json (personal data, gitignored) and writes
// packages/vision/calibration/current.json. See packages/vision/CALIBRATION.md.
//
//   node packages/vision/scripts/fit-calibration.mjs            # fit and write
//   node packages/vision/scripts/fit-calibration.mjs --dry-run  # print only
//
// With no usable pairs it writes the explicit "uncalibrated" set. Fewer than five people
// fit only an offset b (a = 1); see fitCalibrationEntry in src/calibration.ts.
// The math lives in src/calibration.ts (imported through Node's TypeScript type stripping).
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCAN_MEASUREMENT_NAMES,
  UNCALIBRATED,
  fitCalibrationSet,
  parseCalibrationPair,
} from '../src/calibration.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const calibDir = path.resolve(here, '..', 'calibration');
const pairsDir = path.join(calibDir, 'pairs');
const outFile = path.join(calibDir, 'current.json');
const dryRun = process.argv.includes('--dry-run');

let names = [];
try {
  names = (await readdir(pairsDir)).filter((n) => /^[A-Za-z0-9_.-]+\.json$/.test(n)).sort();
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const pairs = [];
for (const name of names) {
  try {
    pairs.push(parseCalibrationPair(JSON.parse(await readFile(path.join(pairsDir, name), 'utf8'))));
  } catch (error) {
    console.error(`skip ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const usable = pairs.filter((p) =>
  SCAN_MEASUREMENT_NAMES.some((m) => typeof p.raw[m] === 'number' && typeof p.tape[m] === 'number'),
);

const today = new Date().toISOString().slice(0, 10);
const persons = new Set(usable.map((p) => p.person_id)).size;
const set =
  usable.length === 0
    ? UNCALIBRATED
    : fitCalibrationSet(usable, `fit-${today.replaceAll('-', '')}-n${persons}`, today);

console.log(`pairs: ${names.length} file(s), ${usable.length} usable, ${persons} person(s)`);
console.log(`calibration id: ${set.id}`);
console.log('measurement          n  people       a        b   sigma_cm  sigma_rel  mean|resid|');
for (const m of SCAN_MEASUREMENT_NAMES) {
  const e = set.entries[m];
  const resid = usable
    .filter((p) => typeof p.raw[m] === 'number' && typeof p.tape[m] === 'number')
    .map((p) => Math.abs(p.tape[m] - (e.a * p.raw[m] + e.b)));
  const mae = resid.length ? (resid.reduce((s, r) => s + r, 0) / resid.length).toFixed(2) : '-';
  console.log(
    `${m.padEnd(19)} ${String(e.n_points).padStart(2)} ${String(e.n_persons).padStart(7)} ` +
      `${e.a.toFixed(4).padStart(7)} ${e.b.toFixed(2).padStart(8)} ${e.sigma_cm.toFixed(2).padStart(10)} ` +
      `${e.sigma_rel.toFixed(3).padStart(10)} ${mae.padStart(12)}`,
  );
}
console.log('mean|resid| is in-sample (training) error, not an accuracy claim.');

if (dryRun) console.log('dry run: nothing written');
else {
  await writeFile(outFile, JSON.stringify(set, null, 2) + '\n', 'utf8');
  console.log(`wrote ${path.relative(process.cwd(), outFile)}`);
}
