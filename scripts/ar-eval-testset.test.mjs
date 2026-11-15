import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  qualifyStill,
  anywearNumbers,
  testsetClips,
  validTestsetFile,
} from './ar-eval-testset.mjs';

test('venue manifest accepts only scoped local paths and rejects traversal/network sources', () => {
  for (const file of [
    'venue/01-hoodie-den.mp4',
    '../reference-photos/FB7675-100-parka-trang/video/cam-still.mp4',
  ])
    assert.equal(validTestsetFile(file), true);
  for (const file of [
    'venue/../../private.mp4',
    'https://example.com/x.mp4',
    '../reference-photos/unknown/video/venue-mac-ao.mp4',
    42,
  ])
    assert.equal(validTestsetFile(file), false);
});
test('manifest maps every existing clip and isolates back labels', () => {
  const c = testsetClips(process.cwd());
  const stock = c.filter((x) => x.file.startsWith('stock/'));
  assert.equal(stock.length, 15);
  assert.equal(stock.filter((x) => x.segments.some((s) => s.expectedBack)).length, 1);
  assert.equal(
    c.some((x) => 'clothing' in x),
    false,
  );
});
test('still qualification uses raw pose spread; moving or sparse intervals stay unavailable', () => {
  const frames = Array.from({ length: 31 }, (_, i) => ({
    videoMs: 100 * i,
    lm: Array.from({ length: 33 }, () => ({ x: 10, y: 20, visibility: 1 })),
  }));
  const seg = [{ id: 's', name: 'still', startMs: 0, endMs: 3100 }];
  assert.equal(qualifyStill(frames, seg)[0].qualified, true);
  frames.forEach((f, i) => f.lm.forEach((p) => (p.x += i * 4)));
  assert.equal(qualifyStill(frames, seg)[0].qualified, false);
  assert.equal(qualifyStill(frames.slice(0, 3), seg)[0].qualified, false);
});
test('Anywear numbers cannot turn unknown visual or missing evidence into PASS', () => {
  assert.equal(anywearNumbers({}).kioskFps, null);
  assert.equal(anywearNumbers({ kioskProfile: { modes: [{ drawnFps: 23.9 }] } }).kioskFps, false);
  assert.equal(anywearNumbers({}).lighting, null);
});
test('Anywear inclusive still bounds and strict coverage bounds match the user bar', () => {
  const row = {
    stillQualification: [{ qualified: true }],
    scoreboard: {
      restOutlinePxPerFrame: { value: 0.3 },
      restRotationRmsDeg: { value: 0.2 },
      restScaleStepP95Pct: { value: 0.1 },
      frontalUncoveredPct: { value: 2 },
      keypointResidualPx: { value: 5 },
    },
    kioskProfile: { modes: [{ drawnFps: 24, violations: [] }] },
  };
  assert.equal(anywearNumbers(row).stationarity, true);
  assert.equal(anywearNumbers(row).coverage, false);
  assert.equal(anywearNumbers(row).residual, false);
  row.scoreboard.restOutlinePxPerFrame.value += 1e-11;
  assert.equal(anywearNumbers(row).stationarity, false);
  row.kioskProfile.modes[0].violations.push('invalid profile');
  assert.equal(anywearNumbers(row).kioskFps, false);
});
