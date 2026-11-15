import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
test('VFR alignment sign, constant signal rejection, cuff units and absent reference', () => {
  const root = resolve(import.meta.dirname, '../..');
  mkdirSync(resolve(root, '.cache/research/live1'), { recursive: true });
  const helper = resolve(root, '.cache/research/live1/test.py');
  writeFileSync(
    helper,
    `#! ${root.replaceAll('\\', '/')}/.venv/Scripts/python.exe
import runpy
m=runpy.run_path('scripts/research/live-recordings.py');np=m['np']
t=np.arange(0,5000,67.0);s=np.sin(t/137)+np.cos(t/89)
a=dict(tMs=t.tolist(),bands=np.tile(s[:,None],(1,4)).tolist())
b=dict(tMs=(t+100).tolist(),bands=a['bands'])
assert m['align'](a,b)['offsetMs']==100
assert m['correlation'](np.ones(30),np.ones(30)) is None
im=np.zeros((300,300,3),np.uint8)
mask,r=m['mask_and_metrics'](im,im,dict(keypoints=None))
assert not r['scorable'] and not mask.any()
points=[dict(x=0,y=0,score=0) for _ in range(17)]
for k,x,y in [(5,50,50),(6,150,50),(7,100,150),(9,140,150),(11,50,200),(12,150,200)]:points[k]=dict(x=x,y=y,score=1)
ar=im.copy();ar[145:156,120:151]=255
_,r=m['mask_and_metrics'](im,ar,dict(keypoints=points))
assert abs(r['cuffs']['left']['offsetOverForearm']-.25)<.06,r
assert r['cuffs']['left']['handVisibleProxy'] is None
on=runpy.run_path('scripts/research/live-onset.py')['onset']
t=np.arange(0,2500,64.0);v=(t>=1024).astype(float);u=(t>=1152).astype(float)
assert on(t,u,0,.2)-on(t,v,0,.2)==128
print('alignment/cuff/reference assertions pass')
`,
  );
  assert.match(execFileSync('py', [helper], { cwd: root, encoding: 'utf8' }), /assertions pass/);
});
