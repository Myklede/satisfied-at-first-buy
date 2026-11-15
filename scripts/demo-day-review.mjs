// Review sheets for every captured matrix screenshot. Local cache only, no browser needed.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './demo-day-warm.mjs';

const report = JSON.parse(readFileSync(join(ROOT, 'docs/validation/demo-day-matrix.json'), 'utf8'));
const out = join(ROOT, '.cache/demo-day-matrix-review');
mkdirSync(out, { recursive: true });
const result = spawnSync(
  join(ROOT, '.venv/Scripts/python.exe'),
  [
    '-c',
    `
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps
data = json.load(sys.stdin)
root, out = Path(data['root']), Path(data['out'])
for i, scenario in enumerate(data['scenarios']):
    screens = scenario['screens']
    sheet = Image.new('RGB', (1600, ((len(screens)+1)//2)*480), '#202020')
    draw = ImageDraw.Draw(sheet)
    for n, screen in enumerate(screens):
        x, y = (n % 2)*800, (n // 2)*480
        with Image.open(root/'docs/validation'/screen['path']) as img:
            thumb = ImageOps.contain(img.convert('RGB'), (796, 446))
            sheet.paste(thumb, (x+(800-thumb.width)//2, y+28))
        draw.text((x+4, y+4), f"{scenario['width']}x{scenario['height']} @{scenario['deviceScaleFactor']} {screen['phase']}", fill='white')
    sheet.save(out/f'scenario-{i+1:02d}.png')
print(json.dumps({'scenarios': len(data['scenarios']), 'screens': sum(len(s['screens']) for s in data['scenarios'])}))
`,
  ],
  {
    input: JSON.stringify({ root: ROOT, out, scenarios: report.scenarios }),
    encoding: 'utf8',
    windowsHide: true,
  },
);
if (result.status !== 0) throw new Error(result.stderr);
console.log(result.stdout.trim());
