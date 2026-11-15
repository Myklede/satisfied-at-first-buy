import { existsSync } from 'node:fs';
import { join } from 'node:path';

export async function runProductFlow(context, id, root, work, shots, step, results) {
  const privacy =
    '#nav-global-location-popover-link, #nav-link-accountList { opacity:0 !important; }';
  const capture = async (page, name) =>
    page.screenshot({ style: privacy, path: join(shots, `fit-agent-r2-${name}.png`) });
  const shop = await context.newPage();
  const observe = (page) => {
    page.on('pageerror', (error) => {
      const target =
        page.url().includes('/saved/') && !error.stack?.includes('chrome-extension:')
          ? results.retailer_console
          : results.console;
      target.push(error.stack || error.message);
    });
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const target =
        page.url().includes('/saved/') && !message.location().url?.startsWith('chrome-extension:')
          ? results.retailer_console
          : results.console;
      target.push(message.text());
    });
  };
  observe(shop);
  context.on('page', observe);
  await shop.goto('http://127.0.0.1:5799/page/garment');
  await shop.getByTestId('needs-profile').waitFor();
  step('fresh profile required', true);
  const profile = await context.newPage();
  await profile.goto(`chrome-extension://${id}/profile.html`);
  await profile.locator('#height').fill('70');
  await profile.locator('#weight').fill('160');
  await profile.locator('#sex').selectOption('male');
  await profile.locator('#chest').fill('38');
  await profile.locator('#units-metric').click();
  step('metric height conversion', (await profile.locator('#height').inputValue()) === '177.8');
  await profile.locator('#units-imperial').click();
  step(
    'verbatim unit round trip',
    (await profile.locator('#weight').inputValue()) === '160' &&
      (await profile.locator('#height').inputValue()) === '70',
  );
  await profile.locator('#remember').check();
  await profile.getByTestId('save-profile').click();
  await profile
    .getByTestId('profile-status')
    .filter({ hasText: 'Saved on this computer' })
    .waitFor();
  step(
    'canonical and original entry stored privately',
    existsSync(join(work, 'store/profile.json')) &&
      (await profile.getByTestId('saved-profile').textContent()).includes('177.8'),
  );
  step(
    'stored details collapsed and no raw JSON',
    !(await profile.getByTestId('saved-profile').isVisible()) &&
      !(await profile.getByTestId('saved-profile').textContent()).includes('"fit_request"'),
  );
  for (const scheme of ['light', 'dark']) {
    await profile.emulateMedia({ colorScheme: scheme });
    await profile.evaluate(() => scrollTo(0, 0));
    await capture(profile, `profile-${scheme}`);
  }
  await shop.reload();
  await shop.getByTestId('recommended-size').waitFor({ timeout: 45000 });
  const first = (await shop.getByTestId('recommended-size').textContent()).trim();
  await shop.getByTestId('map-shoulder').focus();
  await shop.keyboard.press('Enter');
  step(
    'SVG zone keyboard exposes units',
    (await shop.getByTestId('body-map').locator('..').textContent()).includes('cm'),
  );
  step('attached leader lines exist', (await shop.locator('.zone-leader').count()) === 7);
  step(
    'quiet unknown zones without dash rows',
    (await shop.getByTestId('zones').locator('tr').count()) === 0 &&
      (await shop.getByTestId('missing-zones').count()) <= 1,
  );
  await shop.setViewportSize({ width: 360, height: 900 });
  const strip = shop.getByRole('region', { name: 'Compare size measurements' });
  await strip.focus();
  await shop.keyboard.press('ArrowRight');
  await shop.waitForFunction(
    () =>
      document.getElementById('satisfy-fit-agent')?.shadowRoot?.querySelector('.size-strip')
        ?.scrollLeft > 0,
  );
  step('fit-bar comparison keyboard scrolls', true);
  await shop.setViewportSize({ width: 1280, height: 900 });
  const markers = await shop
    .locator('.fit-marker')
    .evaluateAll((nodes) => nodes.map((node) => parseFloat(node.style.left)));
  step(
    'computed bar markers are bounded',
    markers.length > 0 && markers.every((v) => v >= 5 && v <= 95),
  );
  await shop.getByTestId('select-size').click();
  const selected = await shop.locator('#selected-size').textContent();
  step(
    'native fixture selector really changed',
    { Small: 'S', Medium: 'M', Large: 'L', 'X-Large': 'XL' }[selected.trim()] === first,
  );
  await shop.getByTestId('add-compare').click();
  const second = await context.newPage();
  await second.goto('http://127.0.0.1:5799/page/body');
  await second.getByTestId('recommended-size').waitFor({ timeout: 45000 });
  step(
    'body chart estimate badge',
    (await second.getByTestId('recommendation').textContent()).includes('estimated garment'),
  );
  await second.getByTestId('add-compare').click();
  await second.getByTestId('run-compare').click();
  await second.getByTestId('compare-table').waitFor();
  await second.getByTestId('compare-table').scrollIntoViewIfNeeded();
  await capture(second, 'compare');
  step(
    'compare uses real zone bars',
    (await second.getByTestId('compare-table').locator('.fit-bar').count()) > 0,
  );
  await shop.getByTestId('bought').click();
  await shop.getByTestId('fb-chest-tight').click();
  await shop.getByTestId('fb-send').click();
  await shop.getByTestId('fb-send').waitFor({ state: 'detached' });
  const feedback = shop.getByTestId('feedback');
  step(
    'learning below recommendation and collapsed',
    await feedback.evaluate(
      (el) =>
        !el.open &&
        Boolean(
          el.ownerDocument
            .getElementById('satisfy-fit-agent')
            .shadowRoot.querySelector('[data-testid="recommendation"]')
            .compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
    ),
  );
  await feedback.locator(':scope > summary').click();
  await shop.getByTestId('learned').first().waitFor();
  await feedback.scrollIntoViewIfNeeded();
  await capture(shop, 'learning');
  step(
    'headline never prints old conflicting neighbour copy',
    !(await shop.getByTestId('recommendation').textContent()).includes('would be off'),
  );

  for (const name of ['01-garment.html', '02-body.html']) {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:5799/saved/${name}`);
    await page.getByTestId('recommended-size').waitFor({ timeout: 45000 });
    const css = await page.evaluate(() =>
      Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
        .filter((el) => el.href.includes('_files/'))
        .map((el) => Boolean(el.sheet)),
    );
    step(
      `saved styles ${name}`,
      css.length > 0 && css.every(Boolean),
      `${css.filter(Boolean).length}/${css.length}`,
    );
    const text = await page.getByTestId('recommendation').textContent();
    results.steps.push({ name: `computed recommendation ${name}`, ok: true, detail: text });
    step(
      `no dash rows ${name}`,
      (await page.getByTestId('zones').locator('tr').count()) === 0 &&
        !(await page.getByTestId('size-strip').textContent()).includes('—'),
    );
    await page.getByTestId('map-collar').focus();
    await page.keyboard.press('Enter');
    step(
      `chart-only collar unknown ${name}`,
      (await page.getByTestId('body-map').locator('..').textContent()).includes('not in chart'),
    );
    for (const scheme of ['light', 'dark'])
      for (const zoom of [1, 1.5]) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.bringToFront();
        const worker = context.serviceWorkers().find((w) => w.url().endsWith('/background.js'));
        const actual = await worker.evaluate(async (z) => {
          const [tab] = await globalThis.chrome.tabs.query({ active: true, currentWindow: true });
          await globalThis.chrome.tabs.setZoom(tab.id, z);
          return globalThis.chrome.tabs.getZoom(tab.id);
        }, zoom);
        await page.getByTestId('fit-agent-panel').evaluate((el) => (el.scrollTop = 0));
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        const bounds = await page.getByTestId('fit-agent-panel').evaluate((el) => {
          const r = el.getBoundingClientRect();
          return (
            r.top >= 0 && r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth + 1
          );
        });
        step(`native zoom and bounds ${name} ${scheme} ${zoom}`, actual === zoom && bounds);
        await capture(page, `${name.replace('.html', '')}-${scheme}-${zoom}`);
      }
    const worker = context.serviceWorkers().find((w) => w.url().endsWith('/background.js'));
    await worker.evaluate(async () => {
      const [tab] = await globalThis.chrome.tabs.query({ active: true, currentWindow: true });
      await globalThis.chrome.tabs.setZoom(tab.id, 1);
    });
    await page.getByTestId('body-map').scrollIntoViewIfNeeded();
    await capture(page, `${name.replace('.html', '')}-diagram`);
    await page.close();
  }

  await profile.reload();
  await profile.getByText('Your learned preferences', { exact: true }).click();
  await profile.getByTestId('undo').click();
  await profile.getByTestId('undo').waitFor({ state: 'detached' });
  step('learning undone', true);

  // Catalogue jacket → studio, once on the profile's default choices and once on non-default
  // ones: the panel's pick must be the studio's "Best available" for the same layer/preference.
  const presets = await fetch('http://127.0.0.1:8013/garment/options').then((r) => r.json());
  const bodyRequests = [],
    garmentRequests = [];
  context.on('request', (request) => {
    if (request.url().endsWith('/api/body/fit')) bodyRequests.push(request.postDataJSON());
    if (request.url().endsWith('/api/fit/garment')) garmentRequests.push(request.postDataJSON());
  });
  results.handoff_passes = [];
  const catalogueToStudio = async (choices, suffix) => {
    const shot = (base) => (suffix ? `${base}-${suffix}` : base);
    const label = `${choices.layer}/${choices.preference}`;
    const record = { choices };
    results.handoff_passes.push(record);
    const catalogue = await context.newPage();
    await catalogue.goto('http://127.0.0.1:5799/catalogue');
    await catalogue.getByTestId('see-3d').waitFor({ timeout: 45000 });
    const wanted = (await catalogue.getByTestId('recommended-size').textContent()).trim();
    const basis = (await catalogue.getByTestId('basis').textContent()).trim();
    record.panel = { recommended_size: wanted, basis };
    step(
      `catalogue jacket ranked by the full engine (${label})`,
      basis === 'Tape-measured catalogue · full engine',
      basis,
    );
    await catalogue.getByTestId('trace').locator(':scope > summary').click();
    const trace = await catalogue.getByTestId('trace').textContent();
    step(
      `printed chart shown only as a cross-check (${label})`,
      trace.includes('Cross-check only, not the basis'),
    );
    step(
      `panel computed with ${label}`,
      trace.includes(`layer ${choices.layer} (`) &&
        trace.includes(`preference ${choices.preference}`),
    );
    await catalogue.getByTestId('trace').scrollIntoViewIfNeeded();
    await capture(catalogue, shot('catalogue-decided'));
    await catalogue.getByTestId('fit-agent-panel').evaluate((el) => (el.scrollTop = 0));
    await capture(catalogue, shot('catalogue-panel'));
    bodyRequests.length = 0;
    garmentRequests.length = 0;
    const opened = context.waitForEvent('page');
    await catalogue.getByTestId('see-3d').click();
    const studio = await opened;
    await studio.locator('.size-tabs button[aria-pressed="true"]').waitFor({ timeout: 180000 });
    step(`handoff fragment immediately cleared (${label})`, !studio.url().includes('#handoff='));
    step(
      `same body including optional chest (${label})`,
      bodyRequests.length > 0 &&
        bodyRequests.every(
          (r) =>
            r.sex === 'male' &&
            r.height_cm === 177.8 &&
            r.weight_kg === 72.6 &&
            r.known_measurements.chest_cm === 96.5,
        ),
    );
    step(
      `same recommended size selected in fitted studio (${label})`,
      (await studio.locator('.size-tabs button[aria-pressed="true"]').textContent()).startsWith(
        wanted,
      ),
    );
    const product = new URL(studio.url()).searchParams.get('product');
    step(
      `real measured catalogue selected (${label})`,
      (await studio.locator('.fit-picker select').first().inputValue()) === product,
    );
    const best = (
      await studio
        .locator('.fit-results h2')
        .filter({ hasText: 'Best available:' })
        .textContent({ timeout: 60000 })
    ).trim();
    const under = await studio.getByLabel('Worn underneath').inputValue();
    const preference = await studio.getByLabel('How you like it').inputValue();
    record.studio = { best_available: best, under, preference, garment_fit: [...garmentRequests] };
    step(
      `panel size equals studio Best available (${label})`,
      best === `Best available: ${wanted}`,
      best,
    );
    step(
      `studio selectors show ${label}`,
      under === choices.layer && preference === choices.preference,
      `${under}/${preference}`,
    );
    step(
      `every studio fit request used ${label}`,
      garmentRequests.length > 0 &&
        garmentRequests.every(
          (r) =>
            r.layer_cm === presets.layer_presets_cm[choices.layer] &&
            r.preference === choices.preference,
        ),
      JSON.stringify(garmentRequests.map((r) => [r.layer_cm, r.preference])),
    );
    await studio.locator('.fit-canvas canvas').first().waitFor();
    // Dressed state: FitStudio replaces "Draping fabric…" with "Drape preview · …" once the
    // cloth has settled on the body (Viewer.onSettled); never capture the undressed body.
    const dressed = Date.now();
    await studio
      .locator('.fit-overlay')
      .filter({ hasText: 'Drape preview' })
      .waitFor({ timeout: 180000 });
    record.studio.dressed_after_s = (Date.now() - dressed) / 1000;
    record.studio.overlay = (await studio.locator('.fit-overlay').textContent()).trim();
    step(`studio dressed before capture (${label})`, true, record.studio.overlay);
    await studio.waitForTimeout(1500);
    await capture(studio, shot('studio-handoff'));
    await studio.close();
    await catalogue.close();
  };
  await catalogueToStudio({ layer: 't-shirt', preference: 'regular' }, '');

  await profile.bringToFront();
  await profile.locator('#preference').selectOption('relaxed');
  await profile.locator('#layer').selectOption('hoodie');
  await profile.locator('#remember').check();
  await profile.getByTestId('profile-status').evaluate((el) => (el.textContent = ''));
  await profile.getByTestId('save-profile').click();
  await profile
    .getByTestId('profile-status')
    .filter({ hasText: 'Saved on this computer' })
    .waitFor();
  await profile.reload();
  step(
    'profile page shows the stored choices',
    await profile
      .waitForFunction(
        () =>
          document.getElementById('layer').value === 'hoodie' &&
          document.getElementById('preference').value === 'relaxed',
        null,
        { timeout: 10000 },
      )
      .then(
        () => true,
        () => false,
      ),
  );
  await catalogueToStudio({ layer: 'hoodie', preference: 'relaxed' }, 'hoodie-relaxed');

  await profile.bringToFront();
  await profile.getByTestId('delete-profile').click();
  await profile.getByTestId('profile-status').filter({ hasText: 'Deleted' }).waitFor();
  step(
    'body and learning files deleted',
    !existsSync(join(work, 'store/profile.json')) && !existsSync(join(work, 'store/learning.json')),
  );
  const worker = context.serviceWorkers().find((w) => w.url().endsWith('/background.js'));
  const cleared = await worker.evaluate(async () => {
    const local = await globalThis.chrome.storage.local.get(['bodyEntry', 'choices', 'compare']);
    const session = await globalThis.chrome.storage.session.get(['bodyEntry', 'sessionBody']);
    return Object.keys(local).length === 0 && Object.keys(session).length === 0;
  });
  step(
    'original entry canonical body and learning cleared',
    cleared &&
      (await profile.locator('#height').inputValue()) === '' &&
      (await profile.locator('#weight').inputValue()) === '',
  );
  await profile.evaluate(() => scrollTo(0, 0));
  await capture(profile, 'deleted');
  await shop.reload();
  await shop.getByTestId('needs-profile').waitFor();
  step('profile required again after delete', true);
  step(
    'no application console errors',
    results.console.length === 0,
    JSON.stringify(results.console),
  );
}
