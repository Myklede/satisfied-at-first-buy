// Local video decoding only. Existing Playwright + installed Chrome; no server/ffmpeg.
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireBrowserSlot } from './browser-slot.mjs';

export { browserReady, browserReadiness, waitForBrowserSlot } from './browser-slot.mjs';

export const ROOT = resolve(import.meta.dirname, '../..');
export const REFERENCES = join(ROOT, 'data/reference-photos');
export const OUTPUT = join(ROOT, '.cache/lookdev-frames');
// Bound decoded-image/contact-sheet RAM on the 14 GB demo laptop. These are
// resource guards, not colour/temporal accuracy settings.
export const MAX_FRAMES = 600;
const EXTENSIONS = new Set(['.mp4', '.mov', '.webm']);

export function timestamps(duration, { at, every = 2 } = {}) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Video duration must be finite');
  let values;
  if (at !== undefined) {
    if (!Array.isArray(at) || !at.length) throw new Error('--at requires timestamps');
    values = [...new Set(at)].sort((a, b) => a - b);
  } else {
    if (!Number.isFinite(every) || every <= 0) throw new Error('--every must be positive');
    const count = Math.ceil(duration / every);
    if (count > MAX_FRAMES) throw new Error(`More than ${MAX_FRAMES} frames; increase --every`);
    values = Array.from({ length: count }, (_, i) => i * every);
  }
  if (values.length > MAX_FRAMES) throw new Error(`At most ${MAX_FRAMES} frames per video`);
  if (values.some((v) => !Number.isFinite(v) || v < 0 || v >= duration))
    throw new Error('Timestamps must be finite, nonnegative and before the end of the video');
  return values;
}

export function contactLayout(count, columns = 4, cellWidth = 320, cellHeight = 180) {
  if (![count, columns, cellWidth, cellHeight].every((n) => Number.isInteger(n) && n > 0))
    throw new Error('Positive integer layout dimensions required');
  if (count > MAX_FRAMES) throw new Error('Too many contact-sheet frames');
  columns = Math.min(count, columns);
  const gap = 12,
    label = 24;
  return {
    width: gap + columns * (cellWidth + gap),
    height: gap + Math.ceil(count / columns) * (cellHeight + label + gap),
    cells: Array.from({ length: count }, (_, i) => ({
      x: gap + (i % columns) * (cellWidth + gap),
      y: gap + Math.floor(i / columns) * (cellHeight + label + gap),
      width: cellWidth,
      height: cellHeight,
      label,
    })),
  };
}

export function containedRect(sourceWidth, sourceHeight, width, height) {
  if (![sourceWidth, sourceHeight, width, height].every((v) => Number.isFinite(v) && v > 0))
    throw new Error('Positive finite image sizes required');
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const w = sourceWidth * scale,
    h = sourceHeight * scale;
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}

export function resolveVideo(path, root = REFERENCES) {
  const video = realpathSync(resolve(path));
  const base = realpathSync(root),
    rel = relative(base, video);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(base, rel) !== video)
    throw new Error('Video must be inside data/reference-photos (no external symlinks)');
  if (!EXTENSIONS.has(extname(video).toLowerCase())) throw new Error('Expected mp4, mov or webm');
  return video;
}

export function scanVideos(root = REFERENCES) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...scanVideos(path));
    else if (entry.isFile() && EXTENSIONS.has(extname(path).toLowerCase())) files.push(path);
  }
  return files.sort();
}

export async function localBrowser() {
  const release = await acquireBrowserSlot('CX-A video frames');
  try {
    const browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: [
        '--allow-file-access-from-files',
        '--disable-background-networking',
        '--disable-component-update',
        '--no-proxy-server',
        '--host-resolver-rules=MAP * ~NOTFOUND',
        '--disable-background-media-suspend',
        '--disable-renderer-backgrounding',
      ],
    });
    browser.once('disconnected', release);
    return browser;
  } catch (error) {
    release();
    throw error;
  }
}

