import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeCheckpoint, timingBlocks, cpuFreeze, syncHolds } from './rtmo-control.mjs';
test('resume preserves source-time history and rejects a different input or damaged order', () => {
  const fresh = {
    source: 'a',
    sourceSha256: 's',
    modelSha256: 'm',
    sampling: 'every frame',
    inferenceThreads: 2,
    frames: [],
  };
  const old = {
    ...fresh,
    inferenceThreads: 4,
    frames: [
      { index: 0, tMs: 0 },
      { index: 1, tMs: 33 },
    ],
  };
  const resumed = resumeCheckpoint(old, fresh);
  assert.deepEqual(resumed.frames, old.frames);
  assert.deepEqual(resumed.inferenceThreadHistory, [
    { fromIndex: 0, threads: 4 },
    { fromIndex: 2, threads: 2 },
  ]);
  assert.throws(() => resumeCheckpoint({ ...old, sourceSha256: 'other' }, fresh), /identity/);
  assert.throws(
    () =>
      resumeCheckpoint(
        {
          ...old,
          frames: [
            { index: 1, tMs: 33 },
            { index: 0, tMs: 0 },
          ],
        },
        fresh,
      ),
    /ordering/,
  );
});
test('new timing requests and heavy always block; explicit gap bypasses only pre-existing tokens', () => {
  const controls = [{ requester: 'F5', requestedAt: 10, expiresAt: 500 }];
  assert.equal(timingBlocks(controls, false, 100), true);
  assert.equal(timingBlocks(controls, false, 100, 200, ['F5:10']), false);
  assert.equal(
    timingBlocks(
      [...controls, { requester: 'F2', requestedAt: 110, expiresAt: 500 }],
      false,
      120,
      200,
      ['F5:10'],
    ),
    true,
  );
  assert.equal(timingBlocks([], true, 100, 200, []), true);
  assert.equal(timingBlocks(controls, false, 600), false);
});
test('reserved user-test window includes its start and excludes its end', () => {
  assert.equal(cpuFreeze(Date.parse('2026-11-15T01:14:59Z')), false);
  assert.equal(cpuFreeze(Date.parse('2026-11-15T01:15:00Z')), true);
  assert.equal(cpuFreeze(Date.parse('2026-11-15T01:44:59Z')), true);
  assert.equal(cpuFreeze(Date.parse('2026-11-15T01:45:00Z')), false);
});
test('sync holds follow append order, ignore quoted release and test verdicts', () => {
  const begin = '2026-11-14 21:20 F6: USER TEST #5 HOLD until "lead: USER TEST END".';
  assert.equal(syncHolds(begin).blocked, true);
  assert.equal(
    syncHolds(begin + '\n2026-11-14 21:40 lead: USER TEST END (hold lifted)').blocked,
    false,
  );
  assert.equal(
    syncHolds('2026-11-14 22:05 lead: USER TEST #5 = TRUE RC4; verdict jelly').blocked,
    false,
  );
  const timing = '2026-11-14 22:10 F4T: TIMING f4tex start (timing-begin posted)';
  assert.equal(syncHolds(timing).blocked, true);
  assert.equal(syncHolds(timing + '\n2026-11-14 22:15 F4T: TIMING f4tex end').blocked, false);
  assert.equal(
    syncHolds(timing + '\n2026-11-14 22:15 F4T RESULT: f4tex fps, slot released').blocked,
    false,
  );
  const peer = '2026-11-14 22:10 CX-DAY timing-begin: isolated measurement';
  assert.equal(syncHolds(peer).blocked, true);
  assert.equal(syncHolds(peer + '\n2026-11-14 22:15 CX-DAY timing-end: released').blocked, false);
});
