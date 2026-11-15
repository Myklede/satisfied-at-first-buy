import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ClothSolver } from '../apps/web/src/engine/cloth/ClothSolver.ts';
import { readCloth } from './read-cloth.mjs';

const rows = [];
for (const style of ['FB7675-100', 'DQ4920-206']) {
  const { asset, sdf } = await readCloth(`.cache/realism/reference-${style}.json`);
  const run = () => {
    const solver = new ClothSolver(asset, sdf);
    while (solver.elapsed < asset.config.maxSeconds) {
      solver.step();
      if (solver.elapsed > 0.5 && solver.energy < asset.config.kineticEpsilon) break;
    }
    if (asset.fabric_surface !== 'neutral') solver.polishContacts();
    return solver;
  };
  const a = run(),
    b = run();
  assert.deepEqual(a.positions, b.positions, `${style} fixed-order positions differ`);
  assert.deepEqual(a.snapshot().strain, b.snapshot().strain);
  assert.equal(a.energy, b.energy);
  const sha256 = createHash('sha256').update(new Uint8Array(a.positions.buffer)).digest('hex');
  rows.push({
    style,
    assetKey: asset.key,
    particles: a.inverseMass.length,
    frames: a.frameIndex,
    exactPositionMatch: true,
    exactStrainMatch: true,
    sha256,
  });
  console.log(`${style}: two full solves match exactly (${a.inverseMass.length} particles).`);
}
await writeFile('docs/validation/realism-determinism.json', JSON.stringify(rows, null, 2) + '\n');
