// Image-space measurement settings: explicit operator thresholds, not cloth calibration.
export const SETTINGS = Object.freeze({
  maskConfidence: 0.5, // MediaPipe person probability; validate overlays before accepting.
  landmarkVisibility: 0.65,
  pixelError: 4, // Operator edge/landmark sensitivity in original 720x1280 images.
  timestampErrorSeconds: 1, // docs/look/video-index.md, one-second extraction.
  colour: {
    minChannel: 80, // Dark puffer hem sample 126/98/79, distinct from the grey layer below.
    maxRedGreen: 1.3, // Include warm shadowed cloth; redder skin is excluded, then reviewed by eye.
    minBlueGreen: 0.65,
    maxBlueGreen: 1.12,
    pufferMinRedBlue: 35, // Private neutral torso sample: 173/144/120; warm grey trousers must be excluded.
    parkaMinChannel: 140, // Private neutral torso 213/201/190 versus grey under-layer/trousers.
  },
});

export function median(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function summary(values) {
  const a = values.filter(Number.isFinite);
  return {
    n: a.length,
    median: median(a),
    min: a.length ? Math.min(...a) : null,
    max: a.length ? Math.max(...a) : null,
  };
}

export function colourMatch(r, g, b, jacket) {
  const c = SETTINGS.colour;
  return (
    Math.min(r, g, b) >= c.minChannel &&
    r / g <= c.maxRedGreen &&
    b / g >= c.minBlueGreen &&
    b / g <= c.maxBlueGreen &&
    (jacket !== 'puffer' || r - b >= c.pufferMinRedBlue) &&
    (jacket !== 'parka' || Math.min(r, g, b) >= c.parkaMinChannel)
  );
}

// Positive hem offset = below hips; positive cuff offset = proximal to wrist.
// This is a projected 2D metric, not a recovered 3D fabric surface length.
export function measureFrame({
  width,
  height,
  rgba,
  person,
  maskWidth,
  maskHeight,
  landmarks,
  jacket,
}) {
  const point = (i) => {
    const p = landmarks?.[i];
    return p &&
      p.visibility >= SETTINGS.landmarkVisibility &&
      p.x > 0 &&
      p.x < 1 &&
      p.y > 0 &&
      p.y < 1
      ? { x: p.x * width, y: p.y * height }
      : null;
  };
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x,
        k = i * 4;
      const m =
        Math.floor((y / height) * maskHeight) * maskWidth + Math.floor((x / width) * maskWidth);
      pixels[i] =
        person[m] >= SETTINGS.maskConfidence &&
        colourMatch(rgba[k], rgba[k + 1], rgba[k + 2], jacket)
          ? 1
          : 0;
    }
  const hips = [point(23), point(24)].filter(Boolean);
  const shoulders = [point(11), point(12)].filter(Boolean);
  const hip = hips.length
    ? { x: median(hips.map((p) => p.x)), y: median(hips.map((p) => p.y)) }
    : null;
  const shoulder = shoulders.length
    ? { x: median(shoulders.map((p) => p.x)), y: median(shoulders.map((p) => p.y)) }
    : null;
  let hem = null;
  if (hip && shoulder) {
    const torso = Math.hypot(hip.x - shoulder.x, hip.y - shoulder.y);
    const half = Math.max(
      20,
      Math.min(
        torso * 0.32,
        shoulders.length === 2 ? Math.abs(shoulders[1].x - shoulders[0].x) * 0.32 : torso * 0.32,
      ),
    );
    const edges = [];
    for (let x = Math.max(0, Math.round(hip.x - half)); x < Math.min(width, hip.x + half); x += 2) {
      // Require a vertical run to reject isolated bright skin/noise pixels.
      let last = null,
        run = 0;
      for (
        let y = Math.max(0, Math.round(shoulder.y + torso * 0.2));
        y < Math.min(height, hip.y + torso * (jacket === 'parka' ? 1.4 : 0.55));
        y++
      ) {
        run = pixels[y * width + x] ? run + 1 : 0;
        if (run >= 8) last = y;
      }
      if (last !== null) edges.push(last);
    }
    const y = median(edges);
    if (y !== null && edges.length >= 10)
      hem = {
        x: hip.x,
        y,
        offsetPx: y - hip.y,
        spreadPx: Math.max(...edges) - Math.min(...edges),
        columns: edges.length,
      };
  }
  const cuffs = [];
  for (const [side, e, w] of [
    ['left', 13, 15],
    ['right', 14, 16],
  ]) {
    const elbow = point(e),
      wrist = point(w);
    if (!elbow || !wrist) {
      cuffs.push({
        side,
        offsetPx: null,
        reason: 'wrist/elbow occluded, outside frame or visibility below 0.65',
      });
      continue;
    }
    const dx = wrist.x - elbow.x,
      dy = wrist.y - elbow.y,
      len = Math.hypot(dx, dy),
      ux = dx / len,
      uy = dy / len;
    if (len < 15) {
      cuffs.push({ side, offsetPx: null, reason: 'projected forearm too short' });
      continue;
    }
    const ends = [];
    for (let lateral = -0.12 * len; lateral <= 0.12 * len; lateral += 3) {
      let end = null,
        run = 0;
      for (let t = 0.25 * len; t < 1.4 * len; t++) {
        const x = Math.round(elbow.x + t * ux - lateral * uy),
          y = Math.round(elbow.y + t * uy + lateral * ux);
        if (x < 0 || x >= width || y < 0 || y >= height) {
          run = 0;
          continue;
        }
        run = pixels[y * width + x] ? run + 1 : 0;
        if (run >= 5) end = t;
      }
      if (end !== null) ends.push(end);
    }
    const end = median(ends);
    cuffs.push({
      side,
      offsetPx: end === null ? null : len - end,
      point: end === null ? null : { x: elbow.x + end * ux, y: elbow.y + end * uy },
      spreadPx: ends.length ? Math.max(...ends) - Math.min(...ends) : null,
      reason: end === null ? 'no continuous sleeve colour run' : null,
    });
  }
  return { hem, hip, cuffs, pixels };
}

export function relativeMetric(
  neutral,
  move,
  pxPerCm,
  scaleFraction,
  sign = 1,
  timestampValues = [],
  neutralTimestampValues = null,
) {
  if (!(pxPerCm > 0) || !(scaleFraction >= 0))
    throw new Error('Valid positive scale and nonnegative uncertainty required');
  const a = summary(neutral),
    b = summary(move),
    t = summary(timestampValues);
  if (!a.n || !b.n) return { valueCm: null, reason: 'no accepted neutral or move observations' };
  const delta = (sign * (b.median - a.median)) / pxPerCm;
  const spread = (a.max - a.min + (b.max - b.min)) / (2 * pxPerCm);
  let timestamp = t.n
    ? Math.max(Math.abs(t.min - b.median), Math.abs(t.max - b.median)) / pxPerCm
    : null;
  if (neutralTimestampValues !== null) {
    const nt = summary(neutralTimestampValues);
    timestamp =
      timestamp !== null && nt.n
        ? timestamp + Math.max(Math.abs(nt.min - a.median), Math.abs(nt.max - a.median)) / pxPerCm
        : null;
  }
  const scale = Math.abs(delta) * scaleFraction,
    pixel = (4 * SETTINGS.pixelError) / pxPerCm;
  return {
    valueCm: delta,
    uncertaintyCm: timestamp === null ? null : spread + timestamp + scale + pixel,
    componentsCm: { frameSpread: spread, timestamp, scale, pixel },
    neutral: a,
    move: b,
    uncertaintyKind:
      'conservative additive sensitivity, not a confidence interval; 2D projection only',
  };
}
