import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

export async function readCloth(path) {
  const asset = JSON.parse(await readFile(path, 'utf8'));
  let bytes;
  if (asset.sdf.values_f32_base64) {
    bytes = Buffer.from(asset.sdf.values_f32_base64, 'base64');
    delete asset.sdf.values_f32_base64;
    asset.sdf.sdf_id = createHash('sha256').update(bytes).digest('hex');
    asset.sdf.byte_length = bytes.length;
  } else {
    if (!/^[a-f0-9]{64}$/.test(asset.sdf.sdf_id)) throw new Error('Invalid SDF hash');
    bytes = await readFile(join(dirname(path), `sdf-${asset.sdf.sdf_id}.bin`));
  }
  const copy = Uint8Array.from(bytes);
  asset.sdf.distance_bias_m ??= (Math.sqrt(3) * asset.sdf.spacing) / 2;
  return { asset, sdf: new Float32Array(copy.buffer) };
}
