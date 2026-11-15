// P2 fixture, part 2: the reference body's garment fit and cloth assets from the running API
// (127.0.0.1:8001). Public reference body only (172 cm / 65 kg male). Writes to
// .cache/motion-fit/ (gitignored): fit-<style>.json, cloth-<prefix>-<size>.json and the
// static grid SDFs sdf-<id>.bin. Run after scripts/motion-fit-fixture.py:
//   node scripts/motion-fit-fetch.mjs [style=DQ4920-206] [sizes=S,M]
import { mkdir, writeFile, access } from 'node:fs/promises';

const API = `http://127.0.0.1:${process.env.SATISFY_API_PORT ?? 8001}`;
const OUT = '.cache/motion-fit';
const [style = 'DQ4920-206', sizeList = 'S,M'] = process.argv.slice(2);
const prefix = style.split('-')[0].slice(0, 2);

async function get(path, init) {
  const response = await fetch(`${API}${path}`, init);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response;
}

await mkdir(OUT, { recursive: true });
const capabilities = await (await get('/body/capabilities')).json();
const body = await (
  await get('/body/fit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      height_cm: 172,
      weight_kg: 65,
      sex: 'male',
      density_kg_m3: capabilities.default_density_kg_m3,
    }),
  })
).json();
const product = (await (await get('/products')).json()).find((p) => p.style === style);
if (!product) throw new Error(`Unknown product ${style}`);
const fit = await (
  await get('/fit/garment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      body_id: body.body_id,
      product_id: product.product_id,
      layer_cm: 0.3,
      preference: 'regular',
    }),
  })
).json();
await writeFile(`${OUT}/fit-${prefix}.json`, JSON.stringify(fit));
for (const size of sizeList.split(',')) {
  const asset = await (await get(`/fit/${fit.fit_id}/${size}/cloth`)).json();
  await writeFile(`${OUT}/cloth-${prefix}-${size}.json`, JSON.stringify(asset));
  const grid = `${OUT}/sdf-${asset.sdf.sdf_id}.bin`;
  if (!/^[a-f0-9]{64}$/.test(asset.sdf.sdf_id)) throw new Error('Invalid SDF id');
  try {
    await access(grid);
  } catch {
    const bytes = new Uint8Array(
      await (await get(`/collision/${asset.sdf.sdf_id}.bin`)).arrayBuffer(),
    );
    await writeFile(grid, bytes);
  }
  console.log(style, size, asset.rest.length / 3, 'particles');
}
console.log('body', body.body_id, 'fit', fit.fit_id, 'recommended', fit.recommended_size);
