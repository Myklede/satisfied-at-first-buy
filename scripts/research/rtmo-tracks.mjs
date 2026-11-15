// P26 reference only. Local CPU inference; py/OpenCV decodes pixels, no product imports.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { freemem } from 'node:os';
import { resumeCheckpoint, timingBlocks, cpuFreeze, syncHolds } from './rtmo-control.mjs';

const root = resolve(import.meta.dirname, '../..');
process.chdir(root);
const out = '.cache/research/tracks';
execFileSync('git', ['check-ignore', '-q', `${out}/probe.png`]);
mkdirSync(out, { recursive: true });
const clips = {
  'venue-khong-ao': 'FB7675-100-parka-trang/video/venue-khong-ao.mp4',
  'cam-still': 'FB7675-100-parka-trang/video/cam-still.mp4',
  'cam-tshirt': 'FB7675-100-parka-trang/video/cam-tshirt.mp4',
  'venue-parka': 'FB7675-100-parka-trang/video/venue-mac-ao.mp4',
  'venue-puffer': 'DQ4920-206-puffer-kem/video/venue-mac-ao.mp4',
  'live-parka': 'FB7675-100-parka-trang/video/live/ar-live-20261114-181149-raw.webm',
  'live-puffer': 'FB7675-100-parka-trang/video/live/ar-live-20261114-181352-raw.webm',
  'camo-1': 'FB7675-100-parka-trang/video/camo/camo-test-1.mp4',
  live5: 'FB7675-100-parka-trang/video/live/ar-live-20261114-212343-raw.webm',
};
const helper = `#! ${root.replaceAll('\\', '/')}/.venv/Scripts/python.exe
import sys,json
from pathlib import Path
sys.path.insert(0,str(Path.cwd()/'.cache/research/cv'))
import cv2,numpy as np
cv2.setNumThreads(1)
cap=cv2.VideoCapture(sys.argv[1]);i=0;fps=cap.get(cv2.CAP_PROP_FPS)
if not cap.isOpened():raise RuntimeError('Video open failed')
if '--start' in sys.argv:
 i=int(sys.argv[sys.argv.index('--start')+1])
 # OpenCV's MP4 frame-seek can reset POS_MSEC. Sequential grab preserves VFR PTS.
 for skipped in range(i):
  if not cap.grab():raise RuntimeError('Checkpoint exceeds source frame count')
while True:
 ok=cap.grab()
 if not ok:break
 t=cap.get(cv2.CAP_PROP_POS_MSEC)
 if round(cap.get(cv2.CAP_PROP_POS_FRAMES))-1!=i:raise RuntimeError('Decoded index mismatch')
 dense=22000<=t<=28000 or 31000<=t<=49000
 if '--half' in sys.argv and i%2 and not dense:i+=1;continue
 ok,im=cap.retrieve()
 if not ok:raise RuntimeError('Frame retrieve failed')
 H,W=im.shape[:2];r=min(640/W,640/H)
 a=np.full((640,640,3),114,np.uint8);s=cv2.resize(im,(int(W*r),int(H*r)));a[:s.shape[0],:s.shape[1]]=s
 a.astype(np.float32).transpose(2,0,1).copy().tofile('.cache/research/tracks/frame.tensor')
 print(json.dumps(dict(index=i,tMs=t,width=W,height=H,fps=fps,opencv=cv2.__version__,numpy=np.__version__)),flush=True)
 if not sys.stdin.readline():break
 i+=1
cap.release()
`;
const pyPath = join(out, 'decode.py');
writeFileSync(pyPath, helper);
process.env.ORT_DISABLE_TELEMETRY = '1';
const require = createRequire(join(root, '.cache/research/ort/package.json'));
const ort = require('onnxruntime-node');
const model =
  '.cache/research/models/x/rtmo-s_8xb32-600e_body7-640x640-dac2bf74_20231211/end2end.onnx';
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
let session;
const wanted = process.argv.includes('--clip')
  ? process.argv[process.argv.indexOf('--clip') + 1]
  : null;
if (wanted && !clips[wanted]) throw new Error('Unknown fixed clip key');
const gapAt = process.argv.indexOf('--cpu-gap-seconds');
const gapSeconds = gapAt < 0 ? 0 : Number(process.argv[gapAt + 1]);
if (!Number.isFinite(gapSeconds) || gapSeconds < 0 || gapSeconds > 120)
  throw new Error('CPU gap must be <=120 seconds and explicitly granted by F6');
