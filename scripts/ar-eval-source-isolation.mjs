// P22: compare exact retained frozen pixels with a newly decoded 2s frame.
// No garment/renderer or temporal pose filter affects these raw joint coordinates.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireBrowserSlot } from './lookdev/browser-slot.mjs';
import { syncWorker } from './codex-day-slot.mjs';

const ROOT = resolve(import.meta.dirname, '..');
export function rawJointSteps(frames) {
  const pairs = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1],
      b = frames[i],
      distances = [];
    for (const k of [11, 12, 13, 14, 15, 16, 23, 24])
      if (a.lm?.[k]?.visibility >= 0.65 && b.lm?.[k]?.visibility >= 0.65)
        distances.push(Math.hypot(a.lm[k].x - b.lm[k].x, a.lm[k].y - b.lm[k].y));
    if (distances.length < 4) continue;
    const gap = b.cameraFrameIndex - a.cameraFrameIndex;
    pairs.push({ stepPx: Math.max(...distances), gap });
  }
  const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
  return {
    observations: frames.length,
    validPairs: pairs.length,
    meanPx: mean(pairs.map((p) => p.stepPx)),
    maxPx: pairs.length ? Math.max(...pairs.map((p) => p.stepPx)) : null,
    meanPxPerCameraFrame: mean(pairs.filter((p) => p.gap > 0).map((p) => p.stepPx / p.gap)),
  };
}

async function sourceProbe({ input, transport }) {
  const { TrackedSource } = await import('/src/engine/live/sources/trackedSource.ts');
  const { videoHandle } = await import('/src/engine/live/sources/videoFileSource.ts');
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  const canvas = document.createElement('canvas');
  const file = document.querySelector('input').files[0];
  const url = URL.createObjectURL(file);
  let stream, source, repeat, off;
  let presentedSeconds = null;
  const frames = [],
    inputMetadata = new Map();
  let measuring = false,
    index = 0;
  try {
    if (input === 'retained') {
      const image = new Image();
      image.src = url;
      await image.decode();
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);
    } else {
      video.src = url;
      await new Promise((ok, bad) => {
        video.onloadeddata = ok;
        video.onerror = bad;
      });
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      // seeked alone can precede a drawable frame. The old probe sometimes copied
      // all-transparent RGBA, making a working tracker appear to return no pose.
      await new Promise((ok, bad) => {
        let handle;
        const timeout = setTimeout(() => {
          video.cancelVideoFrameCallback(handle);
          bad(new Error('No presented source frame after seek'));
        }, 6000);
        const capture = (_now, metadata) => {
          if (video.seeking || metadata.mediaTime < 2) {
            handle = video.requestVideoFrameCallback(capture);
            return;
          }
          try {
            canvas.getContext('2d').drawImage(video, 0, 0);
            presentedSeconds = metadata.mediaTime;
            video.pause();
            clearTimeout(timeout);
            ok();
          } catch (error) {
            clearTimeout(timeout);
            bad(error);
          }
        };
        handle = video.requestVideoFrameCallback(capture);
        video.currentTime = 2;
        void video.play().catch((error) => {
          clearTimeout(timeout);
          video.cancelVideoFrameCallback(handle);
          bad(error);
        });
      });
    }
    const ctx = canvas.getContext('2d'),
      pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    if (!pixels.data.some((value, i) => i % 4 === 3 && value > 0))
      throw new Error('Frozen input is entirely transparent; rejecting invalid no-pose comparison');
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pixels.data)))
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');
    stream = canvas.captureStream(30);
    repeat = setInterval(() => ctx.putImageData(pixels, 0, 0), 1000 / 30);
    video.removeAttribute('src');
    video.srcObject = stream;
    const original = video.requestVideoFrameCallback.bind(video);
    video.requestVideoFrameCallback = (cb) =>
      original((now, metadata) => {
        index = metadata.presentedFrames;
        cb(now, metadata);
      });
    await video.play();
    source = new TrackedSource(
      'video-file',
      async () => {
        const handle = videoHandle(video);
        return {
          ...handle,
          onFrame: (cb) =>
            handle.onFrame((t) => {
              inputMetadata.set(t, index);
              cb(t);
            }),
        };
      },
      { model: 'full', delegate: 'GPU', segmentation: true },
    );
    await source.start();
    off = source.tracker.onRawFrame((raw) => {
      if (!measuring) return;
      frames.push({
        cameraFrameIndex: inputMetadata.get(raw.t),
        lm:
          raw.image?.map((q) => ({
            x: q[0] * raw.width,
            y: q[1] * raw.height,
            visibility: q[3],
          })) ?? null,
      });
    });
    await new Promise((ok) => setTimeout(ok, 2500));
    measuring = true;
    await new Promise((ok) => setTimeout(ok, 4000));
    measuring = false;
    const stats = source.stats();
    return {
      transport,
      presentedSeconds,
      hash,
      width: canvas.width,
      height: canvas.height,
      frames,
      delegate: stats.delegate,
      lastError: stats.lastError ?? null,
    };
  } finally {
    off?.();
    source?.stop();
    clearInterval(repeat);
    for (const track of stream?.getTracks() ?? []) track.stop();
    video.pause();
    video.srcObject = null;
    URL.revokeObjectURL(url);
  }
}

