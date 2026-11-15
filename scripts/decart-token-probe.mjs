// One-off check (lead request, 2026-11-15): does Decart echo the limits the token server requires?
//
//   node scripts/decart-token-probe.mjs
//
// Mints ONE client token with exactly the server's mandatory options (model scope, origin,
// maxSessionDuration). Outside the ledger: no session is opened, no WebRTC, nothing streams; a
// client token by itself costs nothing (it expires unused after 60 s). Prints ONLY which limits
// came back (response echo and the token's decoded claims). Never prints the token or the key.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDecartClient, decodeClientToken } from '@decartai/sdk';

const ROOT = resolve(import.meta.dirname, '..');
const LIMIT_S = 75; // the trial page's limit (the Studio uses 200 s; same code path)
const ORIGIN = 'http://127.0.0.1:5810';
const MODELS = ['lucy-vton-latest', 'lucy-vton-3.6']; // as ALLOWED_MODELS in the token server

function readKey() {
  const text = readFileSync(resolve(ROOT, '.env'), 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*DECART_API_KEY\s*=\s*(.*)\s*$/.exec(raw);
    if (m) return m[1].replace(/^(['"])(.*)\1$/, '$2').trim();
  }
  return '';
}

const key = readKey();
if (!key) {
  console.log('No DECART_API_KEY in .env');
  process.exit(1);
}
const client = createDecartClient({ apiKey: key, telemetry: false });
let token;
try {
  token = await client.tokens.create({
    expiresIn: 60,
    constraints: { realtime: { maxSessionDuration: LIMIT_S } },
    allowedModels: MODELS,
    allowedOrigins: [ORIGIN],
  });
} catch (err) {
  const msg = String(err instanceof Error ? err.message : err)
    .split(key)
    .join('[redacted]');
  console.log(`mint failed: ${msg.replace(/dct_[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 300)}`);
  process.exit(1);
}

const out = {
  requested: { maxSessionDuration: LIMIT_S, models: MODELS, origins: [ORIGIN] },
  responseFields: Object.keys(token ?? {}).filter((k) => k !== 'apiKey' && k !== 'token'),
  responseEcho: {
    maxSessionDuration: token?.constraints?.realtime?.maxSessionDuration ?? null,
    models: token?.permissions?.models ?? null,
    origins: token?.permissions?.origins ?? null,
  },
  apiKeyShape: typeof token?.apiKey === 'string' ? token.apiKey.slice(0, 3) + '…' : null,
  jwtPresent: typeof token?.token === 'string',
  claims: null,
};
if (typeof token?.token === 'string') {
  try {
    const c = decodeClientToken(token.token);
    const raw = c.raw ?? {};
    // Limit-related raw claim names and values only (no user/org/key ids).
    const limitRaw = Object.fromEntries(
      Object.entries(raw).filter(([k]) =>
        /constraint|session|duration|realtime|model|origin/i.test(k),
      ),
    );
    out.claims = {
      allowedModels: c.allowedModels,
      allowedOrigins: c.allowedOrigins,
      realtimeConcurrentSessionLimit: c.realtimeConcurrentSessionLimit,
      zeroDataRetention: c.zeroDataRetention,
      pool: c.pool,
      rawClaimNames: Object.keys(raw),
      limitRaw,
    };
  } catch (err) {
    out.claims = { decodeError: String(err instanceof Error ? err.message : err).slice(0, 200) };
  }
}
console.log(JSON.stringify(out, null, 2));
