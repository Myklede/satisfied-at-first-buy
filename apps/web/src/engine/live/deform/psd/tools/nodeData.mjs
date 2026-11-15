// Node side of the PSD tools (agent V7): the bake inputs of a NEUTRAL reference body from the
// local body service (127.0.0.1:8001), and the live jacket binding built exactly as LiveAvatar
// builds it (liveRig.poseDrivers of the display pose → garmentSkin.bindGarment). Body data stays
// in memory. The reference body is the public 172 cm / 65 kg male of scripts/motion-fit-fetch.mjs,
// never the user's figures.
import { skinVertices } from '../../../../motion/rig.ts';
import { parseArticulatedSdf } from '../../../../motion/articulatedCollider.ts';
import { parseFrames, parseRig } from '../../../../motion/rig.ts';
import { bindGarment } from '../../../garmentSkin.ts';
import { loadLiveRig, poseDrivers } from '../../../liveRig.ts';

export const API = 'http://127.0.0.1:8001';
export const NEUTRAL_BODY = { height_cm: 172, weight_kg: 65, sex: 'male' };
const ID = /^[a-f0-9]{64}$/;

const post = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** fetch, retried while the service is down or restarting (connection refused or reset). */
async function http(path, body) {
  let r;
  for (let attempt = 0; ; attempt++) {
    try {
      r = await fetch(API + path, body ? post(body) : { cache: 'no-store' });
      break;
    } catch (error) {
      // The first failure is usually a pooled keep-alive connection the service closed while the
      // bake ran (uvicorn closes idle ones after 5 s): retry at once. Then wait for a restart.
      if (attempt >= 30) throw error;
      const wait = attempt === 0 ? 200 : 10000;
      console.warn(`[v7] ${path}: ${error.cause?.code ?? error.message}; retrying in ${wait} ms`);
      await sleep(wait);
    }
  }
  if (!r.ok)
    throw new Error(`${path}: ${r.status} ${(await r.text().catch(() => '')).slice(0, 300)}`);
  return r;
}
export const json = async (path, body) => (await http(path, body)).json();
export const bin = async (path, body) => (await http(path, body)).arrayBuffer();

/** Everything a PSD bake needs for (product style, size) on the neutral reference body. */
export async function loadNeutral(style, size) {
  const [caps, options, products] = await Promise.all([
    json('/body/capabilities'),
    json('/garment/options'),
    json('/products'),
  ]);
  const product = products.find((p) => p.style === style);
  if (!product) throw new Error(`Unknown product ${style}`);
  const fitBody = () =>
    json('/body/fit', {
      ...NEUTRAL_BODY,
      shape_reference: 'neutral',
      density_kg_m3: caps.default_density_kg_m3,
      known_measurements: {},
    });
  const body = await fitBody();
  const garment = await json('/fit/garment', {
    body_id: body.body_id,
    product_id: product.product_id,
    layer_cm: options.layer_presets_cm.hoodie,
    preference: 'regular',
  });
  const id = body.body_id;
  if (!ID.test(id) || !ID.test(garment.fit_id)) throw new Error('Bad ids from the service');
  const [rigBuffer, sdfBuffer, anchors, asset] = await Promise.all([
    bin(`/motion/${id}/rig.bin`),
    bin(`/motion/${id}/sdf.bin`),
    json(`/motion/${id}/anchors`),
    json(`/fit/${garment.fit_id}/${size}/cloth`),
  ]);
  if (!ID.test(asset.sdf.sdf_id)) throw new Error('Bad SDF id');
  const grid = new Float32Array(await bin(`/collision/${asset.sdf.sdf_id}.bin`));
  const rig = parseRig(rigBuffer);
  const live = loadLiveRig(rigBuffer);
  const sdf = parseArticulatedSdf(sdfBuffer, rig);
  // The live binding, as LiveAvatar.setGarment builds it.
  const neutral = poseDrivers(live, rig.neutralPose, {});
  const neutralSkin = skinVertices(rig, neutral.drivers, new Float32Array(rig.vertexCount * 3));
  const skin = bindGarment(
    rig,
    neutral.drivers,
    neutralSkin,
    asset.body_positions,
    asset.initial,
    asset.panels,
    asset.triangles,
  );
  // A restarted service has forgotten the body (in-memory LRU): fit it again (same figures,
  // same id) and retry once.
  const revived = async (job) => {
    try {
      return await job();
    } catch (error) {
      if (!/: 404 /.test(String(error.message))) throw error;
      const again = await fitBody();
      if (again.body_id !== id) throw new Error('The service returned a different body id');
      return job();
    }
  };
  const binding = {
    count: skin.count,
    bound: skin.bound,
    triangles: asset.triangles,
    skinDrivers: skin.drivers,
    skinWeights: skin.weights,
    asset,
    key: `${id}|${product.style}|${size}|${asset.key}`,
  };
  return {
    bodyId: id,
    style,
    size,
    product,
    rig,
    live,
    sdf,
    anchors,
    asset,
    grid,
    skin,
    binding,
    neutralDrivers: neutral.drivers,
    frames: (request) =>
      revived(async () =>
        parseFrames(await bin(`/motion/${id}/custom/frames.bin`, request), rig.drivers.length),
      ),
    preset: (motionId) =>
      revived(async () =>
        parseFrames(await bin(`/motion/${id}/${motionId}/frames.bin`), rig.drivers.length),
      ),
  };
}
