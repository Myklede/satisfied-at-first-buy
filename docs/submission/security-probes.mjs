// P32b review reproducer. No browser, HTTP listener, real .env, key, or provider request.
// Production handler/class are copied into ignored cache; only I/O dependencies are replaced.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import {
  emptyState,
  openSession,
  reportUsage,
  canMintToken,
  allTimeTotals,
} from '../../scripts/decart-budget.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = resolve(root, '.cache/cx-day/p32b/probes');
assert.ok(relative(root, out).startsWith('.cache'));
mkdirSync(out, { recursive: true });
const hashes = {};
function source(path) {
  const text = readFileSync(resolve(root, path), 'utf8');
  hashes[path] = createHash('sha256').update(text).digest('hex');
  return text;
}
const budget = source('scripts/decart-budget.mjs');
assert.ok(budget.length);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = new Date('2026-11-15T07:00:00Z');
const result = {
  scope: 'Offline proofs; no real tokens, spend, network, user data or browser',
  hashes,
};
const state = emptyState();
for (let n = 1; n <= 10; n++) {
  assert.equal(
    openSession(state, { id: id(n), now, maxTotalS: 900, maxUsd: 30, page: 'studio' }).ok,
    true,
  );
  assert.equal(canMintToken(state, { id: id(n), now }).ok, true);
  assert.equal(reportUsage(state, { id: id(n), seconds: 0 }).ok, true);
}
result.underreport = {
  acceptedStudioReservations: 10,
  authorizedSeconds: 2000,
  accounted: allTimeTotals(state),
};
assert.equal(result.underreport.accounted.totalS, 0);
const remint = emptyState();
openSession(remint, { id: id(11), now, maxTotalS: 900, maxUsd: 30, page: 'studio' });
result.repeatMint = [0, 10, 210].map((s) =>
  canMintToken(remint, { id: id(11), now: new Date(+now + s * 1000) }),
);
assert.ok(result.repeatMint.every((r) => r.ok && r.limitS === 200));

// Real handler, but no listener and an isolated fake-key fixture. No production .env is read.
let server = source('scripts/decart-token-server.mjs');
assert.ok(server.includes('const ROOT =') && server.includes('const server = createServer'));
server = server.slice(0, server.indexOf('const server = createServer'));
server = server
  .replace(
    "const ROOT = resolve(import.meta.dirname, '..');",
    "const ROOT = resolve(import.meta.dirname, 'fixture');",
  )
  .replace(
    /const USAGE_FILE = process\.env\.DECART_USAGE_FILE[\s\S]*?;\r?\n/,
    "const USAGE_FILE = resolve(ROOT, 'usage.json');\n",
  )
  .replace(
    "from './decart-budget.mjs'",
    `from ${JSON.stringify(pathToFileURL(resolve(root, 'scripts/decart-budget.mjs')).href)}`,
  )
  .replace("import('@decartai/sdk')", "import('./fakes.mjs')");
assert.ok(!server.includes('process.env.DECART_USAGE_FILE'));
writeFileSync(resolve(out, 'handler.mjs'), `${server}\nexport { handle };\n`);
mkdirSync(resolve(out, 'fixture'), { recursive: true });
writeFileSync(
  resolve(out, 'fixture/.env'),
  'DECART_API_KEY=fixture-not-a-provider-key\nDECART_MAX_USD=4\n',
);
writeFileSync(resolve(out, 'fixture/usage.json'), JSON.stringify(emptyState()));
const { handle } = await import(pathToFileURL(resolve(out, 'handler.mjs')).href);
function request(body) {
  const req = new EventEmitter();
  Object.assign(req, {
    method: 'POST',
    url: '/session',
    headers: {
      host: '127.0.0.1:5830',
      origin: 'http://127.0.0.1:5810',
      'content-type': 'application/json',
    },
  });
  const res = {
    status: null,
    body: null,
    writeHead(s) {
      this.status = s;
    },
    end(v) {
      this.body = JSON.parse(v);
    },
  };
  const pending = handle(req, res);
  return {
    finish() {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
      return pending;
    },
    res,
  };
}
// Both handlers load the ledger before either request body completes.
const first = request({ page: 'studio' }),
  second = request({ page: 'studio' });
await Promise.all([first.finish(), second.finish()]);
const ledger = JSON.parse(readFileSync(resolve(out, 'fixture/usage.json'), 'utf8'));
result.parallelReservations = {
  statuses: [first.res.status, second.res.status],
  issuedSessions: 2,
  accounted: allTimeTotals(ledger),
  configuredUsdCap: 4,
};
assert.deepEqual(result.parallelReservations.statuses, [200, 200]);
assert.equal(result.parallelReservations.accounted.totalS, 200);
writeFileSync(resolve(out, 'fixture/usage.json'), JSON.stringify(emptyState()));
const array = request([]);
await array.finish();
result.arraySessionBody = { status: array.res.status };
assert.equal(array.res.status, 200);

