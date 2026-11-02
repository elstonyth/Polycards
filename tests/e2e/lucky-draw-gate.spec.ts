// The Lucky Draw New event form: a start plus hours gives the end, one tap fills
// the hours, moving the start keeps them, and unusable hours can't be saved. The
// admin vitest runner has no DOM, so this is what proves the form's wiring.
import { test, expect } from '@playwright/test';
import { ensureAdmin } from './helpers/admin';

test.use({ locale: 'en-GB', timezoneId: 'Asia/Kuala_Lumpur' });

test('a gate ends the typed hours after its start', async ({ page }) => {
  await ensureAdmin(page, '/lucky-draw');
  await page.getByRole('button', { name: 'New event', exact: true }).click();

  const start = page.locator('#ld-event-starts');
  const hours = page.locator('#ld-event-hours');
  const ends = page.getByText(/^Ends /);
  const create = page.getByRole('button', { name: 'Create event' });
  const chip = (name: string) =>
    page.getByRole('button', { name, exact: true });

  await page.locator('#ld-event-reason').fill('e2e: gate hours');
  await start.fill('2099-01-10T00:00');
  await expect(page.getByText('No end yet')).toBeVisible();
  await expect(create).toBeDisabled();

  await chip('24h').click();
  await expect(hours).toHaveValue('24');
  await expect(chip('24h')).toHaveAttribute('aria-pressed', 'true');
  await expect(ends).toHaveText(/11 Jan 2099, 00:00/);

  await hours.fill('36');
  await expect(chip('24h')).toHaveAttribute('aria-pressed', 'false');
  await expect(ends).toHaveText(/11 Jan 2099, 12:00/);

  await start.fill('2099-01-11T00:00');
  await expect(ends).toHaveText(/12 Jan 2099, 12:00/);

  for (const { typed, message } of [
    { typed: '0', message: 'above 0' },
    { typed: 'e', message: 'above 0' },
    { typed: '7200', message: 'at most' },
  ]) {
    await hours.fill(typed);
    await expect(page.getByText(message)).toBeVisible();
    await expect(ends).toHaveCount(0);
    await expect(create).toBeDisabled();
  }

  await chip('7 days').click();
  await expect(hours).toHaveValue('168');
  const saved = page.waitForRequest(
    (r) =>
      r.method() === 'POST' && r.url().endsWith('/admin/lucky-draw/events'),
  );
  await create.click();
  const body = (await saved).postDataJSON();
  expect(body.starts_at).toBe('2099-01-10T16:00:00.000Z');
  expect(body.ends_at).toBe('2099-01-17T16:00:00.000Z');
});
