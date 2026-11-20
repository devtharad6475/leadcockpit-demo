import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword } from '@/lib/password';
import type { AppData } from '@/lib/types';
import { E2E_DATA_FILE, assertE2EDataDirIsIsolated } from './helpers/data-dir';
import { expectAppShell } from './helpers/login';
import { openTabByLabel } from './helpers/nav';

const company = 'customer_ticket_edit_company', password = 'Synthetic-ticket-editor-password!';
let baseline: AppData, passwordHash: string;
const snapshot = (): AppData => JSON.parse(fs.readFileSync(E2E_DATA_FILE, 'utf8'));
async function quiescent() {
  let previous = -1, stable = 0;
  for (let count = 0; count < 50; count++) {
    const modified = fs.statSync(E2E_DATA_FILE).mtimeMs;
    stable = modified === previous && !fs.existsSync(path.join(path.dirname(E2E_DATA_FILE), 'app-data.lock')) ? stable + 1 : 0;
    if (stable >= 5) return;
    previous = modified; await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Disposable ticket fixture is still being written');
}
test.beforeAll(async () => {
  assertE2EDataDirIsIsolated();
  baseline = JSON.parse(fs.readFileSync(`${E2E_DATA_FILE}.employee-snapshot.json`, 'utf8'));
  passwordHash = await hashPassword(password);
});
test.beforeEach(async () => {
  await quiescent();
  const data = structuredClone(baseline), now = new Date().toISOString();
  data.workspaces.push({ ...data.workspaces[0], id: company, name: 'Ticket editor company', ownerUserId: `${company}_owner` });
  const id = `${company}_owner`, email = `${id}@example.invalid`;
  data.users.push({ id, workspaceId: company, email, name: 'Synthetic owner', role: 'owner', createdAt: now, updatedAt: now });
  (data.userCredentials ||= []).push({ id: `${id}_credential`, workspaceId: company, userId: id, email, passwordHash, sessionVersion: 1, createdAt: now, updatedAt: now });
  (data.workspaceMembers ||= []).push({ id: `${id}_member`, workspaceId: company, userId: id, email, name: 'Synthetic owner', role: 'owner', status: 'active', createdAt: now, updatedAt: now });
  data.leads.push({ ...data.leads[0], id: `${company}_buyer`, workspaceId: company, companyName: 'Synthetic packaging buyer', conversationMemory: undefined });
  fs.writeFileSync(E2E_DATA_FILE, JSON.stringify(data));
});
test.afterEach(async ({ page }) => { await page.close(); await quiescent(); });
async function login(page: Page) {
  await page.goto('/'); await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(`${company}_owner@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expectAppShell(page);
}
async function post(page: Page, url: string, body: object) {
  const response = await page.request.post(url, { data: body, headers: { origin: new URL(page.url()).origin } });
  expect(response.status()).toBe(200); return response.json();
}
async function createResolved(page: Page, subject: string) {
  const ticket = await post(page, '/api/tickets', { leadId: `${company}_buyer`, subject, description: 'Synthetic damaged sample', type: 'complaint', priority: 'medium', sourceChannel: 'manual' });
  await post(page, `/api/tickets/${ticket.id}/status`, { toStatus: 'resolved', note: 'Replacement sample checked; separate customer follow-up requires review.' });
  return ticket.id as string;
}
async function select(page: Page, subject: string) {
  await page.getByRole('button', { name: new RegExp(`#.*${subject}`) }).click();
  await expect(page.getByLabel('Message for the customer')).toBeVisible();
}

test('switching tickets keeps each unsaved follow-up separate during the same screen session', async ({ page }) => {
  await login(page);
  await createResolved(page, 'Ticket A sample'); await createResolved(page, 'Ticket B sample');
  await openTabByLabel(page, 'Tickets'); await select(page, 'Ticket A sample');
  await page.getByLabel('Message for the customer').fill('A replacement sample has been checked.');
  await select(page, 'Ticket B sample');
  await expect(page.getByLabel('Message for the customer')).toHaveValue('');
  await page.getByLabel('Message for the customer').fill('B package inspection is complete.');
  await select(page, 'Ticket A sample');
  await expect(page.getByLabel('Message for the customer')).toHaveValue('A replacement sample has been checked.');
  await select(page, 'Ticket B sample');
  await expect(page.getByLabel('Message for the customer')).toHaveValue('B package inspection is complete.');
  await expect(page.getByText('Save your draft before leaving Tickets or refreshing.', { exact: false })).toBeVisible();
  expect(snapshot().autoReplyLogs?.filter(row => row.workspaceId === company && row.retrievedContext?.ticketId)).toHaveLength(0);
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/customer-ticket-unsaved-switching.png' });
});

test('delayed real save stays attached to its ticket while another ticket is selected', async ({ page }) => {
  await login(page);
  const a = await createResolved(page, 'Ticket A delayed'), b = await createResolved(page, 'Ticket B independent');
  await openTabByLabel(page, 'Tickets'); await select(page, 'Ticket B independent');
  await page.getByLabel('Message for the customer').fill('B independent working message.');
  await select(page, 'Ticket A delayed');
  await page.getByLabel('Message for the customer').fill('A confirmed outcome for owner review.');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/tickets/${a}/closure-draft`, async route => {
    if (route.request().method() === 'POST') { await gate; await route.continue(); } else await route.continue();
  });
  try {
    const requested = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith(`/tickets/${a}/closure-draft`));
    await page.getByRole('button', { name: 'Save customer follow-up draft', exact: true }).click(); await requested;
    await select(page, 'Ticket B independent');
    await expect(page.getByLabel('Message for the customer')).toHaveValue('B independent working message.');
    const saved = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/tickets/${a}/closure-draft`));
    release(); expect((await saved).status()).toBe(200);
    await expect(page.getByLabel('Message for the customer')).toBeEnabled();
    await expect(page.getByLabel('Message for the customer')).toHaveValue('B independent working message.');
    await expect(page.getByText('Draft saved for owner review. No customer message has been sent.', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Save customer follow-up draft', exact: true }).click();
    await expect(page.getByText('Draft saved for owner review. No customer message has been sent.', { exact: true })).toBeVisible();
    await select(page, 'Ticket A delayed');
    await expect(page.getByLabel('Message for the customer')).toHaveValue('A confirmed outcome for owner review.');
    await page.reload(); await openTabByLabel(page, 'Tickets');
    await select(page, 'Ticket B independent');
    await expect(page.getByLabel('Message for the customer')).toHaveValue('B independent working message.');
    const drafts = snapshot().autoReplyLogs!.filter(row => row.workspaceId === company && row.retrievedContext?.ticketId);
    expect(drafts.find(row => row.retrievedContext?.ticketId === a)?.generatedReply).toBe('A confirmed outcome for owner review.');
    expect(drafts.find(row => row.retrievedContext?.ticketId === b)?.generatedReply).toBe('B independent working message.');
    expect(drafts.every(row => row.status === 'held_for_review' && row.sendStatus !== 'sent')).toBe(true);
    await page.screenshot({ path: 'docs/system-workflow/readiness-proof/customer-ticket-delayed-save.png' });
  } finally { release(); }
});


test('a manual customer complaint without an order retains its customer through resolution and follow-up', async ({ page }) => {
  await login(page);
  await openTabByLabel(page, 'Tickets');
  await page.getByRole('button', { name: 'New ticket', exact: true }).click();
  await page.getByLabel('Customer (optional)').selectOption(`${company}_buyer`);
  await page.getByLabel('Subject', { exact: false }).fill('Manual sample complaint');
  await page.getByLabel('Description', { exact: true }).fill('Synthetic carton sample was damaged; owner review needed.');
  await page.getByLabel('Type', { exact: true }).selectOption('complaint');
  await page.getByRole('button', { name: 'Create ticket', exact: true }).click();
  await page.getByRole('button', { name: /#.*Manual sample complaint/ }).click();
  const ticket = snapshot().tickets?.find(row => row.workspaceId === company && row.subject === 'Manual sample complaint');
  expect(ticket?.leadId).toBe(`${company}_buyer`);
  await expect(page.getByRole('button', { name: 'Customer conversations', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mark resolved', exact: true }).click();
  await page.getByLabel('Outcome and follow-up').fill('Replacement reviewed; customer follow-up awaits owner approval.');
  await page.getByRole('button', { name: 'Save resolution', exact: true }).click();
  await page.getByLabel('Message for the customer').fill('Your damaged sample has been reviewed. Our team will confirm the next step.');
  await page.getByRole('button', { name: 'Save customer follow-up draft', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Review customer reply', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Needs you/ }).click();
  await expect(page.getByText("Written by your team. Check it against the ticket's resolution and company policy before approving.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Every claim in it is the model/)).toHaveCount(0);
  await openTabByLabel(page, 'Tickets'); await select(page, 'Manual sample complaint');
  await page.getByRole('button', { name: 'Review customer reply', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /^Edit the WhatsApp reply for /  })).toHaveValue('Your damaged sample has been reviewed. Our team will confirm the next step.');
  await openTabByLabel(page, 'Tickets'); await select(page, 'Manual sample complaint');
  await page.reload(); await expectAppShell(page); await openTabByLabel(page, 'Tickets'); await select(page, 'Manual sample complaint');
  await expect(page.getByLabel('Message for the customer')).toHaveValue('Your damaged sample has been reviewed. Our team will confirm the next step.');
  let failReview = true;
  await page.route('**/api/auto-reply-logs', route => failReview ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: 'Customer review temporarily unavailable' } }) }) : route.continue());
  await page.getByRole('button', { name: 'Review customer reply', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Customer review temporarily unavailable' })).toBeVisible();
  await expect(page.getByLabel('Message for the customer')).toHaveValue('Your damaged sample has been reviewed. Our team will confirm the next step.');
  failReview = false;
  await page.getByRole('button', { name: 'Review customer reply', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /^Edit the WhatsApp reply for /  })).toHaveValue('Your damaged sample has been reviewed. Our team will confirm the next step.');
  await expect(page.getByText('No customer replies yet.', { exact: true })).toHaveCount(0);

  const draft = snapshot().autoReplyLogs?.find(row => row.workspaceId === company && row.retrievedContext?.ticketId === ticket?.id);
  expect(draft?.leadId).toBe(`${company}_buyer`); expect(draft?.sendAttempted).toBe(false);
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/manual-customer-ticket-loop.png' });
});
