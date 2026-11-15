// One machine-wide browser lease for the complete offline proof, never >15min.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { withBrowserSlot, browserReadiness } from '../../../scripts/lookdev/browser-slot.mjs';
const started = new Date().toISOString();
const deadline = Date.now() + 10 * 60_000;
try {
  await withBrowserSlot(
    // owner.txt first line: "A <pid> <time>" (agent A; ':' is not allowed in owner names).
    `A ${process.pid} ${started.replace(/:/g, '-')}`,
    async () => {
      await import('./product-run.mjs');
    },
    {
      inspect: async () => {
        if (Date.now() > deadline)
          throw new Error('Browser resource wait exceeded10min; other agents preserved');
        const state = await browserReadiness();
        for (const port of [8013, 5799]) {
          const probe = createServer();
          await new Promise((ok) => {
            probe.once('error', () => {
              state.busyPorts.push(port);
              ok();
            });
            probe.listen(port, '127.0.0.1', () => probe.close(ok));
          });
        }
        return state;
      },
    },
  );
} catch (error) {
  mkdirSync('docs/validation', { recursive: true });
  writeFileSync(
    'docs/validation/fit-agent-r2-blocked.json',
    JSON.stringify(
      { passed: false, started, finished: new Date().toISOString(), error: String(error) },
      null,
      2,
    ) + '\n',
  );
  console.error(error);
  process.exitCode = 1;
}
