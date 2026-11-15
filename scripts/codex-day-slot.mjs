// Prompt17: read append-only coordination before each lease and yield fairly.
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  acquireBrowserSlot,
  browserReadiness,
  browserReady,
  BROWSER_LOCK,
  BROWSER_POLL_MS,
} from './lookdev/browser-slot.mjs';
export const SYNC = resolve(import.meta.dirname, '../docs/requests/codex-sync.md');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
export const FAIR_OFFER_MS = 2 * BROWSER_POLL_MS;
export function offeredTurnReady(elapsedMs, state, lockHeld) {
  return elapsedMs >= FAIR_OFFER_MS && !lockHeld && browserReady(state.busyPorts, state.ramGiB);
}
function teamQueue(text) {
  const pending = new Map();
  let ours = -1,
    theirs = -1;
  text.split(/\r?\n/).forEach((line, index) => {
    const match = /^\d{4}-\d\d-\d\d \d\d:\d\d (CX-(?:TRY|DAY)(?:\/[A-Z-]+)?): (.*)$/i.exec(line);
    if (!match) return;
    const [, worker, event] = match;
    if (worker.startsWith('CX-TRY')) {
      if (/^(?:SLOT REQUEST\b|Requesting\b)/i.test(event)) pending.set(worker, { line, index });
      if (/^(?:SLOT RELEASE\b|Release(?:d)?\b|NO WAIT\b)/i.test(event)) pending.delete(worker);
      if (
        /^(?:SLOT ACQUIRED\b|SLOT RELEASE\b|Release(?:d)?\b)/i.test(event) &&
        !/NO WAIT/i.test(event)
      )
        theirs = index;
    } else if (/^(?:SLOT RELEASE\b|Released\b)/i.test(event)) ours = index;
  });
  return { pending: [...pending.values()].sort((a, b) => a.index - b.index), ours, theirs };
}
const peerRequest = (text) => teamQueue(text).pending.at(-1)?.line ?? '';
export function mustYieldToTry(text) {
  const state = teamQueue(text);
  return state.pending.length > 0 && state.ours > state.theirs;
}
export function syncWorker(worker, message) {
  if (!/^CX-(DAY|TRY)(\/[A-Z-]+)?$/.test(worker)) throw new Error('Invalid worker');
  const stamp = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/New_York',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date());
  appendFileSync(SYNC, `\n${stamp} ${worker}: ${message.replace(/[\r\n]+/g, ' ')}\n`);
}
export const syncDay = (message) => syncWorker('CX-DAY', message);
export const acquireCodexDaySlot = (task) => acquireWorkerBrowserSlot('CX-DAY', task);
export async function acquireWorkerBrowserSlot(worker, task) {
  if (!/^CX-DAY(?:\/DAY-[PG])?$/.test(worker)) throw new Error('Only assigned DAY workers');
  const syncDay = (message) => syncWorker(worker, message);
  if (!/^[A-Za-z0-9 _.-]{1,45}$/.test(task)) throw new Error('Short plain task label required');
  syncDay(`SLOT REQUEST ${task}`);
  let offeredRequest = null;
  const fair = async () => {
    let eligibleSince = null,
      lastRequest = '';
    while (mustYieldToTry(readFileSync(SYNC, 'utf8'))) {
      const request = peerRequest(readFileSync(SYNC, 'utf8'));
      if (request === offeredRequest) return;
      if (request !== lastRequest) {
        eligibleSince = null;
        lastRequest = request;
      }
      const state = await browserReadiness(),
        held = existsSync(BROWSER_LOCK);
      if (!held && browserReady(state.busyPorts, state.ramGiB)) eligibleSince ??= Date.now();
      else eligibleSince = null;
      // Offer two FULL ready polling cycles. A stale request is not a permanent
      // second lock: if the peer never acquires in that opportunity, requeue.
      // We never invent its release, bypass RAM, or remove its real lock.
      if (eligibleSince !== null && offeredTurnReady(Date.now() - eligibleSince, state, held)) {
        offeredRequest = request;
        syncDay(
          `SLOT OFFER ${task}; CX-TRY had two full ready polling cycles without acquisition; requeuing, fresh peer requests still get priority.`,
        );
        return;
      }
      console.log(
        `CX-DAY waiting60s: peer turn; RAM ${state.ramGiB.toFixed(2)} GiB; lock ${held ? 'held' : 'free'}; ports ${state.busyPorts.join(',') || 'free'}.`,
      );
      await pause(60000);
    }
  };
  while (true) {
    await fair();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    const release = await acquireBrowserSlot(`${worker} ${task} ${stamp}`, {
      pause: async (ms) => {
        await pause(ms);
        await fair();
      },
    });
    const latest = readFileSync(SYNC, 'utf8');
    if (mustYieldToTry(latest) && peerRequest(latest) !== offeredRequest) {
      release();
      continue;
    }
    syncDay(
      `SLOT ACQUIRED ${task}; PID${process.pid}; caller enforces <=15min and finally cleanup.`,
    );
    let done = false;
    return () => {
      if (done) return;
      release();
      done = true;
      syncDay(
        `SLOT RELEASE ${task}; PID${process.pid}; resources closed, next waiting CX-TRY may go.`,
      );
    };
  }
}
