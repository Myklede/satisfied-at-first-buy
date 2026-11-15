import test from 'node:test';
import assert from 'node:assert/strict';
import {
  median,
  summary,
  colourMatch,
  relativeMetric,
  measureFrame,
} from './tryon-validate-math.mjs';
test('missing values never become zero measurements', () => {
  assert.equal(median([]), null);
  assert.equal(summary([NaN]).n, 0);
  assert.equal(relativeMetric([], [2], 5, 0.1).valueCm, null);
});
test('rise sign, scale, temporal sensitivity and baseline spread', () => {
  const r = relativeMetric([100, 110], [50, 60], 5, 0.1, -1, [40, 70]);
  assert.equal(r.valueCm, 10);
  assert.equal(r.componentsCm.frameSpread, 2);
  assert.equal(r.componentsCm.timestamp, 3);
  assert.equal(r.componentsCm.scale, 1);
  assert.equal(r.uncertaintyCm, 9.2);
  assert.equal(relativeMetric([0], [10], 5, 0.1).uncertaintyCm, null);
  assert.throws(() => relativeMetric([0], [1], 0, 0.1));
});
test('colour rejects skin/dark cloth and distinguishes warm puffer', () => {
  assert.equal(colourMatch(230, 225, 210, 'parka'), true);
  assert.equal(colourMatch(210, 185, 155, 'puffer'), true);
  assert.equal(colourMatch(150, 150, 150, 'puffer'), false);
  assert.equal(colourMatch(190, 130, 105, 'parka'), false);
});
test('no pose cannot produce hem or cuffs from a bright image', () => {
  const r = measureFrame({
    width: 10,
    height: 10,
    rgba: new Uint8Array(400).fill(255),
    person: new Float32Array(100).fill(1),
    maskWidth: 10,
    maskHeight: 10,
    landmarks: [],
    jacket: 'parka',
  });
  assert.equal(r.hem, null);
  assert.ok(r.cuffs.every((c) => c.offsetPx === null));
});

test('synthetic coat edge follows the person mask and gives a signed hip distance', () => {
  const width = 160,
    height = 240,
    rgba = new Uint8Array(width * height * 4),
    person = new Float32Array(width * height);
  for (let y = 45; y <= 160; y++)
    for (let x = 45; x <= 115; x++) {
      const i = y * width + x;
      rgba.set([230, 225, 210, 255], i * 4);
      person[i] = 1;
    }
  // Bright background below the jacket must not leak through the person mask.
  for (let y = 180; y < 230; y++)
    for (let x = 45; x <= 115; x++) rgba.set([255, 255, 255, 255], (y * width + x) * 4);
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  for (const [i, x, y] of [
    [11, 50, 40],
    [12, 110, 40],
    [23, 65, 110],
    [24, 95, 110],
  ])
    landmarks[i] = { x: x / width, y: y / height, visibility: 1 };
  const measured = measureFrame({
    width,
    height,
    rgba,
    person,
    maskWidth: width,
    maskHeight: height,
    landmarks,
    jacket: 'parka',
  });
  assert.equal(measured.hem.y, 160);
  assert.equal(measured.hem.offsetPx, 50);
  person.fill(0);
  assert.equal(
    measureFrame({
      width,
      height,
      rgba,
      person,
      maskWidth: width,
      maskHeight: height,
      landmarks,
      jacket: 'parka',
    }).hem,
    null,
  );
});
