import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  distFreshness,
  apiUrl,
  gitState,
  privacyStatus,
  preflightOptions,
  probePrivacy,
  supportedNode,
  topMemoryUsers,
  versionAtLeast,
  warmStatus,
  goDecision,
  ramStatus,
} from './preflight.mjs';
import { buildHash } from './demo-day-warm.mjs';

test('judging RAM threshold is separate from the shared browser launch minimum', () => {
  assert.equal(ramStatus(2.49, true).status, 'fail');
  assert.equal(ramStatus(2.5, true).status, 'warn');
  assert.equal(ramStatus(2.99, true).status, 'warn');
  assert.equal(ramStatus(3, true).status, 'pass');
  assert.equal(ramStatus(3, false).status, 'warn');
  assert.equal(ramStatus(4, false).status, 'pass');
});

test('board fails on first blocker and never accepts stale or incomplete warm evidence', () => {
  assert.equal(goDecision([{ check: 'Power', status: 'warn' }]), 'GO');
  assert.equal(
    goDecision([
      { check: 'RAM', status: 'fail', detail: 'low' },
      { check: 'API', status: 'fail' },
    ]),
    'NO-GO: RAM: low',
  );
  const base = resolve('.cache/demo-day-tests');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'board-'));
  writeFileSync(join(dir, 'index.html'), 'fixture');
  const record = `${dir}-warm.json`;
  assert.equal(warmStatus(dir, record).status, 'warn');
  const run = {
    complete: true,
    deleted: true,
    dressedMs: 3000,
    xrayDelayMs: 1000,
    phases: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i, { longestTaskMs: 100 }])),
  };
  const report = { buildHash: buildHash(dir), runs: [run, run] };
  writeFileSync(record, JSON.stringify(report));
  assert.equal(warmStatus(dir, record).status, 'pass');
  writeFileSync(join(dir, 'index.html'), 'changed');
  assert.equal(warmStatus(dir, record).status, 'warn');
});

test('preflight selects a validated loopback API port without changing privacy mode', () => {
  assert.deepEqual(preflightOptions([]), { kiosk: false, apiPort: 8001 });
  assert.deepEqual(preflightOptions(['--kiosk', '--api-port', '8002']), {
    kiosk: true,
    apiPort: 8002,
  });
  assert.equal(apiUrl('/agent/profile', 8002), 'http://127.0.0.1:8002/agent/profile');
  for (const value of [undefined, '0', '1023', '65536', '8001.5', 'NaN', '8001;whoami'])
    assert.throws(() => preflightOptions(['--api-port', value]), /1024-65535/);
  assert.throws(() => apiUrl('/health', NaN), /1024-65535/);
});

test('privacy probe uses the selected port for both readiness and profile requests', async () => {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return new Response(
      JSON.stringify(
        url.endsWith('/health')
          ? { model_loaded: true }
          : { kiosk_mode: false, saved: false, profile: null },
      ),
    );
  };
  try {
    const result = await probePrivacy(8002);
    assert.equal(result.status, 'warn');
    assert.match(result.detail, /^127\.0\.0\.1:8002:/);
    assert.deepEqual(urls, ['http://127.0.0.1:8002/health', 'http://127.0.0.1:8002/agent/profile']);
    assert.equal((await probePrivacy(8002, true)).status, 'fail');
  } finally {
    globalThis.fetch = original;
  }
});

test('version checks compare numeric components', () => {
  assert.equal(versionAtLeast('v26.13.0', [22, 12, 0]), true);
  assert.equal(versionAtLeast('Python 3.12.9', [3, 12, 0]), true);
  assert.equal(versionAtLeast('3.9.99', [3, 12, 0]), false);
  assert.equal(versionAtLeast('unknown', [3, 12, 0]), false);
  assert.equal(supportedNode('v20.19.0'), true);
  assert.equal(supportedNode('v20.18.9'), false);
  assert.equal(supportedNode('v21.99.0'), false);
  assert.equal(supportedNode('v22.12.0'), true);
});

test('kiosk privacy requires a loaded API and all three kiosk invariants', () => {
  const health = { model_loaded: true };
  const profile = { kiosk_mode: true, saved: false, profile: null };
  assert.equal(privacyStatus(health, profile).status, 'pass');
  for (const invalid of [
    null,
    {},
    { ...profile, kiosk_mode: false },
    { ...profile, saved: true },
    { ...profile, profile: {} },
  ])
    assert.equal(privacyStatus(health, invalid, { kiosk: true }).status, 'fail');
  assert.equal(privacyStatus({ model_loaded: false }, profile).status, 'fail');
});

test('development API warns without changing privacy or hiding an unloaded API', () => {
  const profile = { kiosk_mode: false, saved: true, profile: { example: true } };
  const before = structuredClone(profile);
  assert.equal(privacyStatus({ model_loaded: true }, profile).status, 'warn');
  assert.equal(privacyStatus({ model_loaded: false }, profile).status, 'fail');
  assert.equal(privacyStatus({ model_loaded: true }, profile, { kiosk: true }).status, 'fail');
  assert.deepEqual(profile, before);
});

test('low-memory process list reports only the five largest working sets', () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({
    name: `app${i}`,
    pid: i + 1,
    bytes: i * 1024 ** 2,
    commandLine: 'never printed',
  }));
  const before = structuredClone(rows);
  const output = topMemoryUsers([...rows, { name: 'invalid', bytes: NaN }]);
  assert.equal(output.split('; ').length, 5);
  assert.match(output, /^app6 \(PID 7\): 6 MiB/);
  assert.doesNotMatch(output, /app[01]|never printed|invalid/);
  assert.deepEqual(rows, before);
});

test('dirty tree is reported as a real pre-demo failure, never auto-cleaned', () => {
  assert.equal(gitState('').status, 'pass');
  assert.equal(gitState(' M owned.ts\n?? untracked.txt\n').status, 'fail');
  assert.match(gitState(' M owned.ts\n?? untracked.txt\n').detail, /2 dirty/);
});

test('freshness fails on missing dist and any newer nested source', () => {
  const base = resolve('.cache/codex07');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'preflight-test-'));
  const dist = join(dir, 'dist'),
    src = join(dir, 'src');
  mkdirSync(dist);
  mkdirSync(src);
  const index = join(dist, 'index.html'),
    source = join(src, 'App.tsx');
  assert.equal(distFreshness(dist, [src]).status, 'fail');
  writeFileSync(index, 'synthetic');
  writeFileSync(source, 'synthetic');
  utimesSync(index, new Date(20000), new Date(20000));
  utimesSync(source, new Date(10000), new Date(10000));
  assert.equal(distFreshness(dist, [src]).status, 'pass');
  utimesSync(source, new Date(30000), new Date(30000));
  assert.equal(distFreshness(dist, [src]).status, 'fail');
});
