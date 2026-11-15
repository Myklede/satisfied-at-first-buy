// node --test scripts/decart-token-server.test.mjs
// The real request handler with a fixture .env, a temp ledger, a fake SDK and a fake credits
// fetch: no listener, no network, never the real key (security review P32b regressions).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'decart-server-'));
const usageFile = join(dir, 'usage.json');
writeFileSync(join(dir, '.env'), 'DECART_API_KEY=fixture-not-a-key\nDECART_MAX_USD=8\n');
process.env.DECART_ENV_FILE = join(dir, '.env');
process.env.DECART_USAGE_FILE = usageFile;

const { handle, setTestDeps } = await import('./decart-token-server.mjs');
const { allTimeTotals, emptyState } = await import('./decart-budget.mjs');

let credits = 900;
let echo = true;
let mints = 0;
setTestDeps({
  sdk: Promise.resolve({
    createDecartClient: () => ({
      tokens: {
        create: async (opts) => {
          mints++;
          await new Promise((r) => setTimeout(r, 5));
          return {
            apiKey: `ek_fixture_${mints}`,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            ...(echo
              ? {
                  constraints: opts.constraints,
                  permissions: { models: opts.allowedModels, origins: opts.allowedOrigins },
                }
              : {}),
          };
        },
      },
    }),
  }),
  fetch: async () => ({ ok: true, json: async () => ({ credits }) }),
});

const ORIGIN = 'http://127.0.0.1:5810';
function request(method, path, body, { delayMs = 0, type = 'application/json' } = {}) {
  const req = new EventEmitter();
  Object.assign(req, {
    method,
    url: path,
    headers: { host: '127.0.0.1:5830', origin: ORIGIN, 'content-type': type },
  });
  const res = {
    status: 0,
    body: null,
    headersSent: false,
    writeHead(s) {
      this.status = s;
      this.headersSent = true;
    },
    end(v) {
      this.body = v ? JSON.parse(v) : null;
    },
  };
  const done = handle(req, res);
  if (method === 'POST')
    setTimeout(() => {
      if (body !== undefined) req.emit('data', Buffer.from(body));
      req.emit('end');
    }, delayMs);
  return done.then(() => res);
}
const post = (path, obj, opts) => request('POST', path, JSON.stringify(obj), opts);
const ledger = () => JSON.parse(readFileSync(usageFile, 'utf8'));
const reset = () => {
  writeFileSync(usageFile, JSON.stringify(emptyState()));
  echo = true;
};

test('H2: parallel sessions near the cap are serialised: the third is refused', async () => {
  reset();
  const results = await Promise.all(
    [30, 10, 20].map((d) => post('/session', { page: 'studio' }, { delayMs: d })),
  );
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 200, 429]); // $8 cap = two 200-s Studio sessions
  assert.equal(allTimeTotals(ledger()).totalS, 400);
});

test('M2: non-object and unknown-field bodies are 400s and change nothing', async () => {
  reset();
  for (const raw of ['[]', 'null', '', '5', 'true', '"x"', '{"x":1}', '{"page":"nope"}']) {
    const r = await request('POST', '/session', raw);
    assert.equal(r.status, 400, `body ${raw}`);
  }
  assert.equal(allTimeTotals(ledger()).totalS, 0);
});

test('H3: one token per session even for parallel requests; constraints are sent', async () => {
  reset();
  const s = await post('/session', { page: 'trial' });
  const before = mints;
  const [a, b] = await Promise.all([
    post('/token', { sessionId: s.body.sessionId }),
    post('/token', { sessionId: s.body.sessionId }, { delayMs: 3 }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(mints - before, 1);
  const session = ledger().days[Object.keys(ledger().days)[0]].sessions[0];
  assert.ok(session.mintedAt);
  assert.equal(session.creditsBefore, 900);
});

test('H3: a token whose limits Decart does not confirm is refused (fail closed)', async () => {
  reset();
  echo = false;
  const s = await post('/session', { page: 'trial' });
  const t = await post('/token', { sessionId: s.body.sessionId });
  assert.equal(t.status, 502);
  assert.match(t.body.error, /did not confirm/);
  assert.equal(t.body.apiKey, undefined);
});

test('H1: a report after the mint keeps the reservation; before any mint it releases it', async () => {
  reset();
  const minted = await post('/session', { page: 'studio' });
  await post('/token', { sessionId: minted.body.sessionId });
  const r1 = await post('/usage', { sessionId: minted.body.sessionId, seconds: 0 });
  assert.equal(r1.status, 200);
  assert.equal(allTimeTotals(ledger()).totalS, 200);
  const unminted = await post('/session', { page: 'trial' });
  await post(
    '/usage',
    { sessionId: unminted.body.sessionId, seconds: 0 },
    { type: 'text/plain' }, // the unload beacon
  );
  assert.equal(allTimeTotals(ledger()).totalS, 200);
  const late = await post('/token', { sessionId: unminted.body.sessionId });
  assert.equal(late.status, 409); // a released session never gets a token
});

test('settlement: after the window, the latest minted session is charged from the balance', async () => {
  reset();
  const s = await post('/session', { page: 'studio' });
  credits = 900;
  await post('/token', { sessionId: s.body.sessionId });
  // Move the mint into the past: the 200 s window plus the 30 s grace are over.
  const l = ledger();
  const day = Object.keys(l.days)[0];
  l.days[day].sessions[0].mintedAt = new Date(Date.now() - 300_000).toISOString();
  writeFileSync(usageFile, JSON.stringify(l));
  credits = 780; // 120 credits = 60 s
  const st = await request('GET', '/status');
  assert.equal(st.status, 200);
  assert.equal(st.body.totalS, 60);
  assert.equal(ledger().days[day].sessions[0].settledBy, 'provider-credits');
});
