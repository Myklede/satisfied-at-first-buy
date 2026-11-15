// V3 "Record a move" evaluation on the user's own reference video (prompt 14, step 4).
//   node apps/web/src/engine/live/record/tools/videoEval.mjs [--label run1] [--moves reach,cross]
//        [--parity reach_up_both] [--delegate GPU|CPU] [--calibrate-at 30.5]
// Holds the machine-wide browser lock (prompts/12 §2: ports and RAM checked, at most 15 min),
// serves apps/web with vite on 5770 (V3's ports 5770-5774), runs videoEval.html in Chrome with
// every non-loopback request blocked, and stops everything it started.
// Privacy: the person's figures are read from the gitignored data/reference-photos/toi.txt and
// used in memory only. Every output (numbers, avatar renders) goes to the gitignored .cache/v3/.
// The committed evidence is written separately, numbers only (see docs/STATUS-tryon-physics.md).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../../../../../../..');
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const label = opt('--label', 'run');
if (!/^[a-z0-9-]{1,32}$/.test(label)) throw new Error('--label must be [a-z0-9-]');
const PORT = 5770;
const LOCK = join(root, '.cache/locks/browser');
const OUT = join(root, '.cache/v3');
const MAX_LOCK_MS = 14.5 * 60e3;
const log = (m) => console.log(`[v3] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The person in the video (local file, never written anywhere).
function person() {
  const text = readFileSync(join(root, 'data/reference-photos/toi.txt'), 'utf8');
  const field = (key) => new RegExp(`^${key}:\\s*([^\\s#]+)`, 'm').exec(text)?.[1];
  const height = Number(field('height_cm')),
    weight = Number(field('weight_kg')),
    sex = field('sex'),
    size = field('parka_size_worn');
  if (!(height > 0 && weight > 0) || !['male', 'female'].includes(sex) || !size)
    throw new Error('toi.txt is missing height_cm / weight_kg / sex / parka_size_worn');
  return { person: { height_cm: height, weight_kg: weight, sex }, size };
}

const MOVES = {
  reach: { id: 'reach_up_both', label: 'Reach up both (video 47-50 s)', from: 47, to: 52 },
  cross: { id: 'cross_arms', label: 'Cross arms (video 66-68 s)', from: 65.5, to: 69.5 },
  final: {
    id: 'reach_up_both_final',
    label: 'Reach up both, final (video 213-218 s)',
    from: 212.5,
    to: 217.5,
  },
};

const portFree = (port) =>
  new Promise((done) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      done(false);
    });
    socket.once('error', () => done(true));
  });

async function acquireLock() {
  mkdirSync(join(root, '.cache/locks'), { recursive: true });
  for (let attempt = 0; attempt < 30; attempt++) {
    const ports = [5720, 5730, 5740, 5745, 5750, 8011];
    const free = await Promise.all(ports.map(portFree));
    const ram = freemem() / 2 ** 30;
    // --priority: a slot granted by the lead; the RAM floor is reported instead of awaited.
    if (free.every(Boolean) && (ram >= 2.5 || args.includes('--priority'))) {
      try {
        mkdirSync(LOCK);
        writeFileSync(join(LOCK, 'owner.txt'), `V3 ${process.pid} ${new Date().toISOString()}\n`);
        log(`took the browser lock (free RAM ${ram.toFixed(1)} GiB)`);
        return ram;
      } catch {
        /* held by someone else */
      }
    }
    const busy = ports.filter((_, i) => !free[i]);
    log(
      `waiting for the browser lock (lock ${existsSync(LOCK) ? 'held' : 'free'}, busy ports ` +
        `${busy.join(',') || 'none'}, free RAM ${ram.toFixed(1)} GiB)`,
    );
    await sleep(60e3);
  }
  throw new Error('The browser lock stayed unavailable for 30 minutes');
}

function releaseLock() {
  try {
    const owner = readFileSync(join(LOCK, 'owner.txt'), 'utf8');
    if (owner.startsWith(`V3 ${process.pid} `)) rmSync(LOCK, { recursive: true, force: true });
  } catch {
    /* not ours or already gone */
  }
}

async function waitHttp(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`${url} did not come up`);
}

