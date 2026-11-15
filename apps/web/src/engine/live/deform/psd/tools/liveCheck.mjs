// Live check of the pose correctives (agent V7, lead's requests), in ONE browser lease (≤ 12 min):
//  A. Tracker cost of the background bake, on cam-parka in the AR lab: tracker inference ms,
//     tracker ms, AR fps and mirror fps while the correctives bake with 2 workers, with 1, and
//     with no bake (?psd=0). Decides PSD.workers (lead: 2 workers may cost at most 10 % of AR fps
//     and 5 ms of tracker time).
//  B. With the 2-worker page: wait for the live bake, sample the stage's cost per frame, then at
//     the same video times read the displayed jacket with the correctives OFF and ON (the pose
//     held, the deformer chain re-applied) and count jacket holes with the offline measure
//     (holes.mjs: cloth just under the AR body occluder, front view). Then the same on cam-tshirt
//     (same page: the model comes from the session cache).
// Takes the machine-wide browser lock (scripts/lookdev/browser-slot.mjs: ≥ 2.5 GiB free RAM).
// The person's figures (toi.txt) and videos stay local; output is numbers only, in the gitignored
// .cache/v7/live-check.json.
//   node apps/web/src/engine/live/deform/psd/tools/liveCheck.mjs [--headed] [--perf-seconds 20]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import './tsHooks.mjs';

const root = resolve(import.meta.dirname, '../../../../../../../..');
const { acquireTimingSlot } = await import('../../../../../../../../scripts/codex-heavy-slot.mjs');
const { holeViolation, decidePSDLive } = await import(
  '../../../../../../../../scripts/psd-live-gates.mjs'
);
const { occluderIndex } = await import('../../../ar/occluder.ts');
const { headTriangles, jacketHoles, windingSign } = await import('./holes.mjs');

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const SOURCES = {
  'cam-parka': 'data/reference-photos/FB7675-100-parka-trang/video/cam-parka.mp4',
  'cam-tshirt': 'data/reference-photos/FB7675-100-parka-trang/video/cam-tshirt.mp4',
};
for (const f of Object.values(SOURCES))
  if (!existsSync(join(root, f))) throw new Error(`${f} is missing`);
const perfSeconds = Number(opt('--perf-seconds', '20'));
if (!(perfSeconds >= 5 && perfSeconds <= 60)) throw new Error('--perf-seconds must be 5-60');
const MAX_PAIRS = 40;
const LEASE_MS = 12 * 60e3;
const out = join(root, '.cache/v7');
mkdirSync(out, { recursive: true });
execFileSync('git', ['check-ignore', '-q', '.cache/cx-day/psd/probe.png'], { cwd: root });
const shots = join(root, '.cache/cx-day/psd');
mkdirSync(shots, { recursive: true });
const PORT = 5772; // Prompt18: CX-DAY main.
const log = (m) => console.log(`[v7-live] ${m}`);
const report = { started: new Date().toISOString(), perf: {}, holes: {}, applyMs: null };
const save = () => writeFileSync(join(out, 'live-check.json'), JSON.stringify(report, null, 1));

function person() {
  const text = readFileSync(join(root, 'data/reference-photos/toi.txt'), 'utf8');
  const h = Number(/height_cm:\s*([\d.]+)/.exec(text)?.[1]);
  const w = Number(/weight_kg:\s*([\d.]+)/.exec(text)?.[1]);
  const sex = /sex:\s*(male|female)/.exec(text)?.[1] ?? 'male';
  if (!h || !w) throw new Error('toi.txt needs height_cm and weight_kg');
  return { h, w, sex };
}
const sorted = (xs) => [...xs].filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
const q = (xs, p) => {
  const s = sorted(xs);
  return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2) : null;
};

const release = await acquireTimingSlot('CX-DAY', 'PSD live check');
report.head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
report.protocol =
  'prompt17b OR hole gate; actual learning samples for worker costs; private paired held-frame shots';
