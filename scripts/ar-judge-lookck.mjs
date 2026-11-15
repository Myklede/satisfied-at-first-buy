// F5: convert a render-service look job's frames.json into the ar-eval checkpoint shape that
// scripts/ar-judge-frames.py --landmarks reads (videoMs relative to the recorded window start,
// pose points 11-16 and 23-24 as {x, y, visibility}, yawRaw = drawn yaw). Private, .cache only.
import { readFileSync, writeFileSync } from 'node:fs';
const [, , src, out] = process.argv;
const j = JSON.parse(readFileSync(src, 'utf8'));
const t0 = (j.window?.[0] ?? 0) * 1000;
const ids = [11, 12, 13, 14, 15, 16, 23, 24];
const frames = j.frames
  .filter((f) => Array.isArray(f.lm))
  .map((f) => {
    const lm = [];
    f.lm.forEach((p, k) => {
      if (p) lm[ids[k]] = { x: p[0], y: p[1], visibility: p[2] };
    });
    return { videoMs: f.videoMs - t0, yawRaw: f.yawDeg ?? null, lm };
  });
writeFileSync(out, JSON.stringify({ source: src, frames }));
console.log(out, frames.length);