async function main() {
  const { person: who, size } = person();
  if (!(await portFree(PORT))) throw new Error(`Port ${PORT} is busy`);
  const config = {
    video: '/sandbox/ref?folder=FB7675-100-parka-trang&name=video/video-parka.mp4',
    person: who,
    productStyle: 'FB7675-100',
    size,
    layer: 'hoodie', // the user wears a grey hoodie under the parka in this video
    calibrateAt: Number(opt('--calibrate-at', '30.5')),
    moves: opt('--moves', 'reach,cross')
      .split(',')
      .map((k) => ({ ...MOVES[k], renders: true })),
    parityPreset:
      opt('--parity', 'reach_up_both') === 'none' ? null : opt('--parity', 'reach_up_both'),
    delegate: opt('--delegate', 'GPU'),
  };
  if (config.moves.some((m) => !m.id)) throw new Error('--moves takes reach,cross,final');
  const ramAtLock = await acquireLock();
  const started = Date.now();
  let vite, context;
  const watchdog = setTimeout(() => {
    log('lock time limit reached: stopping');
    context?.close().catch(() => undefined);
    vite?.kill();
    releaseLock();
    process.exit(2);
  }, MAX_LOCK_MS);
  try {
    vite = spawn(
      process.execPath,
      [
        join(root, 'node_modules/vite/bin/vite.js'),
        '--config',
        join(import.meta.dirname, 'vite.eval.config.mjs'),
        '--port',
        String(PORT),
        '--strictPort',
      ],
      { cwd: root, env: { ...process.env, SATISFY_WEB_PORT: String(PORT) }, stdio: 'ignore' },
    );
    const page_url = `http://127.0.0.1:${PORT}/src/engine/live/record/tools/videoEval.html`;
    await waitHttp(page_url, 60e3);
    context = await chromium.launchPersistentContext(join(OUT, 'chrome'), {
      channel: 'chrome',
      headless: false,
      viewport: { width: 640, height: 480 },
      args: [
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      return ['127.0.0.1', 'localhost'].includes(url.hostname) ||
        ['data:', 'blob:'].includes(url.protocol)
        ? route.continue()
        : route.abort('blockedbyclient');
    });
    const page = context.pages()[0] ?? (await context.newPage());
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
      else if (m.text().startsWith('[v3]')) log(`page: ${m.text().slice(5)}`);
    });
    await page.goto(page_url);
    await page.waitForFunction(() => window.v3Status === 'ready', null, { timeout: 60e3 });
    const result = await page.evaluate((c) => window.v3Eval(c), config);
    mkdirSync(join(OUT, label), { recursive: true });
    for (const move of result.moves) {
      for (const [key, url] of Object.entries(move.images ?? {}))
        writeFileSync(
          join(OUT, label, `${move.id}-${key}.png`),
          Buffer.from(url.split(',')[1], 'base64'),
        );
      move.images = Object.keys(move.images ?? {});
    }
    result.errors = errors;
    result.lockSeconds = Math.round((Date.now() - started) / 1000);
    result.freeRamAtLockGiB = Number(ramAtLock.toFixed(1));
    writeFileSync(join(OUT, `eval-${label}.json`), JSON.stringify(result, null, 1) + '\n');
    log(`wrote .cache/v3/eval-${label}.json (${result.lockSeconds} s under the lock)`);
    for (const m of result.moves.filter((x) => x.refusedRecording))
      log(`${m.id}: recording refused before baking: ${m.refusedRecording}`);
    for (const m of result.moves.filter((x) => !x.refusedRecording))
      log(
        `${m.id}: poses ${m.poses}, sleeves ${m.sleeves.valid ? 'ok' : 'LOST'} ` +
          `(max ride-up L ${m.sleeves.maxRideUpCm.L.toFixed(1)} R ${m.sleeves.maxRideUpCm.R.toFixed(1)} cm), ` +
          `bake ${m.bake.wallMs} ms${m.rejected ? `; rejected: ${m.rejected}` : ''}`,
      );
    if (result.parity) log(`parity: ${JSON.stringify(result.parity)}`);
    if (errors.length) log(`page errors: ${errors.slice(0, 5).join(' | ')}`);
  } finally {
    clearTimeout(watchdog);
    await context?.close().catch(() => undefined);
    vite?.kill();
    releaseLock();
  }
}

main().catch((error) => {
  console.error(error);
  releaseLock();
  process.exit(1);
});
