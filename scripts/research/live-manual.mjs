import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const good = (p) => p?.score >= 0.65;
export function cuffRatio(points, side, endpoint, error) {
  const [e, w] = side === 'left' ? [7, 9] : [8, 10];
  if (!good(points?.[e]) || !good(points?.[w])) return null;
  const a = points[e],
    b = points[w];
  const vx = ((b.x - a.x) * 959) / 960,
    vy = b.y - a.y,
    length = Math.hypot(vx, vy);
  if (length < 25) return null;
  return {
    ratio: ((endpoint[0] - (b.x * 959) / 960) * vx + (endpoint[1] - b.y) * vy) / length ** 2,
    readingBound: error / length,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const base = '.cache/research/live1/';
  const annotations = JSON.parse(readFileSync(base + 'manual-annotations.json'));
  const result = [];
  for (const a of annotations) {
    const refs = JSON.parse(readFileSync('.cache/research/tracks/' + a.clip + '.json')).frames;
    const samples = JSON.parse(readFileSync(base + a.clip + '-inspect.json'));
    const sample = samples.find((s) => s.sample === a.sample);
    const frame = refs.reduce((x, y) =>
      Math.abs(x.tMs - sample.rawMs) < Math.abs(y.tMs - sample.rawMs) ? x : y,
    );
    const row = {
      clip: a.clip,
      sample: a.sample,
      arMs: sample.arMs,
      rawMs: sample.rawMs,
      ratios: {},
      hands: a.hands,
    };
    if (a.outline)
      row.outline = Object.fromEntries(
        Object.entries(a.outline).map(([part, o]) => [
          part,
          {
            leftOvershootPx: (o.raw[0] * 959) / 960 - o.ar[0],
            rightOvershootPx: o.ar[1] - (o.raw[1] * 959) / 960,
            readingBoundPx: 2 * o.readingPx,
            caveat:
              'reviewed visible clothing outline at one row, not anatomical body surface; temporal association uncertainty excluded',
          },
        ]),
      );
    for (const [side, point] of Object.entries(a.cuffs ?? {})) {
      const value = cuffRatio(frame.keypoints, side, point, a.errorPx);
      if (value) {
        const alternatives = refs
          .filter((f) => Math.abs(f.index - frame.index) <= 1)
          .map((f) => cuffRatio(f.keypoints, side, point, a.errorPx)?.ratio)
          .filter(Number.isFinite);
        value.timeAssociationBound = Math.max(
          ...alternatives.map((v) => Math.abs(v - value.ratio)),
        );
        value.combinedBound = value.readingBound + value.timeAssociationBound;
      }
      row.ratios[side] = value;
    }
    if (a.chinY !== undefined) {
      const p = frame.keypoints,
        sw = Math.hypot(((p[5].x - p[6].x) * 959) / 960, p[5].y - p[6].y);
      row.collar = {};
      for (const [name, y] of Object.entries(a.collar))
        row.collar[name] = {
          minusChinOverShoulder: (y - a.chinY) / sw,
          minusNoseOverShoulder: (y - p[0].y) / sw,
          readingBound: (a.chinErrorPx + a.collarErrorPx) / sw,
        };
    }
    result.push(row);
  }
  writeFileSync(base + 'manual-results.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
