import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allOf, barRows, handsPass, le, missingFlags, validateCase } from './ar-judge.mjs';

const sb = (values) =>
  Object.fromEntries(Object.entries(values).map(([k, value]) => [k, { value }]));

test('missing metrics are N/A, never PASS (CX-DAY HIGH a23ba5f:160)', () => {
  assert.equal(le(null, 1), null);
  assert.equal(le(undefined, 1), null);
  assert.equal(le(Number.NaN, 1), null);
  assert.equal(allOf([true, null]), null);
  assert.equal(allOf([true, false, null]), false);
  assert.equal(allOf([]), null);
  // qualified still window but every rest metric absent
  const row = { stillQualification: [{ qualified: true }], scoreboard: {} };
  const rows = Object.fromEntries(barRows(row, null, null).map((r) => [r.row, r.pass]));
  for (const [name, pass] of Object.entries(rows)) assert.notEqual(pass, true, name);
  assert.equal(rows['Still -> jacket still'], null);
  assert.equal(rows['Stuck to the body'], null);
  assert.equal(rows['Covers the real clothes'], null);
  assert.equal(rows['Drawn on every frame (D1/D2, judge)'], null);
  assert.equal(rows['Smooth: cadence (judge)'], null);
  assert.equal(rows['Camera-matched edge/grain (A1/A7, D6, judge)'], null);
  assert.equal(rows['Hands visible beyond cuff (A2, judge)'], null);
});

test('coverage needs both V4 and V5: torso N/A cannot pass', () => {
  const row = { scoreboard: sb({ frontalUncoveredPct: 0.4, uncoveredPct: null }) };
  const cov = barRows(row, null).find((r) => r.row === 'Covers the real clothes');
  assert.equal(cov.pass, null);
  const fail = barRows({ scoreboard: sb({ frontalUncoveredPct: 0.4, uncoveredPct: 9 }) }, null);
  assert.equal(fail.find((r) => r.row === 'Covers the real clothes').pass, false);
  const ok = barRows({ scoreboard: sb({ frontalUncoveredPct: 0.4, uncoveredPct: 1 }) }, null);
  assert.equal(ok.find((r) => r.row === 'Covers the real clothes').pass, true);
});

test('failed or stale renders are never graded (CX-DAY HIGH a23ba5f:377)', () => {
  const row = { complete: true, flags: 'f1turn=1', settings: { pageSearch: '?arlab=&f1turn=1' } };
  const prov = { exitCode: 0, flags: 'f1turn=1' };
  assert.equal(validateCase({ provenance: prov, row, flags: 'f1turn=1' }), null);
  assert.match(validateCase({ provenance: null, row, flags: 'f1turn=1' }), /provenance/);
  assert.match(
    validateCase({ provenance: { ...prov, exitCode: 1 }, row, flags: 'f1turn=1' }),
    /exit code 1/,
  );
  // a reused --run under new flags must not consume the old rows
  assert.match(validateCase({ provenance: prov, row, flags: 'f3arms=1' }), /flags/);
  assert.match(
    validateCase({
      provenance: { exitCode: 0, flags: '' },
      row: { complete: true, flags: 'x=1' },
      flags: '',
    }),
    /row flags/,
  );
  assert.match(
    validateCase({ provenance: prov, row: { ...row, complete: false }, flags: 'f1turn=1' }),
    /incomplete/,
  );
  assert.match(validateCase({ provenance: prov, row: null, flags: 'f1turn=1' }), /no row/);
});

test('alignment self-check failure blanks the pixel rows', () => {
  const m = { alignmentOk: false, all: { notSolidPct: 0, flickerPct: { p95: 0 } } };
  const rows = barRows({ scoreboard: {} }, m);
  assert.equal(rows.find((r) => r.row.startsWith('Drawn on every frame')).pass, null);
  assert.equal(rows.find((r) => r.row.startsWith('Smooth: no flicker')).pass, null);
});

test('hands row: an unobserved required window is N/A, never dropped (CX-DAY HIGH :317)', () => {
  const seen = { handsSeen: 40, handsVisiblePct: 100 };
  assert.equal(
    handsPass({ still: seen, 'x-onearm': { handsSeen: 0, handsVisiblePct: null } }),
    null,
  );
  assert.equal(handsPass({ still: seen, 'x-onearm': seen }), true);
  assert.equal(
    handsPass({ still: seen, 'x-onearm': { handsSeen: 10, handsVisiblePct: 50 } }),
    false,
  );
  assert.equal(handsPass({ still: seen }), true); // case without a one-arm window (cam-still)
  assert.equal(handsPass({}), null);
  assert.equal(handsPass({ still: { handsSeen: 0 } }), null);
});

test('a run whose page URL lacks a requested flag is INVALID (lead 22:05)', () => {
  assert.equal(missingFlags('?arlab=&a=1&b=2', 'a=1&b=2'), null);
  assert.equal(missingFlags('?a=1', 'a=1&b=2'), 'b=2');
  assert.equal(missingFlags('?a=0&b=2', 'a=1&b=2'), 'a=1');
  assert.equal(missingFlags(undefined, 'a=1'), 'page URL not recorded');
  assert.equal(missingFlags(undefined, ''), null);
  const prov = { exitCode: 0, flags: 'a=1' };
  assert.match(
    validateCase({
      provenance: prov,
      row: { complete: true, flags: 'a=1', settings: { pageSearch: '?x=1' } },
      flags: 'a=1',
    }),
    /INVALID: page URL lacks a=1/,
  );
});
