// F6 render-service client (AR team, 2026-11-14). Enqueues a job for scripts/ar-render-service.mjs,
// waits, prints the output paths. How-to: docs/requests/render-service.md.
//   node scripts/ar-job.mjs --requester F3X --style FB7675-100 --clip venue-khong-ao \
//        --window 22.6,28 --flags "f3x=1" --strip "270,120,270,200,1.6,18" [--snap 23,25] [--raw]
//        [--still 0|1] [--lane look|timing] [--replay] [--no-wait]
//   node scripts/ar-job.mjs status
//   node scripts/ar-job.mjs timing-begin --requester F5 [--minutes 60]   (service pauses, lock freed)
//   node scripts/ar-job.mjs timing-end --requester F5                    (service resumes)
//   node scripts/ar-job.mjs yield --requester F5 [--max-min 10] [--minutes 60] (between runs)
//   node scripts/ar-job.mjs set-priority F3X,F4X                       (dispatcher: served first)
//   node scripts/ar-job.mjs set-parallel 1|2                            (dispatcher: look lane width)
//   node scripts/ar-job.mjs service-stop                                 (dispatcher: clean stop)
//   node scripts/ar-job.mjs cancel <id>                                  (queued jobs only)
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { testsetClips } from './ar-eval-testset.mjs';

export const SERVICE_DIR = (root) => join(root, '.cache/lead/service');
export const LOOK_MAX_WINDOW_S = 12;
const LONG_MAX_WINDOW_S = 70; // timing-lane jobs and replay recordings (whole venue clip ~65 s)
const STYLES = new Set(['FB7675-100', 'DQ4920-206']);
const REF = 'data/reference-photos/FB7675-100-parka-trang/video';
const NAMED = {
  'venue-khong-ao': `${REF}/venue-khong-ao.mp4`,
  'venue-mac-ao': `${REF}/venue-mac-ao.mp4`,
  'cam-still': `${REF}/cam-still.mp4`,
  'cam-tshirt': `${REF}/cam-tshirt.mp4`,
  'cam-parka': `${REF}/cam-parka.mp4`,
  // The user's live RC2 test (18:11/18:13, 960x540 at 15 fps), re-encoded by F6 from the
  // MediaRecorder VP9 raw.webm (not seekable) to seekable VP8 under .cache (local only, never committed).
  'live-parka': '.cache/lead/service/clips/live-parka.webm',
  'live-puffer': '.cache/lead/service/clips/live-puffer.webm',
  // iPhone via Camo, 1280x720 @ 30 fps (lead 19:20/19:25: reference input for smoothness rows).
  'camo-1': `${REF}/camo/camo-test-1.mp4`,
  // User test #4 raw (21:07, iPhone via Camo, 1280x720 @ 30 fps), re-encoded seekable like live-parka.
  live4: '.cache/lead/service/clips/live4.webm',
  // User test #5 = true RC4 (21:23, iPhone via Camo, 1280x720, 1422 frames / 48.9 s), seekable re-encode.
  live5: '.cache/lead/service/clips/live5.webm',
};
// Same rule as scripts/ar-eval.mjs passThroughFlags: case identity is never a flag.
const PROTECTED = new Set([
  'arlab',
  'jacket',
  'size',
  'h',
  'w',
  'sex',
  'source',
  't',
  'nomirror',
  'mirror',
  'still',
]);