report.screenshots = [];
const leaseEnd = Date.now() + LEASE_MS;
let server, context;
const timer = setTimeout(() => {
  log('lease reached: stopping');
  void context?.close().catch(() => undefined);
}, LEASE_MS);
try {
  const { createServer } = await import('vite');
  server = await createServer({
    root: join(root, 'apps/web'),
    configFile: join(root, 'apps/web/src/engine/live/ar/finish/eval/vite.v4.config.ts'),
    cacheDir: join(out, 'vite'),
    logLevel: 'error',
    server: {
      host: '127.0.0.1',
      port: PORT,
      strictPort: true,
      hmr: false,
      watch: { ignored: ['**/*'] },
    },
  });
  await server.listen();
  const { chromium } = await import('playwright');
  context = await chromium.launchPersistentContext(join(out, 'chrome'), {
    channel: 'chrome',
    headless: !args.includes('--headed'),
    serviceWorkers: 'block',
    viewport: { width: 1500, height: 900 },
    args: [
      '--disable-background-networking',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (['127.0.0.1', 'localhost'].includes(u.hostname) || ['data:', 'blob:'].includes(u.protocol))
      return route.continue();
    return route.abort();
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const { h, w, sex } = person();

  const open = async (extra, source) => {
    const params = new URLSearchParams({
      arlab: '',
      jacket: 'FB7675',
      size: 'S',
      h: String(h),
      w: String(w),
      sex,
      source: 'file',
      t: '0',
      mirror: '0',
      ...extra,
    });
    await page.goto(`http://127.0.0.1:${PORT}/?${params}`, { timeout: 90000 });
    await page.waitForFunction(() => window.__arlab, null, { timeout: 90000 });
    await useSource(source);
  };
  const useSource = async (source) => {
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.arlab select')].some((s) => /^[a-f0-9]{64}$/.test(s.value)),
      null,
      { timeout: 60000 },
    );
    await page.evaluate(() => {
      window.__psdOldSource = window.__arlab.engine.currentSource;
    });
    await page.locator('input[type=file]').setInputFiles(join(root, SOURCES[source]));
    await page.getByRole('button', { name: /^(Start|Restart)$/ }).click();
    await page.waitForFunction(
      () => {
        const L = window.__arlab;
        return (
          L.engine.currentSource &&
          L.engine.currentSource !== window.__psdOldSource &&
          L.engine.currentSource.video?.readyState >= 2 &&
          L.engine.posedScene &&
          L.engine.currentState.phase === 'tracking'
        );
      },
      null,
      { timeout: 180000 },
    );
  };
  /** One stats sample; restarts the video at its end (playback must continue during the bake). */
  const sample = () =>
    page.evaluate(() => {
      const L = window.__arlab;
      const v = L.engine.currentSource?.video;
      if (v?.ended) {
        v.currentTime = 0;
        void v.play();
      }
      const s = L.engine.stats();
      const d = s.deform.find((x) => x.name === 'pose-correctives');
      return {
        inferenceMs: s.inferenceMs,
        trackerMs: s.trackerMs,
        sourceFps: s.sourceFps,
        renderFps: s.renderFps,
        arFps: L.ar.stats.fps,
        phase: L.engine.currentState.phase,
        note: d?.note ?? null,
        active: d?.active ?? false,
        applyMs: d?.lastApplyMs ?? 0,
      };
    });

  // ---- A. Tracker cost of the bake (cam-parka) ----
  const conditions = [
    { name: 'no-bake', extra: { psd: '0' } },
    { name: '1-worker', extra: { psd: '1', psdworkers: '1' } },
    { name: '2-workers', extra: { psd: '1', psdworkers: '2' } },
  ];
  for (const c of conditions) {
    await open(c.extra, 'cam-parka');
    await page.waitForTimeout(3000);
    const xs = [];
    for (let i = 0; i < perfSeconds * 2; i++) {
      await page.waitForTimeout(500);
      xs.push(await sample());
    }
    const learning = xs.filter((x) => /learning/.test(x.note ?? ''));
    const baking = learning.length;
    const measured = c.name === 'no-bake' ? xs : learning;
    report.perf[c.name] = {
      samples: xs.length,
      bakingSamples: baking,
      measuredSamples: measured.length,
      inferenceMs: {
        median: q(
          measured.map((x) => x.inferenceMs),
          0.5,
        ),
        p95: q(
          measured.map((x) => x.inferenceMs),
          0.95,
        ),
      },
      trackerMs: {
        median: q(
          measured.map((x) => x.trackerMs),
          0.5,
        ),
        p95: q(
          measured.map((x) => x.trackerMs),
          0.95,
        ),
      },
      arFps: {
        median: q(
          measured.map((x) => x.arFps),
          0.5,
        ),
        p5: q(
          measured.map((x) => x.arFps),
          0.05,
        ),
      },
      renderFps: {
        median: q(
          measured.map((x) => x.renderFps),
          0.5,
        ),
      },
      sourceFps: {
        median: q(
          measured.map((x) => x.sourceFps),
          0.5,
        ),
      },
      lastNote: xs.at(-1)?.note ?? null,
    };
    log(`${c.name}: ${JSON.stringify(report.perf[c.name])}`);
    save();
  }
  const base = report.perf['no-bake'],
    two = report.perf['2-workers'],
    one = report.perf['1-worker'];
  const cost = (p) => ({
    arFpsLossPct:
      base.arFps.median && Number.isFinite(p.arFps.median)
        ? +((100 * (base.arFps.median - p.arFps.median)) / base.arFps.median).toFixed(1)
        : null,
    addedInferenceMs:
      Number.isFinite(p.inferenceMs.median) && Number.isFinite(base.inferenceMs.median)
        ? +(p.inferenceMs.median - base.inferenceMs.median).toFixed(2)
        : null,
    addedTrackerMs:
      Number.isFinite(p.trackerMs.median) && Number.isFinite(base.trackerMs.median)
        ? +(p.trackerMs.median - base.trackerMs.median).toFixed(2)
        : null,
  });
  report.bakeCost = { oneWorker: cost(one), twoWorkers: cost(two) };
  report.bakeCost.verdict =
    !Number.isFinite(report.bakeCost.twoWorkers.arFpsLossPct) ||
    !Number.isFinite(report.bakeCost.twoWorkers.addedTrackerMs)
      ? 'unknown: no actual background-learning cost observed'
      : report.bakeCost.twoWorkers.arFpsLossPct > 10 ||
          report.bakeCost.twoWorkers.addedTrackerMs > 5
        ? 'two workers cost too much while tracking: use 1 (lead: > 10 % AR fps or > 5 ms tracker)'
        : 'two workers within the budget (≤ 10 % AR fps, ≤ 5 ms tracker)';
  log(`bake cost: ${JSON.stringify(report.bakeCost)}`);
  save();

  // ---- B. The 2-worker page: wait for the live bake, then paired holes ----
  const bakeStart = Date.now();
  let s = await sample();
  while (!/^ready/.test(s.note ?? '') && Date.now() < leaseEnd - 4 * 60e3) {
    await page.waitForTimeout(1000);
    s = await sample();
  }
  report.liveBake = {
    note: s.note,
    waitedAfterPerfS: +((Date.now() - bakeStart) / 1000).toFixed(1),
  };
  log(`correctives: ${s.note}`);
  if (!/^ready/.test(s.note ?? '')) throw new Error(`correctives not ready: ${s.note}`);
  const apply = [];
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(300);
    const x = await sample();
    if (x.active && x.applyMs > 0) apply.push(x.applyMs);
  }
  report.applyMs = {
    n: apply.length,
    median: q(apply, 0.5),
    p95: q(apply, 0.95),
    max: q(apply, 1),
  };
  save();

  const rigData = await page.evaluate(() => {
    const av = window.__arlab.engine.avatar;
    const rig = av.live.rig;
    return {
      bones: rig.bones,
      skinIndices: Array.from(rig.skinIndices),
      skinWeights: Array.from(rig.skinWeights),
      influences: rig.influences,
      vertexCount: rig.vertexCount,
      faces: Array.from(rig.faces),
      triangles: Array.from(av.jacketAsset.triangles),
      panels: Array.from(av.jacketAsset.panels),
      bound: Array.from(av.jacketSkin.bound),
    };
  });
  const occluder = occluderIndex(rigData);
  const head = headTriangles(rigData, occluder);
  const sign = windingSign(rigData.bound, rigData.triangles, rigData.panels);

  for (const source of ['cam-parka', 'cam-tshirt']) {
    if (source !== 'cam-parka') {
      await useSource(source);
      await page.waitForFunction(
        () =>
          /^ready/.test(
            window.__arlab.engine.stats().deform.find((x) => x.name === 'pose-correctives')?.note ??
              '',
          ),
        null,
        { timeout: 120000 },
      );
    }
    const duration = await page.evaluate(() => window.__arlab.engine.currentSource.video.duration);
    const every = Math.max(0.5, (duration - 0.8) / MAX_PAIRS);
    const frames = [];
    let capturedFailure = false;
    for (let t = 0.5; t < duration - 0.3 && Date.now() < leaseEnd - 45e3; t += every) {
      await page.evaluate((time) => window.__arlab.seek(time, 600), t);
      const pair = await page.evaluate(() => {
        const eng = window.__arlab.engine,
          av = eng.avatar;
        const phase = eng.currentState.phase;
        const pose = av.last.pose;
        window.__psdHeldPose = { ...pose };
        const read = (on) => {
          av.deformers.setEnabled('pose-correctives', on);
          av.applyPose(pose);
          return Array.from(av.jacketPositions());
        };
        const off = read(false);
        const on = read(true);
        return {
          phase,
          elevation: [pose.shoulder_L_elevation ?? null, pose.shoulder_R_elevation ?? null],
          body: Array.from(av.bodyArrays().positions),
          off,
          on,
        };
      });
      if (pair.phase !== 'tracking') continue;
      const holes = (jacket) =>
        jacketHoles({
          body: pair.body,
          occluder,
          head,
          jacket,
          triangles: rigData.triangles,
          sign,
        });
      const a = holes(pair.off),
        b = holes(pair.on);
      let moved = 0;
      for (let i = 0; i < pair.on.length; i += 3)
        moved = Math.max(
          moved,
          Math.hypot(
            pair.on[i] - pair.off[i],
            pair.on[i + 1] - pair.off[i + 1],
            pair.on[i + 2] - pair.off[i + 2],
          ),
        );
      frames.push({
        t: +t.toFixed(2),
        elevationDeg: pair.elevation.map((e) => (e === null ? null : Math.round(e))),
        holesOff: a.holes,
        holesOn: b.holes,
        limbOff: a.limbPx,
        limbOn: b.limbPx,
        maxCorrectionCm: +(moved * 100).toFixed(2),
      });
      const bad = holeViolation(frames.at(-1)).fail;
      if (frames.length === 1 || (bad && !capturedFailure)) {
        for (const on of [false, true]) {
          await page.evaluate((on) => {
            const L = window.__arlab,
              av = L.engine.avatar;
            av.deformers.setEnabled('pose-correctives', on);
            av.applyPose(window.__psdHeldPose);
            L.ar.render(L.engine.lastFrame, L.engine.posedScene);
            L.ar.renderer.domElement.setAttribute('data-cxday-psd', 'ar');
          }, on);
          const path = join(
            shots,
            `${source}-${t.toFixed(2).replace('.', 'p')}-${on ? 'on' : 'off'}.png`,
          );
          execFileSync('git', ['check-ignore', '-q', path], { cwd: root });
          await page.locator('[data-cxday-psd="ar"]').screenshot({ path });
          report.screenshots.push(path.replace(root + '\\', '').replaceAll('\\', '/'));
        }
        if (bad) capturedFailure = true;
      }
      log(
        `${source} t ${t.toFixed(1)}: holes off ${a.holes} / on ${b.holes} px; max correction ${(moved * 100).toFixed(1)} cm`,
      );
    }
    const mean = (xs) =>
      xs.length ? +(xs.reduce((s2, x) => s2 + x, 0) / xs.length).toFixed(1) : null;
    report.holes[source] = {
      frames,
      summary: {
        n: frames.length,
        holesOff: {
          mean: mean(frames.map((f) => f.holesOff)),
          max: q(
            frames.map((f) => f.holesOff),
            1,
          ),
        },
        holesOn: {
          mean: mean(frames.map((f) => f.holesOn)),
          max: q(
            frames.map((f) => f.holesOn),
            1,
          ),
        },
        framesOverGate: frames.filter((f) => holeViolation(f).fail).map((f) => f.t),
      },
    };
    log(`${source}: ${JSON.stringify(report.holes[source].summary)}`);
    save();
  }
  report.note =
    'Paired frames: the held pose with the correctives off vs on (dynamics reset by the toggle in both). Holes = front-view jacket pixels (2.5 mm) where the AR body occluder is 1-30 mm in front of the cloth (holes.mjs).';
  report.finished = new Date().toISOString();
  report.decision = decidePSDLive(report);
  save();
} catch (error) {
  report.error = 'Incomplete; private error .cache/cx-day/psd/live-error.txt';
  writeFileSync(join(shots, 'live-error.txt'), String(error));
  report.decision = decidePSDLive(report);
  save();
  throw error;
} finally {
  clearTimeout(timer);
  await context?.close().catch(() => undefined);
  await server?.close().catch(() => undefined);
  release();
}
