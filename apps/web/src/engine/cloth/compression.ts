/** Most compressed incident material edge and its current direction per vertex.
 * Layout: axis.xyz, compression (positive magnitude of negative engineering strain).
 */
export function compressionField(
  positions: ArrayLike<number>,
  edges: ArrayLike<number>,
  lengths: ArrayLike<number>,
  out: Float32Array,
) {
  out.fill(0);
  for (let e = 0; e < lengths.length; e++) {
    const a = edges[e * 2],
      b = edges[e * 2 + 1],
      ai = a * 3,
      bi = b * 3;
    const x = positions[bi] - positions[ai],
      y = positions[bi + 1] - positions[ai + 1],
      z = positions[bi + 2] - positions[ai + 2];
    const length = Math.sqrt(x * x + y * y + z * z);
    if (!(length > 0 && lengths[e] > 0)) continue;
    const compression = Math.max(0, 1 - length / lengths[e]);
    if (!compression) continue;
    for (let endpoint = 0; endpoint < 2; endpoint++) {
      const i = endpoint === 0 ? a : b;
      const k = i * 4;
      if (compression > out[k + 3]) {
        out[k] = x / length;
        out[k + 1] = y / length;
        out[k + 2] = z / length;
        out[k + 3] = compression;
      }
    }
  }
}
