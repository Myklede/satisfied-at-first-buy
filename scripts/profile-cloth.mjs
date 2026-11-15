import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { ClothSolver } from '../apps/web/src/engine/cloth/ClothSolver.ts';
import { readCloth } from './read-cloth.mjs';

const label = process.argv[2] ?? 'baseline';
const file = process.argv[3] ?? '.cache/realism/personal-DQ4920-206.json';
const { asset, sdf } = await readCloth(file);
if (process.argv[4]) asset.config.substeps = Number(process.argv[4]);
if (process.argv[5]) asset.config.iterations = Number(process.argv[5]);
const solver = new ClothSolver(asset, sdf);
let unstable = false;
for (let i = 0; i < 15; i++) {
  solver.step();
  if (!Number.isFinite(solver.energy) || solver.energy > 100) {
    unstable = true;
    break;
  }
}
const phases = { stretch: 0, bend: 0, projectBody: 0, selfCollide: 0 };
for (const name of Object.keys(phases)) {
  const original = solver[name].bind(solver);
  solver[name] = (...args) => {
    const start = performance.now();
    const value = original(...args);
    phases[name] += performance.now() - start;
    return value;
  };
}
const timings = [];
for (let i = 0; i < 60; i++) {
  if (unstable) break;
  const t = performance.now();
  solver.step();
  timings.push(performance.now() - t);
  if (!Number.isFinite(solver.energy) || solver.energy > 100) unstable = true;
}
const mean = timings.length ? timings.reduce((a, b) => a + b, 0) / timings.length : null;
const t = performance.now(),
  snapshot = solver.snapshot(),
  snapshotMs = performance.now() - t;
const result = {
  unstable,
  label,
  node: process.version,
  particles: solver.positions.length / 3,
  edges: solver.restLengths.length,
  bends: solver.restAngles.length,
  substeps: asset.config.substeps,
  iterations: asset.config.iterations,
  meanStepMs: mean,
  p95StepMs: timings.toSorted((a, b) => a - b)[Math.floor(timings.length * 0.95)],
  phases: Object.fromEntries(
    Object.entries(phases).map(([k, v]) => [k, timings.length ? v / timings.length : null]),
  ),
  snapshotMs,
  energy: solver.energy,
  maxStrain: Math.max(...snapshot.strain),
  minGapCm: Math.min(...snapshot.gap),
};
const buffers = {
  positions: new Float32Array(solver.positions.length),
  strain: new Float32Array(solver.positions.length / 3),
  gap: new Float32Array(solver.positions.length / 3),
};
const normalStart = performance.now();
for (let i = 0; i < 100; i++) solver.snapshot({}, buffers);
result.normalSnapshotMs = (performance.now() - normalStart) / 100;
const path = 'docs/validation/realism-cpu-profile.json';
let rows = [];
try {
  rows = JSON.parse(await readFile(path, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
rows.push(result);
await writeFile(path, JSON.stringify(rows, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
