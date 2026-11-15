// Offline "jacket holes" (agent V7, lead's AR question). In the AR view the posed body is drawn
// depth-only as an occluder (ar/occluder.ts: the body without hands and legs), so wherever cloth
// lies inside the body the occluder wins and the real video shows through the jacket. This
// rasterises, in an orthographic front view (the person facing the camera), the jacket and the
// occluding body into depth buffers and counts the pixels inside the jacket's outline where the
// body is nearer the camera:
//   holes: the body hides the jacket there and lies less than LIMB_GAP_M in front of it: cloth
//          just under the skin, the real see-through hole;
//   limb:  the body lies LIMB_GAP_M or more in front of the cloth: a limb in front of the jacket
//          (crossed forearms below a sleeve that rode up), correct occlusion, counted apart;
//   head:  the head or neck hides it (the hood and collar behind the head, which is correct);
//   inner: the nearest cloth shows its INNER side (looking into a cuff or the neck opening), where
//          the arm or neck inside correctly hides the far wall; not a hole either.
// Outer/inner comes from the triangle winding, oriented once so the front panels face +Z at the
// neutral drape (`windingSign`).
// The occluder's polygon offset (ArCompositor BODY_DEPTH_OFFSET) is about a millimetre; a 1 mm bias
// stands in for it. Pure Node, no browser.
import { writePng } from './render.mjs';

const HEAD = /^(neck|head|eye|jaw|tongue|teeth|ear)/;
/** Body this far (m) or more in front of the cloth is a limb in front, not cloth inside the skin. */
const LIMB_GAP_M = 0.03;

/** Per occluder triangle: 1 when most of its skin weight is on the head and neck. */
export function headTriangles(rig, triangles) {
  const head = new Uint8Array(rig.bones.length);
  rig.bones.forEach((name, b) => {
    if (HEAD.test(name)) head[b] = 1;
  });
  const K = rig.influences;
  const vertexHead = new Uint8Array(rig.vertexCount);
  for (let v = 0; v < rig.vertexCount; v++) {
    let w = 0;
    for (let k = 0; k < K; k++)
      if (head[rig.skinIndices[v * K + k]]) w += rig.skinWeights[v * K + k];
    vertexHead[v] = w >= 0.5 ? 1 : 0;
  }
  const out = new Uint8Array(triangles.length / 3);
  for (let t = 0; t < out.length; t++)
    out[t] =
      vertexHead[triangles[t * 3]] +
        vertexHead[triangles[t * 3 + 1]] +
        vertexHead[triangles[t * 3 + 2]] >=
      2
        ? 1
        : 0;
  return out;
}

function rasterise(positions, triangles, frame, W, H, depth, tag, tags) {
  const { ox, oy, scale } = frame;
  const sx = (i) => W / 2 + (positions[i * 3] - ox) * scale;
  const sy = (i) => H - (positions[i * 3 + 1] - oy) * scale;
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t],
      b = triangles[t + 1],
      c = triangles[t + 2];
    const ax = sx(a),
      ay = sy(a),
      bx = sx(b),
      by = sy(b),
      cx = sx(c),
      cy = sy(c);
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-12) continue;
    const za = positions[a * 3 + 2],
      zb = positions[b * 3 + 2],
      zc = positions[c * 3 + 2];
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))),
      x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))),
      y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let py = y0; py <= y1; py++)
      for (let px = x0; px <= x1; px++) {
        const qx = px + 0.5,
          qy = py + 0.5;
        const w0 = ((bx - qx) * (cy - qy) - (by - qy) * (cx - qx)) / area;
        const w1 = ((cx - qx) * (ay - qy) - (cy - qy) * (ax - qx)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * za + w1 * zb + w2 * zc;
        const k = py * W + px;
        if (z > depth[k]) {
          depth[k] = z;
          if (tags) tags[k] = tag[t / 3];
        }
      }
  }
}

/** +1 or −1 so that (b − a) × (c − a) · sign points out of the cloth (front panels face +Z). */
export function windingSign(bound, triangles, panels) {
  let sum = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t],
      b = triangles[t + 1],
      c = triangles[t + 2];
    if (panels[a] > 1 || panels[b] > 1 || panels[c] > 1) continue; // front panels only
    const ux = bound[b * 3] - bound[a * 3],
      uy = bound[b * 3 + 1] - bound[a * 3 + 1],
      vx = bound[c * 3] - bound[a * 3],
      vy = bound[c * 3 + 1] - bound[a * 3 + 1];
    sum += ux * vy - uy * vx;
  }
  return sum >= 0 ? 1 : -1;
}

/** Per jacket triangle: 1 when its outer side faces the camera (+Z) in `positions`. */
function outerFacing(positions, triangles, sign) {
  const out = new Uint8Array(triangles.length / 3);
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t],
      b = triangles[t + 1],
      c = triangles[t + 2];
    const ux = positions[b * 3] - positions[a * 3],
      uy = positions[b * 3 + 1] - positions[a * 3 + 1],
      vx = positions[c * 3] - positions[a * 3],
      vy = positions[c * 3 + 1] - positions[a * 3 + 1];
    out[t / 3] = (ux * vy - uy * vx) * sign > 0 ? 1 : 0;
  }
  return out;
}

/**
 * Counts jacket pixels and holes (front view, `pxPerM` pixels per metre). `occluder` = body
 * triangle indices that occlude in AR, `head` = headTriangles(rig, occluder). With `png`, writes
 * a picture: jacket grey, holes red, head-hidden blue, inner-side green, limb in front orange.
 */
export function jacketHoles({
  body,
  occluder,
  head,
  jacket,
  triangles,
  sign,
  frame,
  pxPerM = 400,
  png,
  biasM = 0.001,
}) {
  const W = Math.round(1.4 * pxPerM),
    H = Math.round(1.9 * pxPerM);
  const f = frame ?? { ox: 0, oy: 0.3, scale: pxPerM };
  const zJ = new Float64Array(W * H).fill(-Infinity);
  const zB = new Float64Array(W * H).fill(-Infinity);
  const tagB = new Uint8Array(W * H);
  const tagJ = new Uint8Array(W * H);
  rasterise(jacket, triangles, f, W, H, zJ, outerFacing(jacket, triangles, sign), tagJ);
  rasterise(body, occluder, f, W, H, zB, head, tagB);
  const BIAS = biasM; // the occluder's depth offset (ArCompositor polygon offset ≈ 1 mm)
  let jacketPx = 0,
    holes = 0,
    headPx = 0,
    innerPx = 0,
    limbPx = 0;
  const img = png ? Buffer.alloc(W * H * 3, 255) : null;
  for (let k = 0; k < W * H; k++) {
    if (zJ[k] === -Infinity) continue;
    jacketPx++;
    let colour = [170, 170, 170];
    if (zB[k] > zJ[k] + BIAS) {
      if (!tagJ[k]) {
        innerPx++;
        colour = [120, 200, 120];
      } else if (zB[k] - zJ[k] >= LIMB_GAP_M) {
        limbPx++;
        colour = [240, 180, 40];
      } else if (tagB[k]) {
        headPx++;
        colour = [60, 110, 220];
      } else {
        holes++;
        colour = [220, 40, 40];
      }
    }
    if (img) img.set(colour, k * 3);
  }
  if (png) writePng(png, W, H, img);
  return { jacketPx, holes, headPx, innerPx, limbPx, holeShare: jacketPx ? holes / jacketPx : 0 };
}
