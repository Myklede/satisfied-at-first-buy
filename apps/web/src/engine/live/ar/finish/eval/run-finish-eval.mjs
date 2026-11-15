// AR finishing pass evaluation (agent V4, prompt 14). Before/after on the user's kiosk-camera clips.
//
//   node apps/web/src/engine/live/ar/finish/eval/run-finish-eval.mjs [--port 5786]
//        [--videos cam-tshirt,cam-parka] [--step 0.5] [--no-shots] [--calibrate]
//
// Needs: the body service on 8001 and a Vite dev server for apps/web on --port (V4's ports
// 5786–5789). Takes the machine-wide browser lock (scripts/lookdev/browser-slot.mjs), holds it at
// most 14 minutes. Opens V2's /?arlab with the clip, installs ArFinish on the lab's compositor
// (compositor.finisher, the seam), and at each sample time seeks, then renders the held frame
// twice: the compositor's own composite (before) and the finisher's (after). It measures the
// uncovered share of the upper-body clothing (ArFinish.measureCoverage), times the finisher, and
// writes before/after frames to docs/validation/look-v4-*.png.
//
// Privacy: look-v4-*.png contain the user's frames; docs/validation/look-*.png is gitignored
// (checked below before writing). The JSON holds numbers only.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { acquireBrowserSlot } from '../../../../../../../../scripts/lookdev/browser-slot.mjs';

const ROOT = resolve(import.meta.dirname, '../../../../../../../..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const PORT = Number(arg('--port', '5786'));
if (PORT < 5786 || PORT > 5789) throw new Error('V4 uses ports 5786–5789');
const OUT = resolve(ROOT, arg('--out', 'docs/validation/ar-finish-v4.json'));
const STEP = Number(arg('--step', '0.5'));
const SHOTS = !args.includes('--no-shots');
const TIMING = !args.includes('--no-timing');
const [VIEW_W, VIEW_H] = arg('--viewport', '1100x760').split('x').map(Number);
const CALIBRATE = args.includes('--calibrate');
// Stale-mask study: comma-separated times; the mask is taken STALE_LAG_S earlier.
const STALE = arg('--stale', '').split(',').filter(Boolean).map(Number);
const STALE_LAG_S = Number(arg('--stale-lag', '0.27'));
// CPU vs GPU segmenter in the worker on the same bitmaps: comma-separated times.
const GPU_TEST = arg('--gpu-test', '').split(',').filter(Boolean).map(Number);
const SAMPLES = !args.includes('--no-samples');
// Rest stability: per-video still windows, e.g. cam-tshirt:1.2-3,cam-parka:1.5-3.
const STILL_WINDOWS = Object.fromEntries(
  arg('--still', '')
    .split(',')
    .filter(Boolean)
    .map((w) => {
      const [k, r] = w.split(':');
      return [k, r.split('-').map(Number)];
    }),
);
const WANTED = arg('--videos', 'cam-tshirt,cam-parka').split(',');
const LOCK_BUDGET_MS = 14 * 60 * 1000;
const SHOT_DIR = join(ROOT, 'docs/validation');

const VIDEOS = [
  {
    key: 'cam-tshirt',
    product: 'FB7675',
    folder: 'FB7675-100-parka-trang',
    name: 'video/cam-tshirt.mp4',
  },
  {
    key: 'cam-parka',
    product: 'FB7675',
    folder: 'FB7675-100-parka-trang',
    name: 'video/cam-parka.mp4',
  },
  {
    key: 'cam-tshirt-puffer',
    product: 'DQ4920',
    folder: 'FB7675-100-parka-trang',
    name: 'video/cam-tshirt.mp4',
  },
].filter((v) => WANTED.includes(v.key));

// Privacy guard: every image path must be gitignored.
function ignored(path) {
  try {
    execFileSync('git', ['check-ignore', '-q', path], { cwd: ROOT });
    return true;
  } catch {
    return false;
  }
}
if (SHOTS && !ignored(join(SHOT_DIR, 'look-v4-probe.png')))
  throw new Error('docs/validation/look-v4-*.png is not gitignored: refusing to write frames');

// The user's height/weight live only in the gitignored toi.txt; read locally, never written out.
function person() {
  const text = readFileSync(join(ROOT, 'data/reference-photos/toi.txt'), 'utf8');
  const h = Number(/height_cm:\s*([\d.]+)/.exec(text)?.[1]);
  const w = Number(/weight_kg:\s*([\d.]+)/.exec(text)?.[1]);
  const sex = /sex:\s*(male|female)/.exec(text)?.[1] ?? 'male';
  if (!h || !w) throw new Error('data/reference-photos/toi.txt needs height_cm and weight_kg');
  return { h, w, sex };
}

// Same as masks.ts staleScores (unit-tested there); inlined because Node cannot load that module
// (its imports are extensionless, resolved by Vite).
function staleScores(ref, test) {
  let clothing = 0,
    missed = 0,
    wrong = 0;
  for (let i = 0; i < ref.length; i += 4) {
    if (ref[i] >= 128) {
      clothing++;
      if (test[i + 2] >= 128) missed++;
    } else if (test[i + 3] >= 128) wrong++;
  }
  return clothing
    ? { clothingPx: clothing, missed: missed / clothing, wrongFill: wrong / clothing }
    : null;
}

const stat = (values) => {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  const r = (x) => Number(x.toFixed(4));
  return {
    n: v.length,
    mean: r(v.reduce((a, b) => a + b, 0) / v.length),
    median: r(q(0.5)),
    p90: r(q(0.9)),
    max: r(v.at(-1)),
  };
};

async function openLab(page, video, body) {
  const ref = `${video.folder}|${video.name}`;
  const url =
    `http://127.0.0.1:${PORT}/?arlab&jacket=${video.product}&size=S&h=${body.h}&w=${body.w}` +
    `&sex=${body.sex}&ref=${encodeURIComponent(ref)}&t=1&nomirror`;
  await page.goto(url);
  await page.waitForFunction(() => window.__arlab, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /^(Start|Restart)$/ }).click();
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    const s = await page.evaluate(() => window.__arlab.sample());
    if (s.phase === 'tracking' && s.status === 'drawn') return true;
    await page.waitForTimeout(500);
  }
  return false;
}