// Exported for a synthetic integration test. The CLI separately enforces the
// reference-photo root; tests use only a generated video in .cache.
export async function extractVideo(browser, video, options = {}) {
  mkdirSync(OUTPUT, { recursive: true });
  const slug = (s) => s.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80) || 'video';
  const jacket = slug(relative(REFERENCES, video).split(sep)[0]);
  const id = createHash('sha256').update(video).digest('hex').slice(0, 10);
  const parent = join(OUTPUT, jacket, `${slug(basename(video, extname(video)))}-${id}`);
  mkdirSync(parent, { recursive: true });
  const output = mkdtempSync(join(parent, 'run-')); // Never overwrite an earlier export.
  const html = join(output, 'decode.html');
  writeFileSync(html, '<!doctype html><meta charset="utf-8"><title>Local video decoder</title>');
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let nonFileRequests = 0;
  context.on('request', (request) => {
    if (new URL(request.url()).protocol !== 'file:') nonFileRequests++;
  });
  try {
    const page = await context.newPage();
    await page.goto(pathToFileURL(html).href);
    const metadata = await page.evaluate(async (src) => {
      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'auto';
      document.body.append(video);
      await new Promise((yes, no) => {
        video.addEventListener('loadeddata', yes, { once: true });
        video.addEventListener('error', () => no(new Error('Chrome cannot decode this video')), {
          once: true,
        });
        video.src = src;
        setTimeout(() => no(new Error('Video load timed out')), 30000);
      });
      window.decoderVideo = video;
      // MediaRecorder WebM may omit the duration element. Seeking beyond the end
      // lets Chrome discover the last timestamp; no guessed/fake duration.
      if (!Number.isFinite(video.duration)) {
        const seek = (time) =>
          new Promise((yes, no) => {
            const timer = setTimeout(() => no(new Error('Cannot determine video duration')), 10000);
            video.addEventListener(
              'seeked',
              () => {
                clearTimeout(timer);
                yes();
              },
              { once: true },
            );
            video.currentTime = time;
          });
        await seek(1e10);
        await seek(0);
      }
      return { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
    }, pathToFileURL(video).href);
    if (
      !(metadata.width > 0 && metadata.height > 0) ||
      metadata.width * metadata.height > 40_000_000
    )
      throw new Error('Invalid or oversized video dimensions');
    const times = timestamps(metadata.duration, options);
    // Long videos are split into several sheets of `sheetSize` frames so each stays viewable.
    const sheetSize = options.contactSheet
      ? Math.min(options.sheetSize ?? times.length, times.length)
      : 0;
    const [cellW, cellH] = options.cell ?? [320, 180];
    const layouts = [];
    for (let from = 0; sheetSize && from < times.length; from += sheetSize)
      layouts.push(
        contactLayout(Math.min(sheetSize, times.length - from), options.columns ?? 4, cellW, cellH),
      );
    const sheetNames = layouts.map((_, k) =>
      layouts.length === 1
        ? 'contact-sheet.jpg'
        : `contact-sheet-${String(k).padStart(2, '0')}.jpg`,
    );
    if (layouts.length)
      await page.evaluate((all) => {
        window.contactCanvases = all.map(({ width, height }) => {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#202020';
          ctx.fillRect(0, 0, width, height);
          return canvas;
        });
      }, layouts);
    const frames = [];
    for (const [i, target] of times.entries()) {
      const sheet = sheetSize ? Math.floor(i / sheetSize) : -1;
      const cell = sheet >= 0 ? layouts[sheet].cells[i - sheet * sheetSize] : null;
      const fit = cell
        ? containedRect(metadata.width, metadata.height, cell.width, cell.height)
        : null;
      const decoded = await page.evaluate(
        async ({ target, cell, fit, sheet }) => {
          const video = window.decoderVideo;
          let mediaTime = null;
          // File media range reads break if Playwright routing is installed.
          // Frame callbacks can be absent when paused/backgrounded, so readiness
          // (not either event alone) gates canvas sampling.
          const callback = video.requestVideoFrameCallback((_, info) => {
            mediaTime = info.mediaTime;
          });
          if (Math.abs(video.currentTime - target) > 1e-7) {
            video.currentTime = target;
          }
          const deadline = performance.now() + 5000;
          while (video.seeking || video.readyState < 2) {
            if (performance.now() >= deadline) throw new Error('Video seek/readiness timed out');
            await new Promise((done) => setTimeout(done, 50));
          }
          video.cancelVideoFrameCallback(callback);
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          canvas.getContext('2d').drawImage(video, 0, 0);
          if (cell) {
            const ctx = window.contactCanvases[sheet].getContext('2d');
            ctx.drawImage(canvas, cell.x + fit.x, cell.y + fit.y, fit.width, fit.height);
            ctx.fillStyle = 'white';
            ctx.font = '16px sans-serif';
            ctx.fillText(`${target.toFixed(3)} s`, cell.x, cell.y + cell.height + 18);
          }
          return { currentTime: video.currentTime, mediaTime, png: canvas.toDataURL('image/png') };
        },
        { target, cell, fit, sheet },
      );
      const file = `frame-${String(i).padStart(4, '0')}.png`;
      writeFileSync(join(output, file), Buffer.from(decoded.png.split(',')[1], 'base64'));
      frames.push({
        file,
        requested_seconds: target,
        current_time_seconds: decoded.currentTime,
        decoded_media_seconds: decoded.mediaTime,
      });
    }
    for (const [k, name] of sheetNames.entries()) {
      const jpg = await page.evaluate(
        (n) => window.contactCanvases[n].toDataURL('image/jpeg', 0.9),
        k,
      );
      writeFileSync(join(output, name), Buffer.from(jpg.split(',')[1], 'base64'));
    }
    if (nonFileRequests) throw new Error(`Observed ${nonFileRequests} non-file requests`);
    const index = {
      schema_version: 1,
      video: basename(video),
      ...metadata,
      frames,
      contact_sheet: sheetNames[0] ?? null,
      contact_sheets: sheetNames,
      non_file_requests: nonFileRequests,
      note: 'Local frames. decoded_media_seconds is a measured callback timestamp when available, otherwise null; current_time_seconds is the seek position, not a decoder timestamp.',
    };
    writeFileSync(join(output, 'index.json'), JSON.stringify(index, null, 2) + '\n');
    return { output, index };
  } finally {
    await context.close();
  }
}

