// Side-by-side frames for the PSD validation (agent V7): a tiny software rasteriser (z-buffer,
// flat Lambert shading) and a PNG writer (node:zlib), so no browser and no browser lock are needed.
// Neutral reference body only. Columns: LBS (the live preview today) | PSD (LBS + correctives,
// guarded) | the true cloth solve; rows: front view, view from the subject's left. A coloured bar
// heads each column: grey = LBS, blue = PSD, green = true solve.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
export function writePng(path, width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** Rasterises triangle meshes into one panel of the image. */
function drawPanel(img, W, zbuf, x0, y0, pw, ph, meshes, view, frame) {
  const { ox, oy, scale } = frame;
  const project = (p, i) => {
    const x = p[i * 3],
      y = p[i * 3 + 1],
      z = p[i * 3 + 2];
    // front: camera on +Z looking at −Z; side: camera on +X (subject's left) looking at −X.
    const u = view === 'front' ? x : -z;
    const depth = view === 'front' ? z : x;
    return [x0 + pw / 2 + (u - ox) * scale, y0 + ph - 10 - (y - oy) * scale, depth];
  };
  const light = view === 'front' ? [0.25, 0.45, 0.86] : [0.86, 0.45, 0.25];
  for (const { positions, triangles, colour, minY } of meshes) {
    for (let t = 0; t < triangles.length; t += 3) {
      const a = triangles[t],
        b = triangles[t + 1],
        c = triangles[t + 2];
      if (minY !== undefined && positions[a * 3 + 1] < minY) continue;
      const A = project(positions, a),
        B = project(positions, b),
        C = project(positions, c);
      const ux = positions[b * 3] - positions[a * 3],
        uy = positions[b * 3 + 1] - positions[a * 3 + 1],
        uz = positions[b * 3 + 2] - positions[a * 3 + 2];
      const vx = positions[c * 3] - positions[a * 3],
        vy = positions[c * 3 + 1] - positions[a * 3 + 1],
        vz = positions[c * 3 + 2] - positions[a * 3 + 2];
      let nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      const shade = 0.3 + 0.7 * Math.abs(nx * light[0] + ny * light[1] + nz * light[2]);
      const minx = Math.max(x0, Math.floor(Math.min(A[0], B[0], C[0]))),
        maxx = Math.min(x0 + pw - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
      const miny = Math.max(y0, Math.floor(Math.min(A[1], B[1], C[1]))),
        maxy = Math.min(y0 + ph - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
      const area = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
      if (Math.abs(area) < 1e-9) continue;
      for (let py = miny; py <= maxy; py++)
        for (let px = minx; px <= maxx; px++) {
          const sx = px + 0.5,
            sy = py + 0.5;
          const w0 = ((B[0] - sx) * (C[1] - sy) - (B[1] - sy) * (C[0] - sx)) / area;
          const w1 = ((C[0] - sx) * (A[1] - sy) - (C[1] - sy) * (A[0] - sx)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = w0 * A[2] + w1 * B[2] + w2 * C[2];
          const k = py * W + px;
          if (z <= zbuf[k]) continue;
          zbuf[k] = z;
          img[k * 3] = Math.min(255, colour[0] * shade);
          img[k * 3 + 1] = Math.min(255, colour[1] * shade);
          img[k * 3 + 2] = Math.min(255, colour[2] * shade);
        }
    }
  }
}

/**
 * One PNG: columns = variants ({ label colour, jacket positions }), rows = front / side.
 * `body` = posed body vertices, `bodyFaces` = the rig's faces, `triangles` = the jacket's.
 */
export function renderComparison(path, { body, bodyFaces, triangles, variants, jacketColour }) {
  const pw = 300,
    ph = 440,
    bar = 8;
  const W = pw * variants.length,
    H = (ph + bar) * 2;
  const img = Buffer.alloc(W * H * 3, 255);
  const zbuf = new Float64Array(W * H).fill(-Infinity);
  // Frame: the union of the jackets and the body above the hips, per view.
  const frameOf = (view) => {
    let lo = Infinity,
      hi = -Infinity,
      ylo = Infinity,
      yhi = -Infinity;
    const take = (p) => {
      for (let i = 0; i < p.length; i += 3) {
        if (p[i + 1] < 0.55) continue;
        const u = view === 'front' ? p[i] : -p[i + 2];
        lo = Math.min(lo, u);
        hi = Math.max(hi, u);
        ylo = Math.min(ylo, p[i + 1]);
        yhi = Math.max(yhi, p[i + 1]);
      }
    };
    for (const v of variants) take(v.positions);
    take(body);
    const scale = Math.min((pw - 20) / (hi - lo), (ph - 20) / (yhi - ylo));
    return { ox: (lo + hi) / 2, oy: ylo, scale };
  };
  ['front', 'side'].forEach((view, row) => {
    const frame = frameOf(view);
    variants.forEach((v, col) => {
      const x0 = col * pw,
        y0 = row * (ph + bar);
      for (let y = y0; y < y0 + bar; y++)
        for (let x = x0 + 2; x < x0 + pw - 2; x++) img.set(v.bar, (y * W + x) * 3);
      drawPanel(
        img,
        W,
        zbuf,
        x0,
        y0 + bar,
        pw,
        ph,
        [
          { positions: body, triangles: bodyFaces, colour: [196, 191, 182], minY: 0.5 },
          { positions: v.positions, triangles, colour: jacketColour },
        ],
        view,
        frame,
      );
    });
  });
  writePng(path, W, H, img);
}
