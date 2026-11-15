// F5 judge (prompt 23): one bounded native AR render per case (own process, 6 GB heap), then
// per-frame visual metrics (scripts/ar-judge-frames.py), atlas sheets and a bar table with a
// delta against a saved named baseline. Writes only under .cache/lead/judge (private pixels).
//
//   node scripts/ar-judge.mjs [--cases venue-parka,venue-puffer,cam-still] [--flags "k=v&k2=v2"]
//        [--run <name>] [--baseline <name>] [--save-baseline <name>] [--analyse-only]
//
// --analyse-only re-analyses an existing run directory without a browser job.
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { freemem } from 'node:os';
import { motionOnsetsV2 } from './ar-eval-motion.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const JUDGE = join(ROOT, '.cache/lead/judge');
const ATLAS = join(ROOT, '.cache/lead/atlas');
const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} requires a value`);
  return args[i + 1];
};
const flag = (n) => args.includes(n);
const safeName = (s) => {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(s)) throw new Error(`Invalid name: ${s}`);
  return s;
};

// Venue-khong-ao times (AR recording seconds; lead's atlas, prompt 23a §4).
const VENUE = [
  { name: 'still', t0: 2.6, t1: 4.4, crop: [280, 30, 240, 160, 2] },
  { name: 'armsup', t0: 8.6, t1: 10.4, crop: [230, 0, 330, 300, 1.4] },
  { name: 'cross', t0: 22.6, t1: 25.0, crop: [250, 40, 290, 260, 1.6] },
  { name: 'turn', t0: 32, t1: 37.5, crop: [230, 0, 330, 446, 1], step: 3 },
  { name: 'back', t0: 44, t1: 49, crop: [230, 0, 330, 446, 1], step: 3 },
  { name: 'empty', t0: 52.5, t1: 55.5, crop: null },
  // diagnostic only (excluded from the judged union): one arm raised, wrist/cuff (F3 vs F3X)
  { name: 'x-onearm', t0: 16.6, t1: 19.0, crop: [230, 0, 330, 300, 1.4] },
];
const CAMSTILL = [{ name: 'still', t0: 3.4, t1: 6.4, crop: [280, 30, 240, 160, 2] }];
export const CASES = {
  'venue-parka': { n: 68, style: 'FB7675-100', windows: VENUE },
  'venue-puffer': { n: 70, style: 'DQ4920-206', windows: VENUE },
  'cam-still': { n: 60, style: 'FB7675-100', windows: CAMSTILL },
  'venue-parka-s1': { n: 69, style: 'FB7675-100', windows: VENUE },
  'venue-puffer-s1': { n: 71, style: 'DQ4920-206', windows: VENUE },
  'cam-still-puffer': { n: 62, style: 'DQ4920-206', windows: CAMSTILL },
  // Laptop-camera close-ups (non-testset path, user's own body file; no kiosk profile, still N/A).
  'cam-tshirt': {
    video: 'cam-tshirt',
    style: 'FB7675-100',
    windows: [{ name: 'early', t0: 1.2, t1: 4.5, crop: [200, 0, 400, 446, 1] }],
  },
  // The user's live RC2 webcam recordings replayed as clips (raw camera stream, 15 fps).
  'live-parka': {
    video: '.cache/lead/service/clips/live-parka.webm', // F6 seekable re-encode of the user's raw stream
    style: 'FB7675-100',
    windows: [],
  },
  'live-puffer': {
    video: '.cache/lead/service/clips/live-puffer.webm',
    style: 'DQ4920-206',
    windows: [],
  },
  // User test #5 (TRUE RC4, Camo), F6 seekable re-encode of the raw stream: the RC5 baseline.
  live5: { video: '.cache/lead/service/clips/live5.webm', style: 'FB7675-100', windows: [] },
  // The user's iPhone via Camo (demo input), F6 clip 'camo-1'.
  'camo-1': {
    video: 'data/reference-photos/FB7675-100-parka-trang/video/camo/camo-test-1.mp4',
    style: 'FB7675-100',
    windows: [],
  },
  'cam-parka': {
    video: 'cam-parka',
    style: 'FB7675-100',
    windows: [{ name: 'early', t0: 1.5, t1: 4.5, crop: [200, 0, 400, 446, 1] }],
  },
};

// Judge-only acceptance for the new visual rows (documented in STATUS-ar-eval.md Final push).
export const JUDGE_BAR = {
  dropoutPct: 0, // person-present frames with jacketPresent < 0.15: none allowed (D1/D2)
  flickerP95Pct: 2, // single-frame blip pixels, % of jacket area, p95 over distinct frames (D3)
  // 10-90 % edge width, recording px (D6). Calibrated on the same 794 px VP8 path: ideal step
  // 1.50 px (measure floor), real person/background camera edge 2.05 px (venue still, plate).
  edgeMedianPx: 2.05,
  // lead 16:58 (Anywear A1/A7): match the CAMERA, not razor-sharp CG. Edge band around the real
  // camera edge (2.05 px): 0.8x..1.25x; grain = still-window temporal noise inside the jacket /
  // the camera background in the same AR recording: 0.7..1.4.
  edgeBandPx: [1.64, 2.56],
  grainBand: [0.7, 1.4],
  handsVisiblePct: 95, // A2: real hands visible beyond the cuff (still, arms up, one arm windows)
  distinctGapMedianMs: 1000 / 24, // >= 24 fps
  distinctGapP95Ms: 1.5 * (1000 / 24), // steady cadence: no gap beyond 1.5 frames at 24 fps
};

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
function run(cmd, argv, { log, timeoutMs, env } = {}) {
  return new Promise((done) => {
    const child = spawn(cmd, argv, { cwd: ROOT, env: { ...process.env, ...env } });
    const chunks = [];
    const sink = (b) => {
      chunks.push(b);
      if (log) writeFileSync(log, Buffer.concat(chunks));
    };
    child.stdout.on('data', sink);
    child.stderr.on('data', sink);
    const timer = timeoutMs
      ? setTimeout(() => {
          try {
            execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
          } catch {
            child.kill();
          }
        }, timeoutMs)
      : null;
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      done({ code, out: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

// Reclaim only F5's OWN lock left by a killed judge (owner line starts with F5, PID dead).
function reclaimOwnStale(name) {
  const dir = join(ROOT, '.cache/locks', name);
  try {
    const owner = readFileSync(join(dir, 'owner.txt'), 'utf8');
    const pid = Number(/PID (\d+)/.exec(owner)?.[1]);
    if (!/^F5\s/.test(owner) || !pid) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      /* dead */
    }
    rmSync(join(dir, 'owner.txt'));
    rmdirSync(dir);
    console.log(`F5: reclaimed own stale ${name} lock (PID ${pid} dead)`);
    return true;
  } catch {
    return false;
  }
}

// Browser+heavy lease held by the judge itself (same order as acquireTimingSlot: browser first,
// give browser back if heavy is busy). 5 s polling, plus the RAM floor of browser-slot.mjs.
async function withBrowserLease(task, fn) {
  const L = join(ROOT, '.cache/locks');
  const lease = randomUUID();
  const take = (name, text) => {
    try {
      mkdirSync(join(L, name));
    } catch (e) {
      if (e.code === 'EEXIST') return false;
      throw e;
    }
    writeFileSync(join(L, name, 'owner.txt'), text, { flag: 'wx' });
    return true;
  };
  const drop = (name) => {
    const f = join(L, name, 'owner.txt');
    if (existsSync(f) && readFileSync(f, 'utf8').includes(lease)) {
      rmSync(f);
      rmdirSync(join(L, name));
    }
  };
  let waited = 0;
  for (;;) {
    if (freemem() / 1024 ** 3 >= 2.5) {
      // MIN_BROWSER_RAM_GIB (scripts/lookdev/browser-slot.mjs)
      const text = [
        `F5 judge ${task}`,
        new Date().toISOString(),
        `PID ${process.pid}`,
        lease,
        '',
      ].join('\n');
      if (take('browser', text)) {
        if (take('heavy', text)) break;
        drop('browser');
      }
    }
    reclaimOwnStale('browser');
    reclaimOwnStale('heavy');
    if (waited++ % 12 === 0) console.log(`F5: waiting for browser+heavy (${task})`);
    await pause(5000);
  }
  try {
    return await fn(lease);
  } finally {
    drop('heavy');
    drop('browser');
  }
}

const v = (row, k) => row?.scoreboard?.[k]?.value ?? null;
// CX-DAY HIGH (a23ba5f:160): a missing metric is N/A, never PASS. Every comparison goes through
// these: a non-finite value gives null; an all() over values is PASS only if all are finite.
export const fin = (x) => typeof x === 'number' && Number.isFinite(x);
export const le = (x, lim) => (fin(x) ? x <= lim : null);
export const lt = (x, lim) => (fin(x) ? x < lim : null);
export const ge = (x, lim) => (fin(x) ? x >= lim : null);
export function allOf(list) {
  if (list.some((x) => x === false)) return false;
  return list.length && list.every((x) => x === true) ? true : null;
}
const fmt = (x, d = 2) => (x == null ? 'N/A' : typeof x === 'number' ? x.toFixed(d) : String(x));
const pf = (ok) => (ok == null ? 'N/A' : ok ? 'PASS' : 'FAIL');

// Onset v2 (scripts/ar-eval-motion.mjs motionOnsetsV2) recomputed from the case checkpoint.
export function onsetV2(dir) {
  const f = join(dir, 'checkpoint.json');
  if (!existsSync(f)) return null;
  const { frames } = JSON.parse(readFileSync(f, 'utf8'));
  const kinds = motionOnsetsV2(frames);
  const events = kinds.flatMap((k) => k.events.map((e) => ({ kind: k.kind, ...e })));
  const lags = events.map((e) => e.lagCameraFrames).filter(Number.isFinite);
  return {
    kinds: kinds.map(({ kind, noisePx, activationPx, events, pass }) => ({
      kind,
      noisePx,
      activationPx,
      events: events.length,
      pass,
    })),
    events,
    maxLag: lags.length ? Math.max(...lags) : null,
    medianLag: lags.length ? lags.sort((a, b) => a - b)[Math.floor(lags.length / 2)] : null,
    noResponse: events.filter((e) => e.outputMs == null).length,
    // PASS only when every kind with an event is certified; any FAIL fails; else N/A.
    pass: allOf(kinds.filter((k) => k.events.length).map((k) => k.pass)),
  };
}

// CX-DAY HIGH (ar-judge.mjs:317): every REQUIRED hands window the case has must be observed;
// an unobserved required window is N/A (never dropped), so the row cannot PASS on it.
export const HANDS_REQUIRED = ['still', 'x-onearm'];
export function handsPass(W) {
  const req = HANDS_REQUIRED.filter((k) => W && k in W);
  return allOf(
    req.map((k) => (W[k]?.handsSeen ? ge(W[k].handsVisiblePct, JUDGE_BAR.handsVisiblePct) : null)),
  );
}

export function barRows(row, m, onset = null) {
  const qualified = row?.stillQualification?.some((w) => w.qualified);
  const kiosk = row?.kioskProfile?.modes?.[0];
  // A run whose pixel alignment failed its self-check is never graded on pixel rows.
  const aligned = m?.alignmentOk !== false;
  // Pixel rows grade the named windows (still, arms up, crossed, turn, back), not the whole clip.
  const all = (aligned && (m?.judged ?? m?.all)) || {};
  const W = (aligned && m?.windows) || {};
  const still = qualified
    ? allOf([
        le(v(row, 'restOutlinePxPerFrame'), 0.3),
        le(v(row, 'restRotationRmsDeg'), 0.2),
        le(v(row, 'restScaleStepP95Pct'), 0.1),
      ])
    : null;
  const ew = all.edgeWidthPx?.median ?? null;
  const fl = all.flickerPct?.p95 ?? null;
  const gap = all.distinctGapMs;
  return [
    {
      row: 'Still -> jacket still',
      value: `outline ${fmt(v(row, 'restOutlinePxPerFrame'), 3)} px, rot ${fmt(v(row, 'restRotationRmsDeg'), 3)} deg, scale ${fmt(v(row, 'restScaleStepP95Pct'), 3)} %${qualified ? '' : ' (still window not qualified)'}`,
      pass: still,
    },
    {
      row: 'Move -> follows at once',
      value: `onset v2 max ${fmt(onset?.maxLag, 0)} / median ${fmt(onset?.medianLag, 0)} camera frames over ${onset?.events?.length ?? 0} events, ${onset?.noResponse ?? 'N/A'} unanswered (<=1); legacy probe ${fmt(v(row, 'restMotionOnsetLagFrames'), 0)}`,
      pass: onset && onset.events.length ? onset.pass : null,
    },
    {
      row: 'Stuck to the body',
      value: `drawn residual ${fmt(v(row, 'keypointResidualPx'))} px (<5); visual check required`,
      pass: lt(v(row, 'keypointResidualPx'), 5),
    },
    {
      row: 'Covers the real clothes',
      value: `V4 frontal ${fmt(v(row, 'frontalUncoveredPct'))} %, V5 torso proxy ${fmt(v(row, 'uncoveredPct'))} % (<2)`,
      pass: allOf([lt(v(row, 'frontalUncoveredPct'), 2), lt(v(row, 'uncoveredPct'), 2)]),
    },
    {
      row: 'Drawn on every frame (D1/D2, judge)',
      value: `not solid ${fmt(all.notSolidPct)} % of person frames (dropout ${fmt(all.dropoutPct)} % absolute + ${all.fadedFrames ?? 'N/A'} frames of relative fade-change, not an opacity measure); turn ${fmt(W.turn?.notSolidPct)} %, back ${fmt(W.back?.notSolidPct)} %; jacketPresent median ${fmt(all.jacketPresent?.median)}, turn ${fmt(W.turn?.jacketPresent?.median)}, back ${fmt(W.back?.jacketPresent?.median)}`,
      pass: le(all.notSolidPct, JUDGE_BAR.dropoutPct),
    },
    {
      row: 'Smooth: AR fps (kiosk)',
      value: `kiosk ${fmt(kiosk?.drawnFps, 1)} fps, lab AR ${fmt(v(row, 'arFps'), 1)} fps (>=24)`,
      pass: allOf([
        ge(kiosk?.drawnFps, 24),
        fin(kiosk?.drawnFps) ? (kiosk.violations?.length ?? 0) === 0 : null,
      ]),
    },
    {
      row: 'Smooth: cadence (judge)',
      value: `distinct-frame gap median ${fmt(gap?.median, 0)} / p95 ${fmt(gap?.p95, 0)} / max ${fmt(gap?.max, 0)} ms (<=42/<=63)`,
      pass: allOf([
        le(gap?.median, JUDGE_BAR.distinctGapMedianMs),
        le(gap?.p95, JUDGE_BAR.distinctGapP95Ms),
      ]),
    },
    {
      row: 'Smooth: no flicker (judge, D3)',
      // graded on the frontal windows; turn/back blips are dominated by D1/D2 dropouts (own row)
      value: `blip p95 still ${fmt(W.still?.flickerPct?.p95)} / arms up ${fmt(W.armsup?.flickerPct?.p95)} / crossed ${fmt(W.cross?.flickerPct?.p95)} % of jacket area (<=2 each); turn ${fmt(W.turn?.flickerPct?.p95)}, back ${fmt(W.back?.flickerPct?.p95)} (info)`,
      pass:
        W.still || W.cross
          ? allOf(
              ['still', 'armsup', 'cross']
                .filter((k) => W[k])
                .map((k) => le(W[k].flickerPct?.p95, JUDGE_BAR.flickerP95Pct)),
            )
          : le(fl, JUDGE_BAR.flickerP95Pct),
    },
    {
      row: 'Camera-matched edge/grain (A1/A7, D6, judge)',
      value: `edge 10-90 % median ${fmt(ew)} px rec (camera 2.05, band ${JUDGE_BAR.edgeBandPx.join('-')}; floor 1.50); grain ratio jacket/camera ${fmt(m?.grainStill?.ratio)} (band ${JUDGE_BAR.grainBand.join('-')})`,
      pass: allOf([
        allOf([ge(ew, JUDGE_BAR.edgeBandPx[0]), le(ew, JUDGE_BAR.edgeBandPx[1])]),
        allOf([
          ge(m?.grainStill?.ratio, JUDGE_BAR.grainBand[0]),
          le(m?.grainStill?.ratio, JUDGE_BAR.grainBand[1]),
        ]),
      ]),
    },
    {
      row: 'Hands visible beyond cuff (A2, judge)',
      value: `visible still ${fmt(W.still?.handsVisiblePct)} / one arm ${fmt(W['x-onearm']?.handsVisiblePct)} % (>=95 each, required); arms up ${fmt(W.armsup?.handsVisiblePct)} (info: the raised hands leave the venue frame); crossed ${fmt(W.cross?.handsVisiblePct)} % (info: tucked hands are legitimately hidden)`,
      pass: handsPass(W),
    },
    {
      row: 'Zero glitch frames (U5, judge)',
      value: m?.glitches
        ? `${m.glitches.count} of ${m.glitches.distinctFrames} frames (${Object.entries(
            m.glitches.byType,
          )
            .map(([k, n]) => `${k} ${n}`)
            .join(
              ', ',
            )}); +${m.glitches.startupCount ?? 0} in the first 1.5 s (startup, listed apart); worst 10: glitches/worst10.jpg + glitches/glitch-NN-<t>s.jpg`
        : 'N/A',
      pass: aligned && m?.glitches ? le(m.glitches.count, 0) : null,
    },
    { row: 'Light fits the scene', value: 'visual (lead sheet)', pass: null },
    { row: 'Looks like the real jacket', value: 'visual (lead sheet)', pass: null },
  ];
}

// Scalar metrics for the delta table: [key, label, better: 'lower'|'higher'].
const DELTA = [
  ['restOutline', 'rest outline px', 'lower', (r) => v(r, 'restOutlinePxPerFrame')],
  ['restRot', 'rest rot deg', 'lower', (r) => v(r, 'restRotationRmsDeg')],
  ['restScale', 'rest scale %', 'lower', (r) => v(r, 'restScaleStepP95Pct')],
  ['onset', 'onset legacy frames', 'lower', (r) => v(r, 'restMotionOnsetLagFrames')],
  ['onsetV2', 'onset v2 max frames', 'lower', (r, m, o) => o?.maxLag ?? null],
  ['onsetV2med', 'onset v2 median frames', 'lower', (r, m, o) => o?.medianLag ?? null],
  ['residual', 'residual px', 'lower', (r) => v(r, 'keypointResidualPx')],
  ['v4', 'V4 frontal unc %', 'lower', (r) => v(r, 'frontalUncoveredPct')],
  ['v5', 'V5 unc %', 'lower', (r) => v(r, 'uncoveredPct')],
  ['yawSd', 'yaw sd deg', 'lower', (r) => v(r, 'facingYawSdDeg')],
  ['scaleP95', 'scale p95 %', 'lower', (r) => v(r, 'scaleStepP95Pct')],
  ['arFps', 'lab AR fps', 'higher', (r) => v(r, 'arFps')],
  ['kioskFps', 'kiosk fps', 'higher', (r) => r?.kioskProfile?.modes?.[0]?.drawnFps ?? null],
  ['c2s', 'cam->screen ms', 'lower', (r) => v(r, 'cameraToScreenMs')],
  // AR-path latency p50 from the checkpoint (sampler >= this commit); N/A on older runs
  ['arTotal', 'cam->AR screen p50 ms', 'lower', (r, m, o, ck) => ck?.arTotalP50 ?? null],
  [
    'dropout',
    'not-solid %',
    'lower',
    (r, m) => (m?.alignmentOk === false ? null : ((m?.judged ?? m?.all)?.notSolidPct ?? null)),
  ],
  [
    'jpTurn',
    'jacketPresent turn med',
    'higher',
    (r, m) => m?.windows?.turn?.jacketPresent?.median ?? null,
  ],
  [
    'jpBack',
    'jacketPresent back med',
    'higher',
    (r, m) => m?.windows?.back?.jacketPresent?.median ?? null,
  ],
  ['flicker', 'blip p95 %', 'lower', (r, m) => (m?.judged ?? m?.all)?.flickerPct?.p95 ?? null],
  [
    'flickerCross',
    'blip p95 % cross',
    'lower',
    (r, m) => m?.windows?.cross?.flickerPct?.p95 ?? null,
  ],
  ['edge', 'edge 10-90 px', 'lower', (r, m) => (m?.judged ?? m?.all)?.edgeWidthPx?.median ?? null],
  ['grain', 'grain ratio (->1)', 'higher', (r, m) => m?.grainStill?.ratio ?? null],
  ['glitches', 'glitch frames (U5)', 'lower', (r, m) => m?.glitches?.count ?? null],
  [
    'handsOneArm',
    'hands visible % one arm',
    'higher',
    (r, m) => m?.windows?.['x-onearm']?.handsVisiblePct ?? null,
  ],
  [
    'handsArmsUp',
    'hands visible % arms up',
    'higher',
    (r, m) => m?.windows?.armsup?.handsVisiblePct ?? null,
  ],
  [
    'gapMed',
    'gap median ms',
    'lower',
    (r, m) => (m?.judged ?? m?.all)?.distinctGapMs?.median ?? null,
  ],
  ['gapP95', 'gap p95 ms', 'lower', (r, m) => (m?.judged ?? m?.all)?.distinctGapMs?.p95 ?? null],
];
export function scalars(row, m, o, ck = null) {
  return Object.fromEntries(DELTA.map(([k, , , f]) => [k, f(row, m, o, ck)]));
}

function caseDir(runName, name) {
  return join(JUDGE, runName, name);
}

async function renderCase(runName, name, flags) {
  const c = CASES[name];
  const dir = caseDir(runName, name);
  mkdirSync(dir, { recursive: true });
  const argv = [
    '--max-old-space-size=6144',
    'scripts/ar-eval.mjs',
    ...(c.video
      ? ['--video', c.video, '--review', '--product', c.style, '--still', '0']
      : ['--testset', '--start-case', String(c.n), '--limit', '1']),
    '--no-write',
    '--proof-root',
    dir,
    '--result-json',
    join(dir, 'row.json'),
  ];
  if (flags) argv.push('--flags', flags);
  const until = arg('--until');
  if (until) argv.push('--until', until);
  if (flag('--no-kiosk')) argv.push('--no-kiosk');
  // CX-DAY HIGH (a23ba5f:377): a rerun must never be graded on the previous run's files.
  for (const f of RUN_OUTPUTS) rmSync(join(dir, f), { force: true });
  console.log(`F5 render ${name} (case ${c.n ?? c.video}) flags=${flags || '(none)'}`);
  const provenance = {
    case: name,
    flags,
    head: gitHead(),
    until: until ?? null,
    kiosk: !flag('--no-kiosk'),
    startedUtc: new Date().toISOString(),
  };
  // The lease covers the timed render only; the CPU pixel analysis runs without any lock (lead).
  // With F6's render service up, ask for its exclusive timing lane per case (--timing-lane).
  const job = (cmd) =>
    run(
      process.execPath,
      [
        'scripts/ar-job.mjs',
        cmd,
        '--requester',
        arg('--requester', 'F5'),
        ...(cmd === 'timing-begin' ? ['--minutes', '15'] : []),
      ],
      {
        log: join(dir, `${cmd}.log`),
        timeoutMs: 15 * 60e3,
      },
    );
  if (flag('--timing-lane')) await job('timing-begin');
  let r;
  try {
    r = await withBrowserLease(`${name}`, (lease) =>
      run(process.execPath, [...argv, '--parent-lease', lease], {
        log: join(dir, 'eval.log'),
        timeoutMs: 14.5 * 60e3, // the lease covers only this child: <= 15 min total (shared limit)
      }),
    );
  } finally {
    if (flag('--timing-lane')) await job('timing-end');
  }
  provenance.exitCode = r.code;
  provenance.endedUtc = new Date().toISOString();
  writeFileSync(join(dir, 'provenance.json'), JSON.stringify(provenance, null, 2));
  return provenance;
}

const RUN_OUTPUTS = [
  'row.json',
  'checkpoint.json',
  'metrics.json',
  'onset-v2.json',
  'provenance.json',
  'ar.webm',
  'raw.webm',
  'mirror.webm',
  'kiosk-profile.json',
  'profile-error.txt',
  'visual-error.txt',
  'masks.jpg',
  'overview.jpg',
];
function gitHead() {
  const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'apps', 'packages'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  return sha.trim() + (dirty ? '+wip' : '');
}

// Every requested k=v must appear in the page's (or a live manifest's) search string; returns the
// missing list, or 'page URL not recorded' when there is no search to check.
export function missingFlags(search, flags) {
  const want = [...new URLSearchParams(flags ?? '')];
  if (!want.length) return null;
  if (typeof search !== 'string') return 'page URL not recorded';
  const got = new URLSearchParams(search.replace(/^\?/, ''));
  const miss = want.filter(([k, v]) => got.get(k) !== v).map(([k, v]) => `${k}=${v}`);
  return miss.length ? miss.join('&') : null;
}

// A case is graded only if its render exited 0, after this run's start, with these flags.
export function validateCase({ provenance, row, flags }) {
  if (!provenance) return 'no provenance.json (render not done by this judge)';
  if (provenance.exitCode !== 0) return `render exit code ${provenance.exitCode}`;
  if ((provenance.flags ?? '') !== (flags ?? ''))
    return `run was rendered with flags '${provenance.flags}', requested '${flags}'`;
  if (!row) return 'no row.json';
  if (!row.complete) return 'row incomplete';
  if ((row.flags ?? '') !== (flags ?? '')) return `row flags '${row.flags}' differ`;
  const missing = missingFlags(row.settings?.pageSearch ?? row.pageSearch, flags);
  if (missing) return `INVALID: page URL lacks ${missing}`;
  return null;
}

async function analyseCase(runName, name) {
  const c = CASES[name];
  const dir = caseDir(runName, name);
  const ar = join(dir, 'ar.webm'),
    raw = join(dir, 'raw.webm');
  if (!existsSync(ar) || !existsSync(raw)) return null;
  const windows = c.windows.map(({ name, t0, t1 }) => ({ name, t0, t1 }));
  const mf = join(dir, 'metrics.json');
  // Reuse metrics newer than the recording (re-running the table never re-analyses pixels).
  if (existsSync(mf) && statSync(mf).mtimeMs > statSync(ar).mtimeMs && !flag('--reanalyse'))
    return JSON.parse(readFileSync(mf, 'utf8'));
  // CPU-only: no lock (lead 14:58); it may run alongside look-lane browser jobs, but never while
  // someone else's timing run holds heavy (lead 20:3x): wait for heavy to be free first.
  for (let n = 0; existsSync(join(ROOT, '.cache/locks/heavy')); n++) {
    if (n % 12 === 0) console.log(`F5: analysis of ${name} waits: a timing run holds heavy`);
    await pause(5000);
  }
  await (async () => {
    const r = await run(
      'py',
      [
        'scripts/ar-judge-frames.py',
        '--ar',
        ar,
        '--raw',
        raw,
        '--out',
        join(dir, 'metrics.json'),
        '--windows',
        JSON.stringify(windows),
        '--sheet',
        join(dir, 'masks.jpg'),
        ...(existsSync(join(dir, 'checkpoint.json'))
          ? ['--landmarks', join(dir, 'checkpoint.json')]
          : []),
      ],
      { log: join(dir, 'frames.log'), timeoutMs: 20 * 60e3 },
    );
    if (r.code !== 0) console.log(`F5 frames ${name} failed: see ${join(dir, 'frames.log')}`);
    await run('py', [join(ATLAS, 'overview.py'), ar, join(dir, 'overview.jpg'), '12']);
    // crops are in 794 px lab-canvas coordinates; scale them to the recording's native size
    let k = 1;
    try {
      const nat = JSON.parse(readFileSync(join(dir, 'metrics.json'), 'utf8')).nativeSize;
      if (nat?.[0] > 0) k = nat[0] / 794;
    } catch {
      /* no metrics: native 794 assumed */
    }
    for (const w of c.windows) {
      if (!w.crop) continue;
      const [x, y, cw, ch, z] = w.crop.map((q, i) =>
        i < 4 ? Math.round(q * k) : +(q / k).toFixed(3),
      );
      await run('py', [
        join(ATLAS, 'strip.py'),
        ar,
        join(dir, `strip-${w.name}.jpg`),
        String(w.t0),
        String(w.t1),
        String(x),
        String(y),
        String(cw),
        String(ch),
        String(z),
        '30',
      ]);
    }
  })();
  const f = join(dir, 'metrics.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
}

function table(header, rows) {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

async function main() {
  const flags = arg('--flags', '');
  const names = arg('--cases', 'venue-parka,venue-puffer,cam-still').split(',');
  for (const n of names) if (!CASES[n]) throw new Error(`Unknown case ${n}`);
  const runName = safeName(
    arg(
      '--run',
      `${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '')}-${flags ? flags.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40) : 'default'}`,
    ),
  );
  mkdirSync(join(JUDGE, runName), { recursive: true });
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  const results = {};
  for (const name of names) {
    const dir = caseDir(runName, name);
    const provenance = flag('--analyse-only')
      ? existsSync(join(dir, 'provenance.json'))
        ? JSON.parse(readFileSync(join(dir, 'provenance.json'), 'utf8'))
        : null
      : await renderCase(runName, name, flags);
    const rowFile = join(dir, 'row.json');
    const rawRow = existsSync(rowFile) ? JSON.parse(readFileSync(rowFile, 'utf8')) : null;
    const invalid = validateCase({ provenance, row: rawRow, flags });
    if (invalid) console.log(`F5 ${name}: NOT GRADED: ${invalid}`);
    const row = invalid ? null : rawRow;
    const metrics = invalid ? null : await analyseCase(runName, name);
    const expected = CASES[name].style;
    const verified =
      row?.selectedProduct?.style === expected &&
      (!row?.kioskProfile || row.kioskProfile.error
        ? true // no kiosk page on this path / kiosk failed: lab check only (reported separately)
        : row.kioskProfile.selectedStyle === expected);
    const onset = onsetV2(caseDir(runName, name));
    let ck = null;
    try {
      const fr = JSON.parse(readFileSync(join(caseDir(runName, name), 'checkpoint.json'), 'utf8'))
        .frames.map((f) => f.arTotalMs)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      if (fr.length) ck = { arTotalP50: fr[Math.floor(fr.length / 2)], arTotalN: fr.length };
    } catch {
      /* no checkpoint */
    }
    if (onset)
      writeFileSync(join(caseDir(runName, name), 'onset-v2.json'), JSON.stringify(onset, null, 2));
    results[name] = {
      row,
      metrics,
      onset: invalid ? null : onset,
      ck: invalid ? null : ck,
      verified: invalid ? null : verified,
      complete: row?.complete ?? false,
      invalid,
      provenance,
    };
  }
  const summary = {
    run: runName,
    flags,
    head,
    generated: new Date().toISOString(),
    cases: Object.fromEntries(
      Object.entries(results).map(([n, r]) => [
        n,
        {
          case: CASES[n].n,
          style: CASES[n].style,
          complete: r.complete,
          productVerified: r.verified,
          notGraded: r.invalid,
          provenance: r.provenance,
          commit: r.row?.commit ?? null,
          scalars: scalars(r.row, r.metrics, r.onset, r.ck),
          bar: barRows(r.row, r.metrics, r.onset),
        },
      ]),
    ),
  };
  writeFileSync(join(JUDGE, runName, 'summary.json'), JSON.stringify(summary, null, 2));
  let md = `# F5 judge ${runName}\n\nflags: \`${flags || '(none)'}\`, HEAD ${head}, ${summary.generated}\n`;
  for (const [n, c] of Object.entries(summary.cases)) {
    md += `\n## ${n} (case ${c.case}, ${c.style}; product verified: ${c.productVerified}; complete: ${c.complete}; source ${c.commit})\n\n`;
    if (c.notGraded) md += `**NOT GRADED: ${c.notGraded}. Every row is N/A.**\n\n`;
    md += `provenance: HEAD ${c.provenance?.head ?? 'N/A'}, flags \`${c.provenance?.flags || '(none)'}\`, ${c.provenance?.startedUtc ?? 'N/A'} -> ${c.provenance?.endedUtc ?? 'N/A'}, exit ${c.provenance?.exitCode ?? 'N/A'}, until ${c.provenance?.until ?? 'end'}, kiosk ${c.provenance?.kiosk ?? 'N/A'}\n\n`;
    if (results[n].metrics?.alignmentOk === false)
      md += `**PIXEL ALIGNMENT SELF-CHECK FAILED: pixel rows are N/A for this case.**${'\n\n'}`;
    md += table(
      ['bar row', 'value', 'verdict'],
      c.bar.map((b) => [b.row, b.value, pf(b.pass)]),
    );
    md += `\n\nsheets: ${join('.cache/lead/judge', runName, n).replaceAll('\\', '/')}/{overview,strip-*,masks}.jpg\n`;
  }
  const base = arg('--baseline');
  if (base) {
    const bf = join(JUDGE, 'baselines', `${safeName(base)}.json`);
    if (!existsSync(bf)) md += `\nBaseline ${base} not found.\n`;
    else {
      const b = JSON.parse(readFileSync(bf, 'utf8'));
      md += `\n## Delta vs baseline ${base} (${b.head}, flags \`${b.flags || '(none)'}\`)\n\n`;
      const rows = [];
      for (const [n, c] of Object.entries(summary.cases)) {
        const bc = b.cases?.[n];
        if (!bc) continue;
        if (c.notGraded || bc.notGraded) {
          rows.push([
            n,
            'ALL',
            '',
            '',
            '',
            `not compared: ${c.notGraded || 'baseline not graded'}`,
          ]);
          continue;
        }
        const pu = c.provenance ?? {},
          bu = bc.provenance ?? {};
        if ((pu.until ?? null) !== (bu.until ?? null) || (pu.kiosk ?? null) !== (bu.kiosk ?? null))
          rows.push([
            n,
            'WARNING',
            '',
            '',
            '',
            `range differs (until ${bu.until}/${pu.until}, kiosk ${bu.kiosk}/${pu.kiosk}): scoreboard deltas not like-for-like`,
          ]);
        for (const [k, label, better] of DELTA) {
          const x = c.scalars[k],
            y = bc.scalars[k];
          if (x == null && y == null) continue;
          const d = x != null && y != null ? x - y : null;
          const tol = Math.max(0.02 * Math.abs(y ?? 0), 1e-9);
          const verdict =
            d == null
              ? 'N/A'
              : Math.abs(d) <= tol
                ? '='
                : (better === 'lower') === d < 0
                  ? 'better'
                  : 'WORSE';
          rows.push([
            n,
            label,
            fmt(y),
            fmt(x),
            d == null ? 'N/A' : (d > 0 ? '+' : '') + d.toFixed(2),
            verdict,
          ]);
        }
        const flips = c.bar
          .map((r, i) => [r.row, bc.bar?.[i]?.pass, r.pass])
          .filter(([, a, bb]) => a !== bb);
        for (const [r, a, bb] of flips)
          rows.push([
            n,
            `BAR ${r}`,
            pf(a),
            pf(bb),
            '',
            bb === false && a === true ? 'REGRESSION' : 'changed',
          ]);
      }
      md += table(['case', 'metric', 'base', 'now', 'delta', 'verdict'], rows) + '\n';
    }
  }
  const save = arg('--save-baseline');
  if (save) {
    mkdirSync(join(JUDGE, 'baselines'), { recursive: true });
    writeFileSync(
      join(JUDGE, 'baselines', `${safeName(save)}.json`),
      JSON.stringify(summary, null, 2),
    );
    md += `\nSaved baseline ${save}.\n`;
  }
  writeFileSync(join(JUDGE, runName, 'judge.md'), md);
  console.log(md);
}

if (
  import.meta.url === `file:///${process.argv[1].replaceAll('\\', '/')}` ||
  process.argv[1]?.endsWith('ar-judge.mjs')
)
  await main();