export function parseArgs(args) {
  const options = {},
    videos = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--contact-sheet') options.contactSheet = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--help') options.help = true;
    else if (arg === '--columns' || arg === '--sheet-size' || arg === '--cell') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} needs a value`);
      const value = args[++i];
      if (arg === '--cell') options.cell = value.split('x').map(Number);
      else if (arg === '--columns') options.columns = Number(value);
      else options.sheetSize = Number(value);
    } else if (arg === '--at' || arg === '--every') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} needs a value`);
      const value = args[++i];
      if (arg === '--at') options.at = value.split(',').map(Number);
      else options.every = Number(value);
    } else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
    else videos.push(arg);
  }
  if (options.at !== undefined && options.every !== undefined)
    throw new Error('Choose --at or --every');
  if (
    options.at?.some((v) => !Number.isFinite(v) || v < 0) ||
    (options.every !== undefined && (!Number.isFinite(options.every) || options.every <= 0))
  )
    throw new Error('Invalid timestamp/interval');
  const positive = (n) => Number.isInteger(n) && n > 0;
  if (
    (options.columns !== undefined && !positive(options.columns)) ||
    (options.sheetSize !== undefined && !positive(options.sheetSize)) ||
    (options.cell !== undefined && !(options.cell.length === 2 && options.cell.every(positive)))
  )
    throw new Error('Invalid --columns/--sheet-size/--cell (use WxH)');
  return { options, videos };
}

export async function main(args = process.argv.slice(2)) {
  const { options, videos } = parseArgs(args);
  if (options.help) {
    console.log(
      'node scripts/lookdev/video-frames.mjs <video...> | --all [--at 0,1,2 | --every 2] [--contact-sheet [--columns 12 --cell 90x160 --sheet-size 72]]',
    );
    return;
  }
  const paths = options.all ? scanVideos() : videos.map((path) => resolveVideo(path));
  if (!paths.length)
    throw new Error('No videos selected/found; put mp4/mov in data/reference-photos/<jacket>/');
  const browser = await localBrowser();
  try {
    for (const path of paths) {
      const { output, index } = await extractVideo(browser, path, options);
      console.log(`${basename(path)}: ${index.frames.length} frames -> ${relative(ROOT, output)}`);
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
