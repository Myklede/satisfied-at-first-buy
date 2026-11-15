import assert from 'node:assert/strict';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Mesh } from 'three';
import { fitSchema, productSchema, garmentFitSchema, clothSchema } from '../apps/web/src/api.ts';

// API/asset smoke only; this does not execute a browser or claim a rendered FPS.
const base = 'http://127.0.0.1:5710/api';
async function get(path, body) {
  const response = await fetch(
    `${base}${path}`,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  assert.equal(response.status, 200, `${path}: ${response.status}`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response;
}
const body = fitSchema.parse(
  await (await get('/body/fit', { height_cm: 172, weight_kg: 65, sex: 'male' })).json(),
);
const products = (await (await get('/products')).json()).map((value) => productSchema.parse(value));
assert.equal(products.length, 2);
let topology;
for (const product of products) {
  const fit = garmentFitSchema.parse(
    await (
      await get('/fit/garment', {
        body_id: body.body_id,
        product_id: product.product_id,
        layer_cm: 0.3,
        preference: 'regular',
      })
    ).json(),
  );
  const size = product.owned_size;
  assert.ok(fit.sizes[size].geometry_available);
  const gltf = await new GLTFLoader().parseAsync(
    await (await get(`/fit/${fit.fit_id}/${size}/garment.glb`)).arrayBuffer(),
    '',
  );
  let geometry;
  gltf.scene.traverse((object) => {
    if (object instanceof Mesh) geometry = object.geometry;
  });
  assert.ok(geometry);
  for (const attribute of ['position', 'normal', '_gap_cm', '_inner_gap_cm', '_detail', 'color']) {
    const value = geometry.getAttribute(attribute);
    assert.ok(value, attribute);
    assert.equal(value.count, geometry.getAttribute('position').count);
    assert.ok(Array.from(value.array).every(Number.isFinite));
  }
  const indices = Array.from(geometry.index.array);
  if (topology) assert.deepEqual(indices, topology);
  topology = indices;
  const medium = await get(`/fit/${fit.fit_id}/M/garment.glb`);
  assert.ok((await medium.arrayBuffer()).byteLength > 0);
  const cloth = clothSchema.parse(await (await get(`/fit/${fit.fit_id}/${size}/cloth`)).json());
  const clothM = clothSchema.parse(await (await get(`/fit/${fit.fit_id}/M/cloth`)).json());
  assert.ok(cloth.rest.length / 3 >= 8000 && cloth.rest.length / 3 <= 15000);
  assert.deepEqual(cloth.triangles, clothM.triangles);
  assert.notDeepEqual(cloth.rest, clothM.rest);
  assert.equal(cloth.sdf.sdf_id, clothM.sdf.sdf_id);
  const field = await get(`/collision/${cloth.sdf.sdf_id}.bin`);
  assert.equal(field.headers.get('content-type'), 'application/octet-stream');
  assert.equal((await field.arrayBuffer()).byteLength, cloth.sdf.byte_length);
  console.log(
    `${product.style}: legacy GLB ${geometry.getAttribute('position').count} vertices / ${indices.length / 3} triangles; dense cloth ${cloth.rest.length / 3} particles; S/M topology and shared binary SDF pass`,
  );
  gltf.scene.traverse((object) => {
    if (object instanceof Mesh) {
      object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material])
        material.dispose();
    }
  });
}
console.log('Local web/API/GLB smoke passed. Browser rendering/FPS not measured.');
