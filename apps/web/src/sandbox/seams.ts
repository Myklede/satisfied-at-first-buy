// Debug seam lines for the sandbox, computed from the cloth asset the kiosk shows.
//  - panelBoundarySegments: triangle edges whose two ends belong to different shell panels
//    (front L/R, back, yoke, sleeves, collar, hood; ids in garmentSurface.ts PANEL).
//  - bafflePhase + isolineSegments: the quilting stitch lines. The garment shader draws a chamber
//    between consecutive integers of (V - yokeDepth) / chamberHeight, with V = the sleeve material
//    arc (arc.y) on sleeves and the uv v elsewhere (garmentShader.ts gRelief). The isolines of that
//    same scalar are exactly where the shader pinches the fabric, so they are the real baffle seams
//    of the model, not a guess.
// Pure functions over typed arrays: no three.js, no DOM.

/** Triangle edges between panels. `panel` is the lower of the two ids (colour key). */
export function panelBoundarySegments(
  triangles: ArrayLike<number>,
  panels: ArrayLike<number>,
  positions: ArrayLike<number>,
  normals?: ArrayLike<number>,
  lift = 0,
): { positions: Float32Array; panel: Uint8Array } {
  const seen = new Set<number>();
  const out: number[] = [];
  const ids: number[] = [];
  const n = panels.length;
  const point = (i: number) =>
    [0, 1, 2].map((k) => positions[i * 3 + k] + (normals ? normals[i * 3 + k] * lift : 0));
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = triangles[t + e],
        b = triangles[t + ((e + 1) % 3)];
      if (panels[a] === panels[b]) continue;
      const key = Math.min(a, b) * n + Math.max(a, b);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(...point(a), ...point(b));
      ids.push(Math.min(panels[a], panels[b]));
    }
  }
  return { positions: Float32Array.from(out), panel: Uint8Array.from(ids) };
}

const SLEEVES = new Set([4, 5]);
const COLLAR = 6;

/**
 * Per-vertex chamber phase and validity. `quilt` = (width, chamber height, yoke depth, kind) x n,
 * `quiltUv` = (u, v) x n, `arc` = garmentCoordinates().arc (x, y, z, w) x n.
 * Vertices on plain bands (kind not 1 or 2), the collar and the yoke band (V < yoke depth) are invalid.
 */
export function bafflePhase(
  panels: ArrayLike<number>,
  quiltUv: ArrayLike<number>,
  arc: ArrayLike<number>,
  quilt: ArrayLike<number>,
) {
  const n = panels.length;
  const phase = new Float32Array(n);
  const valid = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const kind = quilt[i * 4 + 3],
      height = quilt[i * 4 + 1],
      yoke = quilt[i * 4 + 2];
    // Rows between quilted and plain bands carry a fractional kind and are drawn plain.
    if (panels[i] === COLLAR || Math.abs(kind - Math.round(kind)) > 0.02 || Math.round(kind) < 1)
      continue;
    if (!(height > 1e-4)) continue;
    const arcV = arc[i * 4 + 1];
    const v = SLEEVES.has(panels[i]) && arcV > 0 ? arcV : quiltUv[i * 2 + 1];
    if (v < yoke) continue;
    phase[i] = (v - yoke) / height;
    valid[i] = 1;
  }
  return { phase, valid };
}

/**
 * Marching triangles: segments where `phase` crosses an integer. Triangles with any invalid vertex,
 * or whose phase span exceeds `maxSpan` chambers (a chart discontinuity), are skipped.
 */
export function isolineSegments(
  triangles: ArrayLike<number>,
  phase: ArrayLike<number>,
  valid: ArrayLike<number>,
  positions: ArrayLike<number>,
  normals?: ArrayLike<number>,
  lift = 0,
  maxSpan = 1.5,
): Float32Array {
  const out: number[] = [];
  const at = (i: number, j: number, t: number) => {
    const p: number[] = [];
    for (let k = 0; k < 3; k++) {
      const a = positions[i * 3 + k],
        b = positions[j * 3 + k];
      let v = a + (b - a) * t;
      if (normals) v += (normals[i * 3 + k] + (normals[j * 3 + k] - normals[i * 3 + k]) * t) * lift;
      p.push(v);
    }
    return p;
  };
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const v = [triangles[t], triangles[t + 1], triangles[t + 2]];
    if (!(valid[v[0]] && valid[v[1]] && valid[v[2]])) continue;
    const s = v.map((i) => phase[i]);
    const lo = Math.min(...s),
      hi = Math.max(...s);
    if (hi - lo > maxSpan || hi === lo) continue;
    for (let level = Math.ceil(lo); level <= hi; level++) {
      const hits: number[][] = [];
      for (let e = 0; e < 3; e++) {
        const a = e,
          b = (e + 1) % 3;
        if (s[a] < level !== s[b] < level)
          hits.push(at(v[a], v[b], (level - s[a]) / (s[b] - s[a])));
      }
      if (hits.length === 2) out.push(...hits[0], ...hits[1]);
    }
  }
  return Float32Array.from(out);
}
