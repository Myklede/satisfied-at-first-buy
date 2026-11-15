// P2 evidence: bake (size, motion) on the public reference body in Node with the same code the
// motion worker runs (apps/web/src/engine/motion/bake.ts) and write the measured numbers.
//   node scripts/motion-fit-bake.mjs bake <motion> <size> [prefix=DQ]   -> .cache/motion-fit/results/
//   node scripts/motion-fit-bake.mjs report                              -> docs/validation/motion-fit.{json,md}
// Inputs: .cache/motion-fit/ from scripts/motion-fit-fixture.py and scripts/motion-fit-fetch.mjs.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { parseFrames, parseRig } from '../apps/web/src/engine/motion/rig.ts';
import { parseArticulatedSdf } from '../apps/web/src/engine/motion/articulatedCollider.ts';
import { bakeMotion } from '../apps/web/src/engine/motion/bake.ts';
import { summarySentence } from '../apps/web/src/engine/motion/metrics.ts';
import { MOTION_IDS } from '../apps/web/src/engine/motion/config.ts';

const D = '.cache/motion-fit/';
const buffer = async (name) => {
  const b = await readFile(D + name);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const [command, motion, size, prefix = 'DQ'] = process.argv.slice(2);

if (command === 'bake') {
  if (!MOTION_IDS.includes(motion) || !/^[A-Z0-9]{1,4}$/.test(size)) throw new Error('Bad args');
  const rig = parseRig(await buffer('rig.bin'));
  const sdf = parseArticulatedSdf(await buffer('sdf.bin'), rig);
  const anchors = JSON.parse(await readFile(D + 'anchors.json', 'utf8'));
  const asset = JSON.parse(await readFile(D + `cloth-${prefix}-${size}.json`, 'utf8'));
  const grid = new Float32Array(await buffer(`sdf-${asset.sdf.sdf_id}.bin`));
  const frames = parseFrames(await buffer(`frames-${motion}.bin`), rig.drivers.length);
  const bake = bakeMotion({ asset, grid, rig, sdf, frames, anchors, size });
  const peakStrain = bake.metrics.map((m) => Math.max(...m.zones.map((z) => z.peakStrain)));
  // Woven shell strain (the 1.10 gate): non-elastic edges with rest >= 3 mm, every frame.
  // checks.maxStrain above also counts elastic rib edges and sub-3 mm sliver edges of the
  // sleeve cap (shell geometry), whose ratios say little about the fabric.
  const shell = shellStrain(asset, bake.positions, bake.particles, bake.frameCount);
  const out = {
    motion,
    label: frames.motion.label,
    size,
    product: prefix,
    particles: bake.particles,
    frames: bake.frameCount,
    timings: bake.timings,
    checks: bake.checks,
    shellStrain: shell,
    summary: bake.summary,
    peakStrainPerFrame: peakStrain,
    frontMidPerFrame: bake.metrics.map((m) => m.hemAboveCm.mid[0]),
  };
  await mkdir(D + 'results', { recursive: true });
  await writeFile(`${D}results/${prefix}-${motion}-${size}.json`, JSON.stringify(out));
  // Positions for screenshots/replay are not written (body data stays in memory).
  console.log(
    motion,
    size,
    `${(bake.timings.totalMs / 1000).toFixed(1)} s`,
    JSON.stringify(bake.summary.exposure.mid),
  );
} else if (command === 'report') {
  const files = (await readdir(D + 'results')).filter((f) => f.endsWith('.json'));
  const rows = await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(D + 'results/' + f, 'utf8'))),
  );
  const analytic = JSON.parse(await readFile(D + 'fit-DQ.json', 'utf8'));
  const lines = [
    '# Fit in motion (P2): measured on the public reference body',
    '',
    'Body: 172 cm / 65 kg male (public reference). Jacket: DQ4920-206, sizes S and M (recommended M).',
    'Numbers are computed by `scripts/motion-fit-bake.mjs` with the same code as the browser',
    'worker (`apps/web/src/engine/motion/bake.ts`). Waistband = mid (default). Exposure = hem',
    'height above the waistband ring along the local torso up (positive = skin shows); wrist =',
    'cuff centroid past the wrist landmark along the forearm (negative = wrist shows).',
    'Fabric constants (stretch limit, friction) are uncalibrated.',
    '',
    'Shell strain = woven (non-elastic) edges with rest >= 3 mm: the worst length/rest over the',
    'motion and the most such edges above 1.10 in any frame (of the count shown). Peak strain',
    '(all edges, incl. elastic rib and sub-3 mm sleeve-cap slivers) is the per-particle value',
    'the colour map uses.',
    '',
    '| motion | size | belly front cm | back cm | sides cm | max cm | wrist shows L/R cm | sleeve ride-up L/R cm | shell worst | shell edges > 1.10 | peak strain | bake s | ms/step |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const order = (r) => MOTION_IDS.indexOf(r.motion) * 10 + (r.size === 'S' ? 0 : 1);
  rows.sort((a, b) => order(a) - order(b));
  for (const r of rows) {
    const e = r.summary.exposure.mid,
      w = r.summary.wrist;
    lines.push(
      `| ${r.label} | ${r.size} | ${e.front.toFixed(1)} | ${e.back.toFixed(1)} | ${Math.max(e.left, e.right).toFixed(1)} | ${e.any.toFixed(1)} | ${w.L.exposed.toFixed(1)} / ${w.R.exposed.toFixed(1)} | ${w.L.rideUp.toFixed(1)} / ${w.R.rideUp.toFixed(1)} | ${r.shellStrain ? r.shellStrain.worstRatio.toFixed(2) : '—'} | ${r.shellStrain ? `${r.shellStrain.maxEdgesOver110} / ${r.shellStrain.edges}` : '—'} | ${(r.checks.maxStrain * 100).toFixed(0)} % | ${(r.timings.totalMs / 1000).toFixed(1)} | ${r.timings.meanStepMs.toFixed(0)} |`,
    );
  }
  lines.push('', '## Summary sentences (mid waistband)', '');
  for (const m of MOTION_IDS) {
    const pair = rows.filter((r) => r.motion === m);
    if (pair.length)
      lines.push(
        `- ${summarySentence(
          pair[0].label,
          'mid',
          pair.map((r) => r.summary),
        )}`,
      );
  }
  lines.push('', '## Frame 0 (neutral, relaxed on the motion body) vs the static analytic fit', '');
  lines.push(
    '| size | shoulder cm (analytic / motion f0) | hem vs hip cm (analytic / motion f0) | within 2 cm gate |',
  );
  lines.push('| --- | --- | --- | --- |');
  for (const size of ['S', 'M']) {
    const r = rows.find((x) => x.size === size && x.motion === 'reach_up_both');
    if (!r) continue;
    const z = analytic.sizes[size].zones;
    const ok =
      Math.abs(z.shoulder.value_cm - r.checks.neutral.shoulderCm) <= 2 &&
      Math.abs(z.hem.position_vs_hip_cm - r.checks.neutral.hemVsHipCm) <= 2;
    lines.push(
      `| ${size} | ${z.shoulder.value_cm.toFixed(1)} / ${r.checks.neutral.shoulderCm.toFixed(1)} | ${z.hem.position_vs_hip_cm.toFixed(1)} / ${r.checks.neutral.hemVsHipCm.toFixed(1)} | ${ok ? 'yes' : 'NO'} |`,
    );
  }
  await writeFile(
    'docs/validation/motion-fit.json',
    JSON.stringify(
      rows.map((r) => ({ ...r, frontMidPerFrame: undefined })),
      null,
      1,
    ) + '\n',
  );
  await writeFile('docs/validation/motion-fit.md', lines.join('\n') + '\n');
  console.log(lines.join('\n'));
} else throw new Error('Usage: bake <motion> <size> | report');