export async function runSourceIsolation() {
  const output = join(ROOT, '.cache/cx-day/p22-isolation');
  execFileSync('git', ['check-ignore', '-q', join(output, 'results.json')], { cwd: ROOT });
  mkdirSync(output, { recursive: true });
  const report = { generatedUtc: new Date().toISOString(), rows: [] };
  const save = () =>
    writeFileSync(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  syncWorker('CX-DAY', 'SLOT REQUEST P22 identical-pixel source isolation');
  readFileSync(join(ROOT, 'docs/requests/codex-sync.md'), 'utf8');
  const release = await acquireBrowserSlot('CX-DAY P22 source isolation');
  let server, context, timer;
  try {
    const { createServer } = await import('vite');
    server = await createServer({
      root: join(ROOT, 'apps/web'),
      configFile: join(ROOT, 'apps/web/vite.config.ts'),
      cacheDir: join(output, 'vite'),
      logLevel: 'error',
      server: {
        host: '127.0.0.1',
        port: 5771,
        strictPort: true,
        hmr: false,
        watch: { ignored: ['**/*'] },
      },
      plugins: [
        {
          name: 'p22-source-probe',
          configureServer(s) {
            s.middlewares.use((req, res, next) => {
              if (!req.url.startsWith('/p22-source.html')) return next();
              res.setHeader('Content-Type', 'text/html');
              res.end('<!doctype html><input type="file">');
            });
          },
        },
      ],
    });
    await server.listen();
    const { chromium } = await import('playwright');
    context = await chromium.launchPersistentContext(join(output, 'chrome'), {
      channel: 'chrome',
      headless: false,
      args: [
        '--disable-background-networking',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    timer = setTimeout(() => void context.close(), 9 * 60000);
    await context.route('**/*', (route) => {
      const u = new URL(route.request().url());
      return ['127.0.0.1', 'localhost'].includes(u.hostname) ||
        ['data:', 'blob:'].includes(u.protocol)
        ? route.continue()
        : route.abort();
    });
    for (const clip of ['cam-tshirt', 'cam-parka'])
      for (const input of ['retained', 'decoded'])
        for (const transport of ['main', 'worker']) {
          const page = await context.newPage();
          const row = { clip, input, transport };
          try {
            await page.goto(
              `http://127.0.0.1:5771/p22-source.html?still=0${transport === 'worker' ? '&poseWorker=1' : ''}`,
            );
            const file =
              input === 'retained'
                ? join(ROOT, `.cache/cx-day/frozen/${clip}.mp4-FB7675-100/s0-f0-00-raw.png`)
                : join(ROOT, `data/reference-photos/FB7675-100-parka-trang/video/${clip}.mp4`);
            await page.locator('input').setInputFiles(file);
            Object.assign(row, await page.evaluate(sourceProbe, { input, transport }));
            row.summary = rawJointSteps(row.frames);
          } catch (error) {
            row.error = error.message;
          } finally {
            await page.close();
          }
          report.rows.push(row);
          save();
          console.log(JSON.stringify({ ...row, frames: undefined }));
        }
  } catch (error) {
    report.error = error.message;
    if (/Access is denied/i.test(error.message))
      syncWorker(
        'CX-DAY',
        'LEAD RUN REQUEST: node scripts/ar-eval-source-isolation.mjs ; Vite/esbuild Access is denied; no retry in sandbox.',
      );
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    try {
      await context?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        save();
        release();
        syncWorker('CX-DAY', 'SLOT RELEASE P22 source isolation');
      }
    }
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await runSourceIsolation();
