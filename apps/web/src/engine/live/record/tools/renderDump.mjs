// 3-view avatar renders (front / side / back) of dumped bake geometry (hemExperiments.mjs writes
// .cache/v3/render/<preset>-<variant>-{body,cloth}.f32). No camera image is involved; the PNG goes
// to the gitignored .cache/v3/renders/. Holds the browser lock (prompts/12 §2), vite on 5772.
//   node apps/web/src/engine/live/record/tools/renderDump.mjs --name reach-before-after
//        --tags reach_up_both-off,reach_up_both-candLraV [--port5776 --dump-dir .cache/cx-day/physics/dumps/day-p-18]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { acquireTimingSlot } from '../../../../../../../scripts/codex-heavy-slot.mjs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../../../../../../..');
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const dumpRel = opt('--dump-dir', '.cache/v3/render');
if (
  dumpRel !== '.cache/v3/render' &&
  !/^\.cache\/cx-day\/physics\/dumps\/[a-z0-9-]{1,48}$/.test(dumpRel)
)
  throw new Error('Invalid private dump directory');
const dumpDir = join(root, dumpRel);
const name = opt('--name', 'renders');
const tags = opt('--tags', '').split(',').filter(Boolean);
if (
  !/^[a-z0-9_-]{1,48}$/.test(name) ||
  !tags.length ||
  tags.some((t) => !/^[a-zA-Z0-9_-]{1,64}$/.test(t))
)
  throw new Error('bad --name / --tags');
for (const t of tags)
  if (!existsSync(join(dumpDir, `${t}-cloth.f32`))) throw new Error(`no dump for ${t}`);
const PORT = Number(opt('--port', '5776'));
if (![5775, 5776, 5805, 5806, 5807, 5808, 5809].includes(PORT))
  throw new Error('DAY-P port required');
const outDir = opt('--out-dir', '.cache/cx-day/physics');
if (outDir !== '.cache/cx-day/physics') throw new Error('Fixed private output directory required');
const log = (m) => console.log(`[v3-render] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portFree = (port) =>
  new Promise((done) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => {
      s.destroy();
      done(false);
    });
    s.once('error', () => done(true));
  });
const worker = opt('--worker', 'CX-DAY/DAY-P');
let releaseLease = () => {};
async function acquire() {
  if (args.includes('--no-lock')) {
    for (const kind of ['browser', 'heavy']) {
      const owner = readFileSync(join(root, '.cache/locks', kind, 'owner.txt'), 'utf8');
      if (!owner.startsWith(worker + '\n') && !owner.startsWith(worker + ' '))
        throw new Error('Caller must hold both locks as ' + worker);
    }
  } else releaseLease = await acquireTimingSlot(worker, 'physics renders');
}
function release() {
  releaseLease();
}
async function waitHttp(url) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up */
    }
    await sleep(500);
  }
  throw new Error(`${url} did not come up`);
}

async function main() {
  if (!(await portFree(PORT))) throw new Error(`port ${PORT} busy`);
  await acquire();
  let vite, context;
  const watchdog = setTimeout(() => {
    context?.close().catch(() => undefined);
    vite?.kill();
    release();
    process.exit(2);
  }, 10 * 60e3);
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
    const url = `http://127.0.0.1:${PORT}/src/engine/live/record/tools/renderDump.html`;
    await waitHttp(url);
    context = await chromium.launchPersistentContext(join(root, '.cache/v3/chrome'), {
      channel: 'chrome',
      headless: false,
      viewport: { width: 640, height: 480 },
      args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'],
    });
    await context.route('**/*', (route) => {
      const u = new URL(route.request().url());
      return ['127.0.0.1', 'localhost'].includes(u.hostname) ||
        ['data:', 'blob:'].includes(u.protocol)
        ? route.continue()
        : route.abort('blockedbyclient');
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(url);
    await page.waitForFunction(() => window.v3RenderStatus === 'ready', null, { timeout: 60e3 });
    const base = `/@fs/${dumpDir.replace(/\\/g, '/')}`;
    const png = await page.evaluate((c) => window.v3Render(c), { base, tags });
    mkdirSync(join(root, outDir), { recursive: true });
    writeFileSync(join(root, outDir, `${name}.png`), Buffer.from(png.split(',')[1], 'base64'));
    log(`wrote ${outDir}/${name}.png`);
  } finally {
    clearTimeout(watchdog);
    await context?.close().catch(() => undefined);
    vite?.kill();
    release();
  }
}
main().catch((e) => {
  console.error(e);
  release();
  process.exit(1);
});
