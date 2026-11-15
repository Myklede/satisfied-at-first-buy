import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildHash, warmProven } from './demo-day-warm.mjs';

test('build hash includes relative names and every byte, not modification times', () => {
  const base = resolve('.cache/demo-day-tests');
  mkdirSync(base, { recursive: true });
  const a = mkdtempSync(join(base, 'a-'));
  const b = mkdtempSync(join(base, 'b-'));
  for (const dir of [a, b]) writeFileSync(join(dir, 'index.html'), 'one');
  assert.equal(buildHash(a), buildHash(b));
  writeFileSync(join(b, 'index.html'), 'two');
  assert.notEqual(buildHash(a), buildHash(b));
  writeFileSync(join(b, 'index.html'), 'one');
  writeFileSync(join(b, 'other.js'), '');
  assert.notEqual(buildHash(a), buildHash(b));
});

test('warm proof requires two completed resets and strictly sub-1500 ms phases', () => {
  const run = {
    complete: true,
    deleted: true,
    dressedMs: 3000,
    xrayDelayMs: 1000,
    phases: Object.fromEntries(
      ['attract', 'body', 'scan', 'dressing', 'result', 'xray', 'motion', 'feel'].map((name) => [
        name,
        { longestTaskMs: 1499 },
      ]),
    ),
  };
  const report = { runs: [structuredClone(run), structuredClone(run)] };
  assert.equal(warmProven(report), true);
  report.runs[1].phases.feel.longestTaskMs = 1500;
  assert.equal(warmProven(report), false);
  report.runs[1] = structuredClone(run);
  report.runs[0].deleted = false;
  assert.equal(warmProven(report), false);
  assert.equal(warmProven({ runs: [run] }), false);
});

test('responsive main thread alone cannot prove a warm shader path', () => {
  const run = {
    complete: true,
    deleted: true,
    dressedMs: 15000,
    xrayDelayMs: 30000,
    phases: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i, { longestTaskMs: 100 }])),
  };
  assert.equal(warmProven({ runs: [run, run] }), false);
  assert.equal(
    warmProven({
      runs: [
        { ...run, dressedMs: 2000, xrayDelayMs: 1 },
        { ...run, dressedMs: 2000 },
      ],
    }),
    false,
  );
  for (const missing of [null, undefined, NaN, -1]) {
    const fast = { ...run, dressedMs: 2000, xrayDelayMs: 1000 };
    assert.equal(warmProven({ runs: [fast, { ...fast, dressedMs: missing }] }), false);
    assert.equal(warmProven({ runs: [fast, { ...fast, xrayDelayMs: missing }] }), false);
  }
});
