// Decart Lucy V-TON: local token server for apps/web/decart.html (trial) and studio.html.
//
//   node scripts/decart-token-server.mjs        -> http://127.0.0.1:5830
//
// Why: the permanent DECART_API_KEY must never reach the browser. This server mints a short-lived
// client token with the SDK's documented `client.tokens.create()`
// (https://docs.platform.decart.ai/getting-started/client-tokens) and enforces the daily seconds
// cap and the all-time dollar cap from scripts/decart-budget.mjs (docs/USER-RULES.md 2026-11-15).
//
// Endpoints (JSON; CORS only for the Vite pages on 5810):
//   GET  /status   -> { keyPresent, day, usedS, reservedS, totalS, maxTotalS, allTimeUsd, maxUsd, ... }
//   POST /session  -> {} | { page: 'trial'|'studio' } => { sessionId, sessionLimitS, ... } | 503 no key | 429 cap
//   POST /token    -> { sessionId }              => { apiKey, expiresAt }   (SDK apiKeyProvider)
//   POST /usage    -> { sessionId, seconds }     => totals   (also text/plain, for sendBeacon on unload)
//   GET  /refs     -> { files: [names] }  image files in apps/web/public/local-textures/decart/
//   GET  /credits  -> { credits, usd, keyQuota }  Decart's own remaining balance (needs the key)
//
// Security: binds 127.0.0.1 only; Host header must be 127.0.0.1:5830 / localhost:5830; POSTs must
// come from an allowed Origin; bodies <= 2 KB with unknown fields rejected; the key is read from the
// repo-root .env on each request (so adding it needs no restart) and is never logged or returned.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SESSION_LIMITS_S,
  TOKEN_GRACE_S,
  USD_PER_SECOND,
  allTimeTotals,
  canMintToken,
  markMinted,
  settleCandidate,
  settleFromCredits,
  isPage,
  isSessionId,
  loadUsage,
  localDay,
  openSession,
  parseMaxTotal,
  parseMaxUsd,
  reportUsage,
  saveUsage,
  totals,
  validateUsageBody,
} from './decart-budget.mjs';

const ROOT = resolve(import.meta.dirname, '..');
// DECART_ENV_FILE: test fixture only (the server's own tests never read the real .env).
const ENV_FILE = process.env.DECART_ENV_FILE
  ? resolve(process.env.DECART_ENV_FILE)
  : resolve(ROOT, '.env');
// DECART_USAGE_FILE / DECART_TOKEN_PORT exist only for the server's own smoke test (temp file, other port).
const USAGE_FILE = process.env.DECART_USAGE_FILE
  ? resolve(process.env.DECART_USAGE_FILE)
  : resolve(ROOT, '.cache', 'decart', 'usage.json');
const REFS_DIR = resolve(ROOT, 'apps', 'web', 'public', 'local-textures', 'decart');
const HOST = '127.0.0.1';
const PORT = Number(process.env.DECART_TOKEN_PORT ?? 5830);
const ALLOWED_ORIGINS = new Set(['http://127.0.0.1:5810', 'http://localhost:5810']);
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
/** Model names the token may open (alias + what it resolves to today; SDK 0.2.14 model table). */
const ALLOWED_MODELS = ['lucy-vton-latest', 'lucy-vton-3.6'];
/** Seconds a minted client token can be used to START a connection (docs default 60). */
const TOKEN_TTL_S = 60;
const MAX_BODY_BYTES = 2048;
const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(png|jpe?g|webp)$/i;