/** Installs the finisher on the lab's compositor and a render hook that keeps the last call. */
async function installFinisher(page) {
  await page.evaluate(async () => {
    const m = await import('/src/engine/live/ar/finish/index.ts');
    const ar = window.__arlab.ar;
    ar.finisher?.dispose?.();
    const f = new m.ArFinish();
    ar.finisher = f;
    ar.useFinisher = true;
    const v4 = {
      f,
      m,
      video: window.__arlab.engine.currentSource?.video ?? null,
      last: null,
      capture: false,
      shot: null,
      probe: null,
      probeOut: null,
    };
    window.__v4 = v4;
    const render = ar.render.bind(ar);
    ar.render = (frame, scene) => {
      v4.last = { frame, scene };
      render(frame, scene);
      if (v4.onFrame) v4.onFrame();
      const canvas = ar.renderer?.domElement;
      if (!canvas) return;
      if (v4.capture) {
        v4.shot = canvas.toDataURL('image/png');
        v4.capture = false;
      }
      if (v4.probe) {
        // Mean linear Y of boxes (source px) on the composite, read right after the draw.
        const c = document.createElement('canvas');
        c.width = canvas.width;
        c.height = canvas.height;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(canvas, 0, 0);
        const k = canvas.width / frame.width;
        const lin = (x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
        v4.probeOut = v4.probe.map(([x, y, w, h]) => {
          const d = ctx.getImageData(
            Math.round(x * k),
            Math.round(y * k),
            Math.max(1, Math.round(w * k)),
            Math.max(1, Math.round(h * k)),
          ).data;
          let r = 0,
            g = 0,
            b = 0;
          for (let i = 0; i < d.length; i += 4) {
            r += lin(d[i] / 255);
            g += lin(d[i + 1] / 255);
            b += lin(d[i + 2] / 255);
          }
          const n = d.length / 4;
          return { Y: (0.2126 * r + 0.7152 * g + 0.0722 * b) / n, rg: r / g, bg: b / g };
        });
        v4.probe = null;
      }
    };
  });
}

/** Seeks, then renders the held frame before (compositor) and after (finisher). */
async function sampleAt(page, t, shots) {
  return page.evaluate(
    async ({ t, shots }) => {
      const h = window.__arlab,
        v4 = window.__v4,
        ar = h.ar;
      await h.seek(t, 1000);
      const last = v4.last;
      if (!last || ar.status !== 'drawn') return { t, skipped: ar.status };
      const out = { t };
      ar.useFinisher = true;
      // The class mask comes from a worker: render the held frame until a mask of this frame
      // (sent after the seek) is in use, at most 3 s; then the async colour statistics settle.
      // Re-rendering one frame settles the tracker too, so before and after are drawn back to
      // back afterwards, from the same settled state.
      const sought = performance.now();
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 60; i++) {
        ar.render(last.frame, last.scene);
        if (v4.f.classSentAt > sought && v4.f.stats.usedClasses) break;
        await wait(50);
      }
      for (let i = 0; i < 8; i++) {
        ar.render(last.frame, last.scene);
        await wait(30);
      }
      if (ar.status !== 'drawn') return { t, skipped: ar.status };
      out.classFresh = v4.f.classSentAt > sought && v4.f.stats.usedClasses;
      out.classError = v4.f.stats.classError;
      ar.useFinisher = false;
      v4.capture = shots;
      ar.render(last.frame, last.scene);
      out.before = shots ? v4.shot : null;
      ar.useFinisher = true;
      v4.capture = shots;
      ar.render(last.frame, last.scene);
      out.after = shots ? v4.shot : null;
      out.coverage = v4.f.measureCoverage(ar.renderer);
      // The independent metric (every clothes-class person pixel above the hip line, forearms
      // excluded), blind to the fill's own region.
      out.coverageAll = v4.f.measureCoverage(ar.renderer, false, 'independent');
      // The same frame without the class mask (person mask + geometry only).
      v4.f.options.classes = false;
      ar.render(last.frame, last.scene);
      out.coveragePersonMask = v4.f.measureCoverage(ar.renderer);
      v4.f.options.classes = true;
      const s = ar.tracker.last;
      out.yawDeg = s ? (s.pose.yaw * 180) / Math.PI : null;
      out.fade = s?.fade ?? null;
      out.backView = s?.backView ?? null;
      out.alignment = s?.alignment?.score ?? null;
      out.match = { ...v4.f.match };
      out.light = v4.f.light ? JSON.parse(JSON.stringify(v4.f.light)) : null;
      out.compositorMatch = { exposure: ar.match.exposure, tint: [...ar.match.tint] };
      out.stats = { ...v4.f.stats };
      out.geometry = !!v4.f.geometry;
      out.cuffs = v4.f.geometry
        ? v4.f.geometry.cuffs.map((c) => (c ? Number(c.depth.toFixed(2)) : null))
        : null;
      out.canvas = [ar.renderer.domElement.width, ar.renderer.domElement.height];
      out.frame = [last.frame.width, last.frame.height];
      return out;
    },
    { t, shots },
  );
}