export function clipPath(root, clip) {
  if (NAMED[clip]) return resolve(root, NAMED[clip]);
  const stock = testsetClips(root).find((c) => c.id === clip && /^stock\//.test(c.file));
  if (!stock) throw new Error(`Unknown clip ${clip}`);
  return stock.video;
}

const num = (v) => typeof v === 'number' && Number.isFinite(v);
export function validateJob(root, j) {
  if (!/^\d{13}-[A-Za-z0-9]{1,16}-[a-f0-9]{6}$/.test(j.id ?? '')) return 'bad id';
  if (!/^[A-Za-z0-9-]{1,16}$/.test(j.requester ?? '')) return 'bad requester';
  if (!STYLES.has(j.style)) return 'style must be FB7675-100 or DQ4920-206';
  if (!['look', 'timing'].includes(j.lane)) return 'lane must be look or timing';
  try {
    clipPath(root, j.clip);
  } catch (e) {
    return e.message;
  }
  if (![0, 1].includes(j.still ?? 0)) return 'still must be 0 or 1';
  if (j.dpr != null && !(num(j.dpr) && j.dpr >= 1 && j.dpr <= 3)) return 'dpr must be 1..3';
  const w = j.window;
  if (!Array.isArray(w) || w.length !== 2 || !num(w[0]) || !num(w[1]) || w[0] < 0 || w[1] <= w[0])
    return 'window must be t0,t1 seconds with t1 > t0';
  const max = j.lane === 'look' && !j.replay ? LOOK_MAX_WINDOW_S : LONG_MAX_WINDOW_S;
  if (w[1] - w[0] > max) return `window longer than ${max} s for this lane`;
  for (const [k, v] of new URLSearchParams(j.flags ?? ''))
    if (
      !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k) ||
      !/^[A-Za-z0-9_.,:-]{0,32}$/.test(v) ||
      PROTECTED.has(k)
    )
      return `unsupported flag ${k}`;
  const o = j.outputs ?? {};
  if (
    o.snapshots &&
    (!Array.isArray(o.snapshots) ||
      o.snapshots.length > 12 ||
      !o.snapshots.every((t) => num(t) && t >= 0))
  )
    return 'snapshots: up to 12 clip times';
  if (o.strip) {
    const c = o.strip.crop;
    if (
      !Array.isArray(c) ||
      c.length !== 6 ||
      !c.every(num) ||
      c.slice(0, 4).some((v) => v < 0 || v > 4000 || !Number.isInteger(v)) ||
      !(c[4] > 0 && c[4] <= 4) ||
      !(Number.isInteger(c[5]) && c[5] >= 1 && c[5] <= 60)
    )
      return 'strip: x,y,w,h (ints), zoom (0..4], maxFrames 1..60';
    for (const k of ['from', 'to']) if (o.strip[k] != null && !num(o.strip[k])) return `strip ${k}`;
  }
  return null;
}

// ---------------- CLI ----------------
const ROOT = resolve(import.meta.dirname, '..');
const SVC = SERVICE_DIR(ROOT);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function alive() {
  try {
    const a = JSON.parse(readFileSync(join(SVC, 'alive.json'), 'utf8'));
    a.ageS = (Date.now() - Date.parse(a.updatedAt)) / 1000;
    a.ok = a.phase !== 'stopped' && a.ageS < 30;
    return a;
  } catch {
    return { ok: false, phase: 'absent' };
  }
}

function status() {
  const a = alive();
  console.log(
    `service: ${a.ok ? 'UP' : 'DOWN'} phase=${a.phase} pid=${a.pid ?? '-'} port=${a.port ?? '-'} lookParallel=${a.lookParallel ?? '-'} served=${a.jobsServed ?? 0} chromeGen=${a.chromeGen ?? '-'} freeGiB=${a.freeGiB ?? '-'} heartbeat ${a.ageS?.toFixed?.(0) ?? '-'} s ago`,
  );
  if (a.timing)
    console.log(
      `timing pause: ${a.timing.requester} until ${new Date(a.timing.expiresAt).toISOString().slice(11, 19)}Z`,
    );
  for (const r of a.running ?? [])
    console.log(`  RUNNING ${r.id} ${r.requester} ${r.lane} since ${r.startedAt.slice(11, 19)}Z`);
  const q = existsSync(join(SVC, 'jobs'))
    ? readdirSync(join(SVC, 'jobs')).filter((f) => f.endsWith('.json'))
    : [];
  for (const f of q.sort()) {
    try {
      const j = JSON.parse(readFileSync(join(SVC, 'jobs', f), 'utf8'));
      console.log(
        `  QUEUED  ${j.id} ${j.requester} ${j.lane} ${j.style} ${j.clip} ${j.window} ${j.flags || '(base)'}`,
      );
    } catch {
      /* being written */
    }
  }
  const done = existsSync(join(SVC, 'done')) ? readdirSync(join(SVC, 'done')).sort().slice(-8) : [];
  for (const f of done) {
    const id = f.replace(/\.json$/, '');
    try {
      const r = JSON.parse(readFileSync(join(SVC, 'out', id, 'result.json'), 'utf8'));
      console.log(
        `  DONE    ${id} ${r.status} ${r.lane} total ${((r.timings?.totalMs ?? 0) / 1000).toFixed(0)} s queued ${((r.queuedMs ?? 0) / 1000).toFixed(0)} s`,
      );
    } catch {
      /* ignore */
    }
  }
}

