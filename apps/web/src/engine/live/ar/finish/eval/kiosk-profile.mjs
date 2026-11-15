// TRY-F: the actual kiosk UI and camera/pose/render path, fed a local reference video's
// captureStream in place of hardware. Caller owns browser THEN heavy leases and server lifecycle.
// No evaluation renders, gl.finish or screenshots during timing. Production pixel reads count.
// The video stays in browser memory; only numeric aggregates and CPU call frames are returned.
export async function profileKiosk(
  page,
  {
    port,
    body,
    seconds = 12,
    cpu = false,
    modes: wantedModes = ['default', 'classes-off', 'finisher-off'],
    cameraSize = false,
  },
) {
  await page.goto(`http://127.0.0.1:${port}/?kiosk`);
  await page.locator('[data-screen="attract"]').waitFor({ timeout: 180000 });
  await page.evaluate(async (cameraSize) => {
    const { LiveTryOnEngine } = await import('/src/engine/live/LiveTryOnEngine.ts');
    const start = LiveTryOnEngine.prototype.start;
    LiveTryOnEngine.prototype.start = function (...args) {
      window.__tryfEngine = this;
      return start.apply(this, args);
    };
    // Native video capture avoids adding a canvas copy to the production frame budget.
    // Each getUserMedia gets fresh tracks: closing scan must not stop the later try-on camera.
    window.__tryfVideos = [];
    navigator.mediaDevices.getUserMedia = async () => {
      const v = document.createElement('video');
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.src = '/sandbox/ref?folder=FB7675-100-parka-trang&name=video%2Fcam-parka.mp4';
      await v.play();
      window.__tryfVideos.push(v);
      let stream;
      if (cameraSize) {
        const canvas = document.createElement('canvas');
        canvas.width = 960;
        canvas.height = 540;
        const ctx = canvas.getContext('2d', { alpha: false });
        const draw = () => {
          const t = performance.now();
          ctx.drawImage(v, 0, 0, 960, 540);
          if (window.__tryf?.active)
            (window.__tryf.timings['fixture.videoToCameraCanvas'] ??= []).push(
              performance.now() - t,
            );
          if (!v.paused) v.requestVideoFrameCallback(draw);
        };
        draw();
        stream = canvas.captureStream(30);
      } else stream = v.captureStream();
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          stop();
          if (stream.getTracks().every((t) => t.readyState === 'ended')) v.pause();
        };
      }
      return stream;
    };
  }, cameraSize);
  await page.locator('[data-screen="attract"]').click();
  await page.getByRole('button', { name: 'cm · kg', exact: true }).click();
  await page.getByLabel('Height centimetres').fill(String(body.h));
  await page.getByLabel('Weight kilograms').fill(String(body.w));
  await page.getByRole('button', { name: 'Male', exact: true }).click();
  await page.getByRole('button', { name: 'Continue →', exact: true }).click();
  await page.locator('[data-screen="scan"]').waitFor();
  await page
    .getByRole('button', { name: /Skip scan|Continue without scan/ })
    .first()
    .click();
  await page.locator('[data-screen="result"]').waitFor({ timeout: 180000 });
  await page.getByRole('button', { name: 'Try it on you', exact: true }).first().click();
  await page.waitForFunction(() => window.__tryfEngine?.arRenderer?.status === 'drawn', null, {
    timeout: 180000,
  });
  await page.waitForTimeout(5000);
  await page.evaluate(async () => {
    const h = window.__tryfEngine,
      ar = h.arRenderer;
    window.__tryf = { samples: [], active: false, violations: [], count: 0 };
    const s = window.__tryf;
    for (const name of ['measureLayers', 'measureCoverage']) {
      const f = ar.finisher;
      f[name] = () => {
        s.violations.push(name);
        throw Error(`Forbidden eval readback: ${name}`);
      };
    }
    const gl = ar.renderer.getContext();
    const finish = gl.finish.bind(gl),
      read = gl.readPixels.bind(gl);
    gl.finish = (...args) => {
      if (s.active) {
        s.violations.push('gl.finish');
        throw Error('Forbidden GPU stall');
      }
      return finish(...args);
    };
    gl.readPixels = (...args) => {
      // Count production reads rather than removing their cost. VideoProbe passes a PBO
      // offset; the compositor's legacy video match (finisher-off) uses a synchronous buffer.
      if (s.active && typeof args[6] !== 'number') s.productionSyncReads++;
      return read(...args);
    };
    const time = (object, name, label) => {
      if (typeof object?.[name] !== 'function') return;
      const original = object[name];
      object[name] = function (...args) {
        if (!s.active) return original.apply(this, args);
        const t = performance.now();
        try {
          return original.apply(this, args);
        } finally {
          (s.timings[label] ??= []).push(performance.now() - t);
        }
      };
    };
    time(ar, 'render', 'AR.render');
    time(ar, 'adjustPose', 'AR.adjustPose');
    time(ar.renderer, 'render', 'AR.WebGLRenderer.render');
    time(ar.finisher, 'apply', 'finisher.apply');
    for (const name of ['uploadPerson', 'updateClasses', 'updateMatch', 'setUniforms'])
      time(ar.finisher, name, `finisher.${name}`);
    time(h, 'onFrame', 'engine.onFrame');
    time(h.posedScene, 'applyPose', 'avatar.applyPose');
    time(h.mirrorView, 'update', 'mirror.update');
    time(h.mirrorView, 'render', 'mirror.render');
    time(h.mirrorView?.viewer?.composer, 'render', 'mirror.composer.render');
    // Count actual calls, not the rolling FPS estimate; include the drawn status separately.
    const render = ar.render;
    ar.render = function (...args) {
      const out = render.apply(this, args);
      if (s.active) {
        s.count++;
        if (ar.status === 'drawn') s.drawn++;
      }
      return out;
    };
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  const modes = [];
  // Fresh reload per invocation; A/B use the same real compositor and mirror without readbacks.
  for (const mode of wantedModes) {
    await page.evaluate((mode) => {
      const s = window.__tryf,
        ar = window.__tryfEngine.arRenderer;
      ar.useFinisher = mode !== 'finisher-off';
      ar.finisher.options.classes = mode !== 'classes-off';
      ar.finisher.bench = false;
      s.timings = {};
      s.count = 0;
      s.drawn = 0;
      s.productionSyncReads = 0;
    }, mode);
    await page.waitForTimeout(1500);
    if (cpu) await cdp.send('Profiler.start');
    await page.evaluate(() => {
      window.__tryf.active = true;
      window.__tryf.start = performance.now();
    });
    await page.waitForTimeout(seconds * 1000);
    const result = await page.evaluate(() => {
      const s = window.__tryf,
        h = window.__tryfEngine,
        ar = h.arRenderer;
      const elapsedS = (performance.now() - s.start) / 1000;
      s.active = false;
      const stats = (a) => {
        const v = a.slice().sort((a, b) => a - b);
        return {
          n: v.length,
          meanMs: v.reduce((a, b) => a + b, 0) / v.length,
          p95Ms: v[Math.min(v.length - 1, Math.floor(v.length * 0.95))],
          totalMs: v.reduce((a, b) => a + b, 0),
        };
      };
      return {
        elapsedS,
        renderCalls: s.count,
        drawn: s.drawn,
        renderFps: s.count / elapsedS,
        drawnFps: s.drawn / elapsedS,
        phase: h.currentState.phase,
        engine: h.stats(),
        ar: { ...ar.stats },
        finisher: { ...ar.finisher.stats },
        timings: Object.fromEntries(Object.entries(s.timings).map(([k, v]) => [k, stats(v)])),
        violations: [...s.violations],
        productionSyncReads: s.productionSyncReads,
        source: h.currentSource.cameraInfo(),
        background: window.__kiosk.motion(),
      };
    });
    if (cpu) {
      const { profile } = await cdp.send('Profiler.stop');
      const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
      const parents = new Map();
      for (const n of profile.nodes) for (const child of n.children ?? []) parents.set(child, n.id);
      const times = new Map();
      const readStacks = new Map();
      for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
        const n = nodes.get(profile.samples[i]);
        const f = n.callFrame;
        const key = `${f.functionName || '(anonymous)'} ${f.url.replace(/\?.*/, '')}:${f.lineNumber + 1}`;
        times.set(key, (times.get(key) ?? 0) + (profile.timeDeltas?.[i] ?? 0) / 1000);
        if (f.functionName === 'readPixels') {
          let id = n.id;
          const stack = [];
          for (let depth = 0; id !== undefined && depth < 40; depth++) {
            const frame = nodes.get(id)?.callFrame;
            if (!frame) break;
            stack.push(
              `${frame.functionName || '(anonymous)'} ${frame.url.replace(/\?.*/, '')}:${frame.lineNumber + 1}`,
            );
            id = parents.get(id);
          }
          const stackKey = stack.join('\n');
          readStacks.set(
            stackKey,
            (readStacks.get(stackKey) ?? 0) + (profile.timeDeltas?.[i] ?? 0) / 1000,
          );
        }
      }
      result.cpuSelfMs = [...times].sort((a, b) => b[1] - a[1]).slice(0, 35);
      result.readPixelsStacksMs = [...readStacks].sort((a, b) => b[1] - a[1]).slice(0, 5);
    }
    modes.push({ mode, ...result });
  }
  await cdp.detach();
  return {
    method:
      'Real kiosk UI, real cameraSource tracker and split mirror, local cam-parka ' +
      (cameraSize
        ? '960x540 in-memory canvas captureStream (fixture copy timed separately)'
        : 'native video captureStream') +
      ' replacing physical camera. Wall-clock render counts; no evaluation ' +
      'readbacks. Inclusive stage timers overlap; CPU profile self-times reported separately. ' +
      'Dev server (HMR disabled), not a production bundle. Hardware-camera decode/exposure may differ.',
    cpuProfile: cpu,
    fixtureCameraSize: cameraSize,
    modes,
  };
}
