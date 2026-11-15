// CLI preload adapter: keep TRY-F's tool read-only while enforcing prompt19's
// exact-style input and selected-catalogue barrier. Never alters engine output.
import { chromium } from 'playwright';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { resolve, join, basename, dirname } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const privateDir = join(root, '.cache/cx-day/finish', `frames-${Date.now()}`);
execFileSync('git', ['check-ignore', '-q', join(privateDir, 'probe.png')], { cwd: root });
fs.mkdirSync(privateDir, { recursive: true });
const write = fs.writeFileSync.bind(fs),
  frames = [];
fs.writeFileSync = (path, ...args) => {
  if (
    typeof path === 'string' &&
    dirname(resolve(path)) === join(root, 'docs/validation') &&
    /^look-v4-.*\.png$/.test(basename(path))
  ) {
    const redirected = join(privateDir, basename(path));
    frames.push(redirected.slice(root.length + 1));
    return write(redirected, ...args);
  }
  return write(path, ...args);
};
syncBuiltinESMExports();
process.on('exit', () =>
  write(
    join(root, '.cache/cx-day/finish/frames-index.json'),
    JSON.stringify({ directory: privateDir.slice(root.length + 1), frames }, null, 2),
  ),
);

const launch = chromium.launchPersistentContext.bind(chromium);
chromium.launchPersistentContext = async (...args) => {
  const context = await launch(...args);
  const attach = (page) => {
    const goto = page.goto.bind(page);
    page.goto = async (url, options) => {
      const u = new URL(url);
      if (u.searchParams.has('arlab')) {
        const requested = u.searchParams.get('jacket');
        const style = ['DQ4920', 'DQ4920-206'].includes(requested)
          ? 'DQ4920-206'
          : ['FB7675', 'FB7675-100'].includes(requested)
            ? 'FB7675-100'
            : null;
        if (!style) throw new Error('Unknown measurement product; exact style required');
        u.searchParams.set('jacket', style);
        const response = await goto(u.href, options);
        await page.waitForFunction(
          (expected) =>
            [...document.querySelectorAll('.arlab select')].some(
              (s) =>
                /^[a-f0-9]{64}$/.test(s.value) &&
                s.selectedOptions[0]?.textContent.trim().startsWith(expected + ' '),
            ),
          style,
          { timeout: 60000 },
        );
        console.log(`CX-DAY selected exact style ${style}`);
        return response;
      }
      return goto(url, options);
    };
  };
  context.pages().forEach(attach);
  context.on('page', attach);
  return context;
};
