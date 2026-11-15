import assert from 'node:assert/strict';
import { test } from 'node:test';
import { operationCases } from './demo-day-api-audit.mjs';

test('schema drift cannot accidentally send a valid mutation to a newly added route', () => {
  assert.throws(
    () => operationCases('/new/write', 'post', { requestBody: {} }),
    /Unreviewed mutation/,
  );
});
test('body-bearing operations isolate range, type and unknown-field errors', () => {
  const cases = operationCases('/agent/recommend', 'post', { requestBody: {} });
  assert.equal(cases.length, 3);
  assert.equal(cases[0].body.unexpected, true);
  assert.equal(cases[1].body.body.fit_request.height_cm, 119);
  assert.ok(Array.isArray(cases[2].body.page));
  assert.equal(cases[0].body.body.fit_request.height_cm, 172);
});
test('operations without physical fields cannot claim a physical validation pass', () => {
  const cases = operationCases('/agent/purchases', 'post', { requestBody: {} });
  assert.equal(cases[1].physicalApplicable, false);
  assert.equal(operationCases('/health', 'get', {})[1].physicalApplicable, false);
});