/** Real-time playback timing of the whole finisher (CPU + GPU via gl.finish) and of the frame. */
/**
 * Stale mask at frame t: the class mask of t − lag (frozen), applied to frame t with no / the
 * translation / the per-region motion compensation, scored against a fresh mask of t.
 */
async function staleAt(page, t, lag) {
  return page.evaluate(
    async ({ t, lag }) => {
      const h = window.__arlab,
        v4 = window.__v4,
        ar = h.ar,
        f = v4.f;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const freshMask = async () => {
        const since = performance.now();
        for (let i = 0; i < 80; i++) {
          ar.render(v4.last.frame, v4.last.scene);
          if (f.classSentAt > since && f.stats.usedClasses) return true;
          await wait(50);
        }
        return false;
      };
      const joints = () => {
        const l = v4.last.frame.landmarks2d;
        return l ? [15, 16, 13, 14].map((i) => [l[i].x, l[i].y, l[i].visibility]) : null;
      };
      f.freezeClasses = false;
      await h.seek(Math.max(0.05, t - lag), 800);
      if (!(await freshMask())) return { t, error: 'no mask at t - lag' };
      const then = joints();
      f.freezeClasses = true;
      await h.seek(t, 800);
      for (let i = 0; i < 6; i++) {
        ar.render(v4.last.frame, v4.last.scene);
        await wait(30);
      }
      if (ar.status !== 'drawn') {
        f.freezeClasses = false;
        return { t, error: 'status ' + ar.status };
      }
      const now = joints();
      const out = { t, lag, modes: {} };
      for (const mode of ['none', 'translate', 'regions']) {
        f.motionCompensation = mode;
        ar.render(v4.last.frame, v4.last.scene);
        out.modes[mode] = Array.from(f.measureCoverage(ar.renderer, true)?.pixels ?? []);
      }
      f.motionCompensation = 'regions';
      f.freezeClasses = false;
      if (!(await freshMask())) return { t, error: 'no fresh mask at t' };
      ar.render(v4.last.frame, v4.last.scene);
      out.ref = Array.from(f.measureCoverage(ar.renderer, true)?.pixels ?? []);
      const l = v4.last.frame.landmarks2d;
      const span = Math.hypot(l[11].x - l[12].x, l[11].y - l[12].y);
      out.motion =
        then && now
          ? then.map((p, k) =>
              p[2] >= 0.5 && now[k][2] >= 0.5
                ? Math.hypot(now[k][0] - p[0], now[k][1] - p[1]) / span
                : null,
            )
          : null;
      return out;
    },
    { t, lag },
  );
}

