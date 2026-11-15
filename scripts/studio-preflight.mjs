// Read-only Studio readiness. No camera, browser, token mint, session or process control.
import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CHECK_URLS = Object.freeze({
  body: 'http://127.0.0.1:8001/health',
  studio: 'http://127.0.0.1:5810/studio.html',
  status: 'http://127.0.0.1:5830/status',
  credits: 'http://127.0.0.1:5830/credits',
});
const ROOT = resolve(import.meta.dirname, '..');
const validNumber = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const row = (check, status, detail, fix) => ({ check, status, detail, fix });

export function budgetCheck(data) {
  // Whitelist fields: never print raw response bodies, errors, credentials or quotas.
  const { maxUsd, allTimeUsd, sessionLimits, keyPresent } = data ?? {};
  if (
    !validNumber(maxUsd) ||
    maxUsd > 30 ||
    !validNumber(allTimeUsd) ||
    !validNumber(sessionLimits?.studio) ||
    !validNumber(sessionLimits?.trial) ||
    sessionLimits.studio <= 0 ||
    sessionLimits.trial <= 0 ||
    typeof keyPresent !== 'boolean'
  )
    return row(
      'Token server',
      'fail',
      'Invalid local budget/session status',
      'Check the token-server configuration; max spend must be at most $30.',
    );
  const left = Math.max(0, maxUsd - allTimeUsd);
  return row(
    'Token server',
    keyPresent && left > 0 ? 'pass' : 'warn',
    `session caps: Studio ${sessionLimits.studio}s / trial ${sessionLimits.trial}s; local ledger spent/reserved $${allTimeUsd.toFixed(2)} / $${maxUsd.toFixed(2)}; left $${left.toFixed(2)}; key ${keyPresent ? 'present' : 'missing'}`,
    keyPresent
      ? 'Check the Decart dashboard balance separately before starting a session.'
      : 'Set DECART_API_KEY locally for Decart; Fit Lab remains usable without it.',
  );
}

export function creditsCheck(data) {
  const { credits, usd, keyQuota } = data ?? {};
  if (!validNumber(credits) || !validNumber(usd))
    return row(
      'Credits endpoint',
      'warn',
      'Provider balance unavailable',
      'Check the Decart account balance on its dashboard.',
    );
  const quota = validNumber(keyQuota) ? `; key quota ${keyQuota}` : '';
  return row(
    'Credits endpoint',
    credits > 0 ? 'pass' : 'warn',
    `reported ${credits} credits (~$${usd.toFixed(2)})${quota}`,
    'Check the actual Decart account balance on the Decart dashboard; this GET does not start a session.',
  );
}

export function referenceChecks(files) {
  return ['parka', 'puffer'].map((jacket) => {
    const name = files.find((f) =>
      new RegExp(`^${jacket}-closed\\.(?:png|jpe?g|webp)$`, 'i').test(f),
    );
    return row(
      `${jacket} closed reference`,
      name ? 'pass' : 'fail',
      name ?? 'Missing nonempty closed-jacket image',
      name
        ? 'Keep this product-only reference available locally.'
        : `Provide a product-only ${jacket}-closed image in apps/web/public/local-textures/decart/.`,
    );
  });
}

export function formatCheck(r) {
  return `${{ pass: '✅', warn: '⚠️', fail: '❌' }[r.status]} ${r.check}: ${r.detail} — ${r.fix}`;
}
export const exitCode = (rows) => (rows.some((r) => r.status === 'fail') ? 1 : 0);

export async function runPreflight({ fetchImpl = fetch, root = ROOT, timeoutMs = 6000 } = {}) {
  const results = await Promise.allSettled(
    Object.entries(CHECK_URLS).map(async ([name, url]) => {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Do not read/log an error response: a misconfigured service could echo a key.
      const body = response.ok && name !== 'studio' ? await response.json() : null;
      return { name, http: response.status, body };
    }),
  );
  const rows = results.map((result, i) => {
    const name = Object.keys(CHECK_URLS)[i];
    const label = {
      body: 'Body service',
      studio: 'Studio page',
      status: 'Token server',
      credits: 'Credits endpoint',
    }[name];
    if (result.status !== 'fulfilled')
      return row(
        label,
        name === 'credits' ? 'warn' : 'fail',
        'Unavailable, timed out or invalid JSON',
        `Check the existing service at ${CHECK_URLS[name]}; do not restart it during recording.`,
      );
    const { http, body } = result.value;
    if (http !== 200)
      return row(
        label,
        name === 'credits' ? 'warn' : 'fail',
        `HTTP ${http}`,
        name === 'credits'
          ? 'Check the Decart dashboard; local Fit Lab does not require cloud credits.'
          : 'Ask the operator to check the existing service before the demo.',
      );
    if (name === 'body')
      return row(
        label,
        body?.model_loaded === true ? 'pass' : 'fail',
        body?.model_loaded === true ? 'HTTP 200; model loaded' : 'HTTP 200; body model not ready',
        'Wait for the existing body service to finish loading.',
      );
    if (name === 'studio')
      return row(label, 'pass', 'HTTP 200', 'Open http://127.0.0.1:5810/studio.html when ready.');
    return name === 'status' ? budgetCheck(body) : creditsCheck(body);
  });
  let files = [];
  const dir = resolve(root, 'apps/web/public/local-textures/decart');
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((f) => f.isFile() && !f.isSymbolicLink() && statSync(resolve(dir, f.name)).size > 0)
      .map((f) => f.name);
  } catch {
    /* Missing references are explicit failures below. */
  }
  rows.push(...referenceChecks(files));
  rows.push(
    row(
      'Camera reminder',
      'warn',
      'Camo Studio 720p/30; close other camera apps',
      'Confirm it manually; this preflight never opens the camera.',
    ),
  );
  rows.push(
    row(
      'Account balance',
      'warn',
      'Decart account balance must be checked on the Decart dashboard',
      'Local ledger allowance is not proof of provider balance or billing accuracy.',
    ),
  );
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const rows = await runPreflight();
  for (const r of rows) console.log(formatCheck(r));
  process.exitCode = exitCode(rows);
}
