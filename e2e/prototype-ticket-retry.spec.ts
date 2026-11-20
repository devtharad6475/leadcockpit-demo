import { test, expect } from '@playwright/test';
import { expectAppShell } from './helpers/login';
import { openTabByLabel } from './helpers/nav';

test('new ticket explains invalid or failed saves and retains inputs in empty and populated lists', async ({ page }) => {
  test.setTimeout(90000);
  const email = 'ticket-retry-owner@example.invalid';
  const password = 'Synthetic-ticket-retry-password!';
  await page.goto('/signup');
  await page.getByLabel('Your name', { exact: true }).fill('Ticket retry owner');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel(/Business name/).fill('Ticket retry supplies');
  const signedUp = page.waitForResponse(response => response.url().endsWith('/api/auth/signup') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /Create|Sign up/i }).click();
  expect((await signedUp).ok()).toBe(true);
  await expect(page.getByText('Request processed', { exact: true })).toBeVisible();
  await page.goto('/');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expectAppShell(page);
  await openTabByLabel(page, 'Tickets');
  for (const state of ['empty', 'populated']) {
    await page.getByRole('button', { name: 'New ticket', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New ticket', exact: true });
    await dialog.getByRole('button', { name: 'Create ticket', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Subject is required.');
    const subject = `Retry proof ${state}`;
    await dialog.getByLabel('Subject', { exact: false }).fill(subject);
    await dialog.getByLabel('Description', { exact: true }).fill('Keep these details while I retry.');
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/tickets', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      await held;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'TEST_UNAVAILABLE', message: 'Ticket save temporarily unavailable.' } }) });
    });
    await dialog.getByRole('button', { name: 'Create ticket', exact: true }).click();
    try {
      await expect(dialog.getByLabel('Subject', { exact: false })).toBeDisabled();
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
      await dialog.press('Escape');
      await expect(dialog).toBeVisible();
    } finally { release(); }
    await expect(dialog.getByRole('alert')).toHaveText('Ticket save temporarily unavailable.');
    await expect(dialog.getByLabel('Subject', { exact: false })).toBeEnabled();
    await expect(dialog.getByLabel('Subject', { exact: false })).toHaveValue(subject);
    await expect(dialog.getByLabel('Description', { exact: true })).toHaveValue('Keep these details while I retry.');
    await page.screenshot({ path: `docs/system-workflow/readiness-proof/cleanup-ticket-retry-${state}.png` });
    await page.unroute('**/api/tickets');
    const saved = page.waitForResponse(response => response.url().endsWith('/api/tickets') && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Create ticket', exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect(dialog).toHaveCount(0);
    await page.reload();
    // Opening the tab starts a fresh read. Verify the actual saved response
    // before checking its rendering, rather than mistaking Loading for data loss.
    const refreshed = page.waitForResponse(response => response.url().endsWith('/api/tickets') && response.request().method() === 'GET');
    await openTabByLabel(page, 'Tickets');
    const refreshedResponse = await refreshed;
    expect(refreshedResponse.ok()).toBe(true);
    expect(await refreshedResponse.json()).toEqual(expect.arrayContaining([expect.objectContaining({ subject })]));
    await expect(page.getByText(subject, { exact: true }).first()).toBeVisible();
  }
});
