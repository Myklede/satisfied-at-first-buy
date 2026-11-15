// Render private measurement overlays into review sheets, never committed imagery.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, PRIVATE, privateGuard } from './tryon-validate-real.mjs';
privateGuard();
const code = String.raw`
from pathlib import Path
import json
from PIL import Image,ImageDraw
root=Path('.cache/cxday-tryon')
capture=json.loads((root/'capture.json').read_text())
for jacket in ['parka','puffer']:
 rows=[r for r in capture['rows'] if r['jacket']==jacket]
 for start in range(0,len(rows),12):
  batch=rows[start:start+12]
  sheet=Image.new('RGB',(6*240,2*465),'#222222');draw=ImageDraw.Draw(sheet)
  for i,row in enumerate(batch):
   x=i%6*240;y=i//6*465
   path=root/f"{jacket}-{row['t']}.png"
   if path.exists():
    im=Image.open(path);im.thumbnail((240,427));sheet.paste(im,(x,y+36))
   hem=row.get('hem') or {}
   draw.text((x+4,y+2),f"{jacket} {row['t']}s hem={hem.get('offsetPx',None)}",fill='white')
   cuffs=row.get('cuffs') or []
   draw.text((x+4,y+17),' / '.join(f"{c['side'][0]}:{round(c['offsetPx'],1) if c.get('offsetPx') is not None else '?'}" for c in cuffs),fill='white')
  path=root/f'{jacket}-review-{start//12:02}.jpg';sheet.save(path);print(path)
`;
console.log(
  execFileSync(join(ROOT, '.venv/Scripts/python.exe'), ['-c', code], {
    cwd: ROOT,
    encoding: 'utf8',
  }),
);
console.log(`Private acceptance file required: ${join(PRIVATE, 'review.json')}`);
