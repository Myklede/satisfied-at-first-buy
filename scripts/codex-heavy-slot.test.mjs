import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tryHeavySlot } from './codex-heavy-slot.mjs';
test('heavy lease enforces3GiB, exclusion and token ownership; never removes a foreign owner', () => {
  const dir = resolve('.cache/lock-test');
  mkdirSync(dir, { recursive: true });
  const parent = mkdtempSync(join(dir, 'heavy-')),
    lockPath = join(parent, 'heavy');
  try {
    assert.equal(tryHeavySlot('CX-DAY/DAY-P', 'test', { lockPath, ramGiB: 2.99 }), null);
    const release = tryHeavySlot('CX-DAY/DAY-P', 'test', { lockPath, ramGiB: 3 });
    const token = readFileSync(join(lockPath, 'owner.txt'), 'utf8');
    assert.match(token, /^CX-DAY\/DAY-P\ntest\n/);
    assert.equal(tryHeavySlot('CX-DAY/DAY-G', 'test', { lockPath, ramGiB: 5 }), null);
    writeFileSync(join(lockPath, 'owner.txt'), 'foreign');
    assert.throws(release, /ownership changed/);
    assert.equal(readFileSync(join(lockPath, 'owner.txt'), 'utf8'), 'foreign');
    writeFileSync(join(lockPath, 'owner.txt'), token);
    release();
    release();
  } finally {
    rmSync(parent, { recursive: true });
  }
});