const gapUntil = gapSeconds ? Date.now() + gapSeconds * 1000 : 0;
const controls = () => {
  const dir = '.cache/lead/service/control';
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => /^timing.*\.json$/.test(n))
        .flatMap((n) => {
          try {
            return [JSON.parse(readFileSync(join(dir, n), 'utf8'))];
          } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw error;
          }
        })
    : [];
};
const tokens = gapSeconds ? controls().map((c) => c.requester + ':' + c.requestedAt) : [];
const waitQuiet = async () => {
  let announced = false;
  while (
    syncHolds(readFileSync('docs/requests/codex-sync.md', 'utf8')).blocked ||
    cpuFreeze(Date.now()) ||
    freemem() < 2 * 2 ** 30 ||
    timingBlocks(controls(), existsSync('.cache/locks/heavy'), Date.now(), gapUntil, tokens)
  ) {
    if (gapUntil && Date.now() >= gapUntil) return false;
    if (!announced) {
      console.log('RTMO PAUSED for timing; no lease acquired');
      announced = true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return !gapUntil || Date.now() < gapUntil;
};
try {
  for (const [key, file] of Object.entries(clips)) {
    if (wanted && wanted !== key) continue;
    if (!wanted && process.argv.includes('--live') !== key.startsWith('live-')) continue;
    if (!wanted && ['camo-1', 'live5'].includes(key)) continue; // explicit study input
    try {
      if (!(await waitQuiet())) break;
      // Throughput extraction, not A's one-thread latency experiment. Native model
      // and output precision stay unchanged. Lead ruling: CPU work takes NO lock.
      session = await ort.InferenceSession.create(model, {
        executionProviders: ['cpu'],
        intraOpNumThreads: 2,
        interOpNumThreads: 1,
      });
      const source = `data/reference-photos/${file}`;
      let report = {
        source,
        sourceSha256: sha(source),
        modelSha256: sha(model),
        ort: ort.env.versions,
        inferenceThreads: 2,
        sampling: process.argv.includes('--half')
          ? 'every 2nd; 22-28s and31-49s dense'
          : 'every frame',
        referenceNotGroundTruth: true,
        complete: false,
        frames: [],
      };
      const target = `${out}/${key}.json`;
      if (process.argv.includes('--resume'))
        report = resumeCheckpoint(JSON.parse(readFileSync(target, 'utf8')), report);
      const start = report.frames.at(-1)?.index + 1 || 0;
      const sourceTimes =
        key === 'camo-1' && existsSync('.cache/research/live1/camo-1-input.json')
          ? JSON.parse(readFileSync('.cache/research/live1/camo-1-input.json', 'utf8')).tMs
          : null;
      const save = () => writeFileSync(target, JSON.stringify(report));
      const child = spawn(
        'py',
        [
          pyPath,
          source,
          '--start',
          String(start),
          ...(process.argv.includes('--half') ? ['--half'] : []),
        ],
        { stdio: ['pipe', 'pipe', 'inherit'] },
      );
      const exited = new Promise((done, reject) => {
        child.on('error', reject);
        child.on('exit', (code) =>
          code === 0 ? done() : reject(new Error(`Decoder exited ${code}`)),
        );
      });
      // Attach a handler immediately so failures during inference don't become unhandled rejections.
      void exited.catch(() => undefined);
      try {
        let exhaustedGap = false;
        for await (const line of createInterface({ input: child.stdout })) {
          if (!(await waitQuiet())) {
            exhaustedGap = true;
            child.stdin.end();
            break;
          }
          const meta = JSON.parse(line),
            bytes = readFileSync(`${out}/frame.tensor`);
          if (sourceTimes && Math.abs(sourceTimes[meta.index] - meta.tMs) > 0.01)
            throw new Error('Container PTS disagrees with sequential source index');
          const input = new ort.Tensor(
            'float32',
            new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)),
            [1, 3, 640, 640],
          );
          const result = await session.run({ input });
          if (report.frames.length && meta.tMs <= report.frames.at(-1).tMs)
            throw new Error('Non-monotonic source time on resume');
          const det = result.dets,
            pts = result.keypoints.data;
          let best = -1;
          // Research selection heuristic, not a calibrated person-presence probability.
          for (let i = 0; i < det.dims[1]; i++)
            if (
              det.data[i * det.dims[2] + 4] >= 0.3 &&
              (best < 0 || det.data[i * det.dims[2] + 4] > det.data[best * det.dims[2] + 4])
            )
              best = i;
          const r = Math.min(640 / meta.width, 640 / meta.height);
          const keypoints =
            best < 0
              ? null
              : Array.from({ length: 17 }, (_, k) => ({
                  x: pts[(best * 17 + k) * 3] / r,
                  y: pts[(best * 17 + k) * 3 + 1] / r,
                  score: pts[(best * 17 + k) * 3 + 2],
                }));
          const box =
            best < 0
              ? null
              : Array.from(
                  det.data.slice(best * det.dims[2], best * det.dims[2] + 4),
                  (v) => v / r,
                );
          // Shared P24 metric threshold; valid requires >=4 selected upper-body joints.
          const valid =
            !!keypoints &&
            [5, 6, 7, 8, 9, 10, 11, 12].filter((k) => keypoints[k].score >= 0.65).length >= 4;
          report.frames.push({ ...meta, keypoints, box, valid });
          if (report.frames.length % 60 === 0) {
            save();
            console.log(key, report.frames.length, meta.tMs);
          }
          child.stdin.write('next\n');
        }
        await exited;
        report.complete = !exhaustedGap;
        save();
        console.log(report.complete ? 'DONE' : 'CPU GAP ENDED', key, report.frames.length);
      } finally {
        child.stdin.end();
      }
    } finally {
      await session?.release();
      session = undefined;
    }
  }
} finally {
  await session?.release();
}