// Test the actual DecartView control flow, transpiled with inert boundary dependencies.
const fakes = `
export const control = { pending: [], tracks: [], connects: 0, disconnected: 0 };
export const models = { realtime: () => ({}) };
export function createDecartClient() { return { realtime: { connect: async () => {
  control.connects++; return { disconnect() { control.disconnected++; }, on() {}, getConnectionState() { return 'connected'; }, async set() {} };
} } }; }
export const tokenServer = { refs: async () => ['parka-closed.jpg'], status: async () => ({ keyPresent: true }),
  openSession: () => new Promise(resolve => control.pending.push(resolve)), token: async () => 'fake', report: async () => null };
export class TokenServerError extends Error {}
export class SwapProbe { start() {} stop() {} begin() { return null; } }
export async function loadReference() { return new Blob(['fixture']); }
`;
writeFileSync(resolve(out, 'fakes.mjs'), fakes);
const sources = [
  ['apps/web/src/studio/decartView.ts', 'decartView'],
  ['apps/web/src/studio/decartViewMap.ts', 'decartViewMap'],
  ['apps/web/src/studio/contract.ts', 'contract'],
  ['apps/web/src/decart/session-timer.ts', 'session-timer'],
];
for (const [path, name] of sources) {
  let js = ts.transpileModule(source(path), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  js = js
    .replace(/from ['"]@decartai\/sdk['"]/g, "from './fakes.mjs'")
    .replace(/from ['"]\.\.\/decart\/(swapProbe|tokenServer)['"]/g, "from './fakes.mjs'")
    .replace(/from ['"]\.\.\/decart\/session-timer['"]/g, "from './session-timer.mjs'")
    .replace(/from ['"]\.\/(contract|decartViewMap)['"]/g, "from './$1.mjs'");
  writeFileSync(resolve(out, `${name}.mjs`), js);
}
const savedDocument = globalThis.document,
  savedWindow = globalThis.window;
const savedFetch = globalThis.fetch;
const listeners = new Map(),
  intervals = new Set();
let timerId = 0;
globalThis.fetch = () => {
  throw new Error('Network forbidden in P32b proof');
};
globalThis.document = {
  visibilityState: 'visible',
  createElement: () => ({}),
  addEventListener(k, f) {
    if (!listeners.has(k)) listeners.set(k, new Set());
    listeners.get(k).add(f);
  },
  removeEventListener(k, f) {
    listeners.get(k)?.delete(f);
  },
};
globalThis.window = {
  setInterval() {
    const id = ++timerId;
    intervals.add(id);
    return id;
  },
  clearInterval(id) {
    intervals.delete(id);
  },
  setTimeout() {
    return ++timerId;
  },
  clearTimeout() {},
  addEventListener() {},
  removeEventListener() {},
};
try {
  const { control } = await import(pathToFileURL(resolve(out, 'fakes.mjs')).href);
  const { DecartView } = await import(pathToFileURL(resolve(out, 'decartView.mjs')).href);
  const bus = {
    get: () => ({ jacket: 'FB7675-100', size: 'M', zip: 0, hoodOn: true }),
    subscribe: () => () => {},
  };
  const camera = {
    cloneStream() {
      const track = {
        stopped: false,
        stop() {
          this.stopped = true;
        },
      };
      control.tracks.push(track);
      return { getTracks: () => [track] };
    },
  };
  const makeView = async () => {
    const v = new DecartView({ bus, camera, onStatus() {} });
    await v.init();
    return v;
  };
  const settle = async () => {
    for (let n = 0; n < 20; n++) await Promise.resolve();
  };
  const session = () => ({ sessionId: id(++timerId + 100), sessionLimitS: 200 });
  const v = await makeView();
  const a = v.start(),
    b = v.start();
  await settle();
  assert.equal(control.pending.length, 2);
  control.pending.splice(0).forEach((resolve) => resolve(session()));
  await Promise.all([a, b]);
  await v.stop('proof stop');
  result.doubleStart = {
    connectCalls: control.connects,
    liveTracksAfterOneStop: control.tracks.filter((t) => !t.stopped).length,
    intervalsAfterStop: intervals.size,
  };
  assert.equal(result.doubleStart.connectCalls, 2);
  assert.equal(result.doubleStart.liveTracksAfterOneStop, 1);
  assert.equal(result.doubleStart.intervalsAfterStop, 1);
  v.dispose();
  control.tracks.forEach((t) => t.stop());
  intervals.clear();
  const connects = control.connects;
  const hidden = await makeView();
  const pending = hidden.start();
  await settle();
  document.visibilityState = 'hidden';
  for (const f of listeners.get('visibilitychange') ?? []) f();
  control.pending.shift()(session());
  await pending;
  result.hideDuringStart = {
    connectCallsAfterHide: control.connects - connects,
    trackActiveWhileHidden: control.tracks.some((t) => !t.stopped),
  };
  assert.equal(result.hideDuringStart.connectCallsAfterHide, 1);
  assert.equal(result.hideDuringStart.trackActiveWhileHidden, true);
  await hidden.stop('proof cleanup');
  hidden.dispose();
} finally {
  globalThis.document = savedDocument;
  globalThis.window = savedWindow;
  globalThis.fetch = savedFetch;
}
writeFileSync(resolve(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
