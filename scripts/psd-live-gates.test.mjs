import assert from 'node:assert/strict';
import { test } from 'node:test';
import { holeViolation, decidePSDLive } from './psd-live-gates.mjs';
test('either live-hole threshold can fail independently; exact bounds pass', () => {
  assert.equal(holeViolation({ holesOff: 1000, holesOn: 1101 }).fail, true);
  assert.equal(holeViolation({ holesOff: 10, holesOn: 16 }).fail, true);
  assert.equal(holeViolation({ holesOff: 200, holesOn: 300 }).fail, false);
  assert.equal(holeViolation({ holesOff: 0, holesOn: 1 }).fail, true);
  assert.equal(holeViolation({ holesOff: 0, holesOn: 0 }).fail, false);
});
test('missing samples and numbers never authorize the default feature', () => {
  assert.equal(holeViolation({ holesOff: 0, holesOn: NaN }).known, false);
  assert.equal(decidePSDLive({}).parkaDefaultAllowed, false);
  assert.equal(decidePSDLive({}).workers, 1);
});
test('worker decision uses both measured budgets independently', () => {
  const r = {
    holes: Object.fromEntries(
      ['cam-parka', 'cam-tshirt'].map((s) => [
        s,
        { frames: [{ t: 1, holesOff: 200, holesOn: 300 }] },
      ]),
    ),
    perf: {
      'no-bake': { arFps: { median: 30 }, trackerMs: { median: 20 } },
      '2-workers': { arFps: { median: 27 }, trackerMs: { median: 25 } },
    },
  };
  assert.equal(decidePSDLive(r).parkaDefaultAllowed, true);
  assert.equal(decidePSDLive(r).workers, 2);
  r.perf['2-workers'].trackerMs.median = 25.01;
  assert.equal(decidePSDLive(r).workers, 1);
  r.perf['2-workers'].trackerMs.median = 20;
  r.perf['2-workers'].arFps.median = 26.99;
  assert.equal(decidePSDLive(r).workers, 1);
});
