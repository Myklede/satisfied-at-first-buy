// "No body skin visible through the coat" (V3, the lead's added gate): for the mid-hold frames
// hemExperiments.mjs dumps (.cache/v3/render/<tag>-{body,cloth}.f32), count the body vertices that
// lie OUTSIDE the simulated coat surface, i.e. skin a viewer sees through the cloth. A body vertex
// counts when its closest cloth triangle is within 5 cm, is not at an opening (hem, cuff, collar,
// hood edge: triangles touching a boundary edge), and the vertex sits more than 2 mm on the outer
// side of that triangle, which faces the same way as the skin (cos > 0.3; global winding by
// majority).
// Region from the rest pose (rig.bin): back / front of the torso, shoulder top, armpit, upper arm.
// Exposed: covered skin with no cloth at all within 8 cm along its outward normal (gaps, tears,
// poke-through), the "skin visible through the coat" a render shows. Numbers only; no image.
//   node apps/web/src/engine/live/record/tools/skinThrough.mjs --rig ridge-user/rig-off.bin
//        --tags reach_up_both-off,reach_up_both-ridge
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseRig } from '../../../motion/rig.ts';

const root = resolve(import.meta.dirname, '../../../../../../..');
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const dumpRel = opt('--dump-dir', '.cache/v3/render');
if (
  dumpRel !== '.cache/v3/render' &&
  !/^\.cache\/cx-day\/physics\/dumps\/[a-z0-9-]{1,48}$/.test(dumpRel)
)
  throw new Error('Invalid private dump directory');
const dumpDir = join(root, dumpRel);
const rigRel = opt('--rig', 'ridge-user/rig-off.bin');
const tags = opt('--tags', '').split(',').filter(Boolean);
if (
  !/^[a-z0-9_-]{1,32}\/[a-z0-9_-]{1,32}\.bin$/.test(rigRel) ||
  !tags.length ||
  tags.some((t) => !/^[a-zA-Z0-9_-]{1,64}$/.test(t))
)
  throw new Error('bad --rig / --tags');
const EXPOSED_RAY_M = 0.08;
const COVER_M = 0.05,
  OUTSIDE_M = 0.002;
const buf = (path) => {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const rig = parseRig(buf(join(root, '.cache/v3', rigRel)));
const dir = dumpDir;
const tris = new Uint32Array(buf(join(dir, 'triangles.u32')));
const T = tris.length / 3;

// Rest-pose regions (scene metres, Y up, +Z front).
const head = (name) => {
  const b = rig.bones.indexOf(name),
    r = rig.restWorld;
  return [r[b * 16 + 3], r[b * 16 + 7], r[b * 16 + 11]];
};
const jL = head('upperarm01.L'),
  jR = head('upperarm01.R'),
  hip = head('pelvis.L');
const midX = (jL[0] + jR[0]) / 2,
  midZ = (jL[2] + jR[2]) / 2;
const R = rig.restVertices,
  V = rig.vertexCount;
const region = new Array(V);
for (let v = 0; v < V; v++) {
  const x = R[v * 3],
    y = R[v * 3 + 1],
    z = R[v * 3 + 2];
  const j = Math.abs(x - jL[0]) < Math.abs(x - jR[0]) ? jL : jR;
  const lateral = (Math.abs(x - midX) - Math.abs(j[0] - midX)) * 100,
    height = (y - j[1]) * 100;
  if (y < hip[1] - 0.05 || height > 12) region[v] = null;
  else if (lateral > 2 && height < -2)
    region[v] = height > -26 ? 'upper arm' : null; // no forearm or hand
  else if (lateral > -6 && height < -2 && height > -14) region[v] = 'armpit';
  else if (height >= -2) region[v] = 'shoulder top';
  else region[v] = z < midZ ? 'back' : 'front';
}

function closestOnTriangle(p, a, b, c) {
  // Ericson, Real-Time Collision Detection 5.1.5.
  const sub = (u, w) => [u[0] - w[0], u[1] - w[1], u[2] - w[2]];
  const dot = (u, w) => u[0] * w[0] + u[1] * w[1] + u[2] * w[2];
  const add = (u, w, s) => [u[0] + w[0] * s, u[1] + w[1] * s, u[2] + w[2] * s];
  const ab = sub(b, a),
    ac = sub(c, a),
    ap = sub(p, a);
  const d1 = dot(ab, ap),
    d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b),
    d3 = dot(ab, bp),
    d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, ab, d1 / (d1 - d3));
  const cp = sub(p, c),
    d5 = dot(ab, cp),
    d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0)
    return add(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
  const denom = 1 / (va + vb + vc);
  return add(add(a, ab, vb * denom), ac, vc * denom);
}

