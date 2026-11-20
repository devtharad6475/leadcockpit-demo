import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { hashPassword } from '@/lib/password';
import type { AppData } from '@/lib/types';
import { E2E_DATA_FILE } from './helpers/data-dir';
import { readAppData as readSnapshot } from './helpers/app-data';
import { expectAppShell } from './helpers/login';
import { openTabByLabel } from './helpers/nav';
import path from 'node:path';

// Built local application, real signed sessions, disposable company data.
// Invite transport is not configured. Acceptance uses a controlled fixture
// token on the actual saved invite, proving acceptance without claiming mail.
const company = 'journey_company', password = 'Synthetic-journey-password!';
let baseline: AppData;
let passwordHash: string;
let loginSuffix = '';
const readAppData = (): AppData => readSnapshot();
// The demo quiescence helper calls /api/state with a demo cookie, which is
// correctly rejected by production authentication. Wait for the isolated
// file's writer lock and stable modification time after closing all pages.
async function waitForServerQuiescent() {
  let previous = -1, stable = 0;
  for (let count = 0; count < 50; count++) {
    const modified = fs.statSync(E2E_DATA_FILE).mtimeMs;
    stable = modified === previous && !fs.existsSync(path.join(path.dirname(E2E_DATA_FILE), 'app-data.lock')) ? stable + 1 : 0;
    if (stable >= 5) return;
    previous = modified; await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Disposable production fixture is still being written');
}
test.beforeAll(async () => { baseline = JSON.parse(fs.readFileSync(`${E2E_DATA_FILE}.employee-snapshot.json`, 'utf8')); passwordHash = await hashPassword(password); });
test.beforeEach(async ({ page }, testInfo) => {
  void page;
  await waitForServerQuiescent();
  // Each independent synthetic user has a distinct login identifier. Reusing
  // one email across a long suite legitimately triggers the production limit.
  loginSuffix = createHash('sha256').update(testInfo.testId).digest('hex').slice(0, 12);
  const data: AppData = structuredClone(baseline), now = new Date().toISOString();
  for (const workspaceId of [company, 'journey_other_company']) {
    data.workspaces.push({ ...data.workspaces[0], id: workspaceId, name: workspaceId, ownerUserId: `${workspaceId}_owner` });
    for (const role of ['owner', 'admin', 'sales_member', 'viewer'] as const) {
      const id = `${workspaceId}_${role}`, email = `${id}_${loginSuffix}@example.invalid`;
      data.users.push({ id, workspaceId, email, name: role, role, createdAt: now, updatedAt: now });
      (data.userCredentials ||= []).push({ id: `${id}_cred`, workspaceId, userId: id, email, passwordHash, sessionVersion: 1, createdAt: now, updatedAt: now });
      (data.workspaceMembers ||= []).push({ id: `${id}_member`, workspaceId, userId: id, email, name: role, role, status: 'active', createdAt: now, updatedAt: now });
    }
    data.leads.push({ ...data.leads[0], id: `${workspaceId}_buyer`, workspaceId, companyName: `${workspaceId} buyer`, conversationMemory: undefined });
  }
  fs.writeFileSync(E2E_DATA_FILE, JSON.stringify(data));
});
test.afterEach(async ({ page }) => { await page.close(); await waitForServerQuiescent(); });
async function login(page: Page, role: string) {
  await page.goto('/'); await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(`${company}_${role}_${loginSuffix}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expectAppShell(page);
}
async function post(page: Page, url: string, body: object) {
  return page.evaluate(async ({ url, body }) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, { url, body });
}

test('owner sees team failure and unsent invite, and employee accepts then logs in to the correct company', async ({ page }) => {
  await login(page, 'owner');
  let fail = true;
  await page.route('**/api/invites', route => route.request().method() === 'GET' && fail
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: 'Team list temporarily unavailable' } }) }) : route.continue());
  await openTabByLabel(page, 'Workspace');
  await page.getByRole('tab', { name: 'Team', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Team & Invites' }).getByRole('alert')).toContainText('Team list temporarily unavailable');
  fail = false; await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill('new_colleague@journey.example');
  await page.getByLabel('Role', { exact: true }).selectOption('sales_member');
  await page.getByRole('button', { name: 'Send invite', exact: true }).click();
  await expect(page.getByText(/was saved, but the email was not sent/)).toBeVisible();
  const data = readAppData(), invite = data.invites!.find(r => r.workspaceId === company && r.email === 'new_colleague@journey.example')!;
  expect(invite.status).toBe('pending');
  const token = 'synthetic-invite-acceptance-token';
  invite.tokenHash = createHash('sha256').update(token).digest('hex');
  await waitForServerQuiescent(); fs.writeFileSync(E2E_DATA_FILE, JSON.stringify(data));
  await page.goto(`/invite?token=${token}`);
  await page.getByLabel('Your name', { exact: true }).fill('New colleague');
  await page.getByLabel('Choose a password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Accept invite & set up account', exact: true }).click(); await expectAppShell(page, 30000);
  const status = await (await page.request.get('/api/auth/status')).json();
  expect(status.user.workspaceId).toBe(company); expect(status.user.role).toBe('sales_member');
  expect(readAppData().workspaceMembers!.find(r => r.email === invite.email)?.status).toBe('active');
  await page.route('**/api/auth/logout', async route => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await route.continue();
  });
  const logoutRequest = page.waitForRequest(r => new URL(r.url()).pathname === '/api/auth/logout');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await logoutRequest;
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(invite.email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expectAppShell(page);
  expect((await (await page.request.get('/api/auth/status')).json()).user.workspaceId).toBe(company);
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/journey-employee-entry.png' });
});

test('failed sign-out stays visible and retry completes the actual session removal', async ({ page }) => {
  await login(page, 'sales_member');
  await page.route('**/api/auth/logout', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: 'Unavailable' } }) }));
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByText('Sign out could not be completed. Please try again.', { exact: true })).toBeVisible();
  await expectAppShell(page);
  expect((await (await page.request.get('/api/auth/status')).json()).authenticated).toBe(true);
  await page.unroute('**/api/auth/logout');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/auth/status')).json()).authenticated).toBe(false);
});

test('owner assigns an eligible employee, employee resolves it, owner sees saved result and history', async ({ page, browser }) => {
  await login(page, 'owner');
  const created = await post(page, '/api/tickets', { leadId: `${company}_buyer`, subject: 'Synthetic sample complaint', description: 'Sample package issue', type: 'complaint', priority: 'medium', sourceChannel: 'manual' });
  expect(created.status).toBe(200);
  await openTabByLabel(page, 'Tickets');
  await expect(page.getByLabel('Who is handling this')).toBeVisible();
  await expect(page.getByLabel('Who is handling this').locator('option', { hasText: 'viewer' })).toHaveCount(0);
  await page.getByLabel('Who is handling this').selectOption(`${company}_sales_member`);
  await expect(page.getByText('Assigned to sales_member', { exact: true })).toBeVisible();
  const context = await browser.newContext(), staff = await context.newPage();
  try {
    await login(staff, 'sales_member'); await openTabByLabel(staff, 'Tickets');
    await staff.getByRole('button', { name: 'Start working', exact: true }).click();
    await expect(staff.getByRole('button', { name: 'Waiting on customer', exact: true })).toBeVisible();
    await staff.getByRole('button', { name: 'Mark resolved', exact: true }).click();
    await staff.getByLabel('Outcome and follow-up').fill('Sample checked and issue corrected. Customer follow-up requires owner review.');
    await staff.getByRole('button', { name: 'Save resolution', exact: true }).click();
    await expect(staff.getByText('This ticket is done', { exact: true })).toBeVisible();
    await staff.reload(); await openTabByLabel(staff, 'Tickets');
    await expect(staff.getByText('This ticket is done', { exact: true })).toBeVisible();
    await staff.screenshot({ path: 'docs/system-workflow/readiness-proof/journey-employee-resolved.png' });
    expect((await staff.request.get('/api/leads/journey_other_company_buyer')).status()).toBe(404);
    const ownerTicketRead = page.waitForResponse(response => new URL(response.url()).pathname === '/api/tickets' && response.request().method() === 'GET');
    await page.reload(); await openTabByLabel(page, 'Tickets');
    expect((await ownerTicketRead).ok()).toBe(true);
    await expect(page.getByText('This ticket is done', { exact: true })).toBeVisible();
    await expect(page.getByText('By sales_member', { exact: true }).last()).toBeVisible();
    expect(readAppData().tickets!.find(r => r.workspaceId === company)?.assignedTo).toBe(`${company}_sales_member`);
  } finally { await context.close(); }
});

test('ordinary employee sees suitable read-only screens and backend refuses restricted work', async ({ page }) => {
  await login(page, 'viewer');
  await expect(page.getByRole('button', { name: 'Assistant', exact: true })).toHaveCount(0);
  expect((await page.request.get('/api/copilot/jobs')).status()).toBe(403);
  await openTabByLabel(page, 'Leads');
  await expect(page.getByRole('button', { name: 'Add customer', exact: true })).toHaveCount(0);
  await openTabByLabel(page, 'Tickets');
  await expect(page.getByRole('button', { name: 'New ticket', exact: true })).toHaveCount(0);
  expect((await post(page, '/api/tickets', { subject: 'Forbidden', description: 'No write', type: 'complaint', priority: 'medium', sourceChannel: 'manual' })).status).toBe(403);
  expect(readAppData().tickets!.filter(r => r.workspaceId === company)).toHaveLength(0);
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/journey-viewer-interface-corrected.png' });
});

test('learning load failure is visible and retry reads the actual saved result', async ({ page }) => {
  let fail = true;
  await page.route('**/api/learning/this-week', route => fail ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: 'Temporarily unavailable' } }) }) : route.continue());
  await login(page, 'owner');
  const card = page.getByTestId('learned-this-week');
  await expect(card.getByRole('alert')).toContainText('could not load');
  fail = false; const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/learning/this-week');
  await card.getByRole('button', { name: 'Retry', exact: true }).click(); expect((await response).ok()).toBe(true);
  await expect(page.getByText(/We could not load what the system learned/)).toHaveCount(0);
});

test('owner hands over unfinished work before changing access and the old staff session ends', async ({ page, browser }) => {
  await login(page, 'owner');
  expect((await post(page, '/api/tickets', { leadId: `${company}_buyer`, subject: 'Unfinished handover example', description: 'Still open', type: 'complaint', priority: 'medium', sourceChannel: 'manual' })).status).toBe(200);
  const ticket = readAppData().tickets!.find(r => r.workspaceId === company)!;
  expect((await post(page, `/api/tickets/${ticket.id}/assign`, { assignedTo: `${company}_sales_member` })).status).toBe(200);
  const context = await browser.newContext(), staff = await context.newPage();
  try {
    await login(staff, 'sales_member');
    await openTabByLabel(page, 'Workspace');
    await page.getByRole('tab', { name: 'Team', exact: true }).click();
    await page.getByRole('button', { name: 'Change access for sales_member', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Viewer', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'unfinished ticket' })).toBeVisible();
    expect((await staff.request.get('/api/leads')).status()).toBe(200);
    expect(readAppData().tickets!.find(r => r.id === ticket.id)?.assignedTo).toBe(`${company}_sales_member`);
    await openTabByLabel(page, 'Tickets');
    await page.getByLabel('Who is handling this').selectOption(`${company}_owner`);
    await expect(page.getByText('Assigned to owner', { exact: true })).toBeVisible();
    expect(readAppData().tickets!.find(r => r.id === ticket.id)?.assignedTo).toBe(`${company}_owner`);
    await openTabByLabel(page, 'Workspace');
    await page.getByRole('tab', { name: 'Team', exact: true }).click();
    await page.getByRole('button', { name: 'Change access for sales_member', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Viewer', exact: true }).click();
    await expect(page.getByText(/sales_member is now Viewer/)).toBeVisible();
    expect((await staff.request.get('/api/leads')).status()).toBe(401);
    await page.getByRole('button', { name: 'Change access for sales_member', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Remove from team', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.getByText(/sales_member was removed and signed out/)).toBeVisible();
    expect(readAppData().workspaceMembers!.find(r => r.id === `${company}_sales_member_member`)?.status).toBe('disabled');
  } finally { await context.close(); }
});

test('owner corrects customer memory and the exact owner version survives refresh', async ({ page }) => {
  await login(page, 'owner'); await openTabByLabel(page, 'Leads');
  await page.getByRole('button', { name: `More actions for ${company} buyer`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'View details', exact: true }).click();
  await page.getByRole('button', { name: 'Write a note', exact: true }).click();
  const note = 'Customer prefers paid samples before placing a bulk order. Confirm all prices with the owner.';
  await page.getByRole('textbox', { name: 'Your note about this customer' }).fill(note);
  const saved = page.waitForResponse(r => new URL(r.url()).pathname === `/api/leads/${company}_buyer/memory` && r.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  const receipt = await saved; expect(receipt.ok()).toBe(true); expect((await receipt.json()).conversationMemorySource).toBe('owner');
  await expect(page.getByText(note, { exact: true })).toBeVisible();
  expect(readAppData().leads.find(r => r.id === `${company}_buyer`)?.conversationMemorySource).toBe('owner');
  await page.reload(); await openTabByLabel(page, 'Leads');
  await page.getByRole('button', { name: `More actions for ${company} buyer`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'View details', exact: true }).click();
  await expect(page.getByText(note, { exact: true })).toBeVisible();
  await expect(page.getByText(/your version, the AI will not overwrite it/)).toBeVisible();
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/journey-owner-customer-memory.png' });
});

test('long conversation summary explains its limits and original messages remain readable', async ({ page }) => {
  const data = readAppData(), leadId = `${company}_buyer`;
  const lead = data.leads.find(row => row.id === leadId)!;
  lead.conversationMemory = 'Customer previously requested paid samples.';
  lead.conversationMemorySource = 'ai';
  for (let index = 0; index < 90; index++) data.replies.push({
    id: `${company}_long_${index}`, workspaceId: company, leadId, channel: 'whatsapp', rawText: `Customer message ${index}. ${'Please share the catalogue. '.repeat(12)}Our requirement is 275 kg each month.`,
    createdAt: new Date(Date.now() - (90 - index) * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
  });
  (data.autoReplyLogs ||= []).push({ id: `${company}_long_review`, workspaceId: company, leadId, channel: 'whatsapp', incomingMessage: 'Please review the sample request.', generatedReply: 'Please confirm the sample details.', retrievedContext: {}, status: 'held_for_review', sendStatus: 'not_attempted', canAutoSend: false, needsHumanReview: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await waitForServerQuiescent(); fs.writeFileSync(E2E_DATA_FILE, JSON.stringify(data));
  await login(page, 'owner');
  const summaryRead = page.waitForResponse(response => new URL(response.url()).pathname === `/api/leads/${leadId}/conversation-summary`);
  await openTabByLabel(page, 'Replies');
  const response = await summaryRead; expect(response.ok()).toBe(true);
  const summary = await response.json();
  expect(summary.contextCoverage.totalEvents).toBeGreaterThanOrEqual(91);
  await expect(page.getByText(`This summary uses ${summary.contextCoverage.includedEvents} of ${summary.contextCoverage.totalEvents} recent events and saved customer notes.`, { exact: false })).toBeVisible();
  await expect(page.getByText(/Original messages remain in Conversations\./)).toBeVisible();
  expect(summary.contextCoverage.limited).toBe(true);
  expect(summary.contextCoverage.includedEvents).toBeLessThan(91);
  const refreshedSummary = page.waitForResponse(response => new URL(response.url()).pathname === `/api/leads/${leadId}/conversation-summary`);
  await page.reload(); await openTabByLabel(page, 'Replies');
  expect((await refreshedSummary).ok()).toBe(true);
  await expect(page.getByText(/This summary uses/)).toBeVisible();
  const messages = await (await page.request.get(`/api/leads/${leadId}/conversation-messages`)).json();
  expect(messages).toHaveLength(90);
  expect(messages[0].body).toContain('Our requirement is 275 kg each month.');
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/long-conversation-summary.png' });
});

function seedRememberedFact() {
  const data = readAppData(), now = new Date().toISOString();
  const lead = data.leads.find(row => row.id === `${company}_buyer`)!;
  const sourceId = `${company}_fact_source`;
  const body = `${'Please send a product catalogue. '.repeat(7)}We buy from Surat.`;
  data.replies.push({ id: sourceId, workspaceId: company, leadId: lead.id, channel: 'whatsapp', rawText: body, createdAt: now } as never);
  lead.discoveryState = { current_supplier: { label: 'Where they buy it now', value: 'We buy from Surat.', answeredAt: now, sourceReplyId: sourceId } };
  fs.writeFileSync(E2E_DATA_FILE, JSON.stringify(data));
  return body;
}
async function openCustomer(page: Page) {
  await openTabByLabel(page, 'Leads');
  await page.getByRole('button', { name: `More actions for ${company} buyer`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'View details', exact: true }).click();
}
test('customer fact evidence, correction, removal and explicit resume stay clear after refresh', async ({ page }) => {
  const source = seedRememberedFact();
  await login(page, 'owner'); await openCustomer(page);
  await page.getByText('Original customer message', { exact: true }).click();
  await expect(page.getByText(source, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Correct Where they buy it now', exact: true }).click();
  await page.getByRole('textbox', { name: 'Where they buy it now', exact: true }).fill('Owner confirmed Ahmedabad supplier');
  let failOnce = true;
  await page.route(`**/api/leads/${company}_buyer/discovery-facts/current_supplier`, async route => {
    if (failOnce) { failOnce = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'TEST_FAILURE', message: 'Could not save the customer fact. Try again.' } }) }); }
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Save corrected fact', exact: true }).click();
  const correction = page.getByRole('dialog', { name: 'Correct customer fact' });
  await expect(correction.getByRole('alert')).toContainText('Could not save');
  await expect(correction.getByRole('textbox')).toHaveValue('Owner confirmed Ahmedabad supplier');
  await correction.getByRole('button', { name: 'Save corrected fact', exact: true }).click();
  await expect(correction).toHaveCount(0);
  await expect(page.getByText('Owner confirmed Ahmedabad supplier', { exact: true })).toBeVisible();
  await page.reload(); await openCustomer(page);
  await expect(page.getByText('Owner confirmed Ahmedabad supplier', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove remembered fact: Where they buy it now', exact: true }).click();
  const remove = page.getByRole('dialog', { name: 'Remove this remembered fact?' });
  await expect(remove.getByText(/This does not erase customer data/)).toBeVisible();
  await remove.getByRole('button', { name: 'Remove and pause remembering', exact: true }).click();
  await expect(remove).toHaveCount(0);
  await expect(page.getByText('Remembering paused', { exact: true })).toBeVisible();
  await expect(page.getByText('Owner confirmed Ahmedabad supplier', { exact: true })).toHaveCount(0);
  expect(readAppData().replies.some(row => row.id === `${company}_fact_source`)).toBe(true);
  await page.reload(); await openCustomer(page);
  await expect(page.getByText('Remembering paused', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/customer-fact-paused.png' });
  await page.getByRole('button', { name: 'Resume remembering Where they buy it now', exact: true }).click();
  await expect(page.getByText('Remembering paused', { exact: true })).toHaveCount(0);
  await expect(page.locator('p').filter({ hasText: 'Still unknown:' })).toContainText('Where they buy it now');
  expect(readAppData().leads.find(row => row.id === `${company}_buyer`)?.discoveryState?.current_supplier?.forgottenAt).toBeUndefined();
});

test('employee sees full customer messages; viewer facts are read-only', async ({ page }) => {
  const source = seedRememberedFact();
  await login(page, 'viewer'); await openTabByLabel(page, 'Replies');
  await expect(page.getByText(source, { exact: true })).toBeVisible();
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/employee-customer-conversation.png' });
  await openCustomer(page);
  await expect(page.getByText('We buy from Surat.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Correct Where they buy it now', exact: true })).toHaveCount(0);
  expect((await page.request.put(`/api/leads/${company}_buyer/discovery-facts/current_supplier`, { data: { action: 'forget' }, headers: { origin: new URL(page.url()).origin } })).status()).toBe(403);
});

test('admin workspace and staff landing do not fetch owner-only panels', async ({ page }) => {
  const denied: string[] = [];
  page.on('response', response => { if (response.status() === 403 && response.url().includes('/api/')) denied.push(new URL(response.url()).pathname); });
  await login(page, 'admin'); await openTabByLabel(page, 'Workspace');
  await page.getByRole('tab', { name: 'Team', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Team & Invites', exact: true })).toBeVisible();
  await expect(page.getByText('Could not load', { exact: false })).toHaveCount(0);
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/admin-workspace-role.png' });
  await openTabByLabel(page, 'Dashboard');
  await expect(page.getByRole('heading', { name: 'Workspace status', exact: true })).toBeVisible();
  await expect(page.getByText('AI model health', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Outreach drafts to approve', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Customer replies to review', { exact: true })).toHaveCount(0);
  expect(denied).toEqual([]);
});

test('removed company source facts can be inspected and restored with failure recovery', async ({ page }) => {
  const data = readAppData(), now = new Date().toISOString(), chunkId = `${company}_removed_passage`;
  data.knowledgeBaseDocuments ||= []; data.knowledgeBaseChunks ||= [];
  for (const workspaceId of [company, 'journey_other_company']) {
    const documentId = `${workspaceId}_document`, id = workspaceId === company ? chunkId : `${workspaceId}_private_passage`;
    data.knowledgeBaseDocuments.push({ id: documentId, workspaceId, title: 'Synthetic company document', documentType: 'manual', source: 'document', status: 'active', contentText: 'Samples are paid.', metadata: {}, createdAt: now, updatedAt: now });
    data.knowledgeBaseChunks.push({ id, workspaceId, documentId, chunkIndex: 0, chunkText: workspaceId === company ? 'Samples are paid.' : 'Foreign company private source passage', metadata: { sourceFileName: 'Synthetic sample policy.txt', supersededBy: { answerId: 'synthetic_answer', at: now, replacedBy: 'Owner is reviewing the sample policy' } }, createdAt: now, updatedAt: now });
  }
  fs.writeFileSync(E2E_DATA_FILE, JSON.stringify(data));
  await login(page, 'owner'); await openTabByLabel(page, 'Knowledge Base');
  let listFails = true, restoreFails = true;
  await page.route('**/api/knowledge/removed-source-facts', async route => {
    if (listFails) { listFails = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: 'Could not load removed source facts. Try again.' } }) }); }
    else await route.continue();
  });
  await page.route(`**/api/knowledge/chunks/${chunkId}/restore`, async route => {
    if (restoreFails) { restoreFails = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: 'Could not restore this fact. Try again.' } }) }); }
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Removed source facts', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Removed source facts', exact: true });
  await expect(drawer.getByRole('alert')).toContainText('Could not load');
  await drawer.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(drawer.getByText('Samples are paid.', { exact: true })).toBeVisible();
  await expect(page.getByText('Foreign company private source passage', { exact: true })).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Restore source fact', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Restore this source fact?', exact: true });
  await confirm.getByRole('button', { name: 'Restore for AI answers', exact: true }).click();
  await expect(confirm.getByRole('alert')).toContainText('Could not restore');
  expect(readAppData().knowledgeBaseChunks!.find(row => row.id === chunkId)?.metadata.supersededBy).toBeTruthy();
  await confirm.getByRole('button', { name: 'Restore for AI answers', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(drawer.getByText('No removed source facts', { exact: true })).toBeVisible();
  expect(readAppData().knowledgeBaseChunks!.find(row => row.id === chunkId)?.metadata.supersededBy).toBeUndefined();
  const foreign = await page.request.put('/api/knowledge/chunks/journey_other_company_private_passage/restore', { data: {}, headers: { origin: new URL(page.url()).origin } });
  expect(foreign.status()).toBe(404);
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/removed-source-fact-restored.png' });
  await page.reload(); await openTabByLabel(page, 'Knowledge Base');
  await page.getByRole('button', { name: 'Removed source facts', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Removed source facts', exact: true }).getByText('No removed source facts', { exact: true })).toBeVisible();
});
