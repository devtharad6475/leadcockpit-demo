import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { E2E_DATA_DIR } from './helpers/data-dir';
import { expectAppShell } from './helpers/login';
import { openTabByLabel, TAB_GROUP } from './helpers/nav';

test.beforeAll(() => {
  execFileSync(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), 'e2e/helpers/week-four-fixture-seed.ts'], {
    env: { ...process.env, LEADGEN_DATA_DIR: E2E_DATA_DIR, PERSISTENCE_PROVIDER: 'json', DATABASE_URL: '' }, windowsHide: true,
  });
});
async function signIn(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill('week_four_company_a_owner@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('Disposable-week-four-password!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expectAppShell(page);
}
test('Workspace tabs retain drafts, reveal relevant fields and work by keyboard', async ({ page }) => {
  await signIn(page); await openTabByLabel(page, 'Workspace');
  const first = page.getByRole('tab', { name: 'Message controls', exact: true });
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await first.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Ticket handling', exact: true })).toBeFocused();
  const clock = page.getByLabel('When deadlines count');
  await clock.selectOption('business_hours');
  await page.getByLabel('Day starts at').fill('08:30');
  await page.getByLabel('Who a new ticket goes to').selectOption('auto_rule');
  await page.getByRole('button', { name: 'Add a rule', exact: true }).click();
  await expect(page.getByLabel('Goes to', { exact: true })).toBeVisible();
  await page.getByLabel('Who a new ticket goes to').selectOption('manual');
  await expect(page.getByLabel('Goes to', { exact: true })).toBeHidden();
  await clock.selectOption('always_24_7');
  await expect(page.getByLabel('Day starts at')).toBeHidden();
  await clock.selectOption('business_hours');
  await expect(page.getByLabel('Day starts at')).toHaveValue('08:30');
  await page.getByRole('tab', { name: 'Notes and activity', exact: true }).click();
  await page.getByRole('textbox', { name: 'New workspace note', exact: true }).fill('Sample UI review note');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Sample UI review note', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Ticket handling', exact: true }).click();
  await expect(page.getByLabel('Day starts at')).toHaveValue('08:30');
  await expect(page.getByRole('button', { name: 'Save ticket handling', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Save ticket handling', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save ticket handling', exact: true })).toBeDisabled();
  await page.reload(); await openTabByLabel(page, 'Workspace');
  await page.getByRole('tab', { name: 'Ticket handling', exact: true }).click();
  await expect(page.getByLabel('Day starts at')).toHaveValue('08:30');
  await page.getByRole('tab', { name: 'Notifications', exact: true }).click();
  const alerts = page.getByRole('checkbox', { name: 'Send me urgent alerts', exact: true });
  await alerts.uncheck();
  await expect(page.getByLabel('Most alerts in one day')).toBeHidden();
  await alerts.check();
  await expect(page.getByLabel('Most alerts in one day')).toBeVisible();
  await page.getByRole('tab', { name: 'Sign-in', exact: true }).press('Home');
  await expect(first).toBeFocused();
  await first.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'readiness-proof/workspace-ui-cleanup.png', fullPage: true });
});

test('changing AI services clears incompatible input and only custom models ask for exact names', async ({ page }) => {
  await signIn(page); await openTabByLabel(page, 'AI Settings');
  await page.getByRole('tab', { name: 'Which AI does each job', exact: true }).click();
  await page.getByRole('button', { name: 'Change Everyday work', exact: true }).click();
  const drawer = page.getByRole('dialog');
  await drawer.getByRole('combobox', { name: 'AI service', exact: true }).selectOption('openai');
  await drawer.getByLabel('API key', { exact: true }).fill('synthetic-unsaved-key-never-used');
  await drawer.getByRole('combobox', { name: 'AI service', exact: true }).selectOption('anthropic');
  await expect(drawer.getByLabel('API key', { exact: true })).toHaveValue('');
  await expect(drawer.getByLabel('Model name, exactly as the service spells it')).toHaveCount(0);
  await drawer.getByRole('combobox', { name: 'AI service', exact: true }).selectOption('ollama');
  await drawer.getByRole('combobox', { name: 'Model', exact: true }).selectOption('ollama-custom');
  await drawer.getByLabel('Model name, exactly as the service spells it').fill('synthetic-local-model');
  await drawer.getByRole('combobox', { name: 'AI service', exact: true }).selectOption('openai');
  await expect(drawer.getByLabel('Model name, exactly as the service spells it')).toHaveCount(0);
  await drawer.locator('summary').filter({ hasText: 'Backup AI' }).click();
  await drawer.getByRole('combobox', { name: 'Backup AI service', exact: true }).selectOption('openai');
  await drawer.getByLabel('Backup API key (optional)', { exact: true }).fill('synthetic-backup-key-never-used');
  await drawer.getByRole('combobox', { name: 'Backup AI service', exact: true }).selectOption('anthropic');
  await expect(drawer.getByLabel('Backup API key (optional)', { exact: true })).toHaveValue('');
  await expect(drawer.getByRole('combobox', { name: 'Backup model', exact: true })).not.toHaveValue('');
  await page.screenshot({ path: 'readiness-proof/ai-service-dependent-fields.png', fullPage: true });
  // Deliberately do not save, fetch models or run a paid provider check.
});

test('WhatsApp sections retain customer and rule drafts without making a provider call', async ({ page }) => {
  await signIn(page); await openTabByLabel(page, 'WhatsApp Agent');
  const message = page.getByLabel('Customer message to test');
  await message.fill('Synthetic question retained across tabs');
  await page.getByRole('tab', { name: 'Reply rules', exact: true }).click();
  await page.getByRole('combobox', { name: 'Automation mode', exact: true }).selectOption('draft_only');
  await page.getByRole('tab', { name: 'Buyer information', exact: true }).click();
  await page.getByRole('tab', { name: 'Try a customer message', exact: true }).click();
  await expect(message).toHaveValue('Synthetic question retained across tabs');
  await page.getByRole('tab', { name: 'Reply rules', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Automation mode', exact: true })).toHaveValue('draft_only');
  await page.screenshot({ path: 'readiness-proof/whatsapp-rule-tabs.png', fullPage: true });
});

test('every owner navigation page opens without runtime failures or horizontal overflow', async ({ page }) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 500) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  await signIn(page);
  for (const label of Object.keys(TAB_GROUP)) {
    await openTabByLabel(page, label);
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/^(Loading settings…|Checking your connections…|Loading\.\.\.|Loading…)$/)).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), { message: `${label} must fit the viewport` }).toBe(true);
    await page.screenshot({ path: `readiness-proof/ui-review-${label.replace(/[^a-z0-9]/gi, '-')}.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
});
