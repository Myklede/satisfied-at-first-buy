// Inspect the running OpenAPI and probe every documented operation without valid mutations.
// Routes with no physical input explicitly say N/A; a rejected Origin is guard evidence only.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './demo-day-warm.mjs';

const base = 'http://127.0.0.1:8001';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fit = { height_cm: 172, weight_kg: 65, sex: 'male' };
const page = { asin: 'B000000000', url: 'https://www.amazon.com/dp/B000000000' };
const session = { mode: 'session', fit_request: fit };
const seeds = {
  '/body/fit': fit,
  '/fit/garment': { body_id: '0'.repeat(64), product_id: '0'.repeat(64) },
  '/agent/extract': { page },
  '/agent/recommend': { page, body: session },
  '/agent/compare': { asins: ['B000000000', 'B000000001'], body: session },
  '/agent/profile': { consent: true, fit_request: fit },
  '/agent/purchases': { asin: 'B000000000', size: 'S' },
  '/agent/feedback': { purchase_id: '0'.repeat(32), answers: { chest: 'right' } },
};

export function operationCases(path, method, operation) {
  if (operation.requestBody) {
    if (!seeds[path]) throw new Error(`Unreviewed mutation: ${method} ${path}`);
    const unknown = { ...structuredClone(seeds[path]), unexpected: true };
    const range = structuredClone(seeds[path]);
    let physical = true;
    if (path === '/body/fit') range.height_cm = 119;
    else if (path === '/fit/garment') range.layer_cm = -1;
    else if (path === '/agent/profile') range.fit_request.height_cm = 119;
    else if (range.body) range.body.fit_request.height_cm = 119;
    else {
      range.height_cm = 119;
      physical = false;
    }
    const wrong = structuredClone(seeds[path]);
    const key = Object.keys(wrong)[0];
    wrong[key] = ['wrong type'];
    return [
      { kind: 'unknown-field', body: unknown },
      {
        kind: 'physical-range',
        body: range,
        physicalApplicable: physical,
        note: physical
          ? 'Declared physical input below minimum'
          : 'No physical input in schema; unknown height field rejection only',
      },
      { kind: 'wrong-type-or-id', body: wrong },
    ];
  }
  return [
    { kind: 'unknown-field', query: 'unexpected=true' },
    {
      kind: 'physical-range',
      query: 'height_cm=119',
      physicalApplicable: false,
      note: 'No declared physical input; observes treatment of undeclared physical query',
    },
    { kind: 'wrong-type-or-id', query: 'body_id=%5B%5D' },
  ];
}

export function persistedState() {
  const state = {};
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory()) walk(path);
      else if (item.isFile()) state[path.slice(ROOT.length + 1)] = hash(readFileSync(path));
    }
  };
  walk(join(ROOT, '.cache/fit-agent'));
  const board = join(ROOT, 'data/accuracy/board.json');
  if (existsSync(board)) state['data/accuracy/board.json'] = hash(readFileSync(board));
  return state;
}

async function main() {
  const response = await fetch(`${base}/openapi.json`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`OpenAPI HTTP ${response.status}`);
  const source = await response.text();
  const openapi = JSON.parse(source);
  const before = persistedState();
  const results = [];
  for (const [path, item] of Object.entries(openapi.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      for (const sample of operationCases(path, method, operation)) {
        // Invalid path sentinels cannot reference another client's cached body/fit/purchase.
        const concrete = path.replace(/\{[^}]+\}/g, 'invalid!');
        const guarded = method === 'delete' && path.startsWith('/agent/');
        const headers = { 'Content-Type': 'application/json' };
        if (guarded) headers.Origin = 'http://127.0.0.1:5790';
        const request = {
          method: method.toUpperCase(),
          headers,
          signal: AbortSignal.timeout(10000),
        };
        if (sample.body) request.body = JSON.stringify(sample.body);
        const entry = {
          path,
          method,
          ...sample,
          concrete,
          guardOnly: guarded,
          invalidPathAlsoPresent: concrete !== path,
        };
        try {
          const result = await fetch(
            `${base}${concrete}${sample.query ? `?${sample.query}` : ''}`,
            request,
          );
          entry.status = result.status;
          entry.rejected = result.status >= 400 && result.status < 500;
          // Store validation locations/types, never echoed inputs or body/profile data.
          if (result.status === 422) {
            const data = await result.json();
            entry.validation = Array.isArray(data.detail)
              ? data.detail.map(({ loc, type }) => ({ loc, type }))
              : [];
          } else await result.arrayBuffer();
        } catch (error) {
          entry.error = String(error);
          entry.rejected = false;
        }
        results.push(entry);
      }
    }
  }
  const after = persistedState();
  const report = {
    at: new Date().toISOString(),
    openapiSha256: hash(source),
    operations: results.length / 3,
    requests: results.length,
    rejected: results.filter((r) => r.rejected).length,
    accepted: results.filter((r) => !r.rejected && !r.error).length,
    persistedStateUnchanged: JSON.stringify(before) === JSON.stringify(after),
    before,
    after,
    results,
    scope:
      'All OpenAPI operations, three probes each. No valid body created/deleted. Parameterized reads use invalid path IDs (path rejection does not prove unknown-query rejection). Agent DELETE uses rejected Origin so existing personal files cannot be deleted. Physical N/A is explicit. Persisted store/board hashes are compared; all in-memory state is not observable externally.',
  };
  writeFileSync(
    join(ROOT, 'docs/validation/demo-day-api-audit.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      operations: report.operations,
      requests: report.requests,
      rejected: report.rejected,
      accepted: report.accepted,
      persistedStateUnchanged: report.persistedStateUnchanged,
    }),
  );
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/demo-day-api-audit.mjs')) await main();
