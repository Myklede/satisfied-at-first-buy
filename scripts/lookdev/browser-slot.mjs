// Machine-wide browser coordination shared by the two Codex streams and Claude.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { freemem } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const BROWSER_LOCK = resolve(import.meta.dirname, '../../.cache/locks/browser');
export const BENCH_PORTS = [5720, 5730, 5740, 5745, 5750, 8011];
// Prompt 09, 2026-11-12: no environment override may weaken this resource guard.
export const MIN_BROWSER_RAM_GIB = 2.5;
export const BROWSER_POLL_MS = 60_000;

export function browserReady(busyPorts, ramGiB) {
  return busyPorts.length === 0 && Number.isFinite(ramGiB) && ramGiB >= MIN_BROWSER_RAM_GIB;
}

export async function browserReadiness() {
  const busyPorts = [];
  for (const port of BENCH_PORTS) {
    const probe = createServer();
    await new Promise((done) => {
      probe.once('error', () => {
        busyPorts.push(port);
        done();
      });
      probe.listen(port, '127.0.0.1', () => probe.close(done));
    });
  }
  return { busyPorts, ramGiB: freemem() / 1024 ** 3 };
}

const pauseDefault = (ms) => new Promise((done) => setTimeout(done, ms));

export async function waitForBrowserSlot({
  inspect = browserReadiness,
  pause = pauseDefault,
  report = console.log,
} = {}) {
  while (true) {
    const state = await inspect();
    if (browserReady(state.busyPorts, state.ramGiB)) return state;
    report(
      `Waiting 60s: busy ports ${state.busyPorts.join(', ') || 'none'}; free RAM ${state.ramGiB.toFixed(2)} GiB (need ${MIN_BROWSER_RAM_GIB}).`,
    );
    await pause(BROWSER_POLL_MS);
  }
}

export async function acquireBrowserSlot(owner, options = {}) {
  if (typeof owner !== 'string' || !/^[A-Za-z0-9 /_.-]{1,100}$/.test(owner))
    throw new Error('A short, plain browser owner name is required');
  const { lockPath = BROWSER_LOCK, pause = pauseDefault, report = console.log } = options;
  const token = `${owner}\nPID ${process.pid}\n${randomUUID()}\n`;
  mkdirSync(dirname(lockPath), { recursive: true });
  while (true) {
    await waitForBrowserSlot(options);
    try {
      // No recursive flag: this mkdir is the atomic, machine-wide acquisition.
      mkdirSync(lockPath);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      report('Waiting 60s: another agent holds .cache/locks/browser.');
      await pause(BROWSER_POLL_MS);
      continue;
    }
    const ownerPath = join(lockPath, 'owner.txt');
    try {
      writeFileSync(ownerPath, token, { flag: 'wx' });
    } catch (error) {
      // We created this directory; never remove an independently written owner.
      try {
        rmdirSync(lockPath);
      } catch {
        /* Nonempty means somebody else wrote it: preserve it. */
      }
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      if (readFileSync(ownerPath, 'utf8') !== token)
        throw new Error('Browser lock ownership changed; refusing to remove another owner');
      // The directory contains only our owner file; rm never follows child links.
      rmSync(ownerPath);
      rmdirSync(lockPath);
      released = true;
    };
  }
}

export async function withBrowserSlot(owner, job, options = {}) {
  const release = await acquireBrowserSlot(owner, options);
  try {
    return await job();
  } finally {
    release();
  }
}
