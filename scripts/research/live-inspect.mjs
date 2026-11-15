import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
process.chdir(root);
execFileSync('git', ['check-ignore', '-q', '.cache/research/live1/probe.jpg']);
mkdirSync('.cache/research/live1', { recursive: true });
writeFileSync(
  '.cache/research/live1/inspection-run.py',
  `#! ${root.replaceAll('\\', '/')}/.venv/Scripts/python.exe
import sys,json
from pathlib import Path
sys.path.insert(0,'.cache/research/cv')
import cv2,numpy as np
cv2.setNumThreads(1)
b=Path('.cache/research/live1'); source=Path('data/reference-photos/FB7675-100-parka-trang/video/live')
for key,ident,wanted in [('live-parka','181149',[0,6.3,12.1,16.3,23.9,26.1,32.6,43.9,49.5,57.5,64.7]),('live-puffer','181352',[0,12.9,13.6,21.7,24.4,27.2,40.8,43.6])]:
 alignment=json.loads((b/(key+'-alignment.json')).read_text())['alignment'];offset=alignment['offsetMs']; selected={}
 for kind in ['raw','ar']:
  cap=cv2.VideoCapture(str(source/f'ar-live-20261114-{ident}-{kind}.webm'));j=0;prev=None;pt=0
  try:
   while j<len(wanted):
    ok,im=cap.read()
    if not ok:break
    t=cap.get(cv2.CAP_PROP_POS_MSEC);target=max(0,wanted[j]*1000-(offset if kind=='raw' else 0))
    if t>=target:
     image=prev if prev is not None and abs(pt-target)<abs(t-target) else im
     ts=pt if image is prev else t
     selected[(j,kind)]=(image.copy(),ts);cv2.imwrite(str(b/f'{key}-{j}-{kind}.jpg'),image)
     j+=1
    prev=im;pt=t
  finally:cap.release()
 tiles=[];meta=[]
 for j,t in enumerate(wanted):
  if (j,'raw') not in selected or (j,'ar') not in selected:continue
  raw,rt=selected[(j,'raw')];ar,at=selected[(j,'ar')];tile=cv2.resize(np.hstack([raw,cv2.resize(ar,(raw.shape[1],raw.shape[0]))]),(960,270))
  cv2.putText(tile,f'{key} #{j} raw {rt/1000:.3f} | AR {at/1000:.3f}',(5,20),0,.5,(0,0,255),1);tiles.append(tile);meta.append(dict(sample=j,rawMs=rt,arMs=at))
 for k in range(0,len(tiles),4):cv2.imwrite(str(b/f'{key}-inspect-{k//4}.jpg'),np.vstack(tiles[k:k+4]))
 (b/f'{key}-inspect.json').write_text(json.dumps(meta));print(key,meta)
`,
);
execFileSync('py', ['.cache/research/live1/inspection-run.py'], { stdio: 'inherit' });