/** The CPU and the GPU delegate in their own workers, on the same upper-body bitmaps. */
async function gpuTest(page, times) {
  return page.evaluate(async (times) => {
    const h = window.__arlab,
      v4 = window.__v4;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const { WorkerSegmenter } = await import('/src/engine/live/ar/finish/segmenterClient.ts');
    const { upperBodyRect } = await import('/src/engine/live/ar/finish/geometry.ts');
    v4.f.freezeClasses = true;
    const segs = {
      CPU: new WorkerSegmenter('/vision/', 'CPU'),
      GPU: new WorkerSegmenter('/vision/', 'GPU'),
    };
    const t0 = performance.now();
    while (performance.now() - t0 < 30000 && Object.values(segs).some((s) => !s.ready && !s.error))
      await wait(100);
    const out = { delegates: {}, errors: {}, frames: [] };
    const video = v4.video ?? h.engine.currentSource?.video;
    for (const t of times) {
      await h.seek(t, 600);
      const fr = v4.last?.frame;
      const l = fr?.landmarks2d;
      if (!l || !video) continue;
      const span = Math.hypot(l[11].x - l[12].x, l[11].y - l[12].y);
      const rect = upperBodyRect(l, span, fr);
      if (!rect) continue;
      const masks = {};
      for (const [k, s] of Object.entries(segs)) {
        if (!s.ready) continue;
        const before = s.latest;
        s.request(video, rect, fr, null);
        const w0 = performance.now();
        while (s.latest === before && !s.error && performance.now() - w0 < 5000) await wait(10);
        if (s.latest !== before) masks[k] = s.latest;
      }
      const row = { t, ms: {} };
      for (const [k, m] of Object.entries(masks)) row.ms[k] = m.workerMs;
      if (masks.CPU && masks.GPU && masks.CPU.mask.data.length === masks.GPU.mask.data.length) {
        const a = masks.CPU.mask.data,
          b = masks.GPU.mask.data;
        let same = 0;
        const hist = { CPU: [0, 0, 0, 0, 0, 0], GPU: [0, 0, 0, 0, 0, 0] };
        for (let i = 0; i < a.length; i++) {
          if (a[i] === b[i]) same++;
          hist.CPU[a[i]]++;
          hist.GPU[b[i]]++;
        }
        row.agreement = same / a.length;
        row.hist = hist;
      }
      out.frames.push(row);
    }
    for (const [k, s] of Object.entries(segs)) {
      out.delegates[k] = s.delegate;
      out.errors[k] = s.error;
      s.dispose();
    }
    v4.f.freezeClasses = false;
    return out;
  }, times);
}

/**
 * Rest stability over a still window, played in real time, with the finisher's stabilisation
 * off or on: per frame, the edge motion (source px/frame) of the jacket before this pass, the
 * fill and the final alpha; the colour change (8-bit levels) of this pass's layer inside the
 * jacket and inside the fill; and the grade drift (%/s).
 */
