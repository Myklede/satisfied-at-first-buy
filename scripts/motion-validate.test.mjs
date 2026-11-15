import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellStats } from './motion-validate.mjs';

test('woven strain: shared edges count once, frame and edge medians use every sample', () => {
  const rest = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const asset = { rest, triangles: [0, 1, 2, 2, 1, 0], elastic: [0, 0, 0] };
  const bake = {
    particles: 3,
    frameCount: 2,
    positions: Float32Array.from([...rest, ...rest.map((v) => v * 2)]),
  };
  assert.deepEqual(shellStats(asset, bake), {
    edges: 3,
    worstRatio: 2,
    maxEdgesOver110: 3,
    medianRatio: 1.5,
    medianFrameWorst: 1.5,
  });
  asset.elastic = [1, 1, 0];
  assert.equal(shellStats(asset, bake).edges, 2);
});

test('sliver and elastic-only meshes cannot silently produce a median', () => {
  const asset = {
    rest: [0, 0, 0, 0.001, 0, 0, 0, 0.001, 0],
    triangles: [0, 1, 2],
    elastic: [0, 0, 0],
  };
  const bake = { particles: 3, frameCount: 1, positions: Float32Array.from(asset.rest) };
  assert.throws(() => shellStats(asset, bake), /No woven edges/);
  asset.rest = asset.rest.map((v) => v * 1000);
  asset.elastic = [1, 1, 1];
  assert.throws(() => shellStats(asset, bake), /No woven edges/);
});
