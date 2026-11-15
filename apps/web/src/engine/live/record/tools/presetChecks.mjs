// Preset bit-identity checks after V3's custom-motion changes, run inside the machine-wide browser
// lock (prompts/12 §2: heavy CPU only inside a lock window):
//   1. bakeCheck.mjs: JS vs WebAssembly bakes of presets must hash identically;
//   2. scripts/motion-validate.mjs: every (preset, size) bake hash on the P2 fixture, compared with
//      the stored run .cache/codex-motion/<baseline>.json.
//   node apps/web/src/engine/live/record/tools/presetChecks.mjs [--baseline e5-final] [--priority]
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../../../../..');
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const baseline = opt('--baseline', 'e5-final');
if (!/^[a-z0-9-]{1,32}$/.test(baseline)) throw new Error('bad baseline name');
const LOCK = join(root, '.cache/locks/browser');
const log = (m) => console.log(`[v3-presets] ${m}`);
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

async function acquire() {
  mkdirSync(join(root, '.cache/locks'), { recursive: true });
  for (let i = 0; i < 30; i++) {
    const free = await Promise.all([5720, 5730, 5740, 5745, 5750, 8011].map(portFree));
    const ram = freemem() / 2 ** 30;
    if (free.every(Boolean) && (ram >= 2.5 || args.includes('--priority'))) {
      try {
        mkdirSync(LOCK);
        writeFileSync(join(LOCK, 'owner.txt'), `V3 ${process.pid} ${new Date().toISOString()}\n`);
        log(`took the lock (free RAM ${ram.toFixed(1)} GiB)`);
        return;
      } catch {
        /* held */
      }
    }
    log('waiting for the lock');
    await sleep(60e3);
  }
  throw new Error('lock unavailable');
}
function release() {
  try {
    if (readFileSync(join(LOCK, 'owner.txt'), 'utf8').startsWith(`V3 ${process.pid} `))
      rmSync(LOCK, { recursive: true, force: true });
  } catch {
    /* not ours */
  }
}

async function main() {
  await acquire();
  const watchdog = setTimeout(() => {
    release();
    process.exit(2);
  }, 14.5 * 60e3);
  try {
    const run = (file, extra) =>
      spawnSync(process.execPath, [join(root, file), ...extra], { cwd: root, encoding: 'utf8' });
    log('bakeCheck: JS vs WebAssembly, S, reach_up_both + cross_arms, first 60 frames');
    const check = run('apps/web/src/engine/motion/wasm/bakeCheck.mjs', [
      '--sizes',
      'S',
      '--motions',
      'reach_up_both,cross_arms',
      '--frames',
      '60',
      '--out',
      join(root, '.cache/v3/bakecheck.json'),
    ]);
    log(`bakeCheck exit ${check.status}`);
    process.stdout.write(check.stdout.split('\n').slice(-6).join('\n') + '\n');
    log('motion-validate: every preset, S and M (WebAssembly)');
    const validate = run('scripts/motion-validate.mjs', ['v3-presets']);
    log(`motion-validate exit ${validate.status}`);
    const now = JSON.parse(readFileSync(join(root, '.cache/codex-motion/v3-presets.json'), 'utf8'));
    const before = JSON.parse(
      readFileSync(join(root, `.cache/codex-motion/${baseline}.json`), 'utf8'),
    );
    const rows = now.map((r) => {
      const b = before.find((x) => x.motion === r.motion && x.size === r.size);
      const same = b ? Object.keys(r.hashes).every((k) => r.hashes[k] === b.hashes[k]) : null;
      return { motion: r.motion, size: r.size, identicalToBaseline: same };
    });
    writeFileSync(
      join(root, '.cache/v3/preset-checks.json'),
      JSON.stringify({ baseline, bakeCheckExit: check.status, rows }, null, 1),
    );
    log(
      `${rows.filter((r) => r.identicalToBaseline).length}/${rows.length} preset bakes identical to ${baseline}`,
    );
    for (const r of rows.filter((x) => !x.identicalToBaseline))
      log(`DIFFERS: ${r.motion} ${r.size}`);
  } finally {
    clearTimeout(watchdog);
    release();
  }
}
main().catch((e) => {
  console.error(e);
  release();
  process.exit(1);
});