async function stillWindow(page, t0, t1, stabilize) {
  return page.evaluate(
    async ({ t0, t1, stabilize }) => {
      const h = window.__arlab,
        v4 = window.__v4,
        ar = h.ar,
        f = v4.f;
      const S = await import('/src/engine/live/ar/finish/stability.ts');
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const video = v4.video ?? h.engine.currentSource?.video;
      if (!video) return { error: 'no video' };
      f.options.stabilize = stabilize;
      const res = { warped: [], fill: [], final: [], colJacket: [], colFill: [], still: [] };
      const grade = [];
      let prev = null;
      v4.onFrame = () => {
        if (video.currentTime < t0) return;
        const m = f.measureLayers(ar.renderer);
        if (!m) return;
        grade.push({
          t: performance.now(),
          e: f.match.exposure,
          g: [...f.match.gain],
          l: f.match.lift,
        });
        res.still.push(f.still);
        if (prev) {
          const e = (c) => S.edgeMotion(prev.alphas, m.alphas, m.width, m.height, c, m.scale);
          res.warped.push(e(0));
          res.fill.push(e(1));
          res.final.push(e(2));
          res.colJacket.push(S.colourChange(prev.colour, m.colour, prev.alphas, m.alphas, 2));
          res.colFill.push(S.colourChange(prev.colour, m.colour, prev.alphas, m.alphas, 1, 230));
        }
        prev = m;
      };
      video.pause();
      video.currentTime = Math.max(0, t0 - 1);
      await wait(400);
      await video.play();
      while (video.currentTime < t1 && !video.paused) await wait(40);
      video.pause();
      v4.onFrame = null;
      f.options.stabilize = true;
      const stat = (v) => {
        const a = v.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y);
        if (!a.length) return null;
        const r = (x) => Number(x.toFixed(4));
        return {
          n: a.length,
          mean: r(a.reduce((p, q) => p + q, 0) / a.length),
          p90: r(a[Math.floor(0.9 * (a.length - 1))]),
          max: r(a.at(-1)),
        };
      };
      // Grade drift: mean |change| per second relative to the value (lift: of full scale).
      let de = 0,
        dg = 0,
        dl = 0;
      for (let i = 1; i < grade.length; i++) {
        de += Math.abs(grade[i].e - grade[i - 1].e) / Math.max(1e-6, grade[i].e);
        dg += Math.max(
          ...grade[i].g.map((g, k) => Math.abs(g - grade[i - 1].g[k]) / Math.max(1e-6, g)),
        );
        dl += Math.abs(grade[i].l - grade[i - 1].l);
      }
      const secs = grade.length > 1 ? (grade.at(-1).t - grade[0].t) / 1000 : 0;
      return {
        t0,
        t1,
        stabilize,
        frames: grade.length,
        seconds: Number(secs.toFixed(2)),
        edgePxPerFrame: {
          jacketBeforeFinisher: stat(res.warped),
          fill: stat(res.fill),
          final: stat(res.final),
        },
        colourLevelsPerFrame: { jacket: stat(res.colJacket), fill: stat(res.colFill) },
        gradeDriftPctPerS: secs
          ? {
              exposure: Number(((100 * de) / secs).toFixed(3)),
              gain: Number(((100 * dg) / secs).toFixed(3)),
              lift: Number(((100 * dl) / secs).toFixed(3)),
            }
          : null,
        stillness: stat(res.still),
      };
    },
    { t0, t1, stabilize },
  );
}

async function bench(page, from, seconds, options) {
  return page.evaluate(
    async ({ from, seconds, options }) => {
      const h = window.__arlab,
        v4 = window.__v4,
        ar = h.ar;
      const video = v4.video ?? h.engine.currentSource?.video;
      if (!video) return { error: 'no video', samples: null };
      Object.assign(v4.f.options, options.finish ?? {});
      v4.f.bench = !!options.bench;
      ar.useFinisher = options.useFinisher !== false;
      v4.f.stats.benchMs = null;
      v4.f.stats.applyMs = NaN;
      video.currentTime = from;
      await video.play();
      const samples = { bench: [], apply: [], render: [], cls: [], latency: [], fps: [] };
      const t0 = performance.now();
      while (performance.now() - t0 < seconds * 1000) {
        await new Promise((r) => setTimeout(r, 250));
        const s = v4.f.stats;
        if (s.benchMs != null) samples.bench.push(s.benchMs);
        if (Number.isFinite(s.applyMs)) samples.apply.push(s.applyMs);
        if (s.classMs != null) samples.cls.push(s.classMs);
        if (s.classLatencyMs != null) samples.latency.push(s.classLatencyMs);
        samples.render.push(ar.stats.renderMs);
        samples.fps.push(ar.stats.fps);
      }
      video.pause();
      v4.f.bench = false;
      ar.useFinisher = true;
      Object.assign(v4.f.options, { classes: true });
      return {
        samples,
        delegate: v4.f.stats.classDelegate,
        classError: v4.f.stats.classError,
        classMasks: v4.f.stats.classMasks,
        engine: h.engine.stats?.() ?? null,
      };
    },
    { from, seconds, options },
  );
}

