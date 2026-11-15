import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { freemem } from 'node:os';
import { createConnection } from 'node:net';
import { chromium } from 'playwright';
import { acquireTimingSlot } from './codex-heavy-slot.mjs';

export const ROOT = join(import.meta.dirname, '..');
export function buildHash(dist) {
  const hash = createHash('sha256');
  function walk(dir) {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(dir, item.name);
      if (item.isSymbolicLink()) throw new Error('Dist symlinks are unsupported');
      if (item.isDirectory()) walk(path);
      else
        hash.update(
          JSON.stringify([
            relative(dist, path).replaceAll('\\', '/'),
            readFileSync(path).toString('base64'),
          ]),
        );
    }
  }
  walk(dist);
  return hash.digest('hex');
}
export function busy(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (value) => {
      socket.destroy();
      done(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1500, () => finish(true));
  });
}
export async function browserSlot() {
  const ports = [5720, 5730, 5740, 5745, 5750, 8011];
  const occupied = (await Promise.all(ports.map(async (p) => ((await busy(p)) ? p : null)))).filter(
    Boolean,
  );
  return { freeGiB: freemem() / 1024 ** 3, occupied };
}
export async function takeBrowserLock() {
  return acquireTimingSlot('CX-DAY', 'kiosk warm');
}
export async function waitForBrowserLock() {
  return acquireTimingSlot('CX-DAY', 'demo validation');
}
export function warmProven(report) {
  // Prompt 13b: a 15–30 second pass-2 wait remains WARN despite a responsive main thread.
  const shortWait = (value) => Number.isFinite(value) && value >= 0 && value < 15000;
  return (
    report.runs?.length === 2 &&
    report.runs.every((r) => r.complete && r.deleted) &&
    shortWait(report.runs[1].dressedMs) &&
    shortWait(report.runs[1].xrayDelayMs) &&
    Object.keys(report.runs[1].phases ?? {}).length >= 7 &&
    Object.values(report.runs[1].phases).every((p) => p.longestTaskMs < 1500) &&
    !report.error
  );
}

