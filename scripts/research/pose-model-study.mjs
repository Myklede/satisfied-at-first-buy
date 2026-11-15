// P24: local CPU study. No browser/app imports. py is used only for OpenCV pixel IO/affine.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const cache = join(root, '.cache/research');
const sha = (data) => createHash('sha256').update(data).digest('hex');
export const joints = [5, 6, 7, 8, 9, 10, 11, 12]; // COCO -> MP 11..16,23..24
export function steps(frames) {
  const values = [];
  for (let i = 1; i < frames.length; i++) {
    const d = joints
      .filter((k) => frames[i]?.[k]?.score >= 0.65 && frames[i - 1]?.[k]?.score >= 0.65)
      .map((k) =>
        Math.hypot(frames[i][k].x - frames[i - 1][k].x, frames[i][k].y - frames[i - 1][k].y),
      );
    if (d.length >= 4) values.push(Math.max(...d));
  }
  return {
    validPairs: values.length,
    meanPx: values.length ? mean(values) : null,
    maxPx: values.length ? Math.max(...values) : null,
  };
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
export function jitter(frames) {
  const values = joints.map((k) => {
    const pts = frames.map((f) => f?.[k]).filter((p) => p?.score >= 0.65);
    if (!pts.length) return { joint: k, samples: 0, rmsPx: null };
    const x = mean(pts.map((p) => p.x)),
      y = mean(pts.map((p) => p.y));
    return {
      joint: k,
      samples: pts.length,
      rmsPx: Math.sqrt(mean(pts.map((p) => (p.x - x) ** 2 + (p.y - y) ** 2))),
    };
  });
  const valid = values.filter((v) => v.rmsPx !== null);
  return {
    joints: values,
    rmsPx: valid.length ? Math.sqrt(mean(valid.map((v) => v.rmsPx ** 2))) : null,
  };
}
export function decodeSimcc(x, y, box) {
  const cx = (box[0] + box[2]) / 2,
    cy = (box[1] + box[3]) / 2;
  let w = (box[2] - box[0]) * 1.25,
    h = (box[3] - box[1]) * 1.25;
  if (w / h > 192 / 256) h = (w * 256) / 192;
  else w = (h * 192) / 256;
  const argmax = (data, start, count) => {
    let best = 0;
    for (let i = 1; i < count; i++) if (data[start + i] > data[start + best]) best = i;
    return [best, data[start + best]];
  };
  return Array.from({ length: 17 }, (_, k) => {
    const [ix, sx] = argmax(x, k * 384, 384),
      [iy, sy] = argmax(y, k * 512, 512);
    return {
      x: (ix / 2 / 192) * w + cx - w / 2,
      y: (iy / 2 / 256) * h + cy - h / 2,
      score: Math.min(sx, sy),
    };
  });
}

// Generated helper remains private. The explicit launcher shebang works without registry
// Python registrations; never execute the Windows Store alias or invoke a python command.
const helper = `#! ${root.replaceAll('\\', '/')}/.venv/Scripts/python.exe
import sys,json,base64,hashlib,shutil
from pathlib import Path
sys.path.insert(0,str(Path.cwd()/'.cache/research/cv'))
import cv2,numpy as np
cv2.setNumThreads(1)
base=Path('.cache/research/frames');base.mkdir(parents=True,exist_ok=True)
if sys.argv[1]=='prepare':
 rows=[]
 folder=Path('data/reference-photos/FB7675-100-parka-trang/video')
 for clip in ['cam-tshirt','cam-parka']:
  dst=base/(clip+'-retained.png');shutil.copyfile(Path('.cache/cx-day/frozen')/(clip+'.mp4-FB7675-100')/'s0-f0-00-raw.png',dst)
  rows.append(dict(clip=clip,kind='retained',path=str(dst)))
  cap=cv2.VideoCapture(str(folder/(clip+'.mp4')));cap.set(cv2.CAP_PROP_POS_MSEC,2000);ok,im=cap.read()
  if not ok: raise RuntimeError('decode failed '+clip)
  dst=base/(clip+'-decoded.png');cv2.imwrite(str(dst),im);rows.append(dict(clip=clip,kind='decoded-opencv',path=str(dst),decodePositionMs=cap.get(cv2.CAP_PROP_POS_MSEC)));cap.release()
 for clip in ['cam-tshirt','cam-still','venue-khong-ao']:
  cap=cv2.VideoCapture(str(folder/(clip+'.mp4')));i=0
  while True:
   ok,im=cap.read()
   if not ok:break
   if i%3==0:
    dst=base/(clip+'-'+str(i)+'.png');cv2.imwrite(str(dst),im)
    rows.append(dict(clip=clip,kind='video',index=i,t=cap.get(cv2.CAP_PROP_POS_MSEC)/1000,path=str(dst)))
   i+=1
  cap.release()
 for row in rows:
  im=cv2.imread(row['path']);row.update(width=im.shape[1],height=im.shape[0],bgrSha256=hashlib.sha256(im.tobytes()).hexdigest())
 Path('.cache/research/frames/manifest.json').write_text(json.dumps(dict(cv=cv2.__version__,numpy=np.__version__,rows=rows)))
 print(len(rows));sys.exit()
if sys.argv[1]=='draw':
 data=json.loads(Path('.cache/research/results.json').read_text())
 samples=[r for r in data['temporal'] if r['clip']=='cam-tshirt']
 thumbs=[]
 for j in range(10):
  row=samples[round(j*(len(samples)-1)/9)];im=cv2.imread(row['path'])
  for model,color in [('rtmpose',(0,255,0)),('rtmo',(0,0,255))]:
   for k,p in enumerate(row[model] or []):
    xy=(round(p['x']),round(p['y']));cv2.circle(im,xy,4,color,-1 if p['score']>=.65 else 1);cv2.putText(im,model[3:]+str(k),xy,cv2.FONT_HERSHEY_SIMPLEX,.35,color,1)
  cv2.putText(im,str(row['index'])+' t='+str(round(row['t'],3)),(20,35),cv2.FONT_HERSHEY_SIMPLEX,1,(255,255,255),2)
  cv2.imwrite(str(base/('spot-'+str(j)+'.png')),im)
  thumbs.append(cv2.resize(im,(640,360)))
 cv2.imwrite(str(base/'spot-sheet.png'),np.vstack([np.hstack(thumbs[:5]),np.hstack(thumbs[5:])]))
 sys.exit()
for line in sys.stdin:
 try:
  req=json.loads(line);im=cv2.imread(req['path']);H,W=im.shape[:2]
  if 'box' in req:
   x1,y1,x2,y2=req['box'];cx=(x1+x2)/2;cy=(y1+y2)/2;w=(x2-x1)*1.25;h=(y2-y1)*1.25
   if w/h>192/256:h=w*256/192
   else:w=h*192/256
   M=np.array([[192/w,0,96-cx*192/w],[0,256/h,128-cy*256/h]],dtype=np.float32)
   out=cv2.warpAffine(im,M,(192,256),flags=cv2.INTER_LINEAR)[:,:,::-1].astype(np.float32)
   out=(out-np.array([123.675,116.28,103.53],dtype=np.float32))/np.array([58.395,57.12,57.375],dtype=np.float32)
  else:
   s=req['size'];ratio=min(s/W,s/H);out=np.full((s,s,3),114,dtype=np.uint8)
   small=cv2.resize(im,(int(W*ratio),int(H*ratio)),interpolation=cv2.INTER_LINEAR);out[:small.shape[0],:small.shape[1]]=small;out=out.astype(np.float32)
  a=np.ascontiguousarray(out.transpose(2,0,1));print(json.dumps(dict(data=base64.b64encode(a.tobytes()).decode())),flush=True)
 except Exception as e: print(json.dumps(dict(error=str(e))),flush=True)
`;

function findModels(dir, found = {}) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findModels(p, found);
    else if (e.name === 'end2end.onnx')
      found[p.includes('rtmpose') ? 'rtmpose' : p.includes('rtmo-') ? 'rtmo' : 'detector'] = p;
  }
  return found;
}
let releaseTiming;
async function main() {
  process.chdir(root);
  mkdirSync(cache, { recursive: true });
  execFileSync('git', ['check-ignore', '-q', '.cache/research/frames/probe.png']);
  const pyFile = join(cache, 'pose-study-helper.py');
  writeFileSync(pyFile, helper);
  if (process.argv.includes('--prepare')) {
    execFileSync('py', [pyFile, 'prepare'], { stdio: 'inherit' });
    return;
  }
  if (process.argv.includes('--draw')) {
    execFileSync('py', [pyFile, 'draw'], { stdio: 'inherit' });
    return;
  }
  if (process.argv.includes('--cpu-benchmark')) {
    if (!process.argv.includes('--on-ac'))
      throw new Error('Timing requires AC power: pass --on-ac only when plugged in.');
    const { acquireResearchTiming } = await import('./research-slot.mjs');
    // Do not allocate models/decoder RAM while waiting behind other timing jobs.
    releaseTiming = await acquireResearchTiming();
  }
  // Set before importing the native runtime: official ORT privacy opt-out.
  process.env.ORT_DISABLE_TELEMETRY = '1';
  const require = createRequire(join(cache, 'ort/package.json'));
  const ort = require('onnxruntime-node');
  const paths = findModels(join(cache, 'models/x'));
  const sessions = {};
  for (const [name, p] of Object.entries(paths))
    sessions[name] = await ort.InferenceSession.create(p, {
      executionProviders: ['cpu'],
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
    });
  const child = spawn('py', [pyFile, 'serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const tensor = async (path, size, box) => {
    child.stdin.write(JSON.stringify({ path, size, box }) + '\n');
    const line = await lines.next();
    if (line.done) throw new Error('OpenCV helper exited');
    const reply = JSON.parse(line.value);
    if (reply.error) throw new Error(reply.error);
    const bytes = Buffer.from(reply.data, 'base64');
    return new ort.Tensor(
      'float32',
      new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)),
      [1, 3, box ? 256 : size, box ? 192 : size],
    );
  };
  const infer = async (name, input) => sessions[name].run({ input });
  const result = {
    generatedUtc: new Date().toISOString(),
    versions: { node: process.version, ort: ort.env.versions },
    execution: 'CPU single thread; no browser',
    models: Object.fromEntries(
      Object.entries(paths).map(([k, p]) => [k, { path: p, sha256: sha(readFileSync(p)) }]),
    ),
    frozen: [],
    temporal: [],
  };
  const manifest = JSON.parse(readFileSync(join(cache, 'frames/manifest.json')));
  const save = () => writeFileSync(join(cache, 'results.json'), JSON.stringify(result));
  const processFrame = async (row, repeat) => {
    const detectorInput = await tensor(row.path, 416);
    const detection = await infer('detector', detectorInput);
    const d = detection.dets.data;
    let best = -1;
    for (let i = 0; i < d.length; i += 5)
      if (d[i + 4] >= 0.3 && (best < 0 || d[i + 4] > d[best + 4])) best = i;
    const ratio = Math.min(416 / row.width, 416 / row.height);
    const box = best < 0 ? null : Array.from(d.slice(best, best + 4), (x) => x / ratio);
    const poseInput = box ? await tensor(row.path, 0, box) : null;
    const rtmoInput = await tensor(row.path, 640);
    const samples = { rtmpose: [], rtmo: [] };
    for (let run = 0; run < repeat; run++) {
      if (poseInput) {
        const p = await infer('rtmpose', poseInput);
        samples.rtmpose.push(decodeSimcc(p.simcc_x.data, p.simcc_y.data, box));
      } else samples.rtmpose.push(null);
      const p = await infer('rtmo', rtmoInput),
        det = p.dets.data,
        count = p.dets.dims[1],
        stride = p.dets.dims[2];
      let selected = -1;
      for (let i = 0; i < count; i++)
        if (
          det[i * stride + 4] >= 0.3 &&
          (selected < 0 || det[i * stride + 4] > det[selected * stride + 4])
        )
          selected = i;
      const r = Math.min(640 / row.width, 640 / row.height),
        pts = p.keypoints.data;
      samples.rtmo.push(
        selected < 0
          ? null
          : Array.from({ length: 17 }, (_, k) => ({
              x: pts[(selected * 17 + k) * 3] / r,
              y: pts[(selected * 17 + k) * 3 + 1] / r,
              score: pts[(selected * 17 + k) * 3 + 2],
            })),
      );
    }
    return {
      ...row,
      box,
      rtmpose: samples.rtmpose.at(-1),
      rtmo: samples.rtmo.at(-1),
      ...(repeat > 1
        ? {
            repeat,
            determinism: Object.fromEntries(
              Object.entries(samples).map(([k, v]) => [
                k,
                { ...steps(v), detected: v.filter(Boolean).length },
              ]),
            ),
          }
        : {}),
    };
  };
  if (process.argv.includes('--cpu-benchmark')) {
    if (!process.argv.includes('--on-ac')) {
      child.stdin.end();
      for (const s of Object.values(sessions)) await s.release();
      throw new Error('Timing is queued until plugged in; pass --on-ac only on AC power.');
    }
    try {
      const retained = JSON.parse(readFileSync(join(cache, 'results.json'))).frozen;
      const rows = [];
      for (const row of retained) {
        for (const name of ['detector', 'rtmpose', 'rtmo']) {
          if (name === 'rtmpose' && !row.box) continue;
          const input = await tensor(
            row.path,
            name === 'detector' ? 416 : 640,
            name === 'rtmpose' ? row.box : undefined,
          );
          for (let i = 0; i < 3; i++) await infer(name, input);
          const ms = [];
          for (let i = 0; i < 30; i++) {
            const begin = performance.now();
            await infer(name, input);
            ms.push(performance.now() - begin);
          }
          rows.push({
            clip: row.clip,
            kind: row.kind,
            model: name,
            samples: 30,
            meanMs: mean(ms),
            maxMs: Math.max(...ms),
          });
          console.log('CPU', row.clip, row.kind, name, JSON.stringify(rows.at(-1)));
        }
      }
      writeFileSync(
        join(cache, 'cpu-benchmark.json'),
        JSON.stringify({
          execution: result.execution,
          excludes: 'decode, IO, preprocessing, sessions, browser/GPU',
          versions: result.versions,
          rows,
        }),
      );
    } finally {
      child.stdin.end();
      for (const s of Object.values(sessions)) await s.release();
    }
    return;
  }
  try {
    for (const row of manifest.rows.filter((r) => r.kind !== 'video')) {
      result.frozen.push(await processFrame(row, 100));
      save();
      console.log('frozen', row.clip, row.kind, JSON.stringify(result.frozen.at(-1).determinism));
    }
    for (const row of manifest.rows.filter((r) => r.kind === 'video')) {
      result.temporal.push(await processFrame(row, 1));
      if (result.temporal.length % 30 === 0) {
        save();
        console.log('frames', result.temporal.length);
      }
    }
    const still = result.temporal.filter((r) => r.clip === 'cam-still' && r.t >= 3.4 && r.t <= 6.4);
    result.still = Object.fromEntries(
      ['rtmpose', 'rtmo'].map((k) => [k, jitter(still.map((r) => r[k]))]),
    );
    save();
  } finally {
    child.stdin.end();
    for (const s of Object.values(sessions)) await s.release();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } finally {
    releaseTiming?.();
  }
}
