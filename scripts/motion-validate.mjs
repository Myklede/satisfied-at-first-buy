// Local fixture correctness runner (prompt 07 D2): woven-shell strain and penetration of every
// (motion, size) bake on the P2 fixture (.cache/motion-fit/), written to .cache/codex-motion/.
// Timings deliberately omitted: safe under shared CPU load. Bakes use the WebAssembly kernels,
// which are bit-identical to the JS solver (cloth/wasm/, prompt 08).
// node scripts/motion-validate.mjs <label> [--motion cross_arms] [--size M]
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseFrames, parseRig } from '../apps/web/src/engine/motion/rig.ts';
import { parseArticulatedSdf } from '../apps/web/src/engine/motion/articulatedCollider.ts';
import { bakeMotion } from '../apps/web/src/engine/motion/bake.ts';
import { MOTION_IDS } from '../apps/web/src/engine/motion/config.ts';
import { wasmKernels } from '../apps/web/src/engine/cloth/wasm/kernels.ts';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

function main() {
  const args = process.argv.slice(2),
    label = args[0];
  if (!/^[a-zA-Z0-9_-]+$/.test(label ?? '')) throw new Error('Expected a safe run label');
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  if (args.includes('--motion') && !MOTION_IDS.includes(option('--motion')))
    throw new Error('Invalid motion');
  if (args.includes('--size') && !['S', 'M'].includes(option('--size')))
    throw new Error('Invalid size');
  const dir = '.cache/motion-fit/';
  const buffer = (name) => {
    const b = readFileSync(dir + name);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };
  const json = (name) => JSON.parse(readFileSync(dir + name, 'utf8'));
  const rig = parseRig(buffer('rig.bin'));
  const sdf = parseArticulatedSdf(buffer('sdf.bin'), rig);
  const anchors = json('anchors.json');
  mkdirSync('.cache/codex-motion', { recursive: true });
  const results = [];
  for (const motion of MOTION_IDS.filter((m) => !option('--motion') || m === option('--motion'))) {
    for (const size of ['S', 'M'].filter((s) => !option('--size') || s === option('--size'))) {
      console.log('Baking', label, motion, size);
      const asset = json(`cloth-DQ-${size}.json`);
      const grid = new Float32Array(buffer(`sdf-${asset.sdf.sdf_id}.bin`));
      const frames = parseFrames(buffer(`frames-${motion}.bin`), rig.drivers.length);
      const bake = bakeMotion({ asset, grid, rig, sdf, frames, anchors, size }, undefined, {
        kernels: wasmKernels,
      });
      const hash = (v) =>
        createHash('sha256')
          .update(
            ArrayBuffer.isView(v)
              ? Buffer.from(v.buffer, v.byteOffset, v.byteLength)
              : JSON.stringify(v),
          )
          .digest('hex');
      const hashes = Object.fromEntries(
        [
          'positions',
          'strain',
          'exposed',
          'exposureVertices',
          'exposureLevel',
          'metrics',
          'summary',
          'checks',
        ].map((k) => [k, hash(bake[k])]),
      );
      const shell = shellStats(asset, bake);
      results.push({ motion, size, hashes, shell, checks: bake.checks });
      writeFileSync(`.cache/codex-motion/${label}.json`, JSON.stringify(results, null, 2) + '\n');
      console.log(motion, size, JSON.stringify(shell));
    }
  }
}

export function shellStats(asset, bake) {
  const { particles: n, positions, frameCount } = bake;
  const seen = new Set(),
    pairs = [],
    rest = [];
  for (let t = 0; t < asset.triangles.length; t += 3)
    for (let c = 0; c < 3; c++) {
      const a = Math.min(asset.triangles[t + c], asset.triangles[t + ((c + 1) % 3)]);
      const b = Math.max(asset.triangles[t + c], asset.triangles[t + ((c + 1) % 3)]);
      const key = a * n + b;
      if (seen.has(key)) continue;
      seen.add(key);
      if (asset.elastic[a] > 0.5 && asset.elastic[b] > 0.5) continue;
      const r = asset.rest;
      const length = Math.hypot(
        r[a * 3] - r[b * 3],
        r[a * 3 + 1] - r[b * 3 + 1],
        r[a * 3 + 2] - r[b * 3 + 2],
      );
      if (length < 0.003) continue;
      pairs.push(a * 3, b * 3);
      rest.push(length);
    }
  const ratios = new Float64Array(rest.length * frameCount),
    peaks = [];
  if (!rest.length || !frameCount) throw new Error('No woven edges or frames to measure');
  let worstRatio = 0,
    maxEdgesOver110 = 0;
  for (let f = 0; f < frameCount; f++) {
    let peak = 0,
      over = 0;
    const p = positions.subarray(f * n * 3, (f + 1) * n * 3);
    for (let e = 0; e < rest.length; e++) {
      const a = pairs[e * 2],
        b = pairs[e * 2 + 1];
      const q = Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]) / rest[e];
      ratios[f * rest.length + e] = q;
      peak = Math.max(peak, q);
      if (q > 1.1) over++;
    }
    peaks.push(peak);
    worstRatio = Math.max(worstRatio, peak);
    maxEdgesOver110 = Math.max(maxEdgesOver110, over);
  }
  const median = (values) => {
    values.sort((a, b) => a - b);
    const i = Math.floor(values.length / 2);
    return values.length % 2 ? values[i] : (values[i - 1] + values[i]) / 2;
  };
  return {
    edges: rest.length,
    worstRatio,
    maxEdgesOver110,
    medianRatio: median(ratios),
    medianFrameWorst: median(peaks),
  };
}
