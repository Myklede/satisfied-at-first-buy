import { writeFile, readdir } from 'node:fs/promises';
import { readCloth } from './read-cloth.mjs';
import { performance } from 'node:perf_hooks';
import { ClothSolver } from '../apps/web/src/engine/cloth/ClothSolver.ts';

for (const file of (await readdir('.cache/realism')).filter(
  (f) =>
    /^(reference|personal)-.*\.json$/.test(f) &&
    !/-(analytic|settled)\.json$/.test(f) &&
    (!process.argv[2] || f.startsWith(process.argv[2])),
)) {
  const { asset, sdf } = await readCloth(`.cache/realism/${file}`);
  // REALISM_RELAX_SECONDS evaluates the relax even when the live asset ships without it.
  if (process.env.REALISM_RELAX_SECONDS)
    asset.config.maxSeconds = +process.env.REALISM_RELAX_SECONDS;
  const started = performance.now();
  const solver = new ClothSolver(asset, sdf);
  const timings = [];
  let frames = 0;
  while (solver.elapsed < asset.config.maxSeconds) {
    const t = performance.now();
    solver.step();
    timings.push(performance.now() - t);
    frames++;
    if (solver.elapsed > 0.5 && solver.energy < asset.config.kineticEpsilon) break;
  }
  // Same as the worker: the neutral (shell) path shows the solver state as relaxed.
  if (asset.fabric_surface !== 'neutral') solver.polishContacts();
  const elapsedMs = performance.now() - started;
  const snapshot = solver.snapshot();
  const report = {
    assetKey: asset.key,
    positions: Array.from(snapshot.positions),
    strain: Array.from(snapshot.strain),
    gap: Array.from(snapshot.gap),
    energy: snapshot.energy,
    simulatedSeconds: snapshot.simulatedSeconds,
    elapsedMs,
    frames,
    meanStepMs: timings.reduce((a, b) => a + b, 0) / frames,
    p95StepMs: timings.slice().sort((a, b) => a - b)[Math.floor(frames * 0.95)],
    stopReason: solver.energy < asset.config.kineticEpsilon ? 'kinetic' : 'time_limit',
    maxStrain: Math.max(...snapshot.strain),
    minGapCm: Math.min(...snapshot.gap),
    particles: snapshot.strain.length,
  };
  await writeFile(
    `.cache/realism/${file.replace('.json', '-settled.json')}`,
    JSON.stringify(report),
  );
  console.log(
    file,
    JSON.stringify({ ...report, positions: undefined, strain: undefined, gap: undefined }),
  );
}
