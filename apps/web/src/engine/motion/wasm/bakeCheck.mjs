// JS vs WebAssembly motion bakes on the P2 fixture (.cache/motion-fit/, see motion/testFixture.ts):
// bakes every (motion, size) with both paths in the same process, alternating, and compares a
// sha256 over everything a bake returns (positions, strain, exposure, per-frame metrics, summary,
// checks; not the timings). Each path keeps one relax cache per size, like the motion worker.
//   node apps/web/src/engine/motion/wasm/bakeCheck.mjs [--sizes S,M] [--motions a,b]
//        [--paths js,wasm] [--repeat 1] [--frames N] [--product DQ] [--out file.json]
// Exit 1 when any pair of hashes differs.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseFrames, parseRig } from '../rig.ts';
import { parseArticulatedSdf } from '../articulatedCollider.ts';
import { bakeMotion } from '../bake.ts';
import { MOTION_IDS } from '../config.ts';
import { wasmKernels } from '../../cloth/wasm/kernels.ts';
import { wasmColliderKernels } from './colliderKernels.ts';

const { values: args } = parseArgs({
  options: {
    sizes: { type: 'string', default: 'S,M' },
    motions: { type: 'string', default: MOTION_IDS.join(',') },
    paths: { type: 'string', default: 'js,wasm' },
    repeat: { type: 'string', default: '1' },
    frames: { type: 'string' },
    product: { type: 'string', default: 'DQ' },
    out: { type: 'string' },
  },
});
const D = new URL('../../../../../../.cache/motion-fit/', import.meta.url);
const buffer = (name) => {
  const b = readFileSync(new URL(name, D));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const rig = parseRig(buffer('rig.bin'));
const sdf = parseArticulatedSdf(buffer('sdf.bin'), rig);
const anchors = JSON.parse(readFileSync(new URL('anchors.json', D), 'utf8'));
const paths = args.paths.split(',');
const maxFrames = args.frames ? Number(args.frames) : undefined;

function digest(bake) {
  const h = createHash('sha256');
  for (const a of [bake.positions, bake.strain, bake.exposed, bake.exposureVertices])
    h.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  h.update(JSON.stringify([bake.metrics, bake.summary, bake.checks, bake.frameCount]));
  return h.digest('hex').slice(0, 16);
}

const rows = [];
let mismatches = 0;
for (const size of args.sizes.split(',')) {
  const asset = JSON.parse(readFileSync(new URL(`cloth-${args.product}-${size}.json`, D), 'utf8'));
  const grid = new Float32Array(buffer(`sdf-${asset.sdf.sdf_id}.bin`));
  const caches = Object.fromEntries(paths.map((p) => [p, {}]));
  for (const motion of args.motions.split(',')) {
    const frames = parseFrames(buffer(`frames-${motion}.bin`), rig.drivers.length);
    for (let r = 0; r < Number(args.repeat); r++) {
      const row = { motion, size, run: r };
      for (const path of r % 2 ? [...paths].reverse() : paths) {
        const bake = bakeMotion({ asset, grid, rig, sdf, frames, anchors, size }, undefined, {
          relaxCache: caches[path],
          maxFrames,
          kernels: path === 'wasm' ? wasmKernels : undefined,
          colliderKernels: path === 'wasm' ? wasmColliderKernels : undefined,
        });
        row[path] = {
          hash: digest(bake),
          totalS: +(bake.timings.totalMs / 1000).toFixed(2),
          motionS: +(bake.timings.motionMs / 1000).toFixed(2),
          relaxS: +(bake.timings.relaxMs / 1000).toFixed(2),
          relaxCached: bake.timings.relaxCached,
          stepMs: +bake.timings.meanStepMs.toFixed(1),
        };
      }
      const hashes = new Set(paths.map((p) => row[p].hash));
      row.identical = hashes.size === 1;
      if (!row.identical) mismatches++;
      rows.push(row);
      console.log(
        `${motion.padEnd(15)} ${size} run ${r}: ` +
          paths
            .map((p) => `${p} ${row[p].hash} ${row[p].totalS}s (step ${row[p].stepMs} ms)`)
            .join(' | ') +
          (row.identical ? '  identical' : '  MISMATCH'),
      );
    }
  }
}
console.log(`${rows.length} cases, ${mismatches} mismatches`);
if (args.out) writeFileSync(args.out, JSON.stringify({ rows, mismatches }, null, 1));
process.exit(mismatches ? 1 : 0);
