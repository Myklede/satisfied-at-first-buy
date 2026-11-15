import test from 'node:test';
import assert from 'node:assert/strict';
import {
  budgetCheck,
  creditsCheck,
  referenceChecks,
  exitCode,
  formatCheck,
  runPreflight,
  CHECK_URLS,
} from './studio-preflight.mjs';

const status = {
  maxUsd: 30,
  allTimeUsd: 7.25,
  sessionLimits: { studio: 200, trial: 75 },
  keyPresent: true,
};
test('budget allowance includes reservations and cannot claim provider funds', () => {
  const r = budgetCheck(status);
  assert.equal(r.status, 'pass');
  assert.match(r.detail, /left \$22\.75/);
  assert.match(r.detail, /Studio 200s/);
  assert.match(r.fix, /dashboard/);
  assert.equal(budgetCheck({ ...status, allTimeUsd: 31 }).status, 'warn');
  assert.equal(budgetCheck({ ...status, maxUsd: 31 }).status, 'fail');
  assert.equal(budgetCheck({ ...status, allTimeUsd: NaN }).status, 'fail');
});
test('optional cloud warnings do not pretend the local Fit Lab failed', () => {
  assert.equal(budgetCheck({ ...status, keyPresent: false }).status, 'warn');
  assert.equal(creditsCheck({ credits: 0, usd: 0 }).status, 'warn');
  assert.equal(creditsCheck({ credits: null }).status, 'warn');
  assert.equal(exitCode([{ status: 'warn' }]), 0);
  assert.equal(exitCode([{ status: 'fail' }]), 1);
});
test('status/credit output whitelists numbers and never echoes secrets or error strings', () => {
  const secret = 'dct_PRIVATE_DO_NOT_LOG';
  assert.ok(!formatCheck(budgetCheck({ ...status, apiKey: secret })).includes(secret));
  assert.ok(
    !formatCheck(creditsCheck({ credits: 10, usd: 0.1, keyQuota: secret })).includes(secret),
  );
  assert.ok(!formatCheck(creditsCheck({ error: secret })).includes(secret));
});
test('both product-only closed references are required, with supported image extensions', () => {
  assert.ok(
    referenceChecks(['parka-closed.jpg', 'puffer-closed.PNG']).every((r) => r.status === 'pass'),
  );
  assert.equal(referenceChecks(['parka-open.jpg', 'puffer-closed.jpg'])[0].status, 'fail');
});
test('preflight performs exactly the four allowlisted GETs and never follows redirects', async () => {
  const calls = [];
  const rows = await runPreflight({
    root: '.cache/studio-preflight-no-refs',
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      return {
        ok: true,
        status: 200,
        json: async () =>
          url.endsWith('/health')
            ? { model_loaded: true }
            : url.endsWith('/status')
              ? status
              : { credits: 10, usd: 0.1 },
      };
    },
  });
  assert.deepEqual(calls.map((c) => c.url).sort(), Object.values(CHECK_URLS).sort());
  assert.ok(calls.every((c) => c.method === 'GET' && c.redirect === 'error'));
  assert.ok(rows.some((r) => r.check === 'Camera reminder'));
});
test('unavailable services and unloaded body are explicit failures without raw exception output', async () => {
  const rows = await runPreflight({
    root: '.cache/studio-preflight-no-refs',
    fetchImpl: async (url) => {
      if (url.endsWith('/health'))
        return { ok: true, status: 200, json: async () => ({ model_loaded: false }) };
      throw new Error('dct_PRIVATE_DO_NOT_LOG');
    },
  });
  assert.equal(rows[0].status, 'fail');
  assert.equal(exitCode(rows), 1);
  assert.ok(rows.every((r) => !formatCheck(r).includes('dct_')));
});
