import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mustYieldToTry, offeredTurnReady, FAIR_OFFER_MS } from './codex-day-slot.mjs';
const line = (who, message) => `2026-11-14 01:00 ${who}: ${message}`;
test('requeue after a real two-poll opportunity never bypasses RAM, ports or an actual lock', () => {
  const ready = { ramGiB: 2.5, busyPorts: [] };
  assert.equal(offeredTurnReady(FAIR_OFFER_MS - 1, ready, false), false);
  assert.equal(offeredTurnReady(FAIR_OFFER_MS, ready, false), true);
  assert.equal(offeredTurnReady(FAIR_OFFER_MS, { ...ready, ramGiB: 2.49 }, false), false);
  assert.equal(offeredTurnReady(FAIR_OFFER_MS, { ...ready, busyPorts: [5730] }, false), false);
  assert.equal(offeredTurnReady(FAIR_OFFER_MS, ready, true), false);
});
test('after our lease, a pending peer gets the next turn; a release clears it', () => {
  const text = [
    line('CX-TRY', 'SLOT REQUEST tracking'),
    line('CX-DAY', 'SLOT RELEASE baseline'),
  ].join('\n');
  assert.equal(mustYieldToTry(text), true);
  assert.equal(mustYieldToTry(text + '\n' + line('CX-TRY', 'SLOT RELEASE tracking')), false);
});
test('first lease after a peer release is ours even if they requeued; no fake unavailable ports', () => {
  assert.equal(
    mustYieldToTry([line('CX-TRY', 'Released old'), line('CX-TRY', 'Requesting retry')].join('\n')),
    false,
  );
  assert.equal(mustYieldToTry(''), false);
});
test('informal prose does not release ownership or suppress a real pending request', () => {
  const text = [
    line('CX-DAY', 'Released own job'),
    line('CX-TRY', 'SLOT REQUEST job'),
    line('CX-DAY', 'SLOT ACQUIRED setup'),
  ].join('\n');
  assert.equal(mustYieldToTry(text), true);
  assert.equal(mustYieldToTry(text + '\n' + line('CX-TRY', 'NO WAIT finished')), false);
  assert.equal(mustYieldToTry(text + '\n' + line('CX-TRY', 'RELEASE / NO WAIT item0')), false);
});

test('fairness alternates whole teams including full subagent names', () => {
  assert.equal(
    mustYieldToTry(
      [
        line('CX-TRY/TRY-F', 'SLOT REQUEST profile'),
        line('CX-DAY/DAY-G', 'SLOT RELEASE garment'),
      ].join('\n'),
    ),
    true,
  );
});

test('one TRY subagent NO WAIT cannot erase another pending TRY request', () => {
  const text = [
    line('CX-DAY', 'SLOT RELEASE ruler'),
    line('CX-TRY/TRY-M', 'SLOT REQUEST mirror'),
    line('CX-TRY/TRY-F', 'SLOT REQUEST finish'),
    line('CX-TRY/TRY-F', 'NO WAIT cancelled'),
  ].join('\n');
  assert.equal(mustYieldToTry(text), true);
  assert.equal(mustYieldToTry(text + '\n' + line('CX-TRY/TRY-M', 'SLOT ACQUIRED mirror')), false);
});
