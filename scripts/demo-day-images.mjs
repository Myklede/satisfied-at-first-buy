// Local-only review sheets: never commit a sheet that might contain a private photograph.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './demo-day-warm.mjs';

let files = execFileSync('git', ['ls-files', '-z', '--', 'docs'], {
  cwd: ROOT,
  encoding: 'utf8',
  windowsHide: true,
})
  .split('\0')
  .filter((p) => /\.(png|jpe?g|webp)$/i.test(p));
const additions = process.argv.includes('--additions');
if (additions) {
  const baseline = JSON.parse(
    readFileSync(join(ROOT, 'docs/validation/demo-day-images.json'), 'utf8'),
  );
  const reviewed = new Map(baseline.images.map((i) => [i.path, i.sha256]));
  files = files.filter(
    (path) =>
      reviewed.get(path) !==
      createHash('sha256')
        .update(readFileSync(join(ROOT, path)))
        .digest('hex'),
  );
}
const out = join(ROOT, `.cache/demo-day-image-review${additions ? '-additions' : ''}`);
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
for start in range(0, len(data['files']), 12):
    sheet = Image.new('RGB', (1440, 1360), '#202020')
    draw = ImageDraw.Draw(sheet)
    for n, path in enumerate(data['files'][start:start+12]):
        x, y = (n % 3)*480, (n // 3)*340
        with Image.open(root/path) as img:
            thumb = ImageOps.contain(img.convert('RGB'), (476, 296))
            sheet.paste(thumb, (x+(480-thumb.width)//2, y+30))
        draw.text((x+4, y+4), f'{start+n+1:03d} {Path(path).name}', fill='white')
    sheet.save(out/f'sheet-{start//12+1:02d}.png')
print(json.dumps({'images': len(data['files']), 'sheets': (len(data['files'])+11)//12}))
`,
  ],
  { input: JSON.stringify({ root: ROOT, out, files }), encoding: 'utf8', windowsHide: true },
);
if (result.status !== 0) throw new Error(result.stderr);
const report = {
  at: new Date().toISOString(),
  sheetDirectory: `${out.slice(ROOT.length + 1)} (private, gitignored)`,
  images: files.map((path, i) => ({
    index: i + 1,
    path,
    sha256: createHash('sha256')
      .update(readFileSync(join(ROOT, path)))
      .digest('hex'),
    sheet: Math.floor(i / 12) + 1,
  })),
  visualReview: 'Pending; generating thumbnails does not certify privacy',
};
writeFileSync(
  join(ROOT, `docs/validation/demo-day-images${additions ? '-additions' : ''}.json`),
  JSON.stringify(report, null, 2),
);
console.log(result.stdout.trim());
