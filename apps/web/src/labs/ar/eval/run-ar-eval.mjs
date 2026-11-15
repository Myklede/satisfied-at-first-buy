// AR overlay evaluation on the user's videos (agent V2, prompt 14). Numbers only.
//
//   node apps/web/src/labs/ar/eval/run-ar-eval.mjs [--port 5765] [--videos parka,puffer,cam]
//        [--sheets] [--out docs/validation/tryon-ar-eval.json]
//
// Needs: the body service on 8001 and a Vite dev server for apps/web on --port (V2's ports
// 5765–5769). Takes the machine-wide browser lock (scripts/lookdev/browser-slot.mjs) and holds it
// at most 14 minutes. For each phone video it opens /?arlab, starts V1's engine with the AR
// compositor, and at every sample time of labs/ar/moves.ts EVAL_SAMPLES seeks, lets the held frame
// settle, and calls window.__arlab.evaluateAt (alignment + silhouette offsets). The kiosk-camera
// videos (cam-*.mp4) are played through for the camera intrinsics (focal estimate) and sampled
// every few seconds for alignment.
//
// Privacy: the user's frames never leave the browser. --sheets writes mask-only silhouettes
// (ours red, real green; no photo pixels) to .cache/v2/ (gitignored) for local inspection. The
// JSON holds numbers only.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { acquireBrowserSlot } from '../../../../../../scripts/lookdev/browser-slot.mjs';

