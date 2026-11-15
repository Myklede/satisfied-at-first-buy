// Downloads the MediaPipe models into public/models and copies the WASM runtime
// that matches the installed @mediapipe/tasks-vision version into public/mediapipe/wasm.
// Network is used only here (asset download, AGENTS.md §3). The first download
// records SHA-256 hashes in models.lock.json; later runs verify against them.
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const modelsDir = path.join(pkgRoot, 'public', 'models');
const lockFile = path.join(pkgRoot, 'models.lock.json');

const MODELS = {
  'hand_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task',
  // lite: the real-time option for the live pose mirror (pose tracker benches all three).
  'pose_landmarker_lite.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
  'pose_landmarker_full.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
  'pose_landmarker_heavy.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task',
  'selfie_multiclass_256x256.tflite':
    'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
};

const exists = (p) =>
  access(p).then(
    () => true,
    () => false,
  );
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const lock = (await exists(lockFile)) ? JSON.parse(await readFile(lockFile, 'utf8')) : {};
await mkdir(modelsDir, { recursive: true });

for (const [name, url] of Object.entries(MODELS)) {
  const target = path.join(modelsDir, name);
  let buf;
  if (await exists(target)) buf = await readFile(target);
  else {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed ${res.status} for ${url}`);
    buf = Buffer.from(await res.arrayBuffer());
    await writeFile(target, buf);
  }
  const hash = sha256(buf);
  if (lock[name] && lock[name].sha256 !== hash)
    throw new Error(`${name}: hash ${hash} does not match models.lock.json (${lock[name].sha256})`);
  lock[name] = { url, sha256: hash, bytes: buf.length };
  console.log(`${name}  ${(buf.length / 1e6).toFixed(1)} MB  ${hash.slice(0, 12)}`);
}

// The package's "exports" map hides package.json, so locate it from the main entry.
const require = createRequire(import.meta.url);
let mpDir = path.dirname(require.resolve('@mediapipe/tasks-vision'));
while (!(await exists(path.join(mpDir, 'wasm')))) mpDir = path.dirname(mpDir);
const mpPkg = path.join(mpDir, 'package.json');
const mpVersion = JSON.parse(await readFile(mpPkg, 'utf8')).version;
await cp(
  path.join(path.dirname(mpPkg), 'wasm'),
  path.join(pkgRoot, 'public', 'mediapipe', 'wasm'),
  {
    recursive: true,
  },
);
lock['@mediapipe/tasks-vision/wasm'] = { version: mpVersion };
console.log(`wasm runtime copied from @mediapipe/tasks-vision ${mpVersion}`);

await writeFile(lockFile, JSON.stringify(lock, null, 2) + '\n');
