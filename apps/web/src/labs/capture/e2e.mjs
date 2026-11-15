// Fake-device-only integration proof. Saved media stays in the repo-local ignored run directory.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { captureSteps } from '../../../../../scripts/ar-eval-steps.mjs';

export async function runCaptureCheck({ page, context, port, work, result, check, capture }) {
  await page.setViewportSize({ width: 1280, height: 720 });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.detach();
  await page.goto(`http://127.0.0.1:${port}/?arcapture`);
  await page.getByRole('heading', { name: 'AR test capture', exact: true }).waitFor();
  await page.waitForLoadState('networkidle');
  check(
    'capture camera is opt-in',
    await page.evaluate(() => globalThis.__tryonStreams.length === 0),
  );
  const functionalHttp = [];
  const onRequest = (request) => {
    if (/^https?:/.test(request.url())) functionalHttp.push(request.url());
  };
  page.on('request', onRequest);
  const downloads = [];
  const onDownload = (download) => downloads.push(download);
  page.on('download', onDownload);
  try {
    await page.getByLabel('Jacket worn', { exact: true }).fill('synthetic-fake-camera');
    await page.getByRole('button', { name: 'Start camera', exact: true }).click();
    await page.locator('[data-screen="ar-capture"][data-phase="preview"]').waitFor();
    const camera = await page.evaluate(() => {
      const stream = globalThis.__tryonStreams[0];
      const settings = stream?.getVideoTracks()[0]?.getSettings();
      return {
        label: stream?.getVideoTracks()[0]?.label,
        width: settings?.width,
        height: settings?.height,
        audioTracks: stream?.getAudioTracks().length,
      };
    });
    // Refuse before any screenshot or recording if Chrome did not give us the fake device.
    check(
      'capture uses fake video and no microphone',
      /fake|dummy/i.test(camera.label ?? '') && camera.audioTracks === 0,
      JSON.stringify(camera),
    );
    await page.getByRole('button', { name: /Record routine/ }).click();
    await page.locator('[data-screen="ar-capture"][data-phase="recording"]').waitFor();
    await page.waitForTimeout(4000);
    await capture('capture-recording');
    console.log('[tryon] Recording the real 74.5s fake-camera routine; no timer acceleration.');
    await page.waitForFunction(
      () =>
        ['ready', 'error'].includes(
          document.querySelector('[data-screen="ar-capture"]')?.getAttribute('data-phase'),
        ),
      null,
      { timeout: 110000 },
    );
    const phase = await page.locator('[data-screen="ar-capture"]').getAttribute('data-phase');
    check(
      'capture completes',
      phase === 'ready',
      phase === 'error' ? await page.getByRole('alert').innerText() : phase,
    );
    const downloadDeadline = Date.now() + 5000;
    while (downloads.length < 2 && Date.now() < downloadDeadline) await delay(100);
    // Native multiple-download policy can require a separate operator click for each file.
    if (!downloads.some((d) => d.suggestedFilename().endsWith('.webm')))
      await page.getByRole('button', { name: 'Download raw video', exact: true }).click();
    if (!downloads.some((d) => d.suggestedFilename().endsWith('.json')))
      await page.getByRole('button', { name: 'Download manifest', exact: true }).click();
    const finalDeadline = Date.now() + 10000;
    while (downloads.length < 2 && Date.now() < finalDeadline) await delay(100);
    check(
      'capture downloads video and manifest',
      downloads.some((d) => d.suggestedFilename().endsWith('.webm')) &&
        downloads.some((d) => d.suggestedFilename().endsWith('.json')),
    );
    const saved = {};
    for (const download of downloads) {
      const name = download.suggestedFilename();
      if (!/^capture-\d{8}-\d{6}\.(webm|json)$/.test(name))
        throw Error('Unexpected capture filename');
      const path = join(work, name);
      execFileSync('git', ['check-ignore', '--', path], { stdio: 'pipe' });
      await download.saveAs(path);
      saved[name.endsWith('.json') ? 'json' : 'webm'] = path;
    }
    const manifest = JSON.parse(readFileSync(saved.json, 'utf8'));
    const video = readFileSync(saved.webm);
    const steps = captureSteps(manifest);
    check(
      'capture schema and isolated back hold match scorer',
      manifest.schema === 'satisfy-capture' &&
        manifest.version === 1 &&
        steps.length === 12 &&
        steps.some((step) => step.name === 'back_hold' && step.expectedBack),
    );
    check(
      'capture includes actual build and operator garment',
      /^[a-f0-9]{7,64}$/.test(manifest.build?.commit ?? '') &&
        manifest.jacket === 'synthetic-fake-camera',
    );
    check(
      'capture frame timestamps are measured and monotonic',
      manifest.frames.length > 1 &&
        manifest.frames.every(
          (frame, index, frames) =>
            Number.isFinite(frame.tMs) &&
            frame.tMs >= 0 &&
            frame.tMs <= manifest.durationMs &&
            (!index || frame.tMs > frames[index - 1].tMs),
        ),
    );
    check(
      'capture raw WebM and accepted encoding target',
      video.subarray(0, 4).toString('hex') === '1a45dfa3' &&
        manifest.encoding.requestedBitsPerSecond >= 5_000_000 &&
        manifest.encoding.recorderBitsPerSecond >= 5_000_000,
    );
    check(
      'capture reports actual bitrate from file bytes',
      Math.abs(
        manifest.encoding.actualBitsPerSecond -
          (statSync(saved.webm).size * 8000) / manifest.durationMs,
      ) < 1e-6,
    );
    const media = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
      const element = document.createElement('video');
      try {
        await new Promise((resolve, reject) => {
          element.onloadedmetadata = resolve;
          element.onerror = () => reject(Error('Recorded WebM did not decode'));
          element.preload = 'metadata';
          element.src = url;
          element.load();
        });
        return {
          width: element.videoWidth,
          height: element.videoHeight,
          duration: Number.isFinite(element.duration) ? element.duration : null,
        };
      } finally {
        element.removeAttribute('src');
        element.load();
        URL.revokeObjectURL(url);
      }
    }, video.toString('base64'));
    check(
      'capture file preserves raw camera dimensions',
      media.width === camera.width &&
        media.height === camera.height &&
        manifest.camera.width === media.width &&
        manifest.camera.height === media.height,
      JSON.stringify(media),
    );
    await page.waitForFunction(() =>
      globalThis.__tryonStreams.every((stream) =>
        stream.getTracks().every((track) => track.readyState === 'ended'),
      ),
    );
    check('capture completion stops camera', true);
    check(
      'capture makes no functional HTTP requests',
      functionalHttp.length === 0,
      JSON.stringify(functionalHttp),
    );
    result.capture = {
      schema: manifest.schema,
      version: manifest.version,
      videoFilename: manifest.videoFilename,
      build: manifest.build,
      jacket: manifest.jacket,
      camera: manifest.camera,
      frames: manifest.frames.length,
      steps: manifest.steps,
      durationMs: manifest.durationMs,
      encoding: manifest.encoding,
      bytes: video.length,
      sha256: createHash('sha256').update(video).digest('hex'),
      decoded: media,
      savedUnderIgnoredCache: true,
      functionalHttpRequests: functionalHttp,
    };
  } finally {
    page.off('request', onRequest);
    page.off('download', onDownload);
  }
}
