// Read-only audit. Invalid POSTs are restricted to the two strict, required-body fit routes.
// Never call profile mutations, board submissions, quit or somebody else's DELETE.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './demo-day-warm.mjs';

const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
const files = git('ls-files', '-z').split('\0').filter(Boolean);
const images = files.filter((p) => p.startsWith('docs/') && /\.(png|jpe?g|webp)$/i.test(p));
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\b(?:sk-ant-|sk-proj-)[A-Za-z0-9_-]{24,}/,
];
const secretFindings = [];
for (const path of files) {
  if (/\.(png|jpe?g|webp|wasm|glb|zip|woff2?|mp4|pdf)$/i.test(path)) continue;
  const value = readFileSync(join(ROOT, path), 'utf8');
  for (const [index, line] of value.split(/\r?\n/).entries())
    if (secretPatterns.some((pattern) => pattern.test(line)))
      secretFindings.push({ path, line: index + 1 });
}
const results = [];
for (const path of ['/body/fit', '/fit/garment']) {
  const payloads =
    path === '/body/fit'
      ? [
          { height_cm: 172, weight_kg: 65, sex: 'male', unexpected: true },
          { height_cm: 119, weight_kg: 65, sex: 'male' },
          { height_cm: 172, weight_kg: 201, sex: 'male' },
        ]
      : [
          { body_id: '0'.repeat(64), product_id: '0'.repeat(64), unexpected: true },
          { body_id: '0'.repeat(64), product_id: '0'.repeat(64), layer_cm: -1 },
          { body_id: '0'.repeat(64), product_id: '0'.repeat(64), layer_cm: 3 },
        ];
  for (const body of payloads) {
    try {
      const r = await fetch(`http://127.0.0.1:8001${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      results.push({ path, body, status: r.status, pass: r.status === 422 });
    } catch (e) {
      results.push({ path, body, error: String(e), pass: false });
    }
  }
}
const report = {
  at: new Date().toISOString(),
  trackedReferencePhotos: files.filter((p) => p.startsWith('data/reference-photos/')),
  envFiles: files.filter((p) => /(^|\/)\.env($|\.)/.test(p)),
  images,
  trackedLookImages: images.filter((p) => /\/look-/.test(p)),
  secretFindings,
  secretScanScope:
    'Tracked working-tree text, private-key headers, AWS access IDs and Anthropic/OpenAI key prefixes only; not proof of absence of all secrets or a history scan',
  validation: results,
  validationScope:
    'Two kiosk POST fit routes, three invalid bodies each. Other agent/profile routes and destructive methods not dynamically probed.',
};
writeFileSync(join(ROOT, 'docs/validation/demo-day-audit.json'), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    trackedPhotos: report.trackedReferencePhotos.length,
    images: images.length,
    trackedLook: report.trackedLookImages.length,
    secretFindings: secretFindings.length,
    validationPassed: results.filter((r) => r.pass).length,
    validationTotal: results.length,
  }),
);
