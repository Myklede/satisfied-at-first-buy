// Prompt18: fixed local lock paths, ownership tokens, no stale-lock deletion.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { freemem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { acquireWorkerBrowserSlot, syncWorker } from './codex-day-slot.mjs';
export const HEAVY_LOCK = resolve(import.meta.dirname, '../.cache/locks/heavy');
export const MIN_HEAVY_RAM_GIB = 3;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
export function tryHeavySlot(
  worker,
  task,
  { lockPath = HEAVY_LOCK, ramGiB = freemem() / 1024 ** 3 } = {},
) {
  if (!/^CX-(DAY|TRY)(\/[A-Z-]+)?$/.test(worker) || !/^[A-Za-z0-9 _.-]{1,45}$/.test(task))
    throw new Error('Assigned worker and plain task required');
  if (!(ramGiB >= MIN_HEAVY_RAM_GIB)) return null;
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    mkdirSync(lockPath);
  } catch (error) {
    if (error.code === 'EEXIST') return null;
    throw error;
  }
  const owner = join(lockPath, 'owner.txt');
  const token = `${worker}\n${task}\n${new Date().toISOString()}\nPID ${process.pid}\n${randomUUID()}\n`;
  try {
    writeFileSync(owner, token, { flag: 'wx' });
  } catch (error) {
    try {
      rmdirSync(lockPath);
    } catch {
      /* Preserve nonempty foreign directory. */
    }
    throw error;
  }
  let done = false;
  return () => {
    if (done) return;
    if (readFileSync(owner, 'utf8') !== token)
      throw new Error('Heavy ownership changed; preserving lock');
    rmSync(owner);
    rmdirSync(lockPath);
    done = true;
  };
}
// Heavy-only callers never acquire or wait for browser. Caller must stop its work
// within20min and release in finally; a lock must never expire beneath a live job.
export async function acquireHeavySlot(worker, task) {
  for (;;) {
    const release = tryHeavySlot(worker, task);
    if (release) {
      syncWorker(worker, `HEAVY ACQUIRED ${task}; PID${process.pid}; caller deadline <=20min.`);
      return () => {
        release();
        syncWorker(worker, `HEAVY RELEASE ${task}; PID${process.pid}.`);
      };
    }
    console.log(`${worker}: heavy/RAM waiting60s (need3GiB).`);
    await pause(60000);
  }
}
// Timing acquisition order is ALWAYS browser -> heavy. If heavy/RAM is unavailable,
// return browser immediately, so heavy-only work cannot deadlock a browser waiter.
export async function acquireTimingSlot(worker, task) {
  for (;;) {
    const browser = await acquireWorkerBrowserSlot(worker, task);
    const heavy = tryHeavySlot(worker, task);
    if (heavy) {
      syncWorker(worker, `HEAVY ACQUIRED ${task}; browser first; PID${process.pid}.`);
      let done = false;
      return () => {
        if (done) return;
        try {
          heavy();
          syncWorker(worker, `HEAVY RELEASE ${task}; PID${process.pid}.`);
        } finally {
          browser();
          done = true;
        }
      };
    }
    browser();
    console.log(`${worker}: returned browser; heavy/RAM unavailable, waiting60s.`);
    await pause(60000);
  }
}
