// window.__arlab: hooks for driving the AR lab from a script (the numbers-only evaluation,
// labs/ar/eval/run-ar-eval.mjs). Only numbers leave the page; no pixels.
import type { ArCompositor } from '../../engine/live/ar/ArCompositor';
import type { LiveTryOnEngine } from '../../engine/live/LiveTryOnEngine';
import type { ImageLandmark, LiveFrame } from '../../engine/live/contract';
import {
  silhouetteOffsets,
  type Mask,
  type SilhouetteOffsets,
} from '../../engine/live/ar/silhouette';
import { chestColour, realJacketMask } from './realJacket';
import { yawFromWorld } from '../../engine/live/ar/ArTracker';

function armLag(track: { t: number; raw: number[]; sm: number[] }[]) {
  if (track.length < 10) return null;
  const at = (k: number, t: number) => {
    // raw track interpolated at time t (ms)
    let i = 1;
    while (i < track.length - 1 && track[i].t < t) i++;
    const a = track[i - 1],
      b = track[i];
    const f = b.t === a.t ? 0 : Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
    return a.raw[k] + (b.raw[k] - a.raw[k]) * f;
  };
  const moving: number[] = [];
  for (let i = 1; i < track.length; i++) {
    const dt = (track[i].t - track[i - 1].t) / 1000;
    let speed = 0;
    for (let j = 0; j < 4; j++)
      speed = Math.max(
        speed,
        Math.hypot(
          track[i].raw[j * 2] - track[i - 1].raw[j * 2],
          track[i].raw[j * 2 + 1] - track[i - 1].raw[j * 2 + 1],
        ) / Math.max(dt, 1e-3),
      );
    if (speed > 100) moving.push(i);
  }
  if (moving.length < 5) return { lagMs: null, movingFrames: moving.length };
  let best = 0,
    bestErr = Infinity;
  for (let lag = 0; lag <= 200; lag += 5) {
    let err = 0;
    for (const i of moving)
      for (let k = 0; k < 8; k++) err += (track[i].sm[k] - at(k, track[i].t - lag)) ** 2;
    if (err < bestErr) {
      bestErr = err;
      best = lag;
    }
  }
  return { lagMs: best, movingFrames: moving.length };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Seek the source video and wait until `settleMs` of the held frame has been processed. */
export async function seekAndSettle(
  engine: LiveTryOnEngine,
  ar: ArCompositor,
  t: number,
  settleMs = 900,
) {
  const video = engine.currentSource?.video;
  if (!video) throw new Error('No video source');
  video.pause();
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    video.addEventListener('seeked', done, { once: true });
    video.currentTime = t;
  });
  ar.tracker.resetSmoothing();
  await wait(settleMs);
}

/** Intersection over union of two masks (any nonzero = inside). */
function iou(a: Mask, b: Mask) {
  let inter = 0,
    union = 0;
  for (let i = 0; i < a.data.length; i++) {
    const x = a.data[i] > 0,
      y = b.data[i] > 0;
    if (x && y) inter++;
    if (x || y) union++;
  }
  return union ? inter / union : null;
}

/**
 * Coverage of the real torso by the drawn jacket: the person-mask pixels inside the
 * shoulder–hip quadrilateral (shoulders raised by 10 % of the torso height so the shoulder
 * tops count), and the share of them our jacket covers. `beyond` = share of the drawn jacket
 * outside the person (a puffer is wider than a T-shirt: expected > 0).
 */
function torsoCoverage(
  ours: Mask,
  person: NonNullable<LiveFrame['mask']>,
  l: readonly ImageLandmark[],
) {
  const q = [l[11], l[12], l[24], l[23]];
  if (q.some((p) => !p || p.visibility < 0.5)) return null;
  const lift =
    0.1 *
    Math.hypot((q[0].x + q[1].x - q[2].x - q[3].x) / 2, (q[0].y + q[1].y - q[2].y - q[3].y) / 2);
  const poly = [
    [q[0].x, q[0].y - lift],
    [q[1].x, q[1].y - lift],
    [q[2].x, q[2].y],
    [q[3].x, q[3].y],
  ];
  const inside = (x: number, y: number) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i],
        [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const { width, height } = ours;
  const sx = person.width / width,
    sy = person.height / height;
  let torso = 0,
    covered = 0,
    drawn = 0,
    beyond = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const isPerson =
        person.data[
          Math.min(person.height - 1, Math.floor(y * sy)) * person.width +
            Math.min(person.width - 1, Math.floor(x * sx))
        ] >= 0.5;
      const isOurs = ours.data[y * width + x] > 0;
      if (isOurs) {
        drawn++;
        if (!isPerson) beyond++;
      }
      if (isPerson && inside(x, y)) {
        torso++;
        if (isOurs) covered++;
      }
    }
  return {
    torsoCovered: torso ? covered / torso : null,
    drawnBeyondPerson: drawn ? beyond / drawn : null,
  };
}

