import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  acquireBrowserSlot,
  BENCH_PORTS,
  BROWSER_POLL_MS,
  MIN_BROWSER_RAM_GIB,
  withBrowserSlot,
} from './browser-slot.mjs';

function options() {
  const parent = resolve(import.meta.dirname, '../../.cache/lookdev-frames');
  mkdirSync(parent, { recursive: true });
  return {
    lockPath: join(mkdtempSync(join(parent, 'synthetic-lock-')), 'browser'),
    inspect: async () => ({ busyPorts: [], ramGiB: 4 }),
    report: () => {},
  };
}

test('prompt09 coordination constants include port5750 and forbid RAM overrides', () => {
  assert.deepEqual(BENCH_PORTS, [5720, 5730, 5740, 5745, 5750, 8011]);
  assert.equal(MIN_BROWSER_RAM_GIB, 2.5);
  assert.equal(BROWSER_POLL_MS, 60000);
});

test('atomic acquisition waits for another owner and releases only its own token', async () => {
  const opts = options();
  mkdirSync(opts.lockPath);
  const path = join(opts.lockPath, 'owner.txt');
  writeFileSync(path, 'other owner');
  let polls = 0;
  opts.pause = async (ms) => {
    assert.equal(ms, 60000);
    assert.equal(readFileSync(path, 'utf8'), 'other owner');
    polls++;
    rmSync(opts.lockPath, { recursive: true }); // This synthetic owner releases its own lock.
  };
  const release = await acquireBrowserSlot('CX-A synthetic', opts);
  assert.equal(polls, 1);
  assert.match(readFileSync(path, 'utf8'), /CX-A synthetic\nPID \d+/);
  release();
  release();
  assert.equal(existsSync(opts.lockPath), false);
});

test('finally releases on failure; a changed owner is preserved', async () => {
  const opts = options();
  await assert.rejects(
    withBrowserSlot(
      'CX-A synthetic',
      async () => {
        throw new Error('synthetic failure');
      },
      opts,
    ),
    /synthetic failure/,
  );
  assert.equal(existsSync(opts.lockPath), false);
  const release = await acquireBrowserSlot('CX-A synthetic', opts);
  writeFileSync(join(opts.lockPath, 'owner.txt'), 'replacement owner');
  assert.throws(release, /ownership changed/);
  assert.equal(readFileSync(join(opts.lockPath, 'owner.txt'), 'utf8'), 'replacement owner');
});