const body = person();
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const release = await acquireBrowserSlot(`V4 ${process.pid} ${stamp}`);
const deadline = Date.now() + LOCK_BUDGET_MS;
const report = {
  generated: new Date().toISOString(),
  method:
    'ArFinish (apps/web/src/engine/live/ar/finish) on V2s glued AR composite, through the ' +
    'ArFinisher seam. Coverage: share of the upper-body clothing (selfie multiclass clothes/others, ' +
    'plus body skin on the arms above the wrist; torso quad shoulders-to-hips + arm capsules, ' +
    'minus head and hands) whose final alpha < 0.5, read back at half the source resolution; ' +
    '"before" = the warped jacket alone (the compositor without the finisher), "after" = the ' +
    'finished composite. coveragePersonMask = the same with the person mask instead of classes. ' +
    'Independent metric (uncovered_*_independent): every clothes-class person pixel above the ' +
    'hip line except the forearm capsules, whatever the fill region (misses outside it count). ' +
    'Facing = |drawn yaw| <= 20 deg, no fade, not a back view. Timing: benchMs = apply() between two ' +
    'gl.finish() calls (CPU + GPU of the finisher alone, segmenter included when it ran), applyMs ' +
    '= its main-thread time without the stall.',
  body: 'the user, fitted from height/weight (data/reference-photos/toi.txt, local only); size S',
  videos: {},
};
let context;
try {
  context = await chromium.launchPersistentContext(join(ROOT, '.cache/playwright/v4-chrome'), {
    channel: 'chrome',
    headless: false,
    viewport: { width: VIEW_W, height: VIEW_H },
    args: [
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning')
      console.log(`[${m.type()}]`, m.text().slice(0, 300));
  });
  for (const video of VIDEOS) {
    if (Date.now() > deadline) {
      report.videos[video.key] = { skipped: 'browser lock budget used up' };
      continue;
    }
    console.log(`\n== ${video.key}`);
    if (!(await openLab(page, video, body))) {
      report.videos[video.key] = { error: 'did not reach tracking within 90 s' };
      continue;
    }
    await installFinisher(page);
    // Let the segmenter load and the colour statistics settle on live playback.
    await page.evaluate(async () => {
      const v = window.__arlab.engine.currentSource.video;
      v.currentTime = 0.5;
      await v.play();
      await new Promise((r) => setTimeout(r, 3000));
      v.pause();
    });
    // The segmenter worker: wait for it to load (or fail) and say which.
    const worker = await page.evaluate(async () => {
      const v4 = window.__v4,
        ar = window.__arlab.ar;
      const t0 = performance.now();
      while (performance.now() - t0 < 20000) {
        if (v4.last) ar.render(v4.last.frame, v4.last.scene);
        if (v4.f.stats.classMasks > 0 || v4.f.stats.classError) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return {
        ms: Math.round(performance.now() - t0),
        masks: v4.f.stats.classMasks,
        delegate: v4.f.stats.classDelegate,
        error: v4.f.stats.classError,
      };
    });
    console.log('segmenter worker', JSON.stringify(worker));
    const duration = await page.evaluate(() => window.__arlab.engine.currentSource.video.duration);
    const samples = [];
    for (let t = 0.5; SAMPLES && t < duration - 0.3 && Date.now() < deadline - 120000; t += STEP) {
      const r = await sampleAt(page, Number(t.toFixed(2)), SHOTS);
      if (r.before) {
        writeFileSync(
          join(SHOT_DIR, `look-v4-${video.key}-${r.t.toFixed(1)}-before.png`),
          Buffer.from(r.before.split(',')[1], 'base64'),
        );
        writeFileSync(
          join(SHOT_DIR, `look-v4-${video.key}-${r.t.toFixed(1)}-after.png`),
          Buffer.from(r.after.split(',')[1], 'base64'),
        );
      }
      delete r.before;
      delete r.after;
      samples.push(r);
      const c = r.coverage;
      console.log(
        `${video.key} t=${r.t}: ${r.skipped ? `skipped (${r.skipped})` : `yaw ${r.yawDeg?.toFixed(0)} uncovered ${c ? `${(100 * c.uncoveredBefore).toFixed(1)}% -> ${(100 * c.uncoveredAfter).toFixed(1)}% (${c.classes ? 'classes' : 'person mask'})` : '-'} | person-mask ${r.coveragePersonMask ? `${(100 * r.coveragePersonMask.uncoveredBefore).toFixed(1)}% -> ${(100 * r.coveragePersonMask.uncoveredAfter).toFixed(1)}%` : '-'} | indep ${r.coverageAll ? `${(100 * r.coverageAll.uncoveredBefore).toFixed(1)}% -> ${(100 * r.coverageAll.uncoveredAfter).toFixed(1)}%` : '-'} | E ${r.match?.exposure?.toFixed(2)} gain ${r.match?.gain?.map((g) => g.toFixed(2)).join('/')} lift ${r.match?.lift?.toFixed(3)} grain ${r.match?.grainSigma8bit?.toFixed(2)} fresh ${r.classFresh} ${r.classError ?? ''}`}`,
      );
    }
    let calibration = null;
    if (CALIBRATE && video.key === 'cam-parka' && Date.now() < deadline - 150000) {
      // The real optic-white parka vs the face (white balance, exposure reference), then our
      // parka's same chest panels at fixed exposures (no white balance, no lift): config.ts.
      calibration = [];
      for (const t of [2.5, 12.5, 13.5, 14.5]) {
        const c = await page.evaluate(async (t) => {
          const h = window.__arlab,
            v4 = window.__v4,
            ar = h.ar;
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          await h.seek(t, 1000);
          const last = v4.last;
          const l = last?.frame.landmarks2d;
          if (!l || ar.status !== 'drawn') return { t, skipped: ar.status };
          const s = ar.tracker.last;
          const yawDeg = s ? (s.pose.yaw * 180) / Math.PI : null;
          const sx = (l[11].x + l[12].x) / 2,
            span = Math.abs(l[11].x - l[12].x),
            y0 =
              (l[11].y + l[12].y) / 2 + 0.3 * ((l[23].y + l[24].y) / 2 - (l[11].y + l[12].y) / 2);
          const boxes = [
            [sx - 0.32 * span, y0, 0.18 * span, 0.2 * span],
            [sx + 0.14 * span, y0, 0.18 * span, 0.2 * span],
          ];
          const probe = async () => {
            v4.probe = boxes;
            ar.render(last.frame, last.scene);
            return v4.probeOut;
          };
          ar.debug.jacket = false;
          for (let i = 0; i < 14; i++) {
            ar.render(last.frame, last.scene);
            await wait(40);
          }
          const real = await probe();
          const face = v4.f.match.face ? [...v4.f.match.face] : null;
          const frontal = v4.f.match.frontal;
          ar.debug.jacket = true;
          const ours = [];
          for (const e of [0.7, 0.92, 1.15]) {
            v4.f.override = { exposure: e, gain: [1, 1, 1], lift: 0, grainSigma: 0 };
            ar.render(last.frame, last.scene);
            ours.push({ exposure: e, panels: await probe() });
          }
          v4.f.override = {};
          return { t, yawDeg, frontal, face, real, ours };
        }, t);
        console.log('calibration', JSON.stringify(c));
        calibration.push(c);
      }
    }
    const stale = [];
    for (const t of STALE) {
      if (Date.now() > deadline - 90000) break;
      const r = await staleAt(page, t, STALE_LAG_S);
      if (r.error) {
        console.log(`${video.key} stale t=${t}: ${r.error}`);
        stale.push({ t, error: r.error });
        continue;
      }
      const ref = Uint8Array.from(r.ref);
      const scores = Object.fromEntries(
        Object.entries(r.modes).map(([k, px]) => [k, staleScores(ref, Uint8Array.from(px))]),
      );
      const fmt = (v) =>
        v ? `missed ${(100 * v.missed).toFixed(1)}% wrong ${(100 * v.wrongFill).toFixed(1)}%` : '-';
      console.log(
        `${video.key} stale t=${t} motion ${JSON.stringify(r.motion?.map((m) => (m == null ? null : Number(m.toFixed(2)))))} ` +
          Object.entries(scores)
            .map(([k, v]) => `${k}: ${fmt(v)}`)
            .join(' | '),
      );
      stale.push({ t, lag: r.lag, wristElbowMotionOfSpan: r.motion, scores });
    }
    const still = [];
    const win = STILL_WINDOWS[video.key];
    if (win && Date.now() < deadline - 90000)
      for (const stabilize of [false, true]) {
        const r = await stillWindow(page, win[0], win[1], stabilize);
        console.log(
          `${video.key} still ${win[0]}-${win[1]} stabilize=${stabilize} ${JSON.stringify(r).slice(0, 700)}`,
        );
        still.push(r);
      }
    let gpu = null;
    if (GPU_TEST.length && Date.now() < deadline - 90000) {
      gpu = await gpuTest(page, GPU_TEST);
      console.log('gpu test', JSON.stringify(gpu).slice(0, 800));
    }
    // Timing on real-time playback: finisher alone (CPU+GPU), with and without the segmenter.
    const timing = {};
    if (TIMING && Date.now() < deadline - 60000) {
      timing.finisherCpuGpu = await bench(page, 1, 5, { bench: true, finish: { classes: true } });
      timing.frameWithFinisher = await bench(page, 1, 6, { bench: false });
      timing.frameWithoutFinisher = await bench(page, 1, 6, { bench: false, useFinisher: false });
    }
    const summarise = (rows, key) => ({
      before: stat(rows.map((s) => s[key]?.uncoveredBefore)),
      after: stat(rows.map((s) => s[key]?.uncoveredAfter)),
    });
    const drawn = samples.filter((s) => !s.skipped && s.coverage);
    const facing = drawn.filter(
      (s) => Math.abs(s.yawDeg ?? 99) <= 20 && (s.fade ?? 0) < 0.01 && !s.backView,
    );
    report.videos[video.key] = {
      product: video.product,
      frame: drawn[0]?.frame ?? null,
      canvas: drawn[0]?.canvas ?? null,
      samples: samples.length,
      drawn: drawn.length,
      facing: facing.length,
      uncovered_facing: summarise(facing, 'coverage'),
      uncovered_all: summarise(drawn, 'coverage'),
      uncovered_facing_person_mask: summarise(facing, 'coveragePersonMask'),
      uncovered_facing_independent: summarise(facing, 'coverageAll'),
      uncovered_all_independent: summarise(drawn, 'coverageAll'),
      classes_used: drawn.filter((s) => s.coverage?.classes).length,
      timing_ms: Object.fromEntries(
        Object.entries(timing).map(([k, v]) => [
          k,
          v.samples
            ? {
                finisherCpuGpuMs: stat(v.samples.bench),
                finisherMainThreadMs: stat(v.samples.apply),
                segmenterWorkerMs: stat(v.samples.cls),
                classMaskLatencyMs: stat(v.samples.latency),
                compositorRenderMs: stat(v.samples.render),
                arFps: stat(v.samples.fps),
                delegate: v.delegate,
                classError: v.classError,
                classMasks: v.classMasks,
                engine: v.engine,
              }
            : { error: v.error },
        ]),
      ),
      calibration,
      stale,
      still,
      gpu,
      rows: samples.map((s) => ({
        t: s.t,
        skipped: s.skipped ?? null,
        yawDeg: s.yawDeg == null ? null : Number(s.yawDeg.toFixed(1)),
        fade: s.fade,
        backView: s.backView ?? null,
        alignment: s.alignment == null ? null : Number(s.alignment.toFixed(2)),
        uncoveredBefore: s.coverage ? Number(s.coverage.uncoveredBefore.toFixed(4)) : null,
        uncoveredAfter: s.coverage ? Number(s.coverage.uncoveredAfter.toFixed(4)) : null,
        regionPx: s.coverage?.regionPx ?? null,
        independentBefore: s.coverageAll ? Number(s.coverageAll.uncoveredBefore.toFixed(4)) : null,
        independentAfter: s.coverageAll ? Number(s.coverageAll.uncoveredAfter.toFixed(4)) : null,
        independentPx: s.coverageAll?.regionPx ?? null,
        classes: s.coverage?.classes ?? null,
        personMaskBefore: s.coveragePersonMask
          ? Number(s.coveragePersonMask.uncoveredBefore.toFixed(4))
          : null,
        personMaskAfter: s.coveragePersonMask
          ? Number(s.coveragePersonMask.uncoveredAfter.toFixed(4))
          : null,
        exposure: s.match ? Number(s.match.exposure.toFixed(3)) : null,
        gain: s.match ? s.match.gain.map((g) => Number(g.toFixed(3))) : null,
        lift: s.match ? Number(s.match.lift.toFixed(4)) : null,
        grainSigma8bit: s.match ? Number(s.match.grainSigma8bit.toFixed(2)) : null,
        faceY: s.match?.faceY == null ? null : Number(s.match.faceY.toFixed(4)),
        cuffDepth: s.cuffs,
        lightDir: s.light ? s.light.dir.map((v) => Number(v.toFixed(3))) : null,
        lightKey: s.light ? Number(s.light.keyIntensity.toFixed(3)) : null,
        lightConfidence: s.light ? Number(s.light.confidence.toFixed(3)) : null,
        compositorTint: s.compositorMatch
          ? s.compositorMatch.tint.map((g) => Number(g.toFixed(3)))
          : null,
      })),
    };
  }
} catch (error) {
  // Keep what was measured: the report is written below either way.
  report.error = String(error?.stack ?? error).slice(0, 2000);
  console.log('[eval error]', report.error);
} finally {
  await context?.close().catch(() => undefined);
  release();
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
console.log(`\nwrote ${OUT}`);
