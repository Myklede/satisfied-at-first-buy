import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  browserReady,
  contactLayout,
  containedRect,
  MAX_FRAMES,
  parseArgs,
  resolveVideo,
  scanVideos,
  timestamps,
  waitForBrowserSlot,
  OUTPUT,
} from './video-frames.mjs';

test('browser waits 60 seconds until BOTH ports and RAM are safe', async () => {
  assert.equal(browserReady([], 2.5), true);
  assert.equal(browserReady([], 2.49), false);
  assert.equal(browserReady([5740], 8), false);
  assert.equal(browserReady([], NaN), false);
  const states = [
    { busyPorts: [5720, 8011], ramGiB: 4 },
    { busyPorts: [], ramGiB: 2 },
    { busyPorts: [], ramGiB: 3 },
  ];
  const waits = [],
    reports = [];
  await waitForBrowserSlot({
    inspect: async () => states.shift(),
    pause: async (ms) => {
      waits.push(ms);
    },
    report: (s) => reports.push(s),
  });
  assert.deepEqual(waits, [60000, 60000]);
  assert.equal(reports.length, 2);
  assert.equal(states.length, 0);
});

test('timestamps are ordered unique seek targets strictly inside the duration', () => {
  assert.deepEqual(timestamps(5, { every: 2 }), [0, 2, 4]);
  assert.deepEqual(timestamps(4, { at: [3, 0, 1.25, 3] }), [0, 1.25, 3]);
  assert.deepEqual(timestamps(0.1, { every: 2 }), [0]);
  assert.equal(timestamps(252, { every: 1 }).length, 252);
  for (const duration of [0, -1, Infinity, NaN]) assert.throws(() => timestamps(duration));
  for (const every of [0, -1, Infinity, NaN]) assert.throws(() => timestamps(4, { every }));
  for (const at of [[], [-1], [4], [Infinity], [NaN]]) assert.throws(() => timestamps(4, { at }));
  assert.throws(() => timestamps(MAX_FRAMES + 1, { every: 1 }));
});

test('contact grid contains each cell and labels with no overlap or crop', () => {
  const grid = contactLayout(5);
  assert.equal(grid.cells.length, 5);
  assert.deepEqual(grid.cells[0], { x: 12, y: 12, width: 320, height: 180, label: 24 });
  for (const cell of grid.cells) {
    assert.ok(cell.x >= 0 && cell.y >= 0);
    assert.ok(cell.x + cell.width <= grid.width);
    assert.ok(cell.y + cell.height + cell.label <= grid.height);
  }
  assert.equal(contactLayout(1).width, 344);
  for (const n of [0, -1, 1.5, MAX_FRAMES + 1]) assert.throws(() => contactLayout(n));
  assert.deepEqual(containedRect(100, 200, 320, 180), { x: 115, y: 0, width: 90, height: 180 });
  assert.deepEqual(containedRect(200, 100, 320, 180), { x: 0, y: 10, width: 320, height: 160 });
  assert.throws(() => containedRect(0, 100, 320, 180));
});

test('CLI rejects invalid options and contradictory intervals', () => {
  assert.deepEqual(parseArgs(['--at', '0,1.5', '--contact-sheet', 'clip.mov']), {
    options: { at: [0, 1.5], contactSheet: true },
    videos: ['clip.mov'],
  });
  assert.deepEqual(
    parseArgs([
      '--every',
      '1',
      '--contact-sheet',
      '--columns',
      '12',
      '--cell',
      '90x160',
      '--sheet-size',
      '72',
      'v.mp4',
    ]).options,
    { every: 1, contactSheet: true, columns: 12, cell: [90, 160], sheetSize: 72 },
  );
  for (const args of [
    ['--oops'],
    ['--cell', '90'],
    ['--columns', '0'],
    ['--sheet-size', '1.5'],
    ['--at'],
    ['--every', '0'],
    ['--at', '-1'],
    ['--at', 'NaN'],
    ['--at', '0', '--every', '2'],
  ])
    assert.throws(() => parseArgs(args));
});

test('scan only local media; no external CLI paths', () => {
  mkdirSync(OUTPUT, { recursive: true });
  const root = mkdtempSync(join(OUTPUT, 'synthetic-files-'));
  writeFileSync(join(root, 'clip.mov'), 'synthetic');
  writeFileSync(join(root, 'ignore.txt'), 'synthetic');
  writeFileSync(join(root, '.hidden.mp4'), 'synthetic');
  assert.deepEqual(scanVideos(root), [join(root, 'clip.mov')]);
  assert.equal(resolveVideo(join(root, 'clip.mov'), root), join(root, 'clip.mov'));
  assert.throws(() => resolveVideo(join(root, 'ignore.txt'), root));
  assert.throws(() => resolveVideo(import.meta.filename, root));
});
