// Native raw-landmark qualification without Vite: serve only fixed local installed model assets.
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { acquireBrowserSlot } from './lookdev/browser-slot.mjs';
import { syncWorker } from './codex-day-slot.mjs';

const ROOT = resolve(import.meta.dirname, '..'),
  out = join(ROOT, '.cache/cx-day/venue');
execFileSync('git', ['check-ignore', '-q', join(out, 'probe.json')], { cwd: ROOT });
mkdirSync(out, { recursive: true });
const files = ['FB7675-100-parka-trang', 'DQ4920-206-puffer-kem']
  .flatMap((folder) =>
    ['cam-still', 'venue-mac-ao', 'venue-khong-ao'].map(
      (name) => `data/reference-photos/${folder}/video/${name}.mp4`,
    ),
  )
  .filter((f) => existsSync(join(ROOT, f)));
const report = {
  generatedUtc: new Date().toISOString(),
  rows: [],
  method:
    'Native first2-10s raw full/GPU VIDEO landmarks; no model resize/crop or garment/filter. Person masks enabled and closed. No performance measurement.',
};
let release, server, context, timer;
try {
  if (files.length) {
    syncWorker('CX-DAY', 'SLOT REQUEST P22 raw venue still qualification without Vite');
    readFileSync(join(ROOT, 'docs/requests/codex-sync.md'), 'utf8');
    release = await acquireBrowserSlot('CX-DAY P22 venue raw landmarks');
    const wasm = join(ROOT, 'apps/web/public/vision/mediapipe/wasm');
    const routes = new Map([
      ['/vision.mjs', join(ROOT, 'node_modules/@mediapipe/tasks-vision/vision_bundle.mjs')],
      ['/pose.task', join(ROOT, 'apps/web/public/vision/models/pose_landmarker_full.task')],
      ...readdirSync(wasm)
        .filter((n) => /^[a-zA-Z0-9_.-]+\.(?:js|mjs|wasm)$/.test(n))
        .map((n) => [`/wasm/${n}`, join(wasm, n)]),
    ]);
    server = createServer((req, res) => {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (path === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<input type="file">');
        return;
      }
      const file = routes.get(path);
      if (!file) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.setHeader(
        'Content-Type',
        file.endsWith('.wasm')
          ? 'application/wasm'
          : file.endsWith('.task')
            ? 'application/octet-stream'
            : 'text/javascript',
      );
      res.end(readFileSync(file));
    });
    await new Promise((ok, bad) => {
      server.once('error', bad);
      server.listen(5773, '127.0.0.1', ok);
    });
    const { chromium } = await import('playwright');
    context = await chromium.launchPersistentContext(join(out, 'chrome-raw'), {
      channel: 'chrome',
      headless: false,
      args: [
        '--disable-background-networking',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    timer = setTimeout(() => void context.close(), 120000);
    await context.route('**/*', (route) => {
      const u = new URL(route.request().url());
      return u.hostname === '127.0.0.1' || ['blob:', 'data:'].includes(u.protocol)
        ? route.continue()
        : route.abort();
    });
    for (const file of files) {
      const page = await context.newPage();
      try {
        await page.goto('http://127.0.0.1:5773');
        await page.locator('input').setInputFiles(join(ROOT, file));
        const result = await page.evaluate(async () => {
          const { FilesetResolver, PoseLandmarker } = await import('/vision.mjs');
          const fileset = await FilesetResolver.forVisionTasks('/wasm');
          const task = await PoseLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: '/pose.task', delegate: 'GPU' },
            runningMode: 'VIDEO',
            numPoses: 1,
            minPoseDetectionConfidence: 0.5,
            minPosePresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
            outputSegmentationMasks: true,
          });
          const warm = document.createElement('canvas');
          warm.width = warm.height = 64;
          warm.getContext('2d').fillRect(0, 0, 64, 64);
          const warmed = task.detectForVideo(warm, 1);
          for (const mask of warmed.segmentationMasks ?? []) mask.close();
          // All confidence values above are MediaPipe defaults, matching poseTracker.ts.
          const v = document.createElement('video');
          v.muted = true;
          v.playsInline = true;
          const url = URL.createObjectURL(document.querySelector('input').files[0]);
          v.src = url;
          const frames = [];
          let handle,
            lastTimestamp = 1;
          try {
            await new Promise((ok, bad) => {
              v.onloadeddata = ok;
              v.onerror = bad;
            });
            await new Promise((ok) => {
              v.addEventListener('seeked', ok, { once: true });
              v.currentTime = 2;
            });
            await v.play();
            await new Promise((ok, bad) => {
              const tick = (now, metadata) => {
                try {
                  if (v.currentTime >= Math.min(10, v.duration - 2) || v.ended) return ok();
                  lastTimestamp = Math.max(now, lastTimestamp + 1);
                  const result = task.detectForVideo(v, lastTimestamp);
                  frames.push({
                    videoMs: metadata.mediaTime * 1000,
                    cameraFrameIndex: metadata.presentedFrames,
                    lm:
                      result.landmarks[0]?.map((p) => ({
                        x: p.x * v.videoWidth,
                        y: p.y * v.videoHeight,
                        visibility: p.visibility,
                      })) ?? null,
                  });
                  for (const mask of result.segmentationMasks ?? []) mask.close();
                  handle = v.requestVideoFrameCallback(tick);
                } catch (error) {
                  bad(error);
                }
              };
              handle = v.requestVideoFrameCallback(tick);
            });
            return { frames, width: v.videoWidth, height: v.videoHeight };
          } finally {
            if (handle) v.cancelVideoFrameCallback(handle);
            v.pause();
            v.removeAttribute('src');
            v.load();
            URL.revokeObjectURL(url);
            task.close();
          }
        });
        const id = file.replace(/^data\//, '').replace(/[^a-zA-Z0-9_.-]/g, '_');
        writeFileSync(join(out, `${id}-landmarks.json`), JSON.stringify(result));
        report.rows.push({
          file,
          frames: result.frames.length,
          detected: result.frames.filter((f) => f.lm).length,
        });
      } catch (error) {
        report.rows.push({ file, error: error.message.split('\n')[0] });
      } finally {
        await page.close();
      }
    }
  }
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  try {
    await context?.close();
  } finally {
    try {
      if (server) await new Promise((ok) => server.close(ok));
    } finally {
      if (release) {
        release();
        syncWorker('CX-DAY', 'SLOT RELEASE P22 venue raw landmarks');
      }
    }
  }
  writeFileSync(join(out, 'landmark-run.json'), JSON.stringify(report, null, 2) + '\n');
}
if (report.rows.some((r) => r.error)) process.exitCode = 1;
console.log(JSON.stringify(report, null, 2));
