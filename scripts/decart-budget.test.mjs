// node --test scripts/decart-budget.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MAX_TOTAL_S,
  MINT_WINDOW_S,
  SESSION_LIMIT_S,
  SESSION_LIMITS_S,
  SETTLE_GRACE_S,
  allTimeTotals,
  canMintToken,
  emptyState,
  loadUsage,
  localDay,
  markMinted,
  openSession,
  parseMaxTotal,
  parseMaxUsd,
  reportUsage,
  saveUsage,
  settleCandidate,
  settleFromCredits,
  totals,
  validateUsageBody,
} from './decart-budget.mjs';

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date(2026, 10, 15, 1, 0, 0);
const at = (s) => new Date(NOW.getTime() + s * 1000);
const DAY = '2026-11-15';

function openAndMint(state, n, { page = 'trial', when = NOW, credits = null, maxUsd = 30 } = {}) {
  const r = openSession(state, { id: ID(n), now: when, maxTotalS: 900, maxUsd, page });
  assert.equal(r.ok, true, r.error);
  assert.equal(canMintToken(state, { id: ID(n), now: when }).ok, true);
  markMinted(state, { id: ID(n), now: when, creditsBefore: credits });
  return r.session;
}

test('parseMaxTotal: default, valid, invalid', () => {
  assert.equal(parseMaxTotal(undefined), DEFAULT_MAX_TOTAL_S);
  assert.equal(parseMaxTotal(''), DEFAULT_MAX_TOTAL_S);
  assert.equal(parseMaxTotal('300'), 300);
  assert.throws(() => parseMaxTotal('abc'));
  assert.throws(() => parseMaxTotal('10'));
  assert.throws(() => parseMaxTotal('-5'));
});

test('parseMaxUsd: default $30, refuses more than $30', () => {
  assert.equal(parseMaxUsd(undefined), 30);
  assert.equal(parseMaxUsd('12.5'), 12.5);
  assert.throws(() => parseMaxUsd('30.01'));
  assert.throws(() => parseMaxUsd('100'));
  assert.throws(() => parseMaxUsd('0'));
  assert.throws(() => parseMaxUsd('ten'));
});

test('localDay uses the local calendar', () => {
  assert.equal(localDay(NOW), DAY);
});

test('H1: a browser report never lowers the reservation once a token was minted', () => {
  // The review's probe: ten Studio sessions, each minted, each reporting 0 s.
  const s = emptyState();
  for (let n = 1; n <= 4; n++) {
    openAndMint(s, n, { page: 'studio' });
    assert.equal(reportUsage(s, { id: ID(n), seconds: 0 }).ok, true);
  }
  assert.equal(allTimeTotals(s).totalS, 4 * SESSION_LIMITS_S.studio);
  assert.equal(allTimeTotals(s).usd, 16);
  // ...so the $30 cap stops the 5th and later sessions before more credentials exist.
  const r5 = openSession(s, { id: ID(5), now: NOW, maxTotalS: 36000, maxUsd: 30, page: 'studio' });
  assert.equal(r5.ok, true); // $16 + $4 = $20
  const r6 = openSession(s, { id: ID(6), now: NOW, maxTotalS: 36000, maxUsd: 30, page: 'studio' });
  assert.equal(r6.ok, true); // $24
  const r7 = openSession(s, { id: ID(7), now: NOW, maxTotalS: 36000, maxUsd: 30, page: 'studio' });
  assert.equal(r7.ok, true); // $28
  const r8 = openSession(s, { id: ID(8), now: NOW, maxTotalS: 36000, maxUsd: 30, page: 'studio' });
  assert.equal(r8.ok, false); // $32 > $30
  assert.match(r8.error, /Dollar cap/);
});

test('a report before any mint releases the reservation (no credential existed)', () => {
  const s = emptyState();
  openSession(s, { id: ID(1), now: NOW, maxTotalS: 900 });
  const r = reportUsage(s, { id: ID(1), seconds: 12 });
  assert.equal(r.released, true);
  assert.equal(totals(s, DAY).totalS, 0);
  assert.equal(canMintToken(s, { id: ID(1), now: at(1) }).ok, false); // ended: no late token
});

test('H3: exactly one token per session, only inside the mint window', () => {
  const s = emptyState();
  openSession(s, { id: ID(1), now: NOW, maxTotalS: 900, page: 'studio' });
  assert.equal(canMintToken(s, { id: ID(1), now: at(MINT_WINDOW_S + 1) }).ok, false);
  assert.equal(canMintToken(s, { id: ID(1), now: at(2) }).ok, true);
  markMinted(s, { id: ID(1), now: at(2), creditsBefore: 900 });
  for (const t of [3, 10, 210])
    assert.equal(canMintToken(s, { id: ID(1), now: at(t) }).ok, false, `remint at ${t} s`);
  assert.throws(() => markMinted(s, { id: ID(1), now: at(3), creditsBefore: 900 }));
  assert.equal(canMintToken(s, { id: ID(9), now: at(2) }).ok, false);
});

