import { test, expect } from '@playwright/test';

test('pending account status cannot offer demo access on a production site', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/auth/status', async route => { await held; await route.continue(); });
  await page.goto('/');
  try {
    await expect(page.getByText('Opening your workspace…', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue in Demo Mode', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Production login later', exact: true })).toHaveCount(0);
    await page.screenshot({ path: 'docs/system-workflow/readiness-proof/cleanup-login-loading.png' });
  } finally { release(); }
  await expect(page.getByText('Opening your workspace…', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('failed account check stays closed and retry reaches real login', async ({ page }) => {
  await page.route('**/api/auth/status', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'TEST_UNAVAILABLE', message: 'Account service unavailable' } }) }));
  await page.goto('/');
  await expect(page.getByRole('alert').filter({ hasText: 'We could not check your sign-in.' })).toHaveText('We could not check your sign-in. Check your connection and try again.');
  await expect(page.getByRole('button', { name: 'Continue in Demo Mode', exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/cleanup-login-retry.png' });
  await page.unroute('**/api/auth/status');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});