/**
 * Glue coverage: the person's upper-body clothing region (person mask inside the shoulder–hip
 * quad, shoulders raised 10 % of the torso height, plus the arms as capsules shoulder→elbow→wrist
 * of radius 0.2 × shoulder span; face and hands excluded) and the share of it the warped jacket
 * covers.
 */
function glueCoverage(
  jacket: Mask,
  person: NonNullable<LiveFrame['mask']>,
  l: readonly ImageLandmark[],
) {
  const need = [11, 12, 23, 24];
  if (need.some((i) => !l[i] || l[i].visibility < 0.5)) return null;
  const span = Math.hypot(l[11].x - l[12].x, l[11].y - l[12].y);
  const lift =
    0.1 *
    Math.hypot(
      (l[11].x + l[12].x - l[23].x - l[24].x) / 2,
      (l[11].y + l[12].y - l[23].y - l[24].y) / 2,
    );
  const quad = [
    [l[11].x, l[11].y - lift],
    [l[12].x, l[12].y - lift],
    [l[24].x, l[24].y],
    [l[23].x, l[23].y],
  ];
  const inQuad = (x: number, y: number) => {
    let c = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const [xi, yi] = quad[i],
        [xj, yj] = quad[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const segs: [number, number, number, number][] = [];
  for (const [a, b] of [
    [11, 13],
    [13, 15],
    [12, 14],
    [14, 16],
  ])
    if (l[a].visibility >= 0.5 && l[b].visibility >= 0.5)
      segs.push([l[a].x, l[a].y, l[b].x, l[b].y]);
  const r = 0.2 * span;
  const inArm = (x: number, y: number) =>
    segs.some(([ax, ay, bx, by]) => {
      const dx = bx - ax,
        dy = by - ay;
      const h = Math.max(
        0,
        Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)),
      );
      return Math.hypot(x - ax - dx * h, y - ay - dy * h) <= r;
    });
  const { width, height } = jacket;
  const sx = person.width / width,
    sy = person.height / height;
  let region = 0,
    covered = 0;
  for (let y = 0; y < height; y += 2)
    for (let x = 0; x < width; x += 2) {
      const pv =
        person.data[
          Math.min(person.height - 1, Math.floor(y * sy)) * person.width +
            Math.min(person.width - 1, Math.floor(x * sx))
        ];
      if (pv < 0.5 || !(inQuad(x, y) || inArm(x, y))) continue;
      region++;
      if (jacket.data[y * width + x] > 64) covered++;
    }
  return region ? { covered: covered / region, regionPx: region * 4 } : null;
}

