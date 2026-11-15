// Local white-paper RGB/exposure probe. Unknown paper normals cannot recover 3D light direction.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { acquireBrowserSlot } from './lookdev/browser-slot.mjs';
import { syncWorker } from './codex-day-slot.mjs';
import { whiteBalance } from './ar-venue-lib.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const dir = join(ROOT, 'data/test-videos/venue'),
  out = join(ROOT, '.cache/cx-day/venue');
execFileSync('git', ['check-ignore', '-q', join(out, 'light.json')], { cwd: ROOT });
mkdirSync(out, { recursive: true });
const cached = process.argv.includes('--cached');
const report =
  cached && existsSync(join(out, 'light.json'))
    ? JSON.parse(readFileSync(join(out, 'light.json'), 'utf8'))
    : {
        generatedUtc: new Date().toISOString(),
        status: 'PENDING: both venue light clips required',
        samples: [],
        dominantDirection: null,
        directionReason:
          'No calibrated paper normals; image brightness gradient is not a physical 3D light direction.',
        rendererComparison: null,
      };
let release, context, timer;
try {
  const background = existsSync(join(dir, '00-nen-trong.mp4'))
    ? join(dir, '00-nen-trong.mp4')
    : join(ROOT, 'data/reference-photos/FB7675-100-parka-trang/video/venue-khong-ao.mp4');
  const files = [join(dir, '00-giay-trang.mp4'), background];
  if (!cached && files.every((f) => existsSync(f))) {
    syncWorker('CX-DAY', 'SLOT REQUEST P22 venue RGB light probe');
    release = await acquireBrowserSlot('CX-DAY P22 venue light');
    const { chromium } = await import('playwright');
    context = await chromium.launchPersistentContext(join(out, 'chrome-light'), {
      channel: 'chrome',
      headless: false,
      args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND'],
    });
    timer = setTimeout(() => void context.close(), 60000);
    const page = await context.newPage();
    await context.route('**/*', (route) =>
      ['blob:', 'data:', 'about:'].includes(new URL(route.request().url()).protocol)
        ? route.continue()
        : route.abort(),
    );
    await page.setContent('<input type="file">');
    for (const file of files) {
      await page.locator('input').setInputFiles(file);
      const data = await page.evaluate(async (backgroundPlate) => {
        const video = document.createElement('video');
        video.muted = true;
        const url = URL.createObjectURL(document.querySelector('input').files[0]);
        video.src = url;
        try {
          await new Promise((ok, bad) => {
            video.onloadeddata = ok;
            video.onerror = bad;
          });
          const frames = [];
          // Probe choices, not calibrated renderer thresholds: native pixels, three script fractions.
          for (const sample of backgroundPlate ? [55, 55.5, 56] : [0.2, 0.5, 0.8]) {
            await new Promise((ok) => {
              video.addEventListener('seeked', ok, { once: true });
              video.currentTime = backgroundPlate ? sample : video.duration * sample;
              if (!video.seeking) ok();
            });
            const c = document.createElement('canvas');
            c.width = video.videoWidth;
            c.height = video.videoHeight;
            const ctx = c.getContext('2d');
            ctx.drawImage(video, 0, 0);
            const { data } = ctx.getImageData(0, 0, c.width, c.height);
            const rgb = [0, 0, 0];
            let count = 0,
              weightedX = 0,
              weightedY = 0,
              mass = 0,
              clipped = 0;
            const linear = (v) => {
              const s = v / 255;
              return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            };
            for (let y = Math.floor(c.height * 0.2); y < c.height * 0.8; y++)
              for (let x = Math.floor(c.width * 0.25); x < c.width * 0.75; x++) {
                const i = (y * c.width + x) * 4,
                  v = [data[i], data[i + 1], data[i + 2]];
                if (Math.max(...v) >= 250) {
                  clipped++;
                  continue;
                }
                if (Math.min(...v) < 150 || Math.min(...v) / Math.max(...v) < 0.65) continue;
                const l = v.map(linear),
                  Y = 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
                for (let k = 0; k < 3; k++) rgb[k] += l[k];
                weightedX += (x / c.width - 0.5) * Y;
                weightedY += (0.5 - y / c.height) * Y;
                mass += Y;
                count++;
              }
            frames.push({
              sourceSeconds: video.currentTime,
              candidateWhitePixels: count,
              clippedPixelsExcluded: clipped,
              meanLinearRgb: count ? rgb.map((v) => v / count) : null,
              meanLinearLuminance: count ? mass / count : null,
              imageBrightnessCentroid: mass ? [weightedX / mass, weightedY / mass] : null,
            });
          }
          return frames;
        } finally {
          video.pause();
          video.removeAttribute('src');
          video.load();
          URL.revokeObjectURL(url);
        }
      }, file.endsWith('venue-khong-ao.mp4'));
      report.samples.push({
        file: file.slice(ROOT.length + 1).replaceAll('\\', '/'),
        frames: data.map((s) => ({
          ...s,
          rgbWhiteBalanceGain: s.meanLinearRgb ? whiteBalance(s.meanLinearRgb) : null,
        })),
      });
    }
    report.status =
      'HEURISTIC RGB/EXPOSURE ONLY; inspect central bright neutral-pixel selection before using as paper white';
    const rendererFile = join(out, 'renderer-light.json');
    if (existsSync(rendererFile))
      report.rendererComparison = JSON.parse(readFileSync(rendererFile, 'utf8'));
  }
} catch (error) {
  report.error = error.message.split('\n')[0];
  report.status = 'BLOCKED: local browser probe did not complete';
  syncWorker(
    'CX-DAY',
    'LEAD RUN REQUEST: node scripts/ar-venue-light.mjs ; local browser launch/probe blocked; see .cache/cx-day/venue/light.json.',
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  try {
    await context?.close();
  } finally {
    if (release) {
      release();
      syncWorker('CX-DAY', 'SLOT RELEASE P22 venue light');
    }
  }
  writeFileSync(join(out, 'light.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(
    join(ROOT, 'docs/look/venue-light.md'),
    `# Venue light — P22\n\n${report.status}.\n\n${report.samples.length ? 'Numeric probe: .cache/cx-day/venue/light.json; automatic bright neutral candidates, not confirmed paper pixels. RGB gain uses green/channel on linear sRGB; exposure is relative linear image luminance, not lux.' : 'No light numbers measured: 00-giay-trang.mp4 and 00-nen-trong.mp4 are absent.'}\n\nDominant 3D direction: N/A. ${report.directionReason}\n\nRenderer comparison: ${report.rendererComparison ? 'runtime numeric capture retained in private light.json' : 'N/A: no runtime finisher.light or SH L1 sample captured'}. Existing finisher/light.ts fits face shading with an assumed 45-degree elevation; it cannot be treated as calibrated venue ground truth. No renderer configuration changed.\n\nReproduce: node scripts/ar-venue-light.mjs. Optional numeric renderer capture: .cache/cx-day/venue/renderer-light.json.\n`,
  );
  if (report.samples.length) {
    const rows = report.samples.flatMap((sample) =>
      sample.frames.map(
        (f) =>
          `| ${sample.file.includes('00-giay-trang') ? 'paper candidates' : 'background plate candidates'} | ${f.sourceSeconds.toFixed(6)} | ${f.candidateWhitePixels} | ${f.rgbWhiteBalanceGain?.map((v) => v.toFixed(6)).join(', ') ?? 'N/A'} | ${f.meanLinearLuminance?.toFixed(6) ?? 'N/A'} |`,
      ),
    );
    appendFileSync(
      join(ROOT, 'docs/look/venue-light.md'),
      '\n| source | seconds | candidate pixels | RGB gain | relative linear luminance |\n| --- | --- | --- | --- | --- |\n' +
        rows.join('\n') +
        '\n\nBackground plate fallback: venue-khong-ao.mp4 at55-56s, per lead intake review. These are bright neutral-pixel statistics; background candidates are not a white calibration card.\n',
    );
  }
}
console.log(JSON.stringify(report, null, 2));
