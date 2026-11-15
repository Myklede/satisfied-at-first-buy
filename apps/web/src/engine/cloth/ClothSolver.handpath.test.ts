import { describe, expect, it } from 'vitest';
import { PullDriver } from '../hand/pullDriver';
import { selectPatch, vertexAdjacency } from '../hand/mapping';
import { fixtureAvailable, fixtureBuffer, fixtureJson } from '../motion/testFixture';
import { ClothSolver, type ClothAsset } from './ClothSolver';

// Bit-identity guard for the static relax + hand-pull path while the motion-bake code in
// ClothSolver is optimised (prompts/06 item E). The checksum covers every float64 of the cloth
// after each of 20 full-mesh steps and of three PullDriver pulls (40 frames) and releases on the
// DQ4920-206 shell of the P2 fixture. The expected values were recorded with the code of commit
// 9faa6cf (before item E) on the fixture fetched 2026-11-12 07:32. A change here means the hand pull
// moves differently: only update them on purpose (or re-record both with 9faa6cf after a re-fetch).
const EXPECTED: Record<string, string> = { S: '5abf26c3', M: 'ae0742d3' };

/** FNV-1a (32-bit) over the raw bytes of a float64 array. */
function fnv(hash: number, values: Float64Array) {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 16777619);
  return hash >>> 0;
}

export function handPathChecksum(asset: ClothAsset, grid: Float32Array) {
  const solver = new ClothSolver(asset, grid);
  solver.positions.set(asset.initial);
  solver.previous.set(asset.initial);
  let hash = 2166136261;
  for (let f = 0; f < 20; f++) {
    solver.step();
    hash = fnv(hash, solver.positions);
  }
  const p = solver.positions,
    adjacency = vertexAdjacency(asset.triangles, p.length / 3);
  // Grab points: the left shoulder seam and two torso particles.
  for (const seed of [asset.landmarks.seam_L, 1200, 3000]) {
    const point = [p[seed * 3], p[seed * 3 + 1], p[seed * 3 + 2]];
    const patch = selectPatch(p, adjacency, [seed], point);
    const driver = new PullDriver(solver);
    driver.begin(patch.ids, patch.weights, point);
    for (let f = 1; f <= 40; f++) {
      const ramp = Math.min(1, f / 15);
      driver.setRequest([0, 0.03 * ramp, 0.08 * ramp]);
      driver.tick(() => 0);
      hash = fnv(hash, solver.positions);
    }
    driver.end();
    for (let f = 0; f < 40 && driver.phase !== 'idle'; f++) {
      driver.tick(() => 0);
      hash = fnv(hash, solver.positions);
    }
    driver.stop();
  }
  return hash.toString(16).padStart(8, '0');
}

describe.skipIf(!fixtureAvailable('cloth-DQ-S.json', 'cloth-DQ-M.json'))(
  'hand-pull path stays bit-identical (P2 fixture shell)',
  () => {
    for (const size of ['S', 'M'])
      it(`size ${size}`, () => {
        const asset = fixtureJson<ClothAsset>(`cloth-DQ-${size}.json`);
        const grid = new Float32Array(fixtureBuffer(`sdf-${asset.sdf.sdf_id}.bin`));
        expect(handPathChecksum(asset, grid)).toBe(EXPECTED[size]);
      }, 60000);
  },
);