// Opening triangles: any vertex on an edge used by one triangle only.
const edgeUse = new Map();
for (let t = 0; t < T; t++)
  for (let k = 0; k < 3; k++) {
    const a = tris[t * 3 + k],
      b = tris[t * 3 + ((k + 1) % 3)];
    const key = a < b ? a * 1e7 + b : b * 1e7 + a;
    edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
  }
const onBoundary = new Set();
for (const [key, n] of edgeUse)
  if (n === 1) {
    onBoundary.add(Math.floor(key / 1e7));
    onBoundary.add(key % 1e7);
  }
const opening = new Uint8Array(T);
for (let t = 0; t < T; t++)
  for (let k = 0; k < 3; k++) if (onBoundary.has(tris[t * 3 + k])) opening[t] = 1;

const report = {};
for (const tag of tags) {
  const body = new Float32Array(buf(join(dir, `${tag}-body.f32`)));
  const cloth = new Float32Array(buf(join(dir, `${tag}-cloth.f32`)));
  const P = (arr, i) => [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]];
  // Spatial hash of cloth triangles by centroid (3 cm cells).
  const cell = 0.03,
    grid = new Map();
  const keyOf = (x, y, z) =>
    `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  const normal = new Float64Array(T * 3);
  for (let t = 0; t < T; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => P(cloth, tris[t * 3 + k]));
    const cx = (a[0] + b[0] + c[0]) / 3,
      cy = (a[1] + b[1] + c[1]) / 3,
      cz = (a[2] + b[2] + c[2]) / 3;
    const k = keyOf(cx, cy, cz);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(t);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(...n) || 1;
    normal.set([n[0] / l, n[1] / l, n[2] / l], t * 3);
  }
  const nearest = (p) => {
    let best = Infinity,
      bt = -1,
      bq = null;
    const ix = Math.floor(p[0] / cell),
      iy = Math.floor(p[1] / cell),
      iz = Math.floor(p[2] / cell);
    for (let dx = -2; dx <= 2; dx++)
      for (let dy = -2; dy <= 2; dy++)
        for (let dz = -2; dz <= 2; dz++)
          for (const t of grid.get(`${ix + dx},${iy + dy},${iz + dz}`) ?? []) {
            const q = closestOnTriangle(
              p,
              P(cloth, tris[t * 3]),
              P(cloth, tris[t * 3 + 1]),
              P(cloth, tris[t * 3 + 2]),
            );
            const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
            if (d < best) {
              best = d;
              bt = t;
              bq = q;
            }
          }
    return { d: best, t: bt, q: bq };
  };
  // Posed body vertex normals (area-weighted).
  const bn = new Float64Array(V * 3);
  for (let f = 0; f < rig.faces.length / 3; f++) {
    const ids = [rig.faces[f * 3], rig.faces[f * 3 + 1], rig.faces[f * 3 + 2]];
    const [a, b, c] = ids.map((i) => P(body, i));
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    for (const i of ids) for (let k = 0; k < 3; k++) bn[i * 3 + k] += n[k];
  }
  for (let v = 0; v < V; v++) {
    const l = Math.hypot(bn[v * 3], bn[v * 3 + 1], bn[v * 3 + 2]) || 1;
    for (let k = 0; k < 3; k++) bn[v * 3 + k] /= l;
  }
  // A coat triangle covers a skin vertex when it faces the same way (|cos| > 0.3 after the
  // global winding is fixed by the majority): this skips sleeve-on-torso contact, where the
  // nearest cloth is another panel's inner side.
  const cand = [];
  let agree = 0;
  for (let v = 0; v < V; v++) {
    if (!region[v]) continue;
    const p = P(body, v);
    const h = nearest(p);
    if (h.t < 0 || h.d > COVER_M || opening[h.t]) continue;
    const c =
      bn[v * 3] * normal[h.t * 3] +
      bn[v * 3 + 1] * normal[h.t * 3 + 1] +
      bn[v * 3 + 2] * normal[h.t * 3 + 2];
    const s =
      (p[0] - h.q[0]) * normal[h.t * 3] +
      (p[1] - h.q[1]) * normal[h.t * 3 + 1] +
      (p[2] - h.q[2]) * normal[h.t * 3 + 2];
    if (c > 0) agree++;
    cand.push([v, s, c]);
  }
  const flip = agree >= cand.length / 2 ? 1 : -1; // cloth normals point away from the skin
  const away = Math.max(agree, cand.length - agree);
  const hits = cand.filter(([, , c]) => c * flip > 0.3);
  // Exposed: no cloth at all along the skin's outward normal within EXPOSED_RAY_M (a gap or
  // tear in the coat, or skin poking through it). Any panel counts, so layering is handled.
  const rayHits = (p, d) => {
    const seen = new Set();
    for (let t = 0; t <= EXPOSED_RAY_M; t += 0.01) {
      const ix = Math.floor((p[0] + d[0] * t) / cell),
        iy = Math.floor((p[1] + d[1] * t) / cell),
        iz = Math.floor((p[2] + d[2] * t) / cell);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++)
            for (const tri of grid.get(`${ix + dx},${iy + dy},${iz + dz}`) ?? []) {
              if (seen.has(tri)) continue;
              seen.add(tri);
              const [a, b, c] = [0, 1, 2].map((k) => P(cloth, tris[tri * 3 + k]));
              const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
                e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
              const h = [
                d[1] * e2[2] - d[2] * e2[1],
                d[2] * e2[0] - d[0] * e2[2],
                d[0] * e2[1] - d[1] * e2[0],
              ];
              const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
              if (Math.abs(det) < 1e-12) continue;
              const s = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
              const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) / det;
              if (u < 0 || u > 1) continue;
              const q = [
                s[1] * e1[2] - s[2] * e1[1],
                s[2] * e1[0] - s[0] * e1[2],
                s[0] * e1[1] - s[1] * e1[0],
              ];
              const w = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
              if (w < 0 || u + w > 1) continue;
              const tt = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
              if (tt >= 0 && tt <= EXPOSED_RAY_M) return true;
            }
    }
    return false;
  };
  const exposedRows = {};
  let exposed = 0;
  for (const [v] of cand) {
    const e = (exposedRows[region[v]] ??= { candidates: 0, exposed: 0 });
    e.candidates++;
    if (!rayHits(P(body, v), [bn[v * 3], bn[v * 3 + 1], bn[v * 3 + 2]])) {
      e.exposed++;
      exposed++;
    }
  }
  const rows = {};
  let total = 0,
    deepest = 0;
  for (const [v, s0] of hits) {
    const s = s0 * flip;
    const r = (rows[region[v]] ??= { covered: 0, through: 0, deepestMm: 0 });
    r.covered++;
    if (s > OUTSIDE_M) {
      r.through++;
      total++;
      r.deepestMm = Math.max(r.deepestMm, Math.round(s * 1000));
      deepest = Math.max(deepest, s);
    }
  }
  report[tag] = {
    covered: hits.length,
    through: total,
    deepestMm: Math.round(deepest * 1000),
    orientationAgreement: Math.round((away / cand.length) * 1000) / 1000,
    regions: rows,
    exposed,
    exposedRegions: exposedRows,
  };
  console.log(
    `[v3-skin] ${tag}: EXPOSED ${exposed}/${cand.length} (` +
      Object.entries(exposedRows)
        .map(([k, r]) => `${k} ${r.exposed}`)
        .join(', ') +
      `); through the coat ${total}/${hits.length} (deepest ${Math.round(deepest * 1000)} mm: ` +
      Object.entries(rows)
        .map(([k, r]) => `${k} ${r.through}`)
        .join(', ') +
      ')',
  );
}
console.log(JSON.stringify(report));
