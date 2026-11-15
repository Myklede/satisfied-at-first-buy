// Read-only resource observations while CX-DAY prepares the judge pack.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserSlot, ROOT } from './demo-day-warm.mjs';

const file = join(ROOT, 'docs/validation/demo-day-slot.json');
const report = { started: new Date().toISOString(), observations: [] };
const deadline = Date.now() + 3 * 60 * 60 * 1000;
while (Date.now() < deadline) {
  const slot = await browserSlot();
  const lock = join(ROOT, '.cache/locks/browser');
  const owner = join(lock, 'owner.txt');
  const observation = {
    at: new Date().toISOString(),
    ...slot,
    locked: existsSync(lock),
    owner: existsSync(owner) ? readFileSync(owner, 'utf8') : null,
  };
  observation.available = !observation.locked && slot.freeGiB >= 2.5 && !slot.occupied.length;
  report.observations.push(observation);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(observation));
  await new Promise((resolve) => setTimeout(resolve, 60000));
}