/** Ours (red) and real (green) silhouettes only, no photo pixels: a local debug sheet. */
function maskSheet(ours: Mask, real: Mask) {
  const canvas = document.createElement('canvas');
  canvas.width = ours.width;
  canvas.height = ours.height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(ours.width, ours.height);
  for (let i = 0; i < ours.data.length; i++) {
    image.data[i * 4] = ours.data[i] ? 230 : 0;
    image.data[i * 4 + 1] = real.data[i] ? 200 : 0;
    image.data[i * 4 + 2] = 0;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

/**
 * Evaluates the frame at `t`: alignment of the drawn pose, and the drawn jacket's silhouette
 * against the real jacket's (signed offsets in px and cm; cm via the body's px per metre at its
 * solved depth). Numbers only, plus an optional mask-only sheet for local inspection.
 */
export async function evaluateAt(
  engine: LiveTryOnEngine,
  ar: ArCompositor,
  t: number,
  options: { settleMs?: number; sheet?: boolean } = {},
) {
  await seekAndSettle(engine, ar, t, options.settleMs ?? 1000);
  const frame = engine.lastFrame;
  const scene = engine.posedScene;
  const s = ar.tracker.last;
  const video = engine.currentSource?.video;
  const base = { t, phase: engine.currentState.phase, posed: !!frame?.pose };
  if (!frame?.landmarks2d || !scene || !s || !video) return { ...base, tracked: false as const };
  const pxPerM = s.intrinsics.f / s.pose.t[2];
  // Framing facts (no coordinates): which arm landmarks are outside the frame or barely visible,
  // and the tracker's confidence in the arm DOFs (what V1's pose gate reads).
  const names: [string, number][] = [
    ['lElbow', 13],
    ['rElbow', 14],
    ['lWrist', 15],
    ['rWrist', 16],
  ];
  const framing = {
    outOfFrame: names
      .filter(([, i]) => {
        const p = frame.landmarks2d![i];
        return p.x < 0 || p.y < 0 || p.x > frame.width || p.y > frame.height;
      })
      .map(([n]) => n),
    lowVisibility: names.filter(([, i]) => frame.landmarks2d![i].visibility < 0.5).map(([n]) => n),
    confidence: Object.fromEntries(
      ['shoulder_L_elevation', 'shoulder_R_elevation', 'elbow_L_flexion', 'elbow_R_flexion'].map(
        (k) => [k, frame.confidence[k] ?? null],
      ),
    ),
  };
  const result = {
    ...base,
    tracked: true as const,
    alignment: s.alignment,
    framing,
    kioskLook: ar.kioskLook,
    yawDeg: (s.pose.yaw * 180) / Math.PI,
    depthM: s.pose.t[2],
    pxPerM,
    focalPx: s.intrinsics.f,
    focalSource: s.focal.source,
    silhouette: null as null | {
      px: SilhouetteOffsets;
      cm: SilhouetteOffsets;
      iou: number | null;
      realPixels: number;
      oursPixels: number;
    },
    silhouetteError: null as string | null,
    /** The same offsets for the DISPLAYED overlay (the glued layers), when the glue is on. */
    silhouetteGlued: null as null | {
      px: SilhouetteOffsets;
      cm: SilhouetteOffsets;
      iou: number | null;
    },
    coverage: null as ReturnType<typeof torsoCoverage>,
    glueCoverage: null as ReturnType<typeof glueCoverage>,
    sheet: null as string | null,
  };
  const ours = ar.jacketMask(scene);
  if (!ours) return { ...result, silhouetteError: 'no overlay mask' };
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0, frame.width, frame.height);
  const pixels = ctx.getImageData(0, 0, frame.width, frame.height);
  const colour = chestColour(pixels, frame.landmarks2d);
  if (!frame.mask) return { ...result, silhouetteError: 'no person mask on the frame' };
  result.coverage = torsoCoverage(ours, frame.mask, frame.landmarks2d);
  const g = ar.glueRenderer;
  if (ar.glue && g && ar.renderer) {
    const warped = g.readMask(ar.renderer);
    result.glueCoverage = glueCoverage(warped, frame.mask, frame.landmarks2d);
  }
  if (!colour) return { ...result, silhouetteError: 'chest not visible (no colour sample)' };
  const real = realJacketMask(pixels, frame.mask, colour);
  const px = silhouetteOffsets(ours, real, frame.landmarks2d);
  const cm = Object.fromEntries(
    Object.entries(px).map(([k, v]) => [k, v === null ? null : (v / pxPerM) * 100]),
  ) as SilhouetteOffsets;
  let realPixels = 0,
    oursPixels = 0;
  for (let i = 0; i < real.data.length; i++) {
    if (real.data[i]) realPixels++;
    if (ours.data[i]) oursPixels++;
  }
  result.silhouette = { px, cm, iou: iou(ours, real), realPixels, oursPixels };
  const glued = ar.glueMask();
  if (glued && glued.width === real.width && glued.height === real.height) {
    const gpx = silhouetteOffsets(glued, real, frame.landmarks2d);
    const gcm = Object.fromEntries(
      Object.entries(gpx).map(([k, v]) => [k, v === null ? null : (v / pxPerM) * 100]),
    ) as SilhouetteOffsets;
    result.silhouetteGlued = { px: gpx, cm: gcm, iou: iou(glued, real) };
  }
  if (options.sheet) result.sheet = maskSheet(ours, real);
  return result;
}

/**
 * Overlay steadiness on a stretch where the person stands still: plays [t0, t1] in real time and
 * records, per drawn frame, the projected shoulders and hips of the DRAWN pose (and the raw
 * landmarks). Jitter = RMS distance of each track from its own centred 0.5 s moving average (the
 * slow sway of a real person is kept; frame-to-frame swimming is what remains). Numbers only.
 */
export async function stillness(engine: LiveTryOnEngine, ar: ArCompositor, t0: number, t1: number) {
  const video = engine.currentSource?.video;
  if (!video) throw new Error('No video source');
  await seekAndSettle(engine, ar, t0, 600);
  const joints = ['lShoulder', 'rShoulder', 'lHip', 'rHip'] as const;
  const index = { lShoulder: 11, rShoulder: 12, lHip: 23, rHip: 24 } as const;
  const drawn: Record<string, [number, number][]> = {},
    raw: Record<string, [number, number][]> = {};
  const times: number[] = [];
  const yaws: number[] = [],
    rawYaws: number[] = [],
    mpYaws: number[] = [],
    widthRatios: number[] = [],
    drawnDepth: number[] = [],
    collarMargins: number[] = [],
    chinBefore: number[] = [],
    chinAfter: number[] = [],
    faceOffset: number[] = [],
    faceOffsetFlexed: number[] = [],
    headFlexDeg: number[] = [],
    headPersonDeg: number[] = [],
    headRigDeg: number[] = [],
    contourBefore: number[] = [],
    contourAfter: number[] = [],
    contourMs: number[] = [],
    shoulderErr: number[] = [],
    armBefore: number[] = [],
    armAfter: number[] = [],
    jointAfter: Record<string, number[]> = { lElbow: [], rElbow: [], lWrist: [], rWrist: [] },
    misses = { elbow: 0, wrist: 0, arms: 0 },
    glueTrack: Record<string, [number, number][]> = {
      lShoulder: [],
      rShoulder: [],
      lHip: [],
      rHip: [],
    },
    glueErr: number[] = [],
    glueJoint: Record<string, number[]> = {},
    lagTrack: { t: number; raw: number[]; sm: number[] }[] = [],
    dofTrack: Record<string, number>[] = [],
    coverage: number[] = [],
    rawDepth: number[] = [],
    rects = new Set<string>(),
    scores: number[] = [],
    pitches: number[] = [],
    rolls: number[] = [],
    lockFrames: number[] = [],
    controlSteps: number[] = [];
  let lastControls: Record<string, [number, number]> | null = null;
  let sampled = 0;
  for (const j of joints) {
    drawn[j] = [];
    raw[j] = [];
  }
  let last: unknown = null;
  await video.play();
  await new Promise<void>((resolve) => {
    const tick = () => {
      if (video.currentTime >= t1 || video.paused) return resolve();
      const s = ar.tracker.last;
      const frame = engine.lastFrame;
      const scene = engine.posedScene;
      if (s && frame?.landmarks2d && scene && s !== last) {
        last = s;
        const pts = ar.projectPoints(
          ar.jointsOf(scene) as Record<string, [number, number, number]>,
        );
        if (joints.every((j) => pts[j] && frame.landmarks2d![index[j]].visibility >= 0.5)) {
          times.push(frame.t);
          // The DRAWN solution (what is on screen: held by the stillness lock while still).
          const ds = ar.drawnSolution ?? s;
          yaws.push((ds.pose.yaw * 180) / Math.PI);
          pitches.push((ds.pose.pitch * 180) / Math.PI);
          rolls.push((ds.pose.roll * 180) / Math.PI);
          rawYaws.push((s.raw.yaw * 180) / Math.PI);
          drawnDepth.push(ds.pose.t[2]);
          lockFrames.push(ar.stillness.state.engaged ? 1 : 0);
          const g = ar.glueRenderer;
          const applied = (
            engine.posedScene as unknown as { last?: { pose?: Record<string, number> } }
          )?.last?.pose;
          if (applied) dofTrack.push({ ...applied });
          const sm = ar.glueLandmarks;
          if (sm) {
            const ids = [13, 14, 15, 16];
            lagTrack.push({
              t: frame.t,
              raw: ids.flatMap((i) => [frame.landmarks2d![i].x, frame.landmarks2d![i].y]),
              sm: ids.flatMap((i) => [sm[i].x, sm[i].y]),
            });
          }
          if (ar.glue && g) {
            for (const k of Object.keys(glueTrack))
              if (g.warped[k]) glueTrack[k].push(g.warped[k].at);
            // Every named glue control (torso layer: shoulders, hips, contour rows), per frame.
            const now: Record<string, [number, number]> = {};
            for (const [k, v] of Object.entries(g.warped)) now[k] = v.at;
            if (lastControls) {
              const steps: number[] = [];
              for (const [k, p] of Object.entries(now)) {
                const q = lastControls[k];
                if (q) steps.push(Math.hypot(p[0] - q[0], p[1] - q[1]));
              }
              if (steps.length) controlSteps.push(steps.reduce((a, b) => a + b, 0) / steps.length);
            }
            lastControls = now;
            const residual = ar.debugState().glue?.residualPx ?? {};
            for (const [k, v] of Object.entries(residual)) {
              glueErr.push(v);
              (glueJoint[k] ??= []).push(v);
            }
            // Coverage of the upper-body clothing, sampled every 10th drawn frame (GPU readback).
            if (sampled++ % 10 === 0 && frame.mask && ar.renderer) {
              const c = glueCoverage(g.readMask(ar.renderer), frame.mask, frame.landmarks2d!);
              if (c) coverage.push(c.covered);
            }
          }
          if (ar.collar.marginPx !== null) collarMargins.push(ar.collar.marginPx);
          if (ar.collar.chinBeforeCm !== null) chinBefore.push(ar.collar.chinBeforeCm);
          if (ar.collar.chinAfterCm !== null) chinAfter.push(ar.collar.chinAfterCm);
          // Registration at the face: the drawn rig's eyes vs the real eyes, vertical, cm (eye
          // spacing 6.3 cm); + = the rig's face is drawn BELOW the person's (pre-glue solve).
          const le = frame.landmarks2d[2],
            re = frame.landmarks2d[5];
          if (pts.lEye && pts.rEye && Math.min(le.visibility, re.visibility) >= 0.5) {
            const spacing = Math.hypot(le.x - re.x, le.y - re.y);
            if (spacing > 4) {
              faceOffset.push(
                (((pts.lEye[1] + pts.rEye[1]) / 2 - (le.y + re.y) / 2) * 6.3) / spacing,
              );
              // The same with the rig's eyes tipped by the measured head flexion (option B1).
              const flexed = ar.projectPoints(
                ar.flexEyes(ar.jointsOf(scene)) as Record<string, [number, number, number]>,
              );
              if (flexed.lEye && flexed.rEye)
                faceOffsetFlexed.push(
                  (((flexed.lEye[1] + flexed.rEye[1]) / 2 - (le.y + re.y) / 2) * 6.3) / spacing,
                );
            }
          }
          {
            const hf = ar.headFlexion;
            headFlexDeg.push(hf.deg);
            if (hf.personDeg !== null) headPersonDeg.push(hf.personDeg);
            if (hf.rigDeg !== null) headRigDeg.push(hf.rigDeg);
          }
          if (ar.glueGroups.contour && ar.contour.beforePx !== null) {
            contourBefore.push(ar.contour.beforePx);
            if (ar.contour.afterPx !== null) contourAfter.push(ar.contour.afterPx);
            contourMs.push(ar.contour.ms);
          }
          const pj = s.alignment?.perJoint;
          if (pj?.lShoulder && pj.rShoulder)
            shoulderErr.push((pj.lShoulder.errorPx + pj.rShoulder.errorPx) / 2);
          const fit = ar.screenFit.last;
          if (fit?.beforePx != null && fit.afterPx != null) {
            armBefore.push(fit.beforePx);
            armAfter.push(fit.afterPx);
            for (const [k, v] of Object.entries(fit.afterJointPx)) jointAfter[k]?.push(v);
            for (const r of Object.values(fit.reach)) {
              if (!r) continue;
              misses.arms++;
              if (!r.elbow) misses.elbow++;
              if (r.wrist === false) misses.wrist++;
            }
          }
          rawDepth.push(s.raw.t[2]);
          const d = ar.display;
          if (d) rects.add(`${d.left},${d.top},${d.width},${d.height}`);
          const mp = yawFromWorld(frame.world);
          mpYaws.push(mp === null ? NaN : (mp * 180) / Math.PI);
          const l = frame.landmarks2d;
          widthRatios.push(
            s.alignment
              ? Math.hypot(l[11].x - l[12].x, l[11].y - l[12].y) / s.alignment.shoulderWidthPx
              : NaN,
          );
          if (s.alignment) scores.push(s.alignment.score);
          for (const j of joints) {
            drawn[j].push(pts[j]);
            const l = frame.landmarks2d![index[j]];
            raw[j].push([l.x, l.y]);
          }
        }
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
  video.pause();
  const jitter = (track: [number, number][]) => {
    const half = Math.max(
      1,
      Math.round(times.length / Math.max(1e-3, (times.at(-1)! - times[0]) / 1000) / 4),
    );
    let sum = 0,
      n = 0;
    for (let i = half; i < track.length - half; i++) {
      let mx = 0,
        my = 0;
      for (let k = i - half; k <= i + half; k++) {
        mx += track[k][0];
        my += track[k][1];
      }
      mx /= 2 * half + 1;
      my /= 2 * half + 1;
      sum += (track[i][0] - mx) ** 2 + (track[i][1] - my) ** 2;
      n++;
    }
    return n ? Math.sqrt(sum / n) : null;
  };
  const stats = (v: number[]) => {
    if (!v.length) return null;
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
    return { mean, sd, min: Math.min(...v), max: Math.max(...v) };
  };
  const step = (track: [number, number][]) => {
    const d: number[] = [];
    for (let i = 1; i < track.length; i++)
      d.push(Math.hypot(track[i][0] - track[i - 1][0], track[i][1] - track[i - 1][1]));
    d.sort((a, b) => a - b);
    return d.length
      ? { median: d[d.length >> 1], mean: d.reduce((a, b) => a + b, 0) / d.length }
      : null;
  };
  const rmsAbout = (v: number[]) => {
    if (v.length < 2) return null;
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
  };
  const pctls = (v: number[]) => {
    if (!v.length) return null;
    const s2 = v.slice().sort((a, b) => a - b);
    return { median: s2[s2.length >> 1], p95: s2[Math.floor(s2.length * 0.95)] };
  };
  /** Frame-to-frame size change of the drawn jacket (∝ 1/depth), % : median, p95, max. */
  const sizeSteps = (z: number[]) => {
    const d: number[] = [];
    for (let i = 1; i < z.length; i++) d.push((Math.abs(z[i] - z[i - 1]) / z[i]) * 100);
    d.sort((a, b) => a - b);
    return d.length
      ? { median: d[d.length >> 1], p95: d[Math.floor(d.length * 0.95)], max: d[d.length - 1] }
      : null;
  };
  const s = ar.tracker.last;
  return {
    t0,
    t1,
    sizeStepPct: sizeSteps(drawnDepth),
    /** Drawn rotation noise: RMS about the window mean, degrees. */
    rotationRmsDeg: {
      yaw: rmsAbout(yaws),
      pitch: rmsAbout(pitches),
      roll: rmsAbout(rolls),
    },
    /** Mean motion of all the torso glue's control points, px per drawn frame: median, p95. */
    controlMotionPx: pctls(controlSteps),
    /** Stillness lock: share of frames held. */
    stillness: {
      on: ar.stillnessOn,
      heldFraction: lockFrames.length
        ? lockFrames.reduce((a, b) => a + b, 0) / lockFrames.length
        : null,
      lastRelease: ar.stillness.state.lastRelease,
      noiseRmsPx: ar.stillness.noiseRmsPx().map((v) => Math.round(v * 100) / 100),
    },
    /**
     * Lag of the glue's smoothed elbow/wrist targets behind the raw landmarks (ms), on moving
     * frames only (raw speed > 100 px/s): the shift that best aligns the two tracks.
     */
    armTargetLagMs: armLag(lagTrack),
    /** Per-frame change of the APPLIED arm DOFs (V1's flip metric), degrees: p50 / p90. */
    armDofStepDeg: Object.fromEntries(
      ['shoulder_L_elevation', 'shoulder_R_elevation', 'elbow_L_flexion', 'elbow_R_flexion'].map(
        (k) => {
          const d: number[] = [];
          for (let i = 1; i < dofTrack.length; i++) {
            const a = dofTrack[i - 1][k],
              b = dofTrack[i][k];
            if (Number.isFinite(a) && Number.isFinite(b)) d.push(Math.abs(b - a));
          }
          d.sort((x, y) => x - y);
          return [
            k,
            d.length ? { p50: d[d.length >> 1], p90: d[Math.floor(d.length * 0.9)] } : null,
          ];
        },
      ),
    ),
    collarMarginPx: stats(collarMargins),
    collarTriggered: ar.collar.triggered,
    collarTarget: ar.collar.target,
    collarVsTargetCm: { before: stats(chinBefore), after: stats(chinAfter) },
    collarTargetOffsetM: ar.collar.targetOffsetM,
    faceOffsetCm: stats(faceOffset),
    faceOffsetFlexedCm: stats(faceOffsetFlexed),
    headFlexion: {
      deg: stats(headFlexDeg),
      personDeg: stats(headPersonDeg),
      rigDeg: stats(headRigDeg),
      on: ar.headFlexionOn,
    },
    contourPx: { before: stats(contourBefore), after: stats(contourAfter), ms: stats(contourMs) },
    shoulderMarkBlend: ar.shoulderMarkBlend,
    shoulderErrorPx: stats(shoulderErr),
    armErrorPx: { before: stats(armBefore), after: stats(armAfter) },
    armJointAfterPx: Object.fromEntries(Object.entries(jointAfter).map(([k, v]) => [k, stats(v)])),
    armRayMisses: misses,
    glue: ar.glue
      ? {
          outlineStepPx: Object.fromEntries(
            Object.entries(glueTrack).map(([k, v]) => [k, step(v)]),
          ),
          keypointResidualPx: stats(glueErr),
          perKeypointPx: Object.fromEntries(
            Object.entries(glueJoint).map(([k, v]) => {
              const sorted = v.slice().sort((a, b) => a - b);
              return [
                k,
                { p50: sorted[sorted.length >> 1], p95: sorted[Math.floor(sorted.length * 0.95)] },
              ];
            }),
          ),
          layered: ar.layeredLast,
          coverage: stats(coverage),
          warpMs: ar.glueRenderer?.stats.warpMs ?? null,
          capBound: ar.glueRenderer?.stats.capBound ?? null,
          frames: ar.glueRenderer?.stats.frames ?? null,
        }
      : null,
    rawSizeStepPct: sizeSteps(rawDepth),
    videoRects: rects.size,
    yawDeg: stats(yaws),
    /** Per-frame traces (diagnostics, local runs): raw solve yaw, MediaPipe-depth yaw, 2D/3D shoulder width. */
    traces: {
      rawYaw: rawYaws,
      mpYaw: mpYaws,
      widthRatio: widthRatios,
      drawnYaw: yaws,
      held: lockFrames,
    },
    rawYawDeg: stats(rawYaws),
    alignmentScore: stats(scores),
    drawnStepPx: Object.fromEntries(joints.map((j) => [j, step(drawn[j])])),
    landmarkStepPx: Object.fromEntries(joints.map((j) => [j, step(raw[j])])),
    frames: times.length,
    seconds: times.length ? (times.at(-1)! - times[0]) / 1000 : 0,
    shoulderWidthPx: s?.alignment?.shoulderWidthPx ?? null,
    drawnJitterPx: Object.fromEntries(joints.map((j) => [j, jitter(drawn[j])])),
    landmarkJitterPx: Object.fromEntries(joints.map((j) => [j, jitter(raw[j])])),
  };
}

export function installArLabHooks(engine: LiveTryOnEngine, ar: ArCompositor) {
  const hooks = {
    engine,
    ar,
    state: () => engine.currentState,
    seek: (t: number, settleMs?: number) => seekAndSettle(engine, ar, t, settleMs),
    evaluateAt: (t: number, options?: { settleMs?: number; sheet?: boolean }) =>
      evaluateAt(engine, ar, t, options),
    stillness: (t0: number, t1: number) => stillness(engine, ar, t0, t1),
    /** Numbers of the frame on screen now. */
    sample: () => {
      const s = ar.tracker.last;
      const video = engine.currentSource?.video;
      return {
        t: video?.currentTime ?? null,
        status: ar.status,
        phase: engine.currentState.phase,
        alignment: s?.alignment ?? null,
        rawRmsPx: s?.rawRmsPx ?? null,
        depthM: s?.pose.t[2] ?? null,
        yawDeg: s ? (s.pose.yaw * 180) / Math.PI : null,
        focal: ar.tracker.focalEstimate ?? null,
        tilt: ar.tracker.cameraTiltDeg,
        stats: { ...ar.stats },
        engine: engine.stats(),
      };
    },
  };
  (window as unknown as { __arlab?: unknown }).__arlab = hooks;
  return () => {
    delete (window as unknown as { __arlab?: unknown }).__arlab;
  };
}