async function timing(cmd, argv) {
  const get = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
  const requester = get('--requester', '');
  if (!/^[A-Za-z0-9-]{1,16}$/.test(requester)) throw new Error('--requester NAME required');
  const f = join(SVC, 'control', `timing-${requester}.json`);
  mkdirSync(join(SVC, 'control'), { recursive: true });
  if (cmd === 'timing-end') {
    if (existsSync(f)) rmSync(f);
    const legacy = join(SVC, 'control', 'timing.json');
    if (existsSync(legacy) && JSON.parse(readFileSync(legacy, 'utf8')).requester === requester)
      rmSync(legacy);
    console.log(
      'timing-end posted (pauses of other requesters stay in force); the service retakes the browser lock when it is free.',
    );
    return;
  }
  if (cmd === 'yield') {
    // Between two exclusive runs: let the look lane drain (queue empty, nothing running) or
    // --max-min minutes, then pause the service again. Use inside a judge chain.
    const maxMs = Math.min(30, Math.max(1, Number(get('--max-min', '10')))) * 60e3;
    if (existsSync(f)) rmSync(f);
    const legacy = join(SVC, 'control', 'timing.json');
    if (existsSync(legacy) && JSON.parse(readFileSync(legacy, 'utf8')).requester === requester)
      rmSync(legacy);
    const t0 = Date.now();
    console.log(`yield: look lane open for up to ${maxMs / 60e3} min`);
    let served = false;
    while (Date.now() - t0 < maxMs) {
      const a = alive();
      if (!a.ok) break;
      if (a.phase === 'serving') served = true;
      if (served && !(a.queued ?? []).length && !(a.running ?? []).length) break;
      await pause(2000);
    }
    console.log(`yield: look lane had ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    return timing('timing-begin', argv);
  }
  const minutes = Math.min(120, Math.max(5, Number(get('--minutes', '60'))));
  writeFileSync(
    f + '.tmp',
    JSON.stringify({ requester, requestedAt: Date.now(), expiresAt: Date.now() + minutes * 60e3 }),
  );
  renameSync(f + '.tmp', f);
  console.log(
    `timing-begin posted for ${requester} (${minutes} min max); waiting for the service to drain...`,
  );
  for (;;) {
    const a = alive();
    if (!a.ok || a.phase === 'paused-timing') {
      console.log(
        a.ok
          ? 'PAUSED: browser lock released by the service. Run your timing job now, then timing-end.'
          : 'service not running: nothing to pause.',
      );
      return;
    }
    await pause(1000);
  }
}

async function enqueue(argv) {
  const get = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
  const has = (n) => argv.includes(n);
  const requester = get('--requester', '');
  const nums = (s) => s.split(',').filter(Boolean).map(Number);
  const job = {
    id: `${Date.now()}-${requester.replace(/[^A-Za-z0-9]/g, '')}-${randomBytes(3).toString('hex')}`,
    requester,
    createdAt: Date.now(),
    lane: get('--lane', 'look'),
    style: get('--style', 'FB7675-100'),
    clip: get('--clip', 'venue-khong-ao'),
    still: Number(get('--still', '0')),
    dpr: Number(get('--dpr', '1')),
    window: nums(get('--window', '')),
    flags: get('--flags', ''),
    replay: has('--replay'),
    outputs: { raw: has('--raw'), stats: !has('--no-stats') },
  };
  if (get('--snap')) job.outputs.snapshots = nums(get('--snap'));
  if (get('--strip')) {
    job.outputs.strip = { crop: nums(get('--strip')) };
    if (get('--strip-window'))
      [job.outputs.strip.from, job.outputs.strip.to] = nums(get('--strip-window'));
  }
  const bad = validateJob(ROOT, job);
  if (bad) throw new Error(`Invalid job: ${bad}`);
  mkdirSync(join(SVC, 'jobs'), { recursive: true });
  const f = join(SVC, 'jobs', `${job.id}.json`);
  writeFileSync(f + '.tmp', JSON.stringify(job, null, 1));
  renameSync(f + '.tmp', f);
  const a = alive();
  console.log(
    `queued ${job.id} (${job.lane}); service ${a.ok ? a.phase : 'DOWN (job waits in the queue)'}`,
  );
  if (has('--no-wait')) return;
  const out = join(SVC, 'out', job.id);
  const t0 = Date.now();
  const limit = Number(get('--timeout-min', '90')) * 60e3;
  let lastNote = 0;
  while (!existsSync(join(out, 'result.json'))) {
    if (Date.now() - t0 > limit) throw new Error('client wait limit hit; job stays queued');
    if (Date.now() - lastNote > 60e3) {
      lastNote = Date.now();
      const s = alive();
      const pos = (s.queued ?? []).findIndex((q) => q.id === job.id);
      console.log(
        `  waiting ${((Date.now() - t0) / 1000).toFixed(0)} s; service ${s.ok ? s.phase : 'DOWN'}; ${pos >= 0 ? `queue position ${pos + 1}` : 'running'}`,
      );
    }
    await pause(1000);
  }
  await pause(200);
  const r = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'));
  console.log(
    `${r.status.toUpperCase()} ${job.id} lane=${r.lane} head=${r.head?.slice(0, 7)}${r.dirty ? '+dirty' : ''} product=${r.selectedProduct?.style ?? '-'} reusedPage=${r.reusedPage ?? '-'}`,
  );
  if (r.error) console.log(`  error: ${r.error}`);
  const t = r.timings ?? {};
  console.log(
    `  wall: queued ${((r.queuedMs ?? 0) / 1000).toFixed(1)} s, load ${((t.loadMs ?? 0) / 1000).toFixed(1)}, warm ${((t.warmMs ?? 0) / 1000).toFixed(1)}, record ${((t.recordMs ?? 0) / 1000).toFixed(1)}, snaps ${((t.snapMs ?? 0) / 1000).toFixed(1)}, strip ${((t.stripMs ?? 0) / 1000).toFixed(1)}, total ${((t.totalMs ?? 0) / 1000).toFixed(1)} s`,
  );
  if (r.warm)
    console.log(
      `  warm: kioskLook=${r.warm.kioskLook} layered=${r.warm.layered} kioskAt=${r.warm.kioskAtMs} ms`,
    );
  for (const [k, v] of Object.entries(r.files ?? {})) console.log(`  ${k}: ${join(out, v)}`);
  for (const s of r.snapshots ?? [])
    console.log(`  snap ${s.t?.toFixed?.(2)}: ${join(out, s.file)}`);
  if (r.strip?.file) console.log(`  strip: ${join(out, r.strip.file)}`);
  if (r.strip?.error) console.log(`  strip error: ${r.strip.error}`);
  console.log(`  result: ${join(out, 'result.json')}`);
  if (r.status !== 'ok') process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const run =
    cmd === 'status'
      ? async () => status()
      : cmd === 'set-priority'
        ? async () => {
            const names = (argv[1] ?? '').split(',').filter(Boolean);
            if (!names.every((n) => /^[A-Za-z0-9-]{1,16}$/.test(n)))
              throw new Error('set-priority A,B (or "" to clear)');
            mkdirSync(join(SVC, 'control'), { recursive: true });
            writeFileSync(
              join(SVC, 'control', 'priority.json'),
              JSON.stringify({ requesters: names }),
            );
            console.log('priority requesters:', names.join(', ') || '(none)');
          }
        : cmd === 'set-parallel'
          ? async () => {
              const n = Number(argv[1]);
              if (n !== 1 && n !== 2) throw new Error('set-parallel 1|2');
              mkdirSync(join(SVC, 'control'), { recursive: true });
              writeFileSync(join(SVC, 'control', 'parallel.json'), JSON.stringify({ look: n }));
              console.log('look lane parallelism set to', n);
            }
          : cmd === 'service-stop'
            ? async () => {
                mkdirSync(join(SVC, 'control'), { recursive: true });
                writeFileSync(
                  join(SVC, 'control', 'stop.json'),
                  JSON.stringify({ at: Date.now() }),
                );
                console.log(
                  'stop posted: the service finishes running jobs, then releases its lock and exits.',
                );
              }
            : cmd === 'timing-begin' || cmd === 'timing-end' || cmd === 'yield'
              ? () => timing(cmd, argv)
              : cmd === 'cancel'
                ? async () => {
                    const id = argv[1] ?? '';
                    if (!/^\d{13}-[A-Za-z0-9]{1,16}-[a-f0-9]{6}$/.test(id))
                      throw new Error('cancel <id>');
                    const f = join(SVC, 'jobs', `${id}.json`);
                    if (!existsSync(f)) throw new Error('not queued (running or done)');
                    rmSync(f);
                    console.log('cancelled', id);
                  }
                : () => enqueue(argv);
  run().catch((e) => {
    console.error(e.message);
    process.exit(2);
  });
}
