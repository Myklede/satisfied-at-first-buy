// Build the Fit Agent extension (MV3) with the repo's existing esbuild. No new dependencies.
//
//   node apps/extension/build.mjs                 → apps/extension/dist/prod  (Amazon only, API :8001)
//   node apps/extension/build.mjs --api-port 8011 → same, talking to the standalone agent service
//   node apps/extension/build.mjs --dev --api-port 8011 --page-port 5799
//        → apps/extension/dist/dev: also injects on http://127.0.0.1:<page-port>/* (e2e page server)
//          and uses an open shadow root so Playwright can read the panel.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const dev = flag('--dev');
const demo = flag('--demo');
const apiPort = Number(option('--api-port', '8001'));
const pagePort = Number(option('--page-port', '5799'));
if (!Number.isInteger(apiPort) || !Number.isInteger(pagePort))
  throw new Error('Ports must be integers');
const api = `http://127.0.0.1:${apiPort}`;
const webPort = Number(option('--web-port', '5710'));
if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535)
  throw new Error('Invalid web port');
const web = `http://127.0.0.1:${webPort}`;
const variant = demo ? 'demo' : dev ? 'dev' : 'prod';
const out = resolve(option('--out', join(here, 'dist', variant)));

const amazon = [
  'https://www.amazon.com/dp/*',
  'https://www.amazon.com/*/dp/*',
  'https://www.amazon.com/gp/product/*',
  'https://www.amazon.com/*/gp/product/*',
];
const manifest = {
  manifest_version: 3,
  name: demo
    ? 'Satisfy Fit Agent — Offline Demo'
    : dev
      ? 'Satisfy Fit Agent (dev)'
      : 'Satisfy Fit Agent',
  version: '0.1.0',
  description:
    'Picks your size on Amazon from the product size chart and your body profile, computed on your own computer.',
  permissions: ['storage'],
  // The only host the extension may call: the local service on loopback.
  host_permissions: [`${api}/*`],
  background: { service_worker: 'background.js' },
  content_scripts: [
    {
      matches: demo
        ? [`http://127.0.0.1:${pagePort}/*`]
        : dev
          ? [...amazon, `http://127.0.0.1:${pagePort}/*`]
          : amazon,
      js: ['content.js'],
      run_at: 'document_idle',
    },
  ],
  options_page: 'profile.html',
  content_security_policy: {
    extension_pages: `script-src 'self'; object-src 'self'; connect-src ${api}`,
  },
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: {
    content: join(here, 'src/content.ts'),
    background: join(here, 'src/background.ts'),
    profile: join(here, 'src/profile.ts'),
  },
  outdir: out,
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  define: {
    __FIT_AGENT_API__: JSON.stringify(api),
    __FIT_AGENT_WEB__: JSON.stringify(web),
    __FIT_AGENT_DEV__: JSON.stringify(dev || demo),
  },
  logLevel: 'warning',
});
cpSync(join(here, 'static/profile.html'), join(out, 'profile.html'));
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`[extension] built ${variant} → ${out} (API ${api})`);
