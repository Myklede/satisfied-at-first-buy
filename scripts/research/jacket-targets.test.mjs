import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
test('native synthetic cuff overshoot, collar/nose/chin offsets and empty mask', () => {
  const root = resolve(import.meta.dirname, '../..');
  mkdirSync(resolve(root, '.cache/research/jacket-targets'), { recursive: true });
  const file = resolve(root, '.cache/research/jacket-targets/test.py');
  writeFileSync(
    file,
    `#! ${root.replaceAll('\\', '/')}/.venv/Scripts/python.exe
import runpy
m=runpy.run_path('scripts/research/jacket-targets.py')
np=m['np'];measure=m['measure']
points=[dict(x=0,y=0,score=0) for _ in range(17)]
for k,x,y in [(5,50,50),(6,150,50),(7,100,200),(9,140,200),(0,100,10)]:points[k]=dict(x=x,y=y,score=1)
f=dict(keypoints=points)
mask=np.zeros((300,300),np.uint8);mask[194:207,100:151]=255;mask[30:35,90:111]=255
r=measure(mask,f,dict(y=25,errorPx=3,collarTopY=30,collarErrorPx=2,cuffs=dict(left=dict(x=150,y=200,errorPx=2))))
assert abs(r['cuffs']['left']['endMinusWristOverShoulder']-.1)<.01,r
assert abs(r['collarMinusNoseOverShoulder']-.2)<.01,r
assert abs(r['collarMinusChinOverShoulder']-.05)<.01,r
assert abs(r['manualCuffs']['left']['endMinusWristOverShoulder']-.1)<.01,r
assert abs(r['manualCollarMinusChinOverShoulder']-.05)<.01,r
assert abs(r['manualCollarReadingErrorOverShoulder']-.05)<.01,r
assert not measure(np.zeros_like(mask),f)['valid']
segment=m['segment']
im=np.zeros((300,300,3),np.uint8);im[60:160,60:140]=255;im[180:250,220:270]=255
f['box']=[10,0,190,250]
seg=segment(im,f)
assert seg[100,100]==255
assert seg[220,240]==0
assert not segment(im,dict(keypoints=None)).any()
print('synthetic cuff/collar/empty mask pass')
`,
  );
  const out = execFileSync('py', [file], { cwd: root, encoding: 'utf8' });
  assert.match(out, /pass/);
});
