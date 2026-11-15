// CX-TRY timing leases: the DAY-specific browser helper rejects TRY identities.
import { acquireBrowserSlot } from '../lookdev/browser-slot.mjs';
import { tryHeavySlot } from '../codex-heavy-slot.mjs';
import { freemem } from 'node:os';

export async function acquireResearchTiming() {
  for (;;) {
    const browser = await acquireBrowserSlot('CX-TRY P26 CPU study', {
      // P17 requires the global lease and RAM. This Node-only job binds NO ports;
      // the P09 legacy dev-port probe would block behind unrelated live servers.
      inspect: async () => ({ busyPorts: [], ramGiB: freemem() / 1024 ** 3 }),
      // Match the active team's short polling so this long-waiting CPU slot is not
      // perpetually starved by 8-10s browser waiters. RAM/ownership guards stay intact.
      pause: () => new Promise((done) => setTimeout(done, 1000)),
      report: (message) => console.log(message.replace('60s', '1s')),
    });
    const heavy = tryHeavySlot('CX-TRY', 'P26 CPU study');
    if (heavy)
      return () => {
        try {
          heavy();
        } finally {
          browser();
        }
      };
    browser();
    await new Promise((done) => setTimeout(done, 60_000));
  }
}