/** Minimal .env reader (KEY=VALUE lines, # comments, optional quotes). No new dependency. */
function readEnvFile() {
  let text;
  try {
    text = readFileSync(ENV_FILE, 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function config() {
  const env = readEnvFile();
  const key = (env.DECART_API_KEY ?? process.env.DECART_API_KEY ?? '').trim();
  const maxTotalS = parseMaxTotal(env.DECART_MAX_TOTAL_S ?? process.env.DECART_MAX_TOTAL_S);
  const maxUsd = parseMaxUsd(env.DECART_MAX_USD ?? process.env.DECART_MAX_USD);
  return { key, maxTotalS, maxUsd };
}

const MISSING_KEY =
  `DECART_API_KEY is missing. Sign up at https://platform.decart.ai, create an API key, and put the ` +
  `line DECART_API_KEY=<your key> in ${ENV_FILE} (gitignored). No restart needed.`;

function send(res, status, body, origin) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers.vary = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyError('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

class BodyError extends Error {}

async function readJson(req, { allowTextPlain = false } = {}) {
  const type = String(req.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const okType = type === 'application/json' || (allowTextPlain && type === 'text/plain');
  if (!okType) throw new BodyError('content-type must be application/json');
  const text = await readBody(req);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BodyError('body must be a JSON object');
  }
  // Review M2: only a plain JSON object is a valid body ([] / null / primitives are 400s).
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    throw new BodyError('body must be a JSON object');
  return body;
}

/** Review H2: every ledger read-check-mutate-write runs alone, in order, in this process. One
 *  process owns the ledger: a second server cannot bind 5830. */
let ledgerQueue = Promise.resolve();
function withLedger(fn) {
  const run = ledgerQueue.then(fn, fn);
  ledgerQueue = run.catch(() => {});
  return run;
}

function statusBody(state, cfg, now) {
  const day = localDay(now);
  const all = allTimeTotals(state);
  return {
    keyPresent: cfg.key.length > 0,
    day,
    ...totals(state, day),
    maxTotalS: cfg.maxTotalS,
    allTimeS: all.totalS,
    allTimeUsd: all.usd,
    maxUsd: cfg.maxUsd,
    sessionLimits: SESSION_LIMITS_S,
    usdPerSecond: USD_PER_SECOND,
  };
}

function listRefs() {
  try {
    return readdirSync(REFS_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.isSymbolicLink() && REF_NAME.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

let sdkPromise;
/** Tests replace the SDK and the credits fetch (no network); production never sets these. */
const testDeps = { sdk: null, fetch: null };
export function setTestDeps(deps) {
  Object.assign(testDeps, deps);
}

function loadSdk() {
  sdkPromise ??= import('@decartai/sdk').catch((err) => {
    sdkPromise = undefined;
    throw new Error(
      `@decartai/sdk is not installed (npm install --save @decartai/sdk -w apps/web): ${err.message}`,
    );
  });
  return sdkPromise;
}

async function mintToken(key, origin, limitS) {
  const { createDecartClient } = await (testDeps.sdk ?? loadSdk());
  const client = createDecartClient({ apiKey: key, telemetry: false });
  // Review H3: the duration cap and the model/origin scope are MANDATORY (the diagnosis switches
  // DECART_TOKEN_SCOPE / DECART_TOKEN_CONSTRAINTS are gone), and the token is handed out only when
  // Decart's response confirms them (the SDK documents these echo fields); otherwise fail closed.
  const options = {
    expiresIn: TOKEN_TTL_S,
    constraints: { realtime: { maxSessionDuration: limitS } },
    allowedModels: ALLOWED_MODELS,
    allowedOrigins: [origin],
  };
  const token = await client.tokens.create(options);
  const echoedLimit = token?.constraints?.realtime?.maxSessionDuration;
  const echoedOrigins = token?.permissions?.origins;
  const echoedModels = token?.permissions?.models;
  if (
    echoedLimit !== limitS ||
    !Array.isArray(echoedOrigins) ||
    !echoedOrigins.includes(origin) ||
    !Array.isArray(echoedModels) ||
    echoedModels.length === 0
  )
    throw new Error('Decart did not confirm the token limits (duration/model/origin); refused');
  if (typeof token.apiKey !== 'string' || token.apiKey.length === 0)
    throw new Error('Decart returned no client token');
  return { apiKey: token.apiKey, expiresAt: token.expiresAt };
}

/** Remaining Decart credit balance (GET /v1/credits, server-side only; 1 credit = $0.01).
 *  https://docs.platform.decart.ai/api-reference/get-credits */
let lastCredits = { at: 0, body: null };
async function fetchCredits(key) {
  if (lastCredits.body && Date.now() - lastCredits.at < 2000) return lastCredits.body; // docs: <= 1/s
  const res = await (testDeps.fetch ?? fetch)('https://api.decart.ai/v1/credits', {
    headers: { 'x-api-key': key },
  });
  if (!res.ok) throw new Error(`Decart /v1/credits: HTTP ${res.status}`);
  const json = await res.json();
  const credits = typeof json.credits === 'number' ? json.credits : null;
  const body = {
    credits,
    usd: credits === null ? null : Math.round(credits) / 100,
    keyQuota: json.key_quota ?? null,
  };
  lastCredits = { at: Date.now(), body };
  return body;
}

/** Never let the secret reach a log line or a response, even inside an SDK error message. */
function scrub(message, key) {
  let text = String(message);
  if (key) text = text.split(key).join('[redacted]');
  return text.replace(/dct_[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 400);
}

/** Loads the ledger and, when the latest minted session's window has ended, settles it from
 *  Decart's own balance (see decart-budget.mjs). Call only inside withLedger. */
async function settle(cfg, now) {
  const state = loadUsage(USAGE_FILE);
  const candidate = cfg.key ? settleCandidate(state, { now }) : null;
  if (!candidate) return state;
  try {
    lastCredits = { at: 0, body: null }; // a fresh reading, never a cached one
    const creditsNow = (await fetchCredits(cfg.key)).credits;
    const r = settleFromCredits(state, { id: candidate.id, creditsNow });
    if (r.ok) {
      saveUsage(USAGE_FILE, state);
      log(`session ${candidate.id.slice(0, 8)} settled from Decart's balance: ${r.usedS} s`);
    }
  } catch {
    // No reading now: the session stays fully reserved; retried on the next request.
  }
  return state;
}

/** Every request: bad bodies are deterministic 400s (review M2), anything else a 500. */
export async function handle(req, res) {
  try {
    return await route(req, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof BodyError ? 400 : 500;
    if (!res.headersSent) send(res, status, { error: message.slice(0, 300) }, req.headers.origin);
    else res.end();
  }
}

async function route(req, res) {
  const now = new Date();
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  if (!ALLOWED_HOSTS.has(String(req.headers.host ?? '')))
    return send(res, 421, { error: 'bad host' });

  if (req.method === 'OPTIONS') {
    if (!ALLOWED_ORIGINS.has(origin)) return send(res, 403, { error: 'origin not allowed' });
    res.writeHead(204, {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      vary: 'Origin',
    });
    return res.end();
  }

  // Browsers always send Origin on cross-origin requests; a missing Origin is a non-browser client,
  // allowed for GETs only (curl tests of /status).
  if (origin && !ALLOWED_ORIGINS.has(origin))
    return send(res, 403, { error: 'origin not allowed' });

  let cfg;
  try {
    cfg = config();
  } catch (err) {
    return send(res, 500, { error: err.message }, origin);
  }
  if (req.method === 'GET' && url.pathname === '/status') {
    const state = await withLedger(() => settle(cfg, new Date()));
    return send(res, 200, statusBody(state, cfg, new Date()), origin);
  }
  if (req.method === 'GET' && url.pathname === '/refs')
    return send(res, 200, { files: listRefs() }, origin);

  if (req.method === 'GET' && url.pathname === '/credits') {
    if (!cfg.key) return send(res, 503, { error: MISSING_KEY, code: 'NO_KEY' }, origin);
    try {
      return send(res, 200, await fetchCredits(cfg.key), origin);
    } catch (err) {
      return send(
        res,
        502,
        { error: scrub(err instanceof Error ? err.message : err, cfg.key) },
        origin,
      );
    }
  }

  if (req.method !== 'POST') return send(res, 404, { error: 'not found' }, origin);
  if (!ALLOWED_ORIGINS.has(origin)) return send(res, 403, { error: 'origin required' });

  if (url.pathname === '/session') {
    const body = await readJson(req);
    const keys = Object.keys(body);
    const okShape = keys.length === 0 || (keys.length === 1 && keys[0] === 'page');
    if (!okShape || (keys.length === 1 && !isPage(body.page)))
      return send(res, 400, { error: "body must be {} or { page: 'trial' | 'studio' }" }, origin);
    const page = body.page ?? 'trial';
    if (!cfg.key) return send(res, 503, { error: MISSING_KEY, code: 'NO_KEY' }, origin);
    // Body fully read and validated above; the ledger transaction runs alone (review H2).
    const { state, opened } = await withLedger(async () => {
      const ledger = await settle(cfg, new Date());
      const result = openSession(ledger, {
        id: randomUUID(),
        now: new Date(),
        maxTotalS: cfg.maxTotalS,
        maxUsd: cfg.maxUsd,
        page,
      });
      if (result.ok) saveUsage(USAGE_FILE, ledger); // durable before the session is handed out
      return { state: ledger, opened: result };
    });
    if (!opened.ok) return send(res, 429, { error: opened.error, code: 'BUDGET' }, origin);
    const limitS = opened.session.reservedS;
    log(`${page} session ${opened.session.id.slice(0, 8)} opened (reserved ${limitS} s)`);
    return send(
      res,
      200,
      {
        sessionId: opened.session.id,
        sessionLimitS: limitS,
        tokenWindowS: limitS + TOKEN_GRACE_S,
        ...statusBody(state, cfg, now),
      },
      origin,
    );
  }

  if (url.pathname === '/token') {
    const body = await readJson(req);
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== 'sessionId' || !isSessionId(body.sessionId))
      return send(res, 400, { error: 'body must be exactly { sessionId }' }, origin);
    if (!cfg.key) return send(res, 503, { error: MISSING_KEY, code: 'NO_KEY' }, origin);
    // Review H3: one token per session, recorded durably BEFORE it is returned. The whole
    // check -> balance read -> mint -> record runs under the ledger lock, so parallel requests for
    // one session get exactly one token.
    const outcome = await withLedger(async () => {
      const state = loadUsage(USAGE_FILE);
      const allowed = canMintToken(state, { id: body.sessionId, now: new Date() });
      if (!allowed.ok) return { status: 409, body: { error: allowed.error } };
      let creditsBefore = null;
      try {
        lastCredits = { at: 0, body: null }; // a fresh reading, never a cached one
        creditsBefore = (await fetchCredits(cfg.key)).credits;
      } catch {
        creditsBefore = null; // no reading: this session can never be settled, stays reserved
      }
      try {
        const token = await mintToken(cfg.key, origin, allowed.limitS);
        markMinted(state, { id: body.sessionId, now: new Date(), creditsBefore });
        saveUsage(USAGE_FILE, state);
        log(`token minted for session ${body.sessionId.slice(0, 8)} (balance ${creditsBefore})`);
        return { status: 200, body: token };
      } catch (err) {
        const message = scrub(err instanceof Error ? err.message : err, cfg.key);
        log(`token mint failed: ${message}`);
        return { status: 502, body: { error: `Decart token mint failed: ${message}` } };
      }
    });
    return send(res, outcome.status, outcome.body, origin);
  }

  if (url.pathname === '/usage') {
    const body = await readJson(req, { allowTextPlain: true });
    const v = validateUsageBody(body);
    if (!v.ok) return send(res, 400, { error: v.error }, origin);
    const out = await withLedger(() => {
      const state = loadUsage(USAGE_FILE);
      const r = reportUsage(state, { id: v.sessionId, seconds: v.seconds });
      if (r.ok) saveUsage(USAGE_FILE, state);
      return { state, r };
    });
    if (!out.r.ok) return send(res, 404, { error: out.r.error }, origin);
    log(
      `session ${v.sessionId.slice(0, 8)} reported ${v.seconds.toFixed(1)} s ` +
        (out.r.released ? '(no token was minted: released)' : '(diagnostic; reservation kept)'),
    );
    return send(res, 200, statusBody(out.state, cfg, new Date()), origin);
  }

  return send(res, 404, { error: 'not found' }, origin);
}

function log(message) {
  console.log(`[decart-token ${new Date().toTimeString().slice(0, 8)}] ${message}`);
}

const server = createServer((req, res) => void handle(req, res));

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
if (isMain)
  server.listen(PORT, HOST, () => {
    let state = '';
    try {
      const cfg = config();
      const usage = loadUsage(USAGE_FILE);
      const t = totals(usage, localDay(new Date()));
      const all = allTimeTotals(usage);
      state =
        `key ${cfg.key ? 'present' : 'MISSING (put DECART_API_KEY=... in .env)'}; today ` +
        `${t.totalS} s of ${cfg.maxTotalS} s; all time ~$${all.usd} of $${cfg.maxUsd}; session ` +
        `limits trial ${SESSION_LIMITS_S.trial} s, studio ${SESSION_LIMITS_S.studio} s`;
    } catch (err) {
      state = `config error: ${err instanceof Error ? err.message : String(err)}`;
    }
    log(`listening on http://${HOST}:${PORT} (${state})`);
    log(
      'trial page: http://127.0.0.1:5810/decart.html   studio: http://127.0.0.1:5810/studio.html',
    );
  });
