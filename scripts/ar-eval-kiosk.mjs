// Read-only adapter around TRY-F's kiosk tool: actual UI, local fixture and exact card.
import { join } from 'node:path';
import { profileKiosk } from '../apps/web/src/engine/live/ar/finish/eval/kiosk-profile.mjs';
export async function stockKioskProfile(context, { root, file, style, still, flags = null }) {
  const { createServer } = await import('vite');
  const server = await createServer({
    root: join(root, 'apps/web'),
    configFile: join(root, 'apps/web/src/engine/live/ar/finish/eval/vite.v4.config.ts'),
    logLevel: 'error',
    cacheDir: join(root, '.cache/cx-day/testset/vite-profile'),
    server: {
      host: '127.0.0.1',
      port: 5772,
      strictPort: true,
      hmr: false,
      watch: { ignored: ['**/*'] },
    },
  });
  let page, timer;
  let fixtureResponses = 0;
  try {
    await server.listen();
    page = await context.newPage();
    timer = setTimeout(() => void page.close().catch(() => {}), 60000);
    page.setDefaultTimeout(45000);
    await page.route('**/sandbox/ref?**', (route) => {
      fixtureResponses++;
      return route.fulfill({ path: file, contentType: 'video/mp4' });
    });
    const goto = page.goto.bind(page);
    page.goto = (url, options) => {
      const u = new URL(url);
      u.searchParams.set('still', still);
      // F5 judge A/B pass-through (validated by scripts/ar-eval.mjs); absent => unchanged.
      if (flags) for (const [k, v] of flags) u.searchParams.set(k, v);
      return goto(u.href, options);
    };
    const role = page.getByRole.bind(page);
    page.getByRole = (name, options) =>
      name === 'button' && options?.name === 'Try it on you'
        ? page.locator('.k-card').filter({ hasText: style }).getByRole(name, options)
        : role(name, options);
    const result = await profileKiosk(page, {
      port: 5772,
      body: { h: 172, w: 65 },
      seconds: 6,
      cpu: false,
      modes: ['default'],
    });
    const selected = await page.evaluate(async () => {
      const e = window.__tryfEngine,
        id = e?.options?.productId;
      const products = await fetch('/api/products').then((r) => r.json());
      return products.find((p) => p.product_id === id)?.style ?? null;
    });
    if (selected !== style) throw new Error('Kiosk selected style mismatch');
    if (fixtureResponses < 1) throw new Error('No local fixture response observed');
    return {
      ...result,
      selectedStyle: selected,
      fixtureResponses,
      fixture:
        'local manifest clip via loopback route; default fallback172/65, tracking-only; no fit verdict',
      scope:
        'Actual kiosk UI6s profile; native fixture stream, no evaluation readbacks or screenshots. Separate dev/no-HMR source, compared by caller source hashes.',
    };
  } finally {
    clearTimeout(timer);
    await page?.close().catch(() => {});
    await server.close();
  }
}
