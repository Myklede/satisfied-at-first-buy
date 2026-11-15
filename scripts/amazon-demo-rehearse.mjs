import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Prompt 11's judge script, including the total 60-second budget. No fit thresholds here.
export async function runJudgeScript(context, page, root) {
  const result = {
    started: new Date().toISOString(),
    test_data:
      'Synthetic demo body: 70 in / 160 lb, male; hypothetical fit feedback, real engine results.',
    steps: [],
    external_completed: 0,
  };
  const started = performance.now();
  const external = (request) => {
    const url = new URL(request.url());
    if (
      ['http:', 'https:'].includes(url.protocol) &&
      !['127.0.0.1', 'localhost'].includes(url.hostname)
    )
      result.external_completed++;
  };
  context.on('requestfinished', external);
  let profile;
  async function step(name, budget_s, action) {
    const begin = performance.now();
    try {
      await action();
      const elapsed_s = (performance.now() - begin) / 1000;
      result.steps.push({ name, budget_s, elapsed_s, passed: elapsed_s <= budget_s });
      if (elapsed_s > budget_s) throw Error(`${name} exceeded ${budget_s}s`);
    } catch (error) {
      result.error = String(error);
      if (result.steps.at(-1)?.name !== name)
        result.steps.push({
          name,
          budget_s,
          elapsed_s: (performance.now() - begin) / 1000,
          passed: false,
        });
      throw error;
    }
  }
  try {
    await step('01 Private body setup', 8, async () => {
      const opened = context.waitForEvent('page');
      await page.getByTestId('open-profile').click();
      profile = await opened;
      await profile.waitForLoadState();
      await profile.locator('#height').fill('70');
      await profile.locator('#weight').fill('160');
      await profile.locator('#sex').selectOption('male');
      await profile.locator('#remember').check();
      await profile.getByTestId('save-profile').click();
      await profile
        .getByTestId('profile-status')
        .filter({ hasText: 'Saved on this computer' })
        .waitFor();
      if ((await profile.locator('#weight').inputValue()) !== '160')
        throw Error('Original weight entry changed');
    });
    await step('02 First real saved page recommendation', 12, async () => {
      await page.bringToFront();
      await page.reload();
      await page.getByTestId('recommended-size').waitFor();
      result.first_size = await page.getByTestId('recommended-size').textContent();
    });
    await step('03 Explain the measured zone', 5, async () => {
      await page.getByTestId('map-shoulder').locator('text').first().click();
      await page
        .getByRole('region', { name: 'Compare size measurements' })
        .scrollIntoViewIfNeeded();
    });
    await step('04 Select and add to compare', 5, async () => {
      await page.getByTestId('select-size').click();
      await page.getByTestId('add-compare').click();
    });
    await step('05 Compare the second real saved page', 15, async () => {
      await page.goto('http://127.0.0.1:5799/02-body.html');
      await page.getByTestId('recommended-size').waitFor();
      result.second_size = await page.getByTestId('recommended-size').textContent();
      await page.getByTestId('add-compare').click();
      await page.getByTestId('run-compare').click();
      await page.getByTestId('compare-table').waitFor();
      await page.getByTestId('compare-table').scrollIntoViewIfNeeded();
    });
    await step('06 Hypothetical purchase and local feedback', 8, async () => {
      await page.getByTestId('bought').click();
      await page.getByTestId('fb-chest-loose').click();
      await page.getByTestId('fb-send').click();
      await page.getByTestId('fb-send').waitFor({ state: 'detached' });
    });
    await step('07 Measured catalogue to fitted 3D', 15, async () => {
      await page.goto('http://127.0.0.1:5799/catalogue');
      await page.getByTestId('see-3d').waitFor();
      const wanted = (await page.getByTestId('recommended-size').textContent()).trim();
      const opened = context.waitForEvent('page');
      await page.getByTestId('see-3d').click();
      const studio = await opened;
      await studio.locator('.size-tabs button[aria-pressed="true"]').waitFor({ timeout: 180000 });
      if (
        studio.url().includes('#handoff=') ||
        !(await studio.locator('.size-tabs button[aria-pressed="true"]').textContent()).startsWith(
          wanted,
        )
      )
        throw Error('Studio handoff mismatch');
      await studio.close();
    });
    await step('08 Delete everything', 5, async () => {
      await profile.bringToFront();
      await profile.getByTestId('delete-profile').click();
      await profile.getByTestId('profile-status').filter({ hasText: 'Deleted' }).waitFor();
      if ((await profile.locator('#height').inputValue()) !== '')
        throw Error('Body input survived deletion');
    });
    result.elapsed_s = (performance.now() - started) / 1000;
    if (result.elapsed_s > 60) throw Error(`Judge script exceeded 60 seconds: ${result.elapsed_s}`);
    if (result.external_completed) throw Error('A non-loopback request completed');
    result.passed = true;
    return result;
  } catch (error) {
    result.passed = false;
    result.error = String(error);
    throw error;
  } finally {
    context.off('requestfinished', external);
    result.finished = new Date().toISOString();
    writeFileSync(
      join(root, 'docs/validation/fit-agent-r2-rehearsal.json'),
      JSON.stringify(result, null, 2) + '\n',
    );
    console.log(JSON.stringify(result));
  }
}
