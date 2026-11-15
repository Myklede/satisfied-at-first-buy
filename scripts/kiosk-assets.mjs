// Prompt 04 Part D: make the web app serve the @satisfy/vision MediaPipe assets.
// @satisfy/vision loads `${assetBase}models/*.task` and `${assetBase}mediapipe/wasm/*`.
// The files are downloaded (hash-verified) into packages/vision/public by its own
// fetch script and are gitignored. This copies them into apps/web/public/vision/
// (also gitignored), so Vite serves them at /vision/ in dev and copies them into
// dist/vision/ for production. The web app passes assetBase '/vision/'.
// Network is used only when the models are missing (AGENTS.md §3: model download).
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const source = join(root, 'packages/vision/public');
const target = join(root, 'apps/web/public/vision');
export const REQUIRED = [
  'models/pose_landmarker_heavy.task',
  'models/hand_landmarker.task',
  'mediapipe/wasm/vision_wasm_internal.wasm',
  'mediapipe/wasm/vision_wasm_internal.js',
];

const missing = (dir) => REQUIRED.filter((file) => !existsSync(join(dir, file)));

export function ensureVisionAssets({ log = console.log } = {}) {
  if (missing(source).length) {
    log('[kiosk] vision models missing, running npm run fetch:models -w packages/vision');
    const result = spawnSync(
      process.execPath,
      [join(root, 'packages/vision/scripts/fetch-models.mjs')],
      { stdio: 'inherit', cwd: join(root, 'packages/vision') },
    );
    if (result.status !== 0) throw new Error('Downloading the vision models failed');
    if (missing(source).length)
      throw new Error(`Vision assets still missing: ${missing(source).join(', ')}`);
  }
  let copied = 0;
  const walk = (relative) => {
    const from = join(source, relative);
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const rel = join(relative, entry.name);
      if (entry.isDirectory()) {
        walk(rel);
        continue;
      }
      const src = join(source, rel);
      const dst = join(target, rel);
      if (existsSync(dst)) {
        const a = statSync(src);
        const b = statSync(dst);
        if (a.size === b.size && a.mtimeMs <= b.mtimeMs) continue;
      }
      mkdirSync(join(dst, '..'), { recursive: true });
      cpSync(src, dst, { preserveTimestamps: true });
      copied++;
    }
  };
  for (const dir of ['models', 'mediapipe']) walk(dir);
  log(`[kiosk] vision assets ready in apps/web/public/vision (${copied} file(s) updated)`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  ensureVisionAssets();
