// Browser-only sampler. Raw landmarks never leave the private in-memory/checkpoint path.
export const pageSampler = async ({
  every,
  maxSeconds,
  steps,
  restWindows = [],
  untilSeconds = null,
}) => {
  const { engine, ar } = window.__arlab;
  const video = engine.currentSource.video;
  // WebM MediaRecorder files may not have a duration until decoded. Stop on ended or deadline.
  const dur = Number.isFinite(video.duration) ? video.duration : null;
  const IDX = {
    lShoulder: 11,
    rShoulder: 12,
    lElbow: 13,
    rElbow: 14,
    lWrist: 15,
    rWrist: 16,
    lHip: 23,
    rHip: 24,
  };
  video.loop = false;
  video.pause();
  await new Promise((r) => {
    video.addEventListener('seeked', r, { once: true });
    video.currentTime = 0;
    if (video.currentTime === 0 && !video.seeking) r();
  });
  ar.tracker.resetSmoothing();
  const frames = [];
  const cameraFrames = new WeakMap();
  const offCameraProbe = engine.currentSource.onFrame((f) => {
    cameraFrames.set(f, video.__arCameraFrame ? { ...video.__arCameraFrame } : null);
  });
  const restState = new Map();
  let last = null;
  let n = 0;
  const t0 = performance.now();
  await video.play();
  const coverage = (jacket, person, l) => {
    const need = [11, 12, 23, 24];
    if (need.some((i) => !l[i] || l[i].visibility < 0.5)) return null;
    const span = Math.hypot(l[11].x - l[12].x, l[11].y - l[12].y);
    const lift =
      0.1 *
      Math.hypot(
        (l[11].x + l[12].x - l[23].x - l[24].x) / 2,
        (l[11].y + l[12].y - l[23].y - l[24].y) / 2,
      );
    const x0 = Math.min(l[11].x, l[12].x, l[23].x, l[24].x) - 0.25 * span;
    const x1 = Math.max(l[11].x, l[12].x, l[23].x, l[24].x) + 0.25 * span;
    const y0 = Math.min(l[11].y, l[12].y) - lift;
    const y1 = Math.max(l[23].y, l[24].y);
    const sx = person.width / jacket.width;
    const sy = person.height / jacket.height;
    let region = 0;
    let unc = 0;
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(jacket.height, y1); y += 2)
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(jacket.width, x1); x += 2) {
        const pv =
          person.data[
            Math.min(person.height - 1, Math.floor(y * sy)) * person.width +
              Math.min(person.width - 1, Math.floor(x * sx))
          ];
        if (pv < 0.5) continue;
        region++;
        if (jacket.data[y * jacket.width + x] <= 64) unc++;
      }
    return region > 200 ? (100 * unc) / region : null;
  };
  await new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        if (
          video.ended ||
          (untilSeconds !== null && video.currentTime >= untilSeconds) ||
          (performance.now() - t0) / 1000 >= maxSeconds ||
          (dur !== null && video.currentTime >= dur - 0.05)
        )
          return resolve();
        const s = ar.tracker.last;
        const frame = engine.lastFrame;
        const scene = engine.posedScene;
        if (frame && scene && frame !== last) {
          last = frame;
          n++;
          const l = frame.landmarks2d ?? [];
          const g = ar.glue ? ar.glueRenderer : null;
          const warped = g?.warped ?? {};
          const pts = ar.projectPoints(ar.jointsOf(scene));
          // Keypoint residual of the DRAWN jacket points: post-warp where the glue has them,
          // else the projected rig joints, against the raw (unsmoothed) landmarks.
          const res = [];
          for (const k of ['lShoulder', 'rShoulder', 'lElbow', 'rElbow', 'lWrist', 'rWrist']) {
            const p = warped[k]?.at ?? (g ? null : pts[k]);
            const lm = l[IDX[k]];
            if (p && lm?.visibility >= 0.5) res.push(Math.hypot(p[0] - lm.x, p[1] - lm.y));
          }
          const outline = {};
          for (const k of ['lShoulder', 'rShoulder', 'lHip', 'rHip']) {
            const p = warped[k]?.at ?? (g ? null : pts[k]);
            if (p) outline[k] = [p[0], p[1]];
          }
          const dbg = ar.debugState?.() ?? null;
          const fit = ar.screenFit?.last;
          const gs = g?.stats ?? null;
          const camera = cameraFrames.get(frame);
          const videoMs = camera?.mediaMs ?? video.currentTime * 1000;
          const restMeasurements = [];
          const relevant = restWindows.filter(
            (w) => videoMs >= w.startMs && videoMs < w.endMs + 10000,
          );
          const layers =
            relevant.length &&
            ar.status === 'drawn' &&
            dbg?.fade < 0.01 &&
            !dbg?.backView &&
            ar.useFinisher
              ? ar.finisher?.measureLayers?.(ar.renderer)
              : null;
          for (const w of relevant) {
            const state = restState.get(w.id) ?? {};
            const inRest = videoMs < w.endMs;
            const pair =
              layers && inRest && state.previous
                ? window.__arRestPair(state.previous, layers)
                : null;
            const fromRest =
              layers && !inRest && state.reference
                ? window.__arRestPair(state.reference, layers)
                : null;
            restMeasurements.push({
              id: w.id,
              pair: pair
                ? {
                    ...pair,
                    fromVideoMs: state.previousVideoMs,
                    cameraFrameDelta:
                      Number.isFinite(camera?.index) && Number.isFinite(state.cameraIndex)
                        ? camera.index - state.cameraIndex
                        : null,
                  }
                : null,
              fromRestOutlinePx: fromRest?.outlinePx ?? null,
            });
            if (inRest) {
              state.previous = layers;
              state.cameraIndex = camera?.index;
              state.previousVideoMs = videoMs;
              if (layers) state.reference = layers;
            }
            restState.set(w.id, state);
          }
          let uncoveredPct = null;
          let frontalUncoveredPct = null;
          if (g && ar.renderer && frame.mask && n % every === 0) {
            // F5 2026-11-14 (F3 note): V5 counts the DISPLAYED jacket = torso + sleeve layers
            // (ArCompositor.glueMask), not the torso layer alone; arms under sleeves are covered.
            const jm = ar.glueMask?.() ?? g.readMask(ar.renderer);
            uncoveredPct = coverage(jm, frame.mask, l);
            if (
              ar.useFinisher &&
              ar.finisher?.measureCoverage &&
              Math.abs(dbg?.yawDrawnDeg ?? 999) <= 20 &&
              !dbg?.backView &&
              dbg?.fade < 0.01
            ) {
              // V4 10225ec adds an independent clothing reference. The default 'region'
              // mode clips its reference to the fill region and cannot certify missed clothes.
              const c = ar.finisher.measureCoverage(ar.renderer, false, 'independent');
              if (c?.classes) frontalUncoveredPct = 100 * c.uncoveredAfter;
            }
          }
          const drawnPoints = {};
          const controlMaps = [
            g?.warped,
            ar.sleeveGlue?.sleeveL?.warped,
            ar.sleeveGlue?.sleeveR?.warped,
          ].filter(Boolean);
          for (const [name] of Object.entries(IDX)) {
            const mapped = controlMaps.map((m) => m[name]?.at).find(Boolean);
            const q = mapped ?? (g ? null : pts[name]);
            if (q) drawnPoints[name] = [q[0], q[1]];
          }
          frames.push({
            t: frame.t,
            videoMs,
            cameraFrameIndex: camera?.index ?? null,
            yawRaw: s ? (s.raw.yaw * 180) / Math.PI : null,
            yawDrawn: s ? (s.pose.yaw * 180) / Math.PI : null,
            depthDrawn: (ar.drawnSolution ?? s)?.pose.t[2] ?? null,
            drawnRotationDeg:
              ar.status === 'drawn' && ar.drawnSolution
                ? ['yaw', 'pitch', 'roll'].map((k) => (ar.drawnSolution.pose[k] * 180) / Math.PI)
                : null,
            restMeasurements,
            drawnPoints,
            status: ar.status,
            fade: dbg?.fade ?? 0,
            backView: !!dbg?.backView,
            expectedBack: steps.some(
              (p) =>
                p.expectedBack &&
                video.currentTime * 1000 >= p.startMs &&
                video.currentTime * 1000 < p.endMs,
            ),
            alignRmsPx: s?.alignment?.rmsPx ?? null,
            collarFired: !!ar.collar?.fired,
            armBeforePx: fit?.beforePx ?? null,
            armAfterPx: fit?.afterPx ?? null,
            glueResidualPx: (() => {
              const r = dbg?.glue?.residualPx;
              if (!r) return null;
              const v = ['lShoulder', 'rShoulder', 'lElbow', 'rElbow', 'lWrist', 'rWrist']
                .map((k) => r[k])
                .filter(Number.isFinite);
              return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
            })(),
            glueCapBound: gs?.capBound ?? null,
            glueFrames: gs?.frames ?? null,
            totalMs: engine.stats().totalMs ?? null,
            // F5: the AR path (camera callback -> AR frame on screen, no mirror, no double count);
            // totalMs is the MIRROR path and is stale/inflated when mirrorSkip hides the mirror.
            arTotalMs: engine.stats().arTotalMs ?? null,
            keypointResidualPx: res.length ? res.reduce((a, b) => a + b, 0) / res.length : null,
            uncoveredPct,
            frontalUncoveredPct,
            finisherMainThreadMs:
              ar.useFinisher && ar.finisher?.stats.frames > 0 ? ar.finisher.stats.applyMs : null,
            arFps: Number.isFinite(ar.stats.fps) ? ar.stats.fps : null,
            outline,
            lm: l.length ? l.map((p) => ({ x: p.x, y: p.y, visibility: p.visibility })) : null,
          });
          if (n % 30 === 0)
            await window.__arScoreCheckpoint(frames, (performance.now() - t0) / 1000);
        }
        requestAnimationFrame(tick);
      } catch (error) {
        reject(error);
      }
    };
    tick();
  });
  const wallSeconds = (performance.now() - t0) / 1000;
  video.pause();
  offCameraProbe();
  return {
    frames,
    wallSeconds,
    duration: dur,
    // F5 --until: a judge window run is complete when it reached its window end.
    completed:
      video.ended ||
      (dur !== null && video.currentTime >= dur - 0.1) ||
      (untilSeconds !== null && video.currentTime >= untilSeconds),
    untilSeconds,
    engineStats: engine.stats(),
    arStats: { ...ar.stats },
    hasGlue: !!ar.glue && !!ar.glueRenderer,
  };
};