// The reference input is KioskApp.tsx REFERENCE (172 cm / 65 kg male), never private tapes.
// Diagnostics only observe state; all transitions and interaction use UI/pointer events.
export async function judgePath(page, capture = async () => {}, origin = 'http://127.0.0.1:5730') {
  const run = { phases: {}, complete: false, deleted: false };
  const screen = (name) => page.waitForSelector(`[data-screen="${name}"]`, { timeout: 180000 });
  let phase = 'load';
  await page
    .exposeFunction('__dayTask', (name, duration) => {
      const p = (run.phases[name] ??= { longestTaskMs: 0 });
      p.longestTaskMs = Math.max(p.longestTaskMs, duration);
    })
    .catch(() => {});
  await page.addInitScript(() => {
    window.__dayPhases = [{ name: 'load', at: 0 }];
    // Observe the real garment draw, rather than treating linked programs or a timeout as X-ray.
    // This records draw submission; physical display/GPU presentation latency is not measured.
    window.__dayDraws = [];
    const programs = new WeakSet();
    const locations = new WeakMap();
    const modes = new WeakMap();
    const active = new WeakMap();
    const seen = new WeakSet();
    const p = WebGL2RenderingContext.prototype;
    const link = p.linkProgram;
    p.linkProgram = function (program) {
      if (
        (this.getAttachedShaders(program) ?? []).some((s) =>
          (this.getShaderSource(s) ?? '').includes('gNormalOut'),
        )
      )
        programs.add(program);
      return link.call(this, program);
    };
    const location = p.getUniformLocation;
    p.getUniformLocation = function (program, name) {
      const result = location.call(this, program, name);
      if (result && name === 'fitMode' && programs.has(program)) locations.set(result, program);
      return result;
    };
    const uniform = p.uniform1f;
    p.uniform1f = function (location, value) {
      const program = location && locations.get(location);
      if (program) modes.set(program, value);
      return uniform.call(this, location, value);
    };
    const use = p.useProgram;
    p.useProgram = function (program) {
      active.set(this, program);
      return use.call(this, program);
    };
    for (const name of ['drawElements', 'drawArrays']) {
      const draw = p[name];
      p[name] = function (...args) {
        const result = draw.apply(this, args);
        if (modes.get(active.get(this)) === 1 && !seen.has(this.canvas)) {
          seen.add(this.canvas);
          window.__dayDraws.push({
            view: [...document.querySelectorAll('.k-canvas canvas')].indexOf(this.canvas),
            at: performance.now(),
          });
        }
        return result;
      };
    }
    window.__dayTimes = {};
    setInterval(() => {
      const times = window.__dayTimes;
      if (document.querySelector('[data-screen="result"]') && times.result === undefined)
        times.result = performance.now();
      const jackets = window.__kiosk?.jackets;
      if (
        jackets?.length === 2 &&
        jackets.every((j) => j.settled && !j.error) &&
        times.dressed === undefined
      )
        times.dressed = performance.now();
    }, 20);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const phase = window.__dayPhases.findLast((p) => p.at <= e.startTime);
        void window.__dayTask(phase.name, e.duration);
      }
    }).observe({ type: 'longtask', buffered: true });
  });
  const mark = async (next) => {
    const stats = await page.evaluate(() => window.__kiosk?.stats() ?? null);
    run.phases[phase] ??= { longestTaskMs: 0 };
    run.phases[phase].renderStats = stats?.views ?? null;
    phase = next;
    console.log(`CX-DAY phase: ${next}`);
    await page.evaluate((name) => {
      window.__dayPhases.push({ name, at: performance.now() });
    }, next);
  };
  try {
    await page.goto(`${origin}/?kiosk`);
    await screen('attract');
    await mark('attract');
    await capture('attract');
    await mark('body');
    await page.keyboard.press('Space');
    await screen('you');
    await page.getByRole('button', { name: 'cm · kg' }).click();
    await page.getByLabel('Height centimetres').fill('172');
    await page.getByLabel('Weight kilograms').fill('65');
    await page.getByRole('button', { name: 'Male', exact: true }).click();
    await capture('body');
    await mark('scan');
    await page.getByRole('button', { name: 'Continue →' }).click();
    await screen('scan');
    await capture('scan');
    await page.evaluate(() => {
      window.__dayTimes.skip = performance.now();
    });
    await page.getByRole('button', { name: /Skip scan|Continue without scan|Continue →/ }).click();
    await screen('fitting');
    await mark('dressing');
    await capture('dressing');
    await screen('result');
    await mark('result');
    await capture('result');
    await mark('xray');
    await page.waitForFunction(
      () =>
        window.__kiosk?.jackets?.length === 2 &&
        window.__kiosk.jackets.every((j) => j.settled && !j.error),
      null,
      { timeout: 180000 },
    );
    await page.waitForFunction(
      () => window.__dayDraws.filter((d) => d.view >= 0).length >= 2,
      null,
      { timeout: 180000 },
    );
    const timing = await page.evaluate(() => ({
      times: window.__dayTimes,
      draws: window.__dayDraws,
    }));
    run.dressedMs = Math.round(timing.times.dressed - timing.times.skip);
    run.resultMs = Math.round(timing.times.result - timing.times.skip);
    run.xrayDraws = timing.draws;
    run.xrayDelayMs = Math.round(Math.max(...timing.draws.map((d) => d.at)) - timing.times.result);
    run.timingMethod =
      'Browser clock; result/settled sampled every 20 ms; X-ray garment draw submission, not GPU presentation';
    await capture('xray');
    await mark('motion');
    await page.locator('.k-moves').first().click();
    await page.waitForFunction(() => window.__satisfyMotion?.state().ready === true, null, {
      timeout: 180000,
    });
    await capture('motion');
    await mark('feel');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: /Feel the fabric/ }).click();
    await screen('feel');
    await page.waitForFunction(() => window.__interact?.state().ready, null, { timeout: 60000 });
    await capture('feel');
    run.interactions = [];
    for (let jacket = 0; jacket < 2; jacket++) {
      await page.locator('[aria-label="Jacket"] button').nth(jacket).click();
      await page.waitForFunction(() => window.__interact?.state().ready);
      await page.waitForTimeout(1500);
      const state = () => page.evaluate(() => window.__interact.state());
      const drag = async (points) => {
        const rect = await page.locator('.k-canvas:visible').first().boundingBox();
        const px = (p) => ({
          x: rect.x + ((p.x + 1) / 2) * rect.width,
          y: rect.y + ((1 - p.y) / 2) * rect.height,
        });
        let p = px(points[0]);
        await page.mouse.move(p.x, p.y);
        await page.mouse.down();
        for (const point of points.slice(1)) {
          p = px(point);
          await page.mouse.move(p.x, p.y, { steps: 3 });
          await page.waitForTimeout(35);
        }
        await page.mouse.up();
        await page.waitForTimeout(700);
      };
      const track = await page.evaluate(() => window.__interact.zipTrackNdc());
      await drag([...track, { x: track.at(-1).x, y: track.at(-1).y - 0.05 }]);
      const opened = (await state()).zipOpen >= 1;
      const pull = await page.evaluate(() => window.__interact.pullScreen());
      await drag([pull, ...track.toReversed(), { x: track[0].x, y: track[0].y + 0.05 }]);
      const closed = (await state()).zipOpen === 0;
      const item = { jacket, opened, closed };
      if ((await state()).hasHood) {
        await page.getByRole('button', { name: 'Hood view', exact: true }).click();
        await page.waitForTimeout(1200);
        const h = await page.evaluate(() => window.__interact.hoodScreen());
        await drag(
          Array.from({ length: 31 }, (_, i) => ({
            x: h.x + (0.42 * i) / 30,
            y: h.y - (0.12 * i) / 30,
          })),
        );
        item.hoodOff = (await state()).hood === 'detached';
        const h2 = await page.evaluate(() => window.__interact.hoodScreen());
        const edge = await page.evaluate(() => window.__interact.hoodEdges());
        await drag(
          Array.from({ length: 31 }, (_, i) => ({
            x: h2.x + ((edge.collar.x - h2.x) * i) / 30,
            y: h2.y + ((edge.collar.y - h2.y) * i) / 30,
          })),
        );
        item.hoodOn = (await state()).hood === 'attached';
      }
      run.interactions.push(item);
    }
    await mark('reset');
    await page.getByRole('button', { name: /Done/ }).click();
    const deleted = page.waitForResponse(
      (r) => r.request().method() === 'DELETE' && /\/body\/[a-f0-9]{64}$/.test(r.url()) && r.ok(),
    );
    await page.getByRole('button', { name: 'Start over', exact: true }).click();
    await deleted;
    run.deleted = true;
    await screen('attract');
    run.complete = run.interactions.every(
      (i) => i.opened && i.closed && i.hoodOff !== false && i.hoodOn !== false,
    );
  } catch (error) {
    run.error = String(error);
    await capture('failure').catch((e) => {
      run.captureError = String(e);
    });
    // Recover through this page's own UI; never DELETE an ID from another client.
    try {
      for (const name of ['Close', '← Done']) {
        const button = page.getByRole('button', { name, exact: true });
        if (await button.isVisible()) await button.click();
      }
      const button = page.getByRole('button', { name: 'Start over', exact: true });
      if (await button.isVisible()) {
        const deleted = page.waitForResponse(
          (r) =>
            r.request().method() === 'DELETE' && /\/body\/[a-f0-9]{64}$/.test(r.url()) && r.ok(),
          { timeout: 15000 },
        );
        await button.click();
        await deleted;
        run.deleted = true;
      }
    } catch (cleanup) {
      run.cleanupError = String(cleanup);
    }
  }
  return run;
}

