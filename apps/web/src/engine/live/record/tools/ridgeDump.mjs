// Inputs for ridgeSlices.mjs on the person's own body (V3, option b1): rig.bin from the shared
// service on 8001 (ridge off) and from V3's ridge-on service (python -m
// body_service.motion.ridge_parity --serve 5773), plus the six presets' frames.bin, which must be
// identical on both. Figures from the gitignored toi.txt, kept in memory; files go to the
// gitignored .cache/v3/ridge-user/.
//   node apps/web/src/engine/live/record/tools/ridgeDump.mjs [--on-port 5773]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../../../../..');
const args = process.argv.slice(2);
const onPort = Number(args.includes('--on-port') ? args[args.indexOf('--on-port') + 1] : 5773);
if (![5770, 5771, 5772, 5773, 5774].includes(onPort)) throw new Error('bad --on-port');
const PRESETS = [
  'reach_up_both',
  'cross_arms',
  'sit',
  'bend_tie_shoes',
  'reach_forward',
  'reach_up_one',
];
const text = readFileSync(join(root, 'data/reference-photos/toi.txt'), 'utf8');
const field = (key) => new RegExp(`^${key}:\\s*([^\\s#]+)`, 'm').exec(text)?.[1];
const dir = join(root, '.cache/v3/ridge-user');
mkdirSync(dir, { recursive: true });

async function http(port, path, body) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    cache: 'no-store',
    ...(body
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  if (!r.ok) throw new Error(`${port}${path}: ${r.status}`);
  return r;
}
async function load(port) {
  const caps = await (await http(port, '/body/capabilities')).json();
  const body = await (
    await http(port, '/body/fit', {
      height_cm: Number(field('height_cm')),
      weight_kg: Number(field('weight_kg')),
      sex: field('sex'),
      shape_reference: 'neutral',
      density_kg_m3: caps.default_density_kg_m3,
      known_measurements: {},
    })
  ).json();
  const id = body.body_id;
  const rig = Buffer.from(await (await http(port, `/motion/${id}/rig.bin`)).arrayBuffer());
  const frames = {};
  for (const p of PRESETS)
    frames[p] = Buffer.from(
      await (await http(port, `/motion/${id}/${p}/frames.bin`)).arrayBuffer(),
    );
  return { rig, frames };
}
const off = await load(8001);
const on = await load(onPort);
writeFileSync(join(dir, 'rig-off.bin'), off.rig);
writeFileSync(join(dir, 'rig-on.bin'), on.rig);
for (const p of PRESETS) {
  if (!off.frames[p].equals(on.frames[p]))
    throw new Error(`${p}: frames.bin differ between services`);
  writeFileSync(join(dir, `frames-${p}.bin`), off.frames[p]);
}
console.log(`[v3-ridge] wrote .cache/v3/ridge-user (frames identical on 8001 and ${onPort})`);
