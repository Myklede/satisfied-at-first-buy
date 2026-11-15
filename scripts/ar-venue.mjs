// Ingest local venue metadata and script labels. Pixels and raw landmarks remain private.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mp4Metadata, venueSegments } from './ar-venue-lib.mjs';
import { qualifyStill } from './ar-eval-testset.mjs';

const ROOT = resolve(import.meta.dirname, '..'),
  out = join(ROOT, '.cache/cx-day/venue');
execFileSync('git', ['check-ignore', '-q', join(out, 'metadata.json')], { cwd: ROOT });
mkdirSync(out, { recursive: true });
const dir = join(ROOT, 'data/test-videos/venue');
const files = existsSync(dir)
  ? readdirSync(dir)
      .filter((n) => /^\d\d-[a-zA-Z0-9_-]+\.mp4$/.test(n))
      .map((n) => `data/test-videos/venue/${n}`)
  : [];
for (const style of ['FB7675-100-parka-trang', 'DQ4920-206-puffer-kem'])
  for (const name of ['cam-still', 'venue-mac-ao', 'venue-khong-ao']) {
    const file = `data/reference-photos/${style}/video/${name}.mp4`;
    if (existsSync(join(ROOT, file))) files.push(file);
  }
const manifestPath = join(ROOT, 'data/test-videos/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const report = {
  generatedUtc: new Date().toISOString(),
  files: [],
  status: files.length
    ? 'INGESTED METADATA; raw still qualification may be pending'
    : 'NO VENUE FILES PRESENT',
};
for (const file of files) {
  const id = file.replace(/^data\//, '').replace(/[^a-zA-Z0-9_.-]/g, '_');
  try {
    const metadata = mp4Metadata(readFileSync(join(ROOT, file)));
    const probe = /00-(nen-trong|giay-trang)\.mp4$/.test(file);
    let segments = probe
      ? []
      : /cam-still\.mp4$/.test(file)
        ? [{ kind: 'still', start_s: 0, end_s: metadata.duration_s }]
        : venueSegments(metadata.duration_s);
    // Lead's venue intake review (codex-sync.md, 2026-11-14 12:45) supersedes
    // the nominal 30-second script for these longer recordings. Approximate labels only.
    if (/cam-still\.mp4$/.test(file))
      segments = [{ kind: 'still', start_s: 2, end_s: metadata.duration_s - 2 }];
    else if (/FB7675-100-parka-trang\/video\/venue-mac-ao/.test(file))
      segments = [
        { kind: 'still', start_s: 2, end_s: 8 },
        { kind: 'turn', start_s: 73, end_s: 77 },
        { kind: 'back', start_s: 111, end_s: 115 },
      ];
    else if (/FB7675-100-parka-trang\/video\/venue-khong-ao/.test(file))
      segments = [
        { kind: 'still', start_s: 2, end_s: 8 },
        { kind: 'cross_arms', start_s: 26, end_s: 30 },
        { kind: 'back', start_s: 44, end_s: 48 },
      ];
    else if (/DQ4920-206-puffer-kem\/video\/venue-mac-ao/.test(file))
      segments = [{ kind: 'still', start_s: 2, end_s: 8 }];
    segments = segments
      .map((s) => ({
        ...s,
        start_s: Math.max(2, s.start_s),
        end_s: Math.min(s.end_s, metadata.duration_s - 2),
      }))
      .filter((s) => s.end_s > s.start_s);
    const rawPath = join(out, `${id}-landmarks.json`);
    const raw = existsSync(rawPath) ? JSON.parse(readFileSync(rawPath, 'utf8')) : null;
    const qualified = raw
      ? qualifyStill(
          raw.frames,
          segments.map((s, i) => ({
            id: `venue-${i}`,
            name: s.kind,
            startMs: s.start_s * 1000,
            endMs: s.end_s * 1000,
          })),
        )
      : [];
    const still = qualified.find((w) => w.qualified);
    if (still) {
      const s = segments.find((s) => s.kind === 'still');
      s.start_s = still.startMs / 1000;
      s.end_s = still.endMs / 1000;
    }
    const entry = {
      file: file.startsWith('data/test-videos/')
        ? file.slice('data/test-videos/'.length)
        : `../${file.slice(5)}`,
      source: 'local venue recording',
      probeOnly: probe,
      ...metadata,
      segments,
      segmentTimingBasis:
        'Approximate lead intake labels for named long recordings, otherwise venue script; first/last2s omitted. Still is replaced only after raw qualification. Unlabelled moves are not scored.',
      stillQualification: still ?? {
        qualified: false,
        reason: raw
          ? 'No qualifying raw-landmark still interval'
          : 'Raw landmarks not available; still interval is nominal, not certified',
      },
    };
    const index = manifest.findIndex((r) => r.file === entry.file);
    if (index < 0) manifest.push(entry);
    else manifest[index] = { ...manifest[index], ...entry };
    report.files.push(entry);
  } catch (error) {
    report.files.push({ file, error: error.message });
  }
}
if (files.length) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(out, 'metadata.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
