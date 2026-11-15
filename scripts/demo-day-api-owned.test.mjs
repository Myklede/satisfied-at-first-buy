import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertOwnedDelete, assertSafeOperation, probePath } from './demo-day-api-owned.mjs';

test('a valid hash alone never authorizes deleting another client body', () => {
  const own = 'a'.repeat(64),
    foreign = 'b'.repeat(64);
  assert.doesNotThrow(() => assertOwnedDelete(own, new Set([own])));
  assert.throws(() => assertOwnedDelete(foreign, new Set([own])), /not created by this job/);
  assert.throws(
    () => assertOwnedDelete('invalid!', new Set(['invalid!'])),
    /not created by this job/,
  );
});
test('unknown query is independent of ID rejection and bad-ID probe changes just one ID', () => {
  const body = 'a'.repeat(64);
  const values = { body_id: body, motion_id: 'reach_forward' };
  assert.equal(
    probePath('/motion/{body_id}/{motion_id}/frames.bin', 'unknown-field', values),
    `/motion/${body}/reach_forward/frames.bin`,
  );
  assert.equal(
    probePath('/motion/{body_id}/{motion_id}/frames.bin', 'wrong-type-or-id', values),
    '/motion/invalid!/reach_forward/frames.bin',
  );
  assert.throws(
    () => probePath('/body/{body_id}/mesh.glb', 'unknown-field', { body_id: '../foreign' }),
    /safe resource/,
  );
  assert.throws(
    () => probePath('/body/{body_id}/mesh.glb', 'unknown-field', { body_id: 'short' }),
    /resource hash/,
  );
});

test('OpenAPI drift cannot authorize a new destructive handler', () => {
  assert.throws(() => assertSafeOperation('/admin/delete-all', 'delete', {}), /Unreviewed DELETE/);
  assert.throws(() => assertSafeOperation('/agent/delete-all', 'delete', {}), /Unreviewed DELETE/);
  assert.throws(() => assertSafeOperation('/new/mutate', 'post', {}), /without schema/);
  assert.throws(
    () => assertSafeOperation('/new/mutate', 'post', { requestBody: {} }),
    /Unreviewed mutation/,
  );
  assert.doesNotThrow(() => assertSafeOperation('/body/{body_id}', 'delete', {}));
});