export async function warmKiosk({
  dist,
  executablePath,
  profile,
  log = console.log,
  timeoutMs = 14 * 60000,
  origin = 'http://127.0.0.1:5730',
}) {
  const report = {
    buildHash: buildHash(dist),
    at: new Date().toISOString(),
    runs: [],
    requests: [],
    external: [],
  };
  let context;
  let timer;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath,
      headless: false,
      viewport: { width: 1536, height: 864 },
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--force_high_performance_gpu',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      ],
    });
    timer = setTimeout(() => void context.close(), timeoutMs);
    await context.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (
        ['127.0.0.1', 'localhost'].includes(u.hostname) ||
        ['blob:', 'data:'].includes(u.protocol)
      )
        return route.continue();
      report.external.push(u.origin + u.pathname);
      return route.abort();
    });
    context.on('request', (r) => report.requests.push({ method: r.method(), url: r.url() }));
    for (let i = 0; i < 2; i++) {
      const page = await context.newPage();
      try {
        report.runs.push(await judgePath(page, undefined, origin));
      } finally {
        await page.close();
      }
    }
  } catch (error) {
    report.error = String(error);
  } finally {
    clearTimeout(timer);
    await context?.close();
    report.proven = warmProven(report);
    writeFileSync(join(ROOT, '.cache/kiosk-warm.json'), JSON.stringify(report, null, 2));
    log(`Warm-up ${report.proven ? 'PASS' : 'INCOMPLETE/FAIL'}; evidence .cache/kiosk-warm.json`);
  }
  return report;
}
