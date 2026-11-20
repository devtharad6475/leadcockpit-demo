import { test, expect } from '@playwright/test';
import { expectAppShell } from './helpers/login';
import { openTabByLabel } from './helpers/nav';

test('slow optional dashboard data cannot hide customers or a critical loading failure', async ({ page }) => {
  await page.goto('/signup');
  await page.getByLabel('Your name', { exact: true }).fill('Core loading owner');
  await page.getByLabel('Email', { exact: true }).fill('core-loading@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-core-loading-password!');
  await page.getByLabel(/Business name/).fill('Core loading business');
  await page.getByRole('button', { name: /Create|Sign up/i }).click();
  await expect(page.getByText('Request processed', { exact: true })).toBeVisible();
  await page.goto('/');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('core-loading@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-core-loading-password!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expectAppShell(page);
  const created = await page.request.post('/api/leads/manual', {
    headers: { origin: new URL(page.url()).origin },
    data: { companyName: 'Customer available before optional dashboard', email: 'core-buyer@example.invalid' },
  });
  expect(created.ok()).toBe(true);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/dashboard/intelligence', async route => { await held; await route.continue(); });
  try {
    await page.reload();
    await expectAppShell(page);
    await openTabByLabel(page, 'Leads');
    await expect(page.getByText('Customer available before optional dashboard', { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: 'docs/system-workflow/readiness-proof/core-data-before-dashboard.png' });
  } finally {
    const completed = page.waitForResponse(response => response.url().endsWith('/api/dashboard/intelligence'));
    release();
    await completed;
  }
  // Let the held request finish before installing the next phase's handler.
  // Removing a running route handler can otherwise handle its route twice.
  await page.unrouteAll({ behavior: 'wait' });
  let releaseFailure!: () => void;
  const heldFailure = new Promise<void>(resolve => { releaseFailure = resolve; });
  await page.route('**/api/dashboard/intelligence', async route => { await heldFailure; await route.continue(); });
  await page.route('**/api/state', route => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ success: false, error: { code: 'TEST_UNAVAILABLE', message: 'Core workspace temporarily unavailable.' } }),
  }));
  try {
    await page.reload();
    await expect(page.getByRole('heading', { name: "Your workspace didn't load", exact: true })).toBeVisible();
    await expect(page.getByText('Customer available before optional dashboard', { exact: true })).toHaveCount(0);
  } finally {
    const completed = page.waitForResponse(response => response.url().endsWith('/api/dashboard/intelligence'));
    releaseFailure();
    await completed;
    await page.unrouteAll({ behavior: 'wait' });
  }
});
