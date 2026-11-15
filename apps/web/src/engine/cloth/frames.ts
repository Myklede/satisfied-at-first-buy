/** Transport a sewn local offset with its actual adjacent cloth triangle. */
export function frameOffset(
  positions: ArrayLike<number>,
  a: number,
  b: number,
  c: number,
  local: ArrayLike<number>,
  localIndex: number,
  out: Float32Array | Float64Array,
  outIndex: number,
  translate: boolean,
) {
  a *= 3;
  b *= 3;
  c *= 3;
  let xx = positions[b] - positions[a],
    xy = positions[b + 1] - positions[a + 1],
    xz = positions[b + 2] - positions[a + 2];
  const xl = Math.sqrt(xx * xx + xy * xy + xz * xz);
  if (!(xl > 0)) throw new Error('Collapsed cloth attachment edge');
  xx /= xl;
  xy /= xl;
  xz /= xl;
  const dx = positions[c] - positions[a],
    dy = positions[c + 1] - positions[a + 1],
    dz = positions[c + 2] - positions[a + 2];
  let zx = xy * dz - xz * dy,
    zy = xz * dx - xx * dz,
    zz = xx * dy - xy * dx;
  const zl = Math.sqrt(zx * zx + zy * zy + zz * zz);
  if (!(zl > 0)) throw new Error('Collapsed cloth attachment triangle');
  zx /= zl;
  zy /= zl;
  zz /= zl;
  const yx = zy * xz - zz * xy,
    yy = zz * xx - zx * xz,
    yz = zx * xy - zy * xx;
  const x = local[localIndex],
    y = local[localIndex + 1],
    z = local[localIndex + 2];
  out[outIndex] = xx * x + yx * y + zx * z + (translate ? positions[a] : 0);
  out[outIndex + 1] = xy * x + yy * y + zy * z + (translate ? positions[a + 1] : 0);
  out[outIndex + 2] = xz * x + yz * y + zz * z + (translate ? positions[a + 2] : 0);
}

export function attachAccessories(
  positions: Float64Array,
  attachments: ArrayLike<number>,
  offsets: ArrayLike<number>,
) {
  for (let i = 0; i < attachments.length; i += 4)
    frameOffset(
      positions,
      attachments[i + 1],
      attachments[i + 2],
      attachments[i + 3],
      offsets,
      (i / 4) * 3,
      positions,
      attachments[i] * 3,
      true,
    );
}

/** Smooth surface frame for insulation, distinct from a sewn hardware frame. */
export function surfaceOffset(
  positions: ArrayLike<number>,
  normals: ArrayLike<number>,
  a: number,
  b: number,
  local: ArrayLike<number>,
  k: number,
  out: Float32Array,
) {
  const i = a * 3,
    j = b * 3,
    zx = normals[i],
    zy = normals[i + 1],
    zz = normals[i + 2];
  let xx = positions[j] - positions[i],
    xy = positions[j + 1] - positions[i + 1],
    xz = positions[j + 2] - positions[i + 2];
  const dot = xx * zx + xy * zy + xz * zz;
  xx -= dot * zx;
  xy -= dot * zy;
  xz -= dot * zz;
  const length = Math.sqrt(xx * xx + xy * xy + xz * xz);
  if (!(length > 0)) throw new Error('Collapsed fabric surface frame');
  xx /= length;
  xy /= length;
  xz /= length;
  const yx = zy * xz - zz * xy,
    yy = zz * xx - zx * xz,
    yz = zx * xy - zy * xx;
  const x = local[k],
    y = local[k + 1],
    z = local[k + 2];
  out[k] = xx * x + yx * y + zx * z;
  out[k + 1] = xy * x + yy * y + zy * z;
  out[k + 2] = xz * x + yz * y + zz * z;
}
