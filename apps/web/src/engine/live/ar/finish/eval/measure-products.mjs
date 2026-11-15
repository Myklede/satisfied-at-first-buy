// Measurement only: temporary existing hood and mouth-guard states, restored in finally.
// Caller owns leases and checks git-ignore for every output image before writing its data URL.
export async function setMeasuredHood(page, detached) {
  return page.evaluate(async (detached) => {
    const ar = window.__arlab.ar;
    const hood = ar.kiosk?.layer.hood;
    if (!ar.kioskLook || !hood)
      throw Error('Padded kiosk hood is not ready; no hide-mesh fallback');
    if (!hood.info.removable) throw Error('This product hood cannot be detached');
    const Vector3 = hood.position.constructor;
    if (detached) {
      hood.setState('detached', 1);
      // Existing restingTransform places the detached hood beside the feet, outside the torso.
      hood.setRigidTransform(hood.restingTransform(new Vector3(0.8, 0, 0)));
    } else {
      hood.setState('down', 1);
      hood.setRigidTransform(null);
    }
    return {
      detachProgress: hood.detachProgress,
      kioskLook: ar.kioskLook,
      assetKey: ar.kiosk.shownAsset?.key ?? null,
    };
  }, detached);
}

export async function measureCollarWindow(page, { t0, t1, guard }) {
  return page.evaluate(
    async ({ t0, t1, guard }) => {
      const h = window.__arlab,
        ar = h.ar,
        video = h.engine.currentSource.video;
      const { visibleCollarTop } = await import('/src/engine/live/ar/anchors.ts');
      const { COLLAR_HALF_WIDTH_M, COLLAR_TARGET_FROM_MOUTH, EYE_SPACING_M } = await import(
        '/src/engine/live/ar/config.ts'
      );
      const { torsoAlignmentScore } = await import('/src/engine/live/ar/ArTracker.ts');
      const original = ar.render,
        previousGuard = ar.collarGuard;
      const rows = [];
      ar.collarGuard = guard;
      ar.render = function (...args) {
        const out = original.apply(this, args);
        const t = video.currentTime,
          frame = h.engine.lastFrame,
          scene = h.engine.posedScene;
        if (t < t0 || t > t1 || ar.status !== 'drawn' || !frame?.landmarks2d || !scene) return out;
        if (rows.at(-1)?.t === t) return out;
        const l = frame.landmarks2d,
          asset = scene.jacketAsset;
        const p = scene.jacketPositions(),
          ms = scene.joints.midShoulder ?? scene.joints.lShoulder;
        const top = asset && p && ms ? visibleCollarTop(p, asset, ms, COLLAR_HALF_WIDTH_M) : null;
        const projected = top ? ar.projectPoints({ collar: top }).collar : null;
        const mouth = (l[9].y + l[10].y) / 2;
        const eyeSpan = Math.hypot(l[2].x - l[5].x, l[2].y - l[5].y);
        const cmPerPx = (EYE_SPACING_M * 100) / Math.max(1, eyeSpan);
        const target =
          mouth + COLLAR_TARGET_FROM_MOUTH[ar.collar.target] * Math.max(0, mouth - l[0].y);
        const final =
          projected && ar.glue && ar.glueRenderer ? ar.glueRenderer.mapPoint(projected) : projected;
        rows.push({
          t,
          target: ar.collar.target,
          torsoAlignment: torsoAlignmentScore(ar.tracker.last?.alignment),
          guardClamped: ar.collar.clamped,
          guardShiftCm: ar.collar.shiftPx * cmPerPx,
          grossOverMouthCm: ar.collar.marginPx === null ? null : -ar.collar.marginPx * cmPerPx,
          projectedCollarVsTargetCm: projected ? (projected[1] - target) * cmPerPx : null,
          gluedCollarVsTargetCm: final ? (final[1] - target) * cmPerPx : null,
          eyeSpacingScale: 'configured anatomical eye-spacing estimate; not a tape measurement',
        });
        return out;
      };
      try {
        video.pause();
        video.currentTime = Math.max(0, t0 - 1);
        await new Promise((r) => setTimeout(r, 400));
        await video.play();
        const deadline = performance.now() + 30000;
        while (video.currentTime < t1 && performance.now() < deadline)
          await new Promise((r) => setTimeout(r, 25));
        video.pause();
      } finally {
        ar.render = original;
        ar.collarGuard = previousGuard;
      }
      const stats = (key) => {
        const values = rows
          .map((r) => r[key])
          .filter((x) => x !== null && Number.isFinite(x))
          .sort((a, b) => a - b);
        return values.length
          ? {
              n: values.length,
              mean: values.reduce((a, b) => a + b, 0) / values.length,
              min: values[0],
              max: values.at(-1),
            }
          : null;
      };
      return {
        t0,
        t1,
        guard,
        frames: rows.length,
        collarVsTargetCm: stats('gluedCollarVsTargetCm'),
        guardShiftCm: stats('guardShiftCm'),
        torsoAlignment: stats('torsoAlignment'),
        rows,
      };
    },
    { t0, t1, guard },
  );
}