function shellStrain(asset, positions, n, frames) {
  const r = asset.rest,
    tri = asset.triangles,
    seen = new Set(),
    pairs = [],
    rest = [];
  for (let t = 0; t < tri.length; t += 3)
    for (let c = 0; c < 3; c++) {
      const a = Math.min(tri[t + c], tri[t + ((c + 1) % 3)]),
        b = Math.max(tri[t + c], tri[t + ((c + 1) % 3)]),
        key = a * n + b;
      if (seen.has(key)) continue;
      seen.add(key);
      if (asset.elastic[a] > 0.5 && asset.elastic[b] > 0.5) continue;
      const length = Math.hypot(
        r[a * 3] - r[b * 3],
        r[a * 3 + 1] - r[b * 3 + 1],
        r[a * 3 + 2] - r[b * 3 + 2],
      );
      if (length < 0.003) continue;
      pairs.push(a, b);
      rest.push(length);
    }
  let worstRatio = 0,
    maxEdgesOver110 = 0;
  for (let f = 0; f < frames; f++) {
    const p = positions.subarray(f * n * 3, (f + 1) * n * 3);
    let over = 0;
    for (let e = 0; e < rest.length; e++) {
      const a = pairs[e * 2] * 3,
        b = pairs[e * 2 + 1] * 3,
        q = Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]) / rest[e];
      if (q > worstRatio) worstRatio = q;
      if (q > 1.1) over++;
    }
    maxEdgesOver110 = Math.max(maxEdgesOver110, over);
  }
  return { worstRatio, maxEdgesOver110, edges: rest.length };
}
