import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { quickClips, quickDeltas, quickFlags, quickTable } from './ar-quick-lib.mjs';
import { rawJointSteps } from './ar-eval-source-isolation.mjs';

test('the archived no-pose input fingerprint is a wholly transparent native-size frame', () => {
  assert.equal(
    createHash('sha256')
      .update(Buffer.alloc(1280 * 720 * 4))
      .digest('hex'),
    '0c660f2bd3eff3150dd0040789abe2291613b9af319df870203d4f77a4913a5f',
  );
});

test('quick selection covers two camera clips, crossed arms and a distinct dark top', () => {
  const clips = quickClips(
    JSON.parse(readFileSync(new URL('../data/test-videos/manifest.json', import.meta.url))),
  );
  assert.equal(new Set(clips.map((c) => c.file)).size, 4);
  assert.match(clips[2].file, /11569/);
  assert.match(clips[3].file, /10457/);
});
test('flags cannot override fixture, product, body or navigate to a remote source', () => {
  assert.equal(quickFlags('poseWorker=1&still=1').get('still'), '1');
  for (const value of ['source=https://example.com', 'h=180', 'jacket=fake', 'still=1&still='])
    assert.throws(() => quickFlags(value));
});
test('missing measurements never become zero deltas', () => {
  const rows = [
    { clip: 'cam-parka', style: 'FB7675-100', metrics: { stillPx: 0, kioskArFps: 24 } },
  ];
  assert.equal(quickDeltas(rows, null)[0].stillPx, null);
  const baseline = { rows: [{ ...rows[0], metrics: { stillPx: 1, kioskArFps: null } }] };
  const delta = quickDeltas(rows, baseline)[0];
  assert.equal(delta.stillPx, -1);
  assert.equal(delta.kioskArFps, null);
  assert.match(quickTable(rows), /INCOMPLETE/);
});
test('raw metric rejects missing/low-visibility joints and normalizes actual camera gaps', () => {
  const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 1 }));
  const shifted = lm.map((p) => ({ ...p, x: 6, y: 8 }));
  const result = rawJointSteps([
    { lm, cameraFrameIndex: 1 },
    { lm: shifted, cameraFrameIndex: 3 },
  ]);
  assert.equal(result.meanPx, 10);
  assert.equal(result.meanPxPerCameraFrame, 5);
  assert.equal(rawJointSteps([{ lm: null }, { lm: null }]).meanPx, null);
});
