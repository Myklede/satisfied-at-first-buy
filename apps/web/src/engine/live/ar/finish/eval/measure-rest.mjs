import { installRestProbe } from '../../../../../../../../scripts/ar-eval-rest.mjs';

/** Browser/heavy leases, server and privacy-checked output paths belong to the caller. */
export async function openFinishLab(page, { port, body, clip = 'cam-parka' }) {
  const puffer = clip === 'puffer';
  const folder = puffer ? 'DQ4920-206-puffer-kem' : 'FB7675-100-parka-trang';
  const filename = puffer ? 'video-puffer' : clip;
  const ref = encodeURIComponent(`${folder}|video/${filename}.mp4`);
  await page.goto(
    `http://127.0.0.1:${port}/?arlab&jacket=${puffer ? 'puffer' : 'parka'}` +
      `&size=S&h=${body.h}&w=${body.w}&sex=${body.sex ?? 'male'}&ref=${ref}&t=0.2&nomirror&finish=1`,
  );
  await page.waitForFunction(() => window.__arlab, null, { timeout: 60000 });
  await page.getByRole('button', { name: /^(Start|Restart)$/ }).click();
  await page.waitForFunction(
    () =>
      window.__arlab?.ar.status === 'drawn' &&
      window.__arlab?.engine.currentState.phase === 'tracking',
    null,
    { timeout: 180000 },
  );
  await page.waitForTimeout(2500);
}

/** Uses CX-DAY's calibrated contour ruler, with actual presented-camera frame deltas. */
export async function measureFinisherRest(page, { t0, t1, stabilize, captureFrames = 0 }) {
  await page.evaluate(installRestProbe);
  return page.evaluate(
    async ({ t0, t1, stabilize, captureFrames }) => {
      const h = window.__arlab,
        ar = h.ar,
        f = ar.finisher;
      const video = h.engine.currentSource.video;
      if (!f || !video) throw Error('Finisher/video not ready');
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const original = ar.render;
      const previousOption = f.options.stabilize;
      const rows = [];
      const images = [];
      let previous = null;
      f.options.stabilize = stabilize;
      const channel = (m, c) => {
        const alphas = new Uint8Array(m.alphas.length);
        for (let i = 0; i < alphas.length; i += 4) alphas[i + 2] = m.alphas[i + c];
        return { ...m, alphas };
      };
      ar.render = function (...args) {
        const out = original.apply(this, args);
        const t = video.currentTime;
        if (t < t0 || t > t1 || ar.status !== 'drawn') return out;
        const index = video.__arCameraFrame?.index;
        if (previous && index !== undefined && previous.index === index) return out;
        const layers = f.measureLayers(ar.renderer);
        if (!layers) return out;
        const gap =
          Number.isFinite(index) && Number.isFinite(previous?.index)
            ? index - previous.index
            : null;
        const row = {
          t,
          cameraFrame: index ?? null,
          cameraGap: gap,
          still: f.still,
          sharedDecisionPresent: f.sharedStill !== null,
          grade: { exposure: f.match.exposure, gain: [...f.match.gain], lift: f.match.lift },
          edges: null,
        };
        if (previous) {
          row.edges = ['warped', 'fill', 'final'].map((name, c) => {
            const pair = window.__arRestPair(channel(previous.layers, c), channel(layers, c));
            return {
              name,
              edgeCount: pair?.edgeCount ?? 0,
              pxPerObservation: pair?.outlinePx ?? null,
              pxPerCameraFrame: gap > 0 && pair?.outlinePx != null ? pair.outlinePx / gap : null,
            };
          });
        }
        rows.push(row);
        if (images.length < captureFrames)
          images.push({ t, image: ar.renderer.domElement.toDataURL('image/png') });
        previous = { index, layers };
        return out;
      };
      try {
        video.pause();
        video.currentTime = Math.max(0, t0 - 1);
        await wait(300);
        await video.play();
        const deadline = performance.now() + 30000;
        while (video.currentTime < t1 && performance.now() < deadline) await wait(25);
        video.pause();
      } finally {
        ar.render = original;
        f.options.stabilize = previousOption;
      }
      const stat = (values) => {
        const a = values.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
        return a.length
          ? {
              n: a.length,
              mean: a.reduce((a, b) => a + b, 0) / a.length,
              p95: a[Math.min(a.length - 1, Math.floor(a.length * 0.95))],
              max: a.at(-1),
            }
          : null;
      };
      const drift = { exposure: 0, gain: 0, lift: 0 };
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1].grade,
          b = rows[i].grade;
        drift.exposure += Math.abs(b.exposure - a.exposure) / Math.max(1e-6, b.exposure);
        drift.gain += Math.max(
          ...b.gain.map((v, k) => Math.abs(v - a.gain[k]) / Math.max(1e-6, v)),
        );
        drift.lift += Math.abs(b.lift - a.lift);
      }
      const sourceSeconds = rows.length > 1 ? rows.at(-1).t - rows[0].t : 0;
      return {
        t0,
        t1,
        stabilize,
        frames: rows.length,
        sourceSeconds,
        sharedDecisionPresent: rows.some((r) => r.sharedDecisionPresent),
        stillFraction: rows.length ? rows.filter((r) => r.still === 1).length / rows.length : null,
        gradeDriftPctPerSourceS:
          sourceSeconds > 0
            ? Object.fromEntries(
                Object.entries(drift).map(([k, v]) => [k, (100 * v) / sourceSeconds]),
              )
            : null,
        edges: Object.fromEntries(
          ['warped', 'fill', 'final'].map((name) => [
            name,
            {
              pxPerObservation: stat(
                rows.map((r) => r.edges?.find((e) => e.name === name)?.pxPerObservation ?? null),
              ),
              pxPerCameraFrame: stat(
                rows.map((r) => r.edges?.find((e) => e.name === name)?.pxPerCameraFrame ?? null),
              ),
            },
          ]),
        ),
        rows,
        images,
        method:
          'CX-DAY centroid-polar contour, source pixels. Measurements use GPU readbacks ' +
          'and do not estimate production FPS. Camera-frame units use actual presentedFrames; ' +
          'unknown camera frames return N/A. Warped input and final output reported separately.',
      };
    },
    { t0, t1, stabilize, captureFrames },
  );
}
