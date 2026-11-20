import { test, expect, type BrowserContext } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { createSessionToken } from '@/lib/session';
import { hashPassword } from '@/lib/password';
import { expectAppShell } from './helpers/login';
import type { AppData } from '@/lib/types';
import { E2E_DATA_FILE } from './helpers/data-dir';
import { E2E_BASE_URL } from './helpers/e2e-target';

let baseline: AppData;
async function waitForFixtureQuiescent() {
  let previous = -1, stable = 0;
  for (let attempt = 0; attempt < 50; attempt++) {
    const modified = fs.statSync(E2E_DATA_FILE).mtimeMs;
    stable = modified === previous && !fs.existsSync(path.join(path.dirname(E2E_DATA_FILE), 'app-data.lock')) ? stable + 1 : 0;
    if (stable >= 5) return;
    previous = modified;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Disposable account fixture is still being written');
}
test.beforeAll(async () => {
  baseline = JSON.parse(fs.readFileSync(`${E2E_DATA_FILE}.employee-snapshot.json`, 'utf8'));
  const user = baseline.users.find(row => row.role === 'owner')!, now = new Date().toISOString();
  (baseline.workspaceMembers ||= []).push({ id: 'account-proof-owner-member', workspaceId: user.workspaceId, userId: user.id, email: user.email, role: 'owner', status: 'active', createdAt: now, updatedAt: now });
  (baseline.userCredentials ||= []).push({ id: 'account-proof-owner-credential', userId: user.id, workspaceId: user.workspaceId, email: user.email, passwordHash: await hashPassword('Synthetic-old-account-password!'), sessionVersion: 1, createdAt: now, updatedAt: now });
});
test.beforeEach(async ({ page }) => {
  void page;
  await waitForFixtureQuiescent();
  fs.writeFileSync(E2E_DATA_FILE, JSON.stringify(baseline));
});
test.afterEach(async ({ page }) => { await page.close(); await waitForFixtureQuiescent(); });
async function signIn(context: BrowserContext) {
  process.env.AUTH_SESSION_SECRET = 'disposable-week-four-browser-auth-secret-2026';
  const user = baseline.users.find(row => row.role === 'owner')!;
  await context.addCookies([{ name: 'lc_session', value: createSessionToken({ userId: user.id, workspaceId: user.workspaceId, role: 'owner', sessionVersion: 1 }), url: E2E_BASE_URL }]);
}

test('forgot password gives the same honest unavailable-email notice for every address', async ({ page }) => {
  await page.goto('/forgot-password');
  await page.getByLabel('Email', { exact: true }).fill('unknown@example.invalid');
  await page.getByRole('button', { name: 'Send me a link', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Request received' })).toBeVisible();
  await expect(page.getByText(/Account email.*not (configured|connected)/i)).toBeVisible();
  await expect(page.getByText(/we.ve sent/i)).toHaveCount(0);
  const known = await page.request.post('/api/auth/forgot-password', { data: { email: baseline.users[0].email }, headers: { origin: E2E_BASE_URL } });
  const unknown = await page.request.post('/api/auth/forgot-password', { data: { email: 'second_unknown@example.invalid' }, headers: { origin: E2E_BASE_URL } });
  expect(await known.json()).toEqual(await unknown.json());
  expect(JSON.parse(fs.readFileSync(E2E_DATA_FILE, 'utf8')).passwordResetTokens || []).toEqual(baseline.passwordResetTokens || []);
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/account-reset-unavailable.png' });
});

test('forgot password request failure retains the address and allows retry', async ({ page }) => {
  let fail = true;
  await page.route('**/api/auth/forgot-password', route => fail ? route.fulfill({ status: 503, json: { ok: false, error: { message: 'Temporary account service failure' } } }) : route.continue());
  await page.goto('/forgot-password');
  await page.getByLabel('Email', { exact: true }).fill('retry@example.invalid');
  await page.getByRole('button', { name: 'Send me a link', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Temporary account service failure' })).toBeVisible();
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('retry@example.invalid');
  fail = false;
  await page.getByRole('button', { name: 'Send me a link', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Request received' })).toBeVisible();
});

test('signed-out verification recovery has a real sign-in path and truthful access wording', async ({ page }) => {
  await page.goto('/verify-email');
  await expect(page.getByText(/then return to this page/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resend verification' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to sign in' }).click();
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
});

test('signed-in verification recovery reports unavailable transport without retiring a link', async ({ page, context }) => {
  await signIn(context);
  await page.goto('/verify-email');
  await page.getByRole('button', { name: 'Resend verification' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Account email delivery is not configured' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resend verification' })).toBeEnabled();
  expect(JSON.parse(fs.readFileSync(E2E_DATA_FILE, 'utf8')).emailVerificationTokens || []).toEqual(baseline.emailVerificationTokens || []);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Resend verification' })).toBeVisible();
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/account-verification-recovery.png' });
});

test('verification distinguishes synthetic acceptance from uncertain delivery and blocks immediate repeat', async ({ page, context }) => {
  await signIn(context);
  let accepted = true, calls = 0;
  await page.route('**/api/auth/resend-verification', route => {
    calls++;
    return accepted ? route.fulfill({ json: { ok: true, accepted: true } }) : route.fulfill({ status: 502, json: { ok: false, error: { code: 'EMAIL_UNCONFIRMED', message: 'Acceptance could not be confirmed. Check your inbox before trying again.' } } });
  });
  await page.goto('/verify-email');
  await page.getByRole('button', { name: 'Resend verification' }).click();
  await expect(page.getByRole('status')).toContainText('accepted');
  await expect(page.getByRole('status')).toContainText('delivery is not yet confirmed');
  accepted = false;
  await page.getByRole('button', { name: 'Resend verification' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Acceptance could not be confirmed' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resend verification' })).toBeDisabled();
  expect(calls).toBe(2);
});

test('verification confirmation keeps the company role unchanged', async ({ page }) => {
  const data = structuredClone(baseline), user = data.users.find(row => row.role === 'owner')!, token = 'synthetic-account-verification-token';
  const now = new Date().toISOString();
  (data.emailVerificationTokens ||= []).push({ id: 'account-proof-token', userId: user.id, workspaceId: user.workspaceId, tokenHash: createHash('sha256').update(token).digest('hex'), issuedAt: now, expiresAt: new Date(Date.now() + 60000).toISOString(), source: 'signup', createdAt: now, updatedAt: now });
  fs.writeFileSync(E2E_DATA_FILE, JSON.stringify(data));
  await page.goto(`/verify-email?token=${token}`);
  await expect(page.getByText('✓ Email verified')).toBeVisible();
  await expect(page.getByText(/company role still determines/i)).toBeVisible();
  expect(JSON.parse(fs.readFileSync(E2E_DATA_FILE, 'utf8')).users.find((row: { id: string }) => row.id === user.id).role).toBe(user.role);
});

function saveResetFixture(token: string) {
  const data = structuredClone(baseline), user = data.users.find(row => row.role === 'owner')!, now = new Date().toISOString();
  (data.passwordResetTokens ||= []).push({ id: 'account-proof-reset-token', userId: user.id, workspaceId: user.workspaceId, tokenHash: createHash('sha256').update(token).digest('hex'), issuedAt: now, expiresAt: new Date(Date.now() + 60000).toISOString(), issuedByAdminId: 'self_service', createdAt: now, updatedAt: now });
  fs.writeFileSync(E2E_DATA_FILE, JSON.stringify(data));
  return user;
}

test('password reset retains inputs after an uncertain request and manual retry redeems the saved token', async ({ page }) => {
  const token = 'synthetic-retry-password-token', newPassword = 'Synthetic-new-account-password!';
  saveResetFixture(token);
  let fail = true;
  await page.route('**/api/auth/reset-password', route => fail ? route.fulfill({ status: 503, json: { ok: false, error: { message: 'Synthetic temporary database failure' } } }) : route.continue());
  await page.goto(`/reset-password?token=${token}`);
  await page.getByLabel('New password', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirm new password', { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'could not confirm whether your password changed' })).toBeVisible();
  await expect(page.getByLabel('New password', { exact: true })).toHaveValue(newPassword);
  await expect(page.getByLabel('Confirm new password', { exact: true })).toHaveValue(newPassword);
  await expect(page.getByRole('link', { name: 'Try signing in', exact: true })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Retry password reset', exact: true }).click();
  await expect(page.getByText('✓ Password reset')).toBeVisible();
  expect(JSON.parse(fs.readFileSync(E2E_DATA_FILE, 'utf8')).passwordResetTokens.find((row: { id: string }) => row.id === 'account-proof-reset-token').consumedAt).toBeTruthy();
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/account-password-reset-recovered.png' });
});

test('actual password reset leads to new-password sign-in and refuses reused link', async ({ page }) => {
  const token = 'synthetic-complete-password-token', newPassword = 'Synthetic-complete-new-password!';
  const user = saveResetFixture(token);
  await page.goto(`/reset-password?token=${token}`);
  await page.getByLabel('New password', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirm new password', { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expect(page.getByText('✓ Password reset')).toBeVisible();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expectAppShell(page);
  const signedIn = await (await page.request.get('/api/auth/status')).json();
  expect(signedIn.user.workspaceId).toBe(user.workspaceId);
  await page.goto(`/reset-password?token=${token}`);
  await page.getByLabel('New password', { exact: true }).fill('Synthetic-other-password!');
  await page.getByLabel('Confirm new password', { exact: true }).fill('Synthetic-other-password!');
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expect(page.getByText('Couldn\'t reset', { exact: true })).toBeVisible();
  await expect(page.getByText(/already been used/i)).toBeVisible();
  await expect(page.getByRole('link', { name: 'ask for a new link' })).toBeVisible();
  expect((await (await page.request.get('/api/auth/status')).json()).authenticated).toBe(true);
});

test('operator unavailable-email reset preserves existing tokens and working sessions', async ({ page, context }) => {
  const data = structuredClone(baseline), user = data.users.find(row => row.role === 'owner')!, now = new Date().toISOString();
  const adminId = 'account-proof-operator';
  (data.platformAdmins ||= []).push({ id: adminId, email: 'operator@example.invalid', name: 'Synthetic operator', role: 'operator', status: 'active', createdAt: now, updatedAt: now });
  (data.platformAdminCredentials ||= []).push({ id: 'account-proof-operator-credential', adminId, email: 'operator@example.invalid', passwordHash: data.userCredentials![0].passwordHash, sessionVersion: 1, createdAt: now, updatedAt: now });
  fs.writeFileSync(E2E_DATA_FILE, JSON.stringify(data));
  await signIn(context);
  process.env.PLATFORM_ADMIN_SESSION_SECRET = 'disposable-week-four-platform-admin-secret-2026';
  // Construct the synthetic signed operator cookie without importing server
  // repositories into Playwright's CommonJS loader. Actual server validates it.
  const payload = Buffer.from(JSON.stringify({ adminId, role: 'operator', email: 'operator@example.invalid', sessionVersion: 1, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const signature = createHmac('sha256', process.env.PLATFORM_ADMIN_SESSION_SECRET).update(payload).digest('base64url');
  await context.addCookies([{ name: 'lc_platform_admin', value: `${payload}.${signature}`, url: E2E_BASE_URL }]);
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Workspaces', exact: true }).click();
  await page.getByRole('button').filter({ hasText: data.workspaces.find(row => row.id === user.workspaceId)!.businessName || data.workspaces.find(row => row.id === user.workspaceId)!.name }).first().click();
  await page.getByRole('button', { name: 'Reset password', exact: true }).first().click();
  await expect(page.getByText(/No reset was issued and existing sessions are unchanged/i)).toBeVisible();
  const saved: AppData = JSON.parse(fs.readFileSync(E2E_DATA_FILE, 'utf8'));
  expect(saved.passwordResetTokens || []).toEqual(data.passwordResetTokens || []);
  expect(saved.userCredentials!.find(row => row.userId === user.id)!.sessionVersion).toBe(1);
  expect((await (await page.request.get('/api/auth/status')).json()).authenticated).toBe(true);
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/account-operator-reset-unavailable.png' });
});

test('operator account-email health separates configuration from real delivery', async ({ page, context }) => {
  const data = structuredClone(baseline), now = new Date().toISOString(), adminId = 'account-proof-health-operator';
  (data.platformAdmins ||= []).push({ id: adminId, email: 'health-operator@example.invalid', name: 'Synthetic health operator', role: 'operator', status: 'active', createdAt: now, updatedAt: now });
  (data.platformAdminCredentials ||= []).push({ id: 'account-proof-health-credential', adminId, email: 'health-operator@example.invalid', passwordHash: data.userCredentials![0].passwordHash, sessionVersion: 1, createdAt: now, updatedAt: now });
  fs.writeFileSync(E2E_DATA_FILE, JSON.stringify(data));
  const payload = Buffer.from(JSON.stringify({ adminId, role: 'operator', email: 'health-operator@example.invalid', sessionVersion: 1, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const signature = createHmac('sha256', 'disposable-week-four-platform-admin-secret-2026').update(payload).digest('base64url');
  await context.addCookies([{ name: 'lc_platform_admin', value: `${payload}.${signature}`, url: E2E_BASE_URL }]);
  const actual = await page.request.get('/api/admin/health');
  expect(actual.status()).toBe(200);
  const snapshot = await actual.json();
  expect(snapshot.accountEmail).toMatchObject({ ready: false, senderConfigured: false });
  expect(snapshot.accountEmail).not.toHaveProperty('sender');
  expect(snapshot.accountEmail).not.toHaveProperty('key');
  await page.goto('/admin');
  await page.getByRole('button', { name: 'System health', exact: true }).click();
  await expect(page.getByText('Needs setup', { exact: true })).toBeVisible();
  await expect(page.getByText('Account email provider is not connected.', { exact: true })).toBeVisible();
  let configuration = { ready: false, senderConfigured: false, reason: 'Account email sender is not configured.' };
  await page.route('**/api/admin/health', route => route.fulfill({ json: { ...snapshot, emailProvider: 'resend', accountEmail: configuration } }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText(configuration.reason, { exact: true })).toBeVisible();
  await expect(page.getByText('Needs setup', { exact: true })).toBeVisible();
  configuration = { ready: true, senderConfigured: true, reason: '' };
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Configured', { exact: true })).toBeVisible();
  await expect(page.getByText('Delivery not yet verified. Check a joining or password-reset email.', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'readiness-proof/account-email-configured-not-delivered.png' });
});