const ROOT = resolve(import.meta.dirname, '../../../../../..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const PORT = Number(arg('--port', '5765'));
if (PORT < 5765 || PORT > 5769) throw new Error('V2 uses ports 5765–5769');
const OUT = resolve(ROOT, arg('--out', 'docs/validation/tryon-ar-eval.json'));
const SHEETS = args.includes('--sheets');
const WANTED = arg('--videos', 'parka,puffer,cam').split(',');
// The machine-wide rule is <= 10 min per browser slot: run one --videos group per slot (--merge).
const LOCK_BUDGET_MS = 9.5 * 60 * 1000;
const MERGE = args.includes('--merge');
const SHEET_DIR = join(ROOT, '.cache/v2');

const VIDEOS = [
  {
    key: 'parka',
    product: 'FB7675',
    folder: 'FB7675-100-parka-trang',
    name: 'video/video-parka.mp4',
    kind: 'phone',
  },
  {
    key: 'puffer',
    product: 'DQ4920',
    folder: 'DQ4920-206-puffer-kem',
    name: 'video/video-puffer.mp4',
    kind: 'phone',
  },
  {
    key: 'cam-tshirt',
    group: 'cam',
    product: 'FB7675',
    folder: 'FB7675-100-parka-trang',
    name: 'video/cam-tshirt.mp4',
    kind: 'kiosk-camera',
  },
  {
    key: 'cam-parka',
    group: 'cam',
    product: 'FB7675',
    folder: 'FB7675-100-parka-trang',
    name: 'video/cam-parka.mp4',
    kind: 'kiosk-camera',
  },
].filter((v) => WANTED.includes(v.key) || WANTED.includes(v.group ?? ''));

// The user's height/weight live only in the gitignored toi.txt; read locally, never written out.
function person() {
  const text = readFileSync(join(ROOT, 'data/reference-photos/toi.txt'), 'utf8');
  const h = Number(/height_cm:\s*([\d.]+)/.exec(text)?.[1]);
  const w = Number(/weight_kg:\s*([\d.]+)/.exec(text)?.[1]);
  const sex = /sex:\s*(male|female)/.exec(text)?.[1] ?? 'male';
  if (!h || !w) throw new Error('data/reference-photos/toi.txt needs height_cm and weight_kg');
  return { h, w, sex };
}

const median = (values) => {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const round = (x, d = 2) => (x === null || x === undefined ? null : Number(x.toFixed(d)));
// Neutral stands (docs/look/video-index.md): played in real time for the steadiness measure.
const STILL = {
  parka: [
    [25, 27.5],
    [30, 32.5],
  ],
  puffer: [
    [36.5, 39],
    [40, 43],
  ],
};
const SIL = ['shoulderL', 'shoulderR', 'sleeveL', 'sleeveR', 'cuffL', 'cuffR', 'hem'];

function summarise(samples) {
  const tracked = samples.filter((s) => s.tracked && s.alignment);
  const out = {
    samples: samples.length,
    tracked: tracked.length,
    posed: samples.filter((s) => s.posed).length,
    alignment: {
      score_median: round(median(tracked.map((s) => s.alignment.score))),
      rms_px_median: round(median(tracked.map((s) => s.alignment.rmsPx)), 1),
      rms_fraction_of_shoulder_width_median: round(
        median(tracked.map((s) => s.alignment.rmsFraction)),
        3,
      ),
      approximate: tracked.filter((s) => s.alignment.approximate).length,
      per_joint_error_px_median: Object.fromEntries(
        ['lShoulder', 'rShoulder', 'lElbow', 'rElbow', 'lWrist', 'rWrist', 'lHip', 'rHip'].map(
          (j) => [
            j,
            round(
              median(tracked.map((s) => s.alignment.perJoint[j]?.errorPx).filter((x) => x != null)),
              1,
            ),
          ],
        ),
      ),
    },
    silhouette_cm_median: {},
    silhouette_px_median: {},
    silhouette_n: {},
    displayed_silhouette_cm_median: {},
    displayed_silhouette_px_median: {},
    iou_median: round(median(tracked.map((s) => s.silhouette?.iou).filter((x) => x != null)), 3),
    framing: {
      samples_with_arm_landmark_out_of_frame: tracked.filter((s) => s.framing?.outOfFrame.length)
        .length,
      samples_with_arm_landmark_visibility_below_0_5: tracked.filter(
        (s) => s.framing?.lowVisibility.length,
      ).length,
      confidence_median: Object.fromEntries(
        ['shoulder_L_elevation', 'shoulder_R_elevation', 'elbow_L_flexion', 'elbow_R_flexion'].map(
          (k) => [k, round(median(tracked.map((s) => s.framing?.confidence[k])), 2)],
        ),
      ),
    },
    kiosk_look_samples: tracked.filter((s) => s.kioskLook).length,
  };
  for (const k of SIL) {
    const cm = tracked.map((s) => s.silhouette?.cm[k]).filter((x) => x != null);
    const px = tracked.map((s) => s.silhouette?.px[k]).filter((x) => x != null);
    out.silhouette_cm_median[k] = round(median(cm), 1);
    out.silhouette_px_median[k] = round(median(px), 1);
    out.silhouette_n[k] = cm.length;
    // The DISPLAYED overlay (glued layers): what the person sees.
    const gcm = tracked.map((s) => s.silhouetteGlued?.cm[k]).filter((x) => x != null);
    const gpx = tracked.map((s) => s.silhouetteGlued?.px[k]).filter((x) => x != null);
    out.displayed_silhouette_cm_median[k] = round(median(gcm), 1);
    out.displayed_silhouette_px_median[k] = round(median(gpx), 1);
  }
  out.displayed_iou_median = round(
    median(tracked.map((s) => s.silhouetteGlued?.iou).filter((x) => x != null)),
    3,
  );
  return out;
}

async function openLab(page, video, body) {
  const ref = `${video.folder}|${video.name}`;
  const startAt = video.kind === 'phone' ? (video.key === 'parka' ? 4 : 16) : 1;
  const url =
    `http://127.0.0.1:${PORT}/?arlab&jacket=${video.product}&size=S&h=${body.h}&w=${body.w}` +
    `&sex=${body.sex}&ref=${encodeURIComponent(ref)}&t=${startAt}&nomirror`;
  await page.goto(url);
  await page.waitForFunction(() => window.__arlab, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /^(Start|Restart)$/ }).click();
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const s = await page.evaluate(() => window.__arlab.sample());
    if (s.phase === 'tracking' && s.status === 'drawn') return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function evalPhone(page, video, samplesByMove, deadline) {
  const moves = {};
  const all = [];
  for (const [move, times] of samplesByMove) {
    moves[move] = [];
    for (const t of times) {
      if (Date.now() > deadline) break;
      const r = await page.evaluate(
        ({ t, sheet }) => window.__arlab.evaluateAt(t, { settleMs: 1000, sheet }),
        { t, sheet: SHEETS },
      );
      if (r.sheet) {
        const png = Buffer.from(r.sheet.split(',')[1], 'base64');
        writeFileSync(join(SHEET_DIR, `eval-${video.key}-${move}-${t}.png`), png);
      }
      delete r.sheet;
      moves[move].push(r);
      all.push(r);
      const a = r.alignment;
      console.log(
        `${video.key} ${move} t=${t}: align ${a ? a.score.toFixed(2) : '–'} rms ${a ? a.rmsPx.toFixed(1) : '–'} px` +
          (r.silhouette
            ? ` | cm ${SIL.map((k) => `${k} ${r.silhouette.cm[k] === null ? '–' : r.silhouette.cm[k].toFixed(1)}`).join(' ')} iou ${r.silhouette.iou?.toFixed(2)}`
            : ` | ${r.silhouetteError ?? 'untracked'}`),
      );
    }
  }
  return { moves, all };
}

async function evalCam(page, video, deadline) {
  // Play through (real time) so the focal keyframes come from real motion, sampling numbers.
  const duration = await page.evaluate(() => window.__arlab.engine.currentSource.video.duration);
  await page.evaluate(() => {
    const v = window.__arlab.engine.currentSource.video;
    v.currentTime = 0.5;
    v.loop = false;
    return v.play();
  });
  const trace = [];
  const t0 = Date.now();
  while (Date.now() < deadline && Date.now() - t0 < (duration + 2) * 1000) {
    await page.waitForTimeout(500);
    const s = await page.evaluate(() => window.__arlab.sample());
    trace.push({
      t: s.t,
      tracked: !!s.alignment,
      posed: s.phase === 'tracking',
      alignment: s.alignment,
      depthM: s.depthM,
    });
    if (s.t >= duration - 0.1) break;
  }
  const end = await page.evaluate(() => window.__arlab.sample());
  const silhouettes = [];
  if (video.key === 'cam-parka')
    for (let t = 2; t < duration - 0.5 && Date.now() < deadline; t += Math.max(2, duration / 8)) {
      const r = await page.evaluate(
        ({ t, sheet }) => window.__arlab.evaluateAt(t, { settleMs: 1000, sheet }),
        { t, sheet: SHEETS },
      );
      if (r.sheet) {
        writeFileSync(
          join(SHEET_DIR, `eval-${video.key}-${t.toFixed(1)}.png`),
          Buffer.from(r.sheet.split(',')[1], 'base64'),
        );
      }
      delete r.sheet;
      silhouettes.push(r);
    }
  const frame = await page.evaluate(() => {
    const f = window.__arlab.engine.lastFrame;
    return f ? { width: f.width, height: f.height } : null;
  });
  return { duration, frame, focal: end.focal, tilt: end.tilt, trace, silhouettes };
}

const body = person();
mkdirSync(SHEET_DIR, { recursive: true });
const release = await acquireBrowserSlot('V2 ar-eval');
const deadline = Date.now() + LOCK_BUDGET_MS;
const report = {
  generated: new Date().toISOString(),
  method:
    'AR overlay (apps/web/src/engine/live/ar): posed body joints (V1 LiveAvatar) vs MediaPipe ' +
    'pose landmarks; robust pinhole solve (yaw, pitch, roll, translation; focal from keyframes ' +
    'with a 75° diagonal-FOV prior); One Euro smoothing. Alignment = RMS reprojection error of ' +
    'shoulders/elbows/wrists/hips of the DRAWN pose, px and fraction of projected shoulder width. ' +
    'Silhouette = drawn jacket mask vs real jacket mask (person segmentation ∩ chest colour), ' +
    'for the 3D render before the glue (silhouette_*) and for the displayed glued overlay ' +
    '(displayed_silhouette_*); the finisher (look only) is off in the lab. ' +
    'signed offsets ours − real: shoulder + = ours lower, sleeve + = ours sticks out further, ' +
    'cuff + = ours longer, hem + = ours lower; cm via the solved px per metre at the body depth.',
  body: 'the user, fitted from height/weight (data/reference-photos/toi.txt, local only); size S',
  videos: {},
};
let context;
try {
  context = await chromium.launchPersistentContext(join(ROOT, '.cache/playwright/v2-chrome'), {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1500, height: 900 },
    args: [
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  const { EVAL_SAMPLES } = await import('../moves.ts').catch(() => ({ EVAL_SAMPLES: null }));
  const samplesTable = EVAL_SAMPLES ?? JSON.parse(arg('--samples-json', 'null'));
  for (const video of VIDEOS) {
    if (Date.now() > deadline) {
      report.videos[video.key] = { skipped: 'browser lock budget (14 min) used up' };
      continue;
    }
    console.log(`\n== ${video.key}`);
    const ok = await openLab(page, video, body);
    if (!ok) {
      report.videos[video.key] = { error: 'did not reach tracking within 60 s' };
      continue;
    }
    if (video.kind === 'phone') {
      const table = samplesTable[video.name.split('/').pop()];
      // Steadiness first (real-time playback of the neutral stand), then the per-move samples.
      const still = [];
      for (const [t0, t1] of STILL[video.key] ?? []) {
        if (Date.now() > deadline) break;
        const r = await page.evaluate(([a, b]) => window.__arlab.stillness(a, b), [t0, t1]);
        console.log(
          `${video.key} still ${t0}-${t1}s: drawn ${JSON.stringify(r.drawnJitterPx)} landmarks ${JSON.stringify(r.landmarkJitterPx)}`,
        );
        still.push(r);
      }
      const { moves, all } = await evalPhone(page, video, table.moves, deadline);
      const end = await page.evaluate(() => window.__arlab.sample());
      report.videos[video.key] = {
        kind: video.kind,
        focal: end.focal,
        tilt_deg: end.tilt,
        fps: end.stats,
        engine: end.engine,
        stillness: still,
        overall: summarise(all),
        moves: Object.fromEntries(Object.entries(moves).map(([m, s]) => [m, summarise(s)])),
        samples: all,
      };
    } else {
      const r = await evalCam(page, video, deadline);
      report.videos[video.key] = {
        kind: video.kind,
        ...r,
        alignment: summarise(r.trace.map((s) => ({ ...s, tracked: s.tracked }))).alignment,
        silhouette: r.silhouettes.length ? summarise(r.silhouettes) : null,
      };
    }
  }
} finally {
  await context?.close().catch(() => undefined);
  release();
}
mkdirSync(dirname(OUT), { recursive: true });
if (MERGE) {
  // Keep the other videos' results from earlier slots.
  try {
    const previous = JSON.parse(readFileSync(OUT, 'utf8'));
    report.videos = { ...previous.videos, ...report.videos };
  } catch {
    /* no earlier file */
  }
}
writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
console.log(`\nwrote ${OUT}`);
