// Image-reviewed outline endpoints. These are 2D reference ratios, never tape-fit numbers.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export function geometryRatios(points, annotation) {
  if (![5, 6].every((k) => points[k]?.score >= 0.65))
    throw new Error('Confident shoulder reference required');
  const sw = dist(points[5], points[6]);
  if (!(sw >= 10)) throw new Error('Projected shoulder reference is degenerate');
  const out = {};
  for (const name of ['shoulder', 'chest', 'hem']) {
    const edge = annotation[name + 'Edges'];
    out[name + 'Width'] = edge
      ? { ratio: Math.abs(edge[1] - edge[0]) / sw, readingBound: (2 * annotation.edgeErrorPx) / sw }
      : null;
  }
  if (annotation.hemY !== undefined && [11, 12].every((k) => points[k]?.score >= 0.65))
    out.hemHeight = {
      ratio: (annotation.hemY - (points[11].y + points[12].y) / 2) / sw,
      readingBound: annotation.hemErrorPx / sw,
    };
  else out.hemHeight = null;
  out.sleeveWidth = {};
  for (const [side, e, w] of [
    ['left', 7, 9],
    ['right', 8, 10],
  ]) {
    const line = annotation.sleeveEdges?.[side];
    if (!line || ![e, w].every((k) => points[k]?.score >= 0.65)) {
      out.sleeveWidth[side] = null;
      continue;
    }
    const length = dist(points[e], points[w]);
    if (length < 1) {
      out.sleeveWidth[side] = null;
      continue;
    }
    const nx = -(points[w].y - points[e].y) / length,
      ny = (points[w].x - points[e].x) / length;
    const width = Math.abs((line[1][0] - line[0][0]) * nx + (line[1][1] - line[0][1]) * ny);
    out.sleeveWidth[side] = {
      ratio: width / length,
      readingBound: (2 * annotation.edgeErrorPx) / length,
    };
  }
  return out;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const data = JSON.parse(readFileSync('.cache/research/jacket-targets/geometry-annotations.json'));
  const rows = [];
  for (const a of data) {
    const track = JSON.parse(readFileSync('.cache/research/tracks/' + a.clip + '.json'));
    const frame = track.frames.find((f) => f.index === a.index);
    if (!frame) throw new Error('Annotated source frame missing from reference');
    rows.push({ ...a, ratios: geometryRatios(frame.keypoints, a), tMs: frame.tMs });
  }
  writeFileSync(
    '.cache/research/jacket-targets/manual-geometry-results.json',
    JSON.stringify(rows, null, 2),
  );
  for (const r of rows) console.log(r.clip, r.index, r.pose, JSON.stringify(r.ratios));
}