test('budget refusal: a session that would pass the daily cap is refused', () => {
  const s = emptyState();
  openSession(s, { id: ID(1), now: NOW, maxTotalS: 150 });
  openSession(s, { id: ID(2), now: NOW, maxTotalS: 150 });
  const refused = openSession(s, { id: ID(3), now: NOW, maxTotalS: 150 });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /budget reached/);
});

test('usage from another day does not count toward today', () => {
  const s = emptyState();
  openSession(s, { id: ID(1), now: new Date(2026, 10, 14, 23, 0, 0), maxTotalS: 75 });
  assert.equal(openSession(s, { id: ID(2), now: NOW, maxTotalS: 75 }).ok, true);
});

test('settlement from the provider balance: latest minted session, window over, balance down', () => {
  const s = emptyState();
  openAndMint(s, 1, { page: 'studio', credits: 900 });
  const end = SESSION_LIMITS_S.studio + SETTLE_GRACE_S;
  assert.equal(settleCandidate(s, { now: at(end - 1) }), null); // still inside the window
  const c = settleCandidate(s, { now: at(end) });
  assert.equal(c?.id, ID(1));
  assert.equal(settleFromCredits(s, { id: ID(1), creditsNow: 780 }).ok, true); // 120 cr = 60 s
  assert.equal(totals(s, DAY).usedS, 60);
  assert.equal(settleCandidate(s, { now: at(end + 100) }), null); // settled once
});

test('settlement refuses a balance that went up, and sessions without a reading', () => {
  const s = emptyState();
  openAndMint(s, 1, { credits: 500 });
  assert.equal(settleFromCredits(s, { id: ID(1), creditsNow: 700 }).ok, false);
  assert.equal(totals(s, DAY).totalS, SESSION_LIMIT_S); // full reservation kept
  const t = emptyState();
  openAndMint(t, 1, { credits: null });
  assert.equal(settleCandidate(t, { now: at(10_000) }), null);
});

test('only the most recently minted session can be settled', () => {
  const s = emptyState();
  openAndMint(s, 1, { credits: 900 });
  openAndMint(s, 2, { when: at(20), credits: 880 });
  const c = settleCandidate(s, { now: at(10_000) });
  assert.equal(c?.id, ID(2));
  settleFromCredits(s, { id: ID(2), creditsNow: 860 });
  assert.equal(settleCandidate(s, { now: at(20_000) }), null); // #1 stays fully reserved
  assert.equal(totals(s, DAY).totalS, SESSION_LIMIT_S + 10);
});

test('reports are diagnostics after a mint: kept as reportedS, larger value wins', () => {
  const s = emptyState();
  const session = openAndMint(s, 1);
  reportUsage(s, { id: ID(1), seconds: 30 });
  reportUsage(s, { id: ID(1), seconds: 12 });
  assert.equal(session.reportedS, 30);
  assert.equal(totals(s, DAY).totalS, SESSION_LIMIT_S);
});

test('validateUsageBody rejects unknown fields and bad ranges', () => {
  assert.equal(validateUsageBody({ sessionId: ID(1), seconds: 12 }).ok, true);
  assert.equal(validateUsageBody({ sessionId: ID(1), seconds: 12, extra: 1 }).ok, false);
  assert.equal(validateUsageBody({ sessionId: 'x', seconds: 12 }).ok, false);
  assert.equal(validateUsageBody({ sessionId: ID(1), seconds: -1 }).ok, false);
  assert.equal(validateUsageBody({ sessionId: ID(1), seconds: 1e9 }).ok, false);
  assert.equal(validateUsageBody({ sessionId: ID(1), seconds: '5' }).ok, false);
  assert.equal(validateUsageBody(null).ok, false);
  assert.equal(validateUsageBody([]).ok, false);
});

test('usage file round trip; a corrupt file is an error, not a reset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decart-budget-'));
  const file = join(dir, 'usage.json');
  assert.deepEqual(loadUsage(file), emptyState());
  const s = emptyState();
  openAndMint(s, 1, { credits: 10 });
  saveUsage(file, s);
  const back = loadUsage(file);
  assert.equal(totals(back, DAY).reservedS, SESSION_LIMIT_S);
  assert.equal(canMintToken(back, { id: ID(1), now: at(1) }).ok, false); // the mint persisted
  writeFileSync(file, '{not json');
  assert.throws(() => loadUsage(file));
});
