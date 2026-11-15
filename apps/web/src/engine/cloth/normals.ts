/** Reuses the render buffer: no temporary vectors/arrays per physics frame. */
export function smoothNormals(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  out: Float32Array,
) {
  if (out.length !== positions.length) throw new Error('Normal buffer length mismatch');
  out.fill(0);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3,
      b = indices[t + 1] * 3,
      c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a],
      uy = positions[b + 1] - positions[a + 1],
      uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a],
      vy = positions[c + 1] - positions[a + 1],
      vz = positions[c + 2] - positions[a + 2];
    const x = uy * vz - uz * vy,
      y = uz * vx - ux * vz,
      z = ux * vy - uy * vx;
    out[a] += x;
    out[a + 1] += y;
    out[a + 2] += z;
    out[b] += x;
    out[b + 1] += y;
    out[b + 2] += z;
    out[c] += x;
    out[c + 1] += y;
    out[c + 2] += z;
  }
  for (let i = 0; i < out.length; i += 3) {
    const x = out[i],
      y = out[i + 1],
      z = out[i + 2];
    const length = Math.sqrt(x * x + y * y + z * z),
      scale = length > 0 ? 1 / length : 0;
    out[i] *= scale;
    out[i + 1] *= scale;
    out[i + 2] *= scale;
  }
}
