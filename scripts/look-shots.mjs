// Look-dev renders for the jacket look work (agent L1a): canvas-only captures of the running
// sandbox, including close-ups the sandbox has no preset for (back swoosh, sleeve lettering,
// pocket). Installed Chrome, headed, loopback only; nothing is faked (the page renders the real
// jacket from the local body service).
//   npm run sandbox -- --no-browser        (in another terminal; web on :5740)
//   node scripts/look-shots.mjs [--url http://127.0.0.1:5740/?sandbox] [--out .cache/look]
//        [--colour STYLE=#rrggbb]...   override the shown base colour (before/after colour checks)
//        [--size M] [--only STYLE:shot,STYLE:shot]
// Output: <out>/<style>-<shot>[-<hex>].png, the WebGL canvas pixels exactly as rendered.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const url = value('--url', 'http://127.0.0.1:5740/?sandbox');
const out = resolve(value('--out', '.cache/look'));
const size = value('--size', 'M');
const only = value('--only', '');
const overrides = {};
args.forEach((a, i) => {
  if (args[i - 1] !== '--colour') return;
  const [style, hex] = a.split('=');
  if (!/^#[0-9a-f]{6}$/i.test(hex ?? '')) throw new Error(`--colour wants STYLE=#rrggbb: ${a}`);
  overrides[style] = hex;
});

// Camera: preset view, or a custom orbit (azimuth 0 = front, 90 = wearer's left; metres).
const SHOTS = {
  'FB7675-100': [
    { name: 'front', view: 'front' },
    { name: 'back', view: 'back' },
    { name: 'front34', view: 'front34' },
    { name: 'back34', view: 'back34' },
    { name: 'chest-logo', orbit: { at: 'chest', az: 8, el: 4, dist: 0.42 } },
    { name: 'back-swoosh', orbit: { at: 'back', az: 180, el: 6, dist: 0.95 } },
    { name: 'sleeve-logo', orbit: { at: 'sleeveText', az: 150, el: 2, dist: 0.42 } },
    { name: 'zip-pocket', orbit: { at: 'pocket', az: 10, el: 4, dist: 0.5 } },
  ],
  'DQ4920-206': [
    { name: 'front', view: 'front' },
    { name: 'back', view: 'back' },
    { name: 'front34', view: 'front34' },
    { name: 'back34', view: 'back34' },
    { name: 'chest-logo', orbit: { at: 'chest', az: 8, el: 4, dist: 0.42 } },
    { name: 'placket', view: 'zipper' },
    { name: 'cuff', view: 'cuff' },
  ],
};

mkdirSync(out, { recursive: true });
const context = await chromium.launchPersistentContext('.cache/playwright/look-chrome', {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1600, height: 900 },
  args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'],
});
try {
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => m.type() === 'error' && console.log('[console]', m.text()));
  await page.goto(url);
  await page.waitForFunction(() => window.__satisfySandbox?.ready === true, null, {
    timeout: 180_000,
  });
  for (const [style, shots] of Object.entries(SHOTS)) {
    for (const shot of shots) {
      if (only && !only.split(',').includes(`${style}:${shot.name}`)) continue;
      const png = await page.evaluate(
        async ({ style, size, shot, hex }) => {
          const sb = window.__satisfySandbox;
          await sb.apply({ style, size, view: shot.view ?? 'front', lighting: 'kiosk' });
          const engine = sb.engine;
          const garment = engine.viewer.garment;
          const mesh = garment.mesh;
          if (hex) {
            // Base colour override (sRGB hex -> linear, as three's Color does).
            const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
            const rgb = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
            const colour = mesh.geometry.getAttribute('color');
            for (let i = 0; i < colour.count; i++) colour.setXYZ(i, rgb[0], rgb[1], rgb[2]);
            colour.needsUpdate = true;
          }
          if (shot.orbit) {
            const geo = engine.geo;
            const asset = garment.shownAsset;
            const d = asset.render_details ?? {};
            const hpsY = geo.hpsY; // HPS height from the fit anchors
            const below = (d.yoke_depth_m ?? 0.1) + 0.5 * (d.chamber_height_m ?? 0.15);
            const z = Math.abs(geo.zipper[2]);
            // Left cuff ring on the shown shell (panel 4, largest sleeve v), 12 cm up the sleeve.
            const pos = mesh.geometry.getAttribute('position'),
              uv = asset.render_uv ?? [];
            let vMax = -Infinity;
            asset.panels.forEach((p, i) => p === 4 && (vMax = Math.max(vMax, uv[i * 2 + 1])));
            const ring = [0, 0, 0, 0];
            asset.panels.forEach((p, i) => {
              if (p !== 4 || uv[i * 2 + 1] < vMax - 0.003) return;
              ring[0] += pos.getX(i);
              ring[1] += pos.getY(i);
              ring[2] += pos.getZ(i);
              ring[3]++;
            });
            const cuff = [ring[0] / ring[3], ring[1] / ring[3], ring[2] / ring[3]];
            const up = geo.sleeve.map((s, k) => s - cuff[k]),
              ul = Math.hypot(...up);
            const targets = {
              chest: [0.12, hpsY - below, z * 0.9],
              back: [0, hpsY - below, -z * 0.9],
              sleeveText: cuff.map((c, k) => c + (0.13 * up[k]) / ul),
              pocket: [0.15, hpsY - (d.pocket_top_m ?? 0.33) - 0.06, z * 0.95],
            };
            const t = targets[shot.orbit.at];
            const az = (shot.orbit.az * Math.PI) / 180,
              el = (shot.orbit.el * Math.PI) / 180;
            const r = shot.orbit.dist;
            const eye = [
              t[0] + r * Math.sin(az) * Math.cos(el),
              t[1] + r * Math.sin(el),
              t[2] + r * Math.cos(az) * Math.cos(el),
            ];
            engine.viewer.controls.dispatchEvent({ type: 'start' });
            engine.viewer.controls.target.set(...t);
            engine.viewer.camera.position.set(...eye);
            engine.viewer.controls.update();
          }
          for (let i = 0; i < 10; i++) await new Promise((r) => requestAnimationFrame(r));
          return engine.capture().toDataURL('image/png');
        },
        { style, size, shot, hex: overrides[style] ?? null },
      );
      const suffix = overrides[style] ? `-${overrides[style].slice(1)}` : '';
      const file = join(out, `${style}-${shot.name}${suffix}.png`);
      writeFileSync(file, Buffer.from(png.split(',')[1], 'base64'));
      console.log('wrote', file);
    }
  }
} finally {
  await context.close();
}
