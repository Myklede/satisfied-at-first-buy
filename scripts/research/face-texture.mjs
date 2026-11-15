// Public model assets only leave this process over the network; all user pixels stay local.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
process.chdir(resolve(import.meta.dirname, '../..'));
execFileSync('git', ['check-ignore', '-q', '.cache/research/face/privacy-probe.png']);
mkdirSync('.cache/research/face', { recursive: true });
const dir = '.cache/research/models/face';
const urls = {
  'face_landmarker.onnx':
    'https://github.com/yakhyo/mediapipe-face-mesh-onnx/releases/download/weights/face_landmarker_Nx3x256x256.onnx',
  'canonical_face_model.obj':
    'https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/mediapipe/modules/face_geometry/data/canonical_face_model.obj',
  'LICENSE-export':
    'https://raw.githubusercontent.com/yakhyo/mediapipe-face-mesh-onnx/main/LICENSE',
  'LICENSE-google': 'https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/LICENSE',
};
const args = process.argv.slice(2);
if (args.length && !(args.length === 1 && ['--download-assets', '--test'].includes(args[0])))
  throw new Error('Use no arguments, --download-assets or --test');
if (args[0] === '--download-assets') {
  mkdirSync(dir, { recursive: true });
  const provenance = {};
  for (const [name, url] of Object.entries(urls)) {
    const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error('Public model download failed ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    writeFileSync(dir + '/' + name, buf);
    provenance[name] = {
      url,
      bytes: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex'),
    };
  }
  writeFileSync(dir + '/provenance.json', JSON.stringify(provenance, null, 2));
  console.log('Public model assets cached; Apache-2.0 licenses retained');
} else {
  if (args[0] !== '--test' && Object.keys(urls).some((n) => !existsSync(dir + '/' + n)))
    throw new Error('Missing model assets; run --download-assets (public models only)');
  const path = '.cache/research/face/launch.py';
  const body =
    args[0] === '--test'
      ? 'sys.argv=["pytest","scripts/research/test_face_texture.py","-q","-o","cache_dir=.cache/research/face/pytest"]\nrunpy.run_module("pytest",run_name="__main__")\n'
      : 'sys.argv=["scripts/research/face-texture.py"]\nrunpy.run_path(sys.argv[0],run_name="__main__")\n';
  writeFileSync(
    path,
    '#! ' +
      process.cwd().replaceAll('\\', '/') +
      '/.venv/Scripts/python.exe\nimport sys,runpy\nfrom pathlib import Path\nsys.path.insert(0,str(Path.cwd()/"scripts/research"))\nfrom camera_study_common import wait_for_cpu\nwait_for_cpu()\n' +
      body,
  );
  const r = spawnSync('py', [path], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('Face study failed; inspect the private cache');
}
