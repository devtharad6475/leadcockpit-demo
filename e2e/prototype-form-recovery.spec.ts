import { test, expect, type Page } from '@playwright/test';
import { expectAppShell } from './helpers/login';
import { openTabByLabel } from './helpers/nav';

async function owner(page: Page, key: string) {
  const email = `${key}@example.invalid`, password = 'Synthetic-form-recovery-password!';
  await page.goto('/signup');
  await page.getByLabel('Your name', { exact: true }).fill('Form recovery owner');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel(/Business name/).fill(`Form recovery ${key}`);
  await page.getByRole('button', { name: /Create|Sign up/i }).click();
  await expect(page.getByText('Request processed', { exact: true })).toBeVisible();
  await page.goto('/');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expectAppShell(page);
}
const failure = (message: string) => ({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'TEST_UNAVAILABLE', message } }) });

test('support ticket explains failures inside its form and permits a real retry', async ({ page }) => {
  await owner(page, 'support-form-proof');
  await openTabByLabel(page, 'Help & Support');
  await page.getByRole('button', { name: 'Open your first ticket', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Open a support ticket', exact: true });
  await dialog.getByRole('button', { name: 'Open ticket', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Please add a short subject.');
  await dialog.getByLabel('Subject', { exact: true }).fill('Support retry proof');
  await dialog.getByRole('button', { name: 'Open ticket', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Please describe what happened.');
  await dialog.getByLabel('Describe what happened', { exact: true }).fill('Keep this description after the failed save.');
  await page.route('**/api/platform-tickets', route => route.request().method() === 'POST' ? route.fulfill(failure('Support save temporarily unavailable.')) : route.continue());
  await dialog.getByRole('button', { name: 'Open ticket', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Support save temporarily unavailable.');
  await expect(dialog.getByLabel('Subject', { exact: true })).toHaveValue('Support retry proof');
  await expect(dialog.getByLabel('Describe what happened', { exact: true })).toHaveValue('Keep this description after the failed save.');
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/cleanup-support-retry.png' });
  await page.unroute('**/api/platform-tickets');
  const saved = page.waitForResponse(response => response.url().endsWith('/api/platform-tickets') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Open ticket', exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(dialog).toHaveCount(0);
  await page.reload();
  const refreshed = page.waitForResponse(response => response.url().endsWith('/api/platform-tickets') && response.request().method() === 'GET');
  await openTabByLabel(page, 'Help & Support');
  const refreshedResponse = await refreshed;
  expect(refreshedResponse.ok()).toBe(true);
  expect(await refreshedResponse.json()).toEqual(expect.arrayContaining([expect.objectContaining({ subject: 'Support retry proof' })]));
  await expect(page.getByText('Support retry proof', { exact: true }).first()).toBeVisible();
});

test('blocked restriction-removal and erasure requests show errors without changing customer data', async ({ page }) => {
  await owner(page, 'restriction-form-proof');
  const headers = { origin: new URL(page.url()).origin };
  const created = await page.request.post('/api/leads/manual', { headers, data: { companyName: 'Restricted fixture buyer', contactName: 'Restricted fixture buyer', email: 'restricted-buyer@example.invalid' } });
  expect(created.ok()).toBe(true); const lead = await created.json();
  const before = await (await page.request.get(`/api/leads/${lead.id}`)).json();
  await page.route('**/api/consent', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ leadId: lead.id, contactName: 'Restricted fixture buyer', consentStatus: 'none', doNotContact: true }]) }));
  let removals = 0, erasures = 0;
  await page.route('**/api/consent/*/remove-dnc', route => { removals++; return route.fulfill(failure('Contact restriction could not be changed.')); });
  await page.route('**/api/erasure/*', route => {
    if (route.request().method() !== 'POST') return route.continue();
    erasures++; return route.fulfill(failure('Customer information could not be deleted.'));
  });
  await openTabByLabel(page, 'Compliance');
  await page.getByRole('button', { name: 'Remove Restricted fixture buyer from the do-not-contact list', exact: true }).click();
  const restriction = page.getByRole('dialog', { name: 'Remove from do-not-contact list', exact: true });
  await restriction.getByLabel('Reason for removal', { exact: false }).fill('Synthetic intercepted test; do not remove any restriction.');
  await restriction.getByRole('button', { name: 'Remove from DNC', exact: true }).click();
  await expect(restriction.getByRole('alert')).toHaveText('Contact restriction could not be changed.');
  await expect(restriction.getByLabel('Reason for removal', { exact: false })).toHaveValue('Synthetic intercepted test; do not remove any restriction.');
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/cleanup-restriction-error.png' });
  await restriction.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Erase customer data for Restricted fixture buyer', exact: true }).click();
  const erasure = page.getByRole('dialog', { name: 'Erase customer data — DPDPA right to erasure', exact: true });
  await expect(erasure.getByRole('button', { name: 'Permanently erase', exact: true })).toBeDisabled();
  await erasure.getByLabel('Type the customer name to confirm erasure', { exact: true }).fill('Restricted fixture buyer');
  await erasure.getByRole('button', { name: 'Permanently erase', exact: true }).click();
  await expect(erasure.getByRole('alert')).toHaveText('Customer information could not be deleted.');
  await expect(erasure.getByLabel('Type the customer name to confirm erasure', { exact: true })).toHaveValue('Restricted fixture buyer');
  expect(removals).toBe(1); expect(erasures).toBe(1);
  expect(await (await page.request.get(`/api/leads/${lead.id}`)).json()).toEqual(before);
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/cleanup-erasure-error.png' });
});

test('a failed product-list read cannot replace saved products and the reviewed draft can be retried', async ({ page }) => {
  await owner(page, 'product-read-proof');
  const headers = { origin: new URL(page.url()).origin };
  const existing = { id: 'keep-existing', name: 'Existing cartons', price: 42, productMode: 'simple' };
  expect((await page.request.put('/api/settings/products', { headers, data: { products: [existing] } })).ok()).toBe(true);
  expect((await page.request.post('/api/settings/pending-drafts', { headers, data: { kind: 'product', sourceGroupKey: 'product-read-proof', sourceTitle: 'Reviewed new carton', sourceTopic: 'product', sourceAnswer: 'Synthetic owner-approved product draft', products: [{ id: 'new-reviewed', name: 'New reviewed cartons', productMode: 'simple' }] } })).ok()).toBe(true);
  await openTabByLabel(page, 'Questions from AI');
  await page.getByRole('button', { name: 'Review here', exact: true }).click();
  let reads = 0, writes = 0;
  await page.route('**/api/settings/products', route => {
    if (route.request().method() === 'GET') { reads++; return route.fulfill(failure('Product list temporarily unavailable.')); }
    if (route.request().method() === 'PUT') { writes++; return route.fulfill(failure('Unsafe write intercepted by test.')); }
    return route.continue();
  });
  await page.getByRole('button', { name: 'Save reviewed Product Settings', exact: true }).click();
  await expect.poll(() => reads).toBe(1);
  await expect(page.getByText(/Could not read your saved products|Unsafe write intercepted by test/).first()).toBeVisible();
  expect(writes).toBe(0);
  await expect(page.getByText(/Could not read your saved products/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save reviewed Product Settings', exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/settings/products')).json()).products).toEqual([existing]);
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/cleanup-product-read-refused.png' });
  await page.unroute('**/api/settings/products');
  const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/products') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save reviewed Product Settings', exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await page.reload();
  const stored = (await (await page.request.get('/api/settings/products')).json()).products;
  expect(stored.map((product: { id: string }) => product.id).sort()).toEqual(['keep-existing', 'new-reviewed']);
});
