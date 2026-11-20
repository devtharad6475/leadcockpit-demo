import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword } from '@/lib/password';
import type { AppData } from '@/lib/types';
import { E2E_DATA_FILE } from './helpers/data-dir';
import { expectAppShell } from './helpers/login';
import { openTabByLabel } from './helpers/nav';

// Run against production auth and the disposable employee snapshot, never the
// owner's data. No transport credentials are used and no sending is requested.
const company = 'employee_loop_company', password = 'Synthetic-ticket-loop-password!';
let baseline: AppData, passwordHash: string;
const snapshot = (): AppData => JSON.parse(fs.readFileSync(E2E_DATA_FILE, 'utf8'));

async function quiescent() {
  let previous = -1, stable = 0;
  for (let count = 0; count < 50; count++) {
    const modified = fs.statSync(E2E_DATA_FILE).mtimeMs;
    stable = modified === previous && !fs.existsSync(path.join(path.dirname(E2E_DATA_FILE), 'app-data.lock')) ? stable + 1 : 0;
    if (stable >= 5) return;
    previous = modified;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Isolated employee fixture is still being written');
}

test.beforeAll(async () => {
  baseline = JSON.parse(fs.readFileSync(`${E2E_DATA_FILE}.employee-snapshot.json`, 'utf8'));
  passwordHash = await hashPassword(password);
});
test.beforeEach(async () => {
  await quiescent();
  const data = structuredClone(baseline), now = new Date().toISOString();
  data.workspaces.push({ ...data.workspaces[0], id: company, name: 'Employee loop company', ownerUserId: `${company}_owner` });
  for (const role of ['owner', 'admin', 'sales_member', 'viewer'] as const) {
    const id = `${company}_${role}`, email = `${id}@example.invalid`;
    data.users.push({ id, workspaceId: company, email, name: role, role, createdAt: now, updatedAt: now });
    (data.userCredentials ||= []).push({ id: `${id}_credential`, workspaceId: company, userId: id, email, passwordHash, sessionVersion: 1, createdAt: now, updatedAt: now });
    (data.workspaceMembers ||= []).push({ id: `${id}_member`, workspaceId: company, userId: id, email, name: role, role, status: 'active', createdAt: now, updatedAt: now });
  }
  data.leads.push({ ...data.leads[0], id: `${company}_buyer`, workspaceId: company, companyName: 'Synthetic buyer', conversationMemory: undefined });
  fs.writeFileSync(E2E_DATA_FILE, JSON.stringify(data));
});
test.afterEach(async ({ page }) => { await page.close(); await quiescent(); });

async function login(page: Page, role: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(`${company}_${role}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expectAppShell(page);
}
async function post(page: Page, url: string, body: object) {
  return page.evaluate(async ({ url, body }) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, { url, body });
}
async function create(page: Page, subject: string, assignedRole?: string) {
  const response = await post(page, '/api/tickets', { leadId: `${company}_buyer`, subject, description: 'Synthetic customer sample issue', type: 'complaint', priority: 'medium', sourceChannel: 'manual' });
  expect(response.status).toBe(200);
  if (assignedRole) expect((await post(page, `/api/tickets/${response.body.id}/assign`, { assignedTo: `${company}_${assignedRole}` })).status).toBe(200);
  return response.body.id as string;
}

test('personal employee work continues through recorded resolution, owner review and explicit closure', async ({ page, browser }) => {
  await login(page, 'owner');
  const mine = await create(page, 'My synthetic sample issue', 'sales_member');
  await create(page, 'Another employee issue', 'admin');
  await create(page, 'Unassigned customer issue');
  const context = await browser.newContext(), staff = await context.newPage();
  try {
    await login(staff, 'sales_member'); await openTabByLabel(staff, 'Tickets');
    await expect(staff.getByRole('button', { name: /^My assigned work/ })).toBeVisible();
    await expect(staff.getByRole('button', { name: /#.*My synthetic sample issue/ })).toBeVisible();
    await expect(staff.getByRole('button', { name: /#.*Another employee issue/ })).toHaveCount(0);
    await staff.getByLabel('Show', { exact: true }).selectOption('unfinished');
    await staff.getByRole('button', { name: 'Mark resolved', exact: true }).click();
    await staff.getByRole('button', { name: 'Save resolution', exact: true }).click();
    await expect(staff.getByRole('alert').filter({ hasText: 'Please explain the outcome' })).toBeVisible();
    await staff.getByLabel('Outcome and follow-up', { exact: true }).fill('Replacement sample checked. Owner must review the customer follow-up.');
    await staff.getByRole('button', { name: 'Save resolution', exact: true }).click();
    await expect(staff.getByText('This ticket is done', { exact: true })).toBeVisible();
    await expect(staff.getByText(/no longer matches your work view/)).toBeVisible();
    await expect(staff.getByText('Replacement sample checked. Owner must review the customer follow-up.', { exact: false }).last()).toBeVisible();
    expect(snapshot().tickets!.find(ticket => ticket.id === mine)?.status).toBe('resolved');
    await expect(staff.getByLabel('Message for the customer')).toBeVisible();
    await staff.getByLabel('Message for the customer').fill('Your replacement sample has been checked. Please contact us to arrange the next step.');
    await staff.getByRole('button', { name: 'Save customer follow-up draft', exact: true }).click();
    await expect(staff.getByText('Draft saved for owner review. No customer message has been sent.', { exact: true })).toBeVisible();
    await staff.reload(); await openTabByLabel(staff, 'Tickets');
    await expect(staff.getByLabel('Message for the customer')).toHaveValue('Your replacement sample has been checked. Please contact us to arrange the next step.');
    await staff.getByLabel('Message for the customer').fill('The replacement sample is ready for your review.');
    await staff.getByRole('button', { name: 'Save customer follow-up draft', exact: true }).click();
    await expect(staff.getByRole('button', { name: 'Replace draft', exact: true })).toBeVisible();
    await staff.getByRole('button', { name: 'Replace draft', exact: true }).click();
    await expect(staff.getByText('Draft saved for owner review. No customer message has been sent.', { exact: true })).toBeVisible();
    await page.reload(); await openTabByLabel(page, 'Tickets');
    await page.getByRole('button', { name: /#.*My synthetic sample issue/ }).click();
    await expect(page.getByText('By sales_member', { exact: true }).last()).toBeVisible();
    await expect(page.getByLabel('Message for the customer')).toHaveValue('The replacement sample is ready for your review.');
    await expect(page.getByRole('button', { name: 'Review customer reply', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Review customer reply', exact: true }).click();
    await expect(page.getByText('Team follow-up draft', { exact: true })).toBeVisible();
    await expect(page.getByText('Ticket context', { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: /^Edit the WhatsApp reply for/ })).toHaveValue('The replacement sample is ready for your review.');
    await expect(page.getByText('AI draft', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Needs review', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Dismissed', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Approved, not delivered', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: 'docs/system-workflow/readiness-proof/owner-team-followup-review.png' });
    await openTabByLabel(page, 'Tickets');
    await page.getByRole('button', { name: /#.*My synthetic sample issue/ }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByLabel('Outcome and follow-up', { exact: true }).fill('Internal issue complete. Customer message saved for separate review.');
    await page.getByRole('button', { name: 'Confirm close', exact: true }).click();
    await expect.poll(() => snapshot().tickets!.find(ticket => ticket.id === mine)?.status).toBe('closed');
    await page.getByRole('button', { name: 'Reopen', exact: true }).click();
    await page.getByLabel('Reason for reopening', { exact: true }).fill('Customer asked for another sample check.');
    await page.getByRole('button', { name: 'Confirm reopen', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Start working', exact: true })).toBeVisible();
    await page.screenshot({ path: 'docs/system-workflow/readiness-proof/employee-work-loop.png' });
  } finally { await context.close(); }
});

test('read-only colleague can inspect the issue and history without editable ticket controls', async ({ page, browser }) => {
  await login(page, 'owner'); await create(page, 'Viewer inspection issue', 'sales_member');
  const context = await browser.newContext(), viewer = await context.newPage();
  try {
    await login(viewer, 'viewer'); await openTabByLabel(viewer, 'Tickets');
    await expect(viewer.getByText('View only', { exact: true })).toBeVisible();
    await expect(viewer.getByText('Synthetic customer sample issue', { exact: true })).toBeVisible();
    for (const name of ['New ticket', 'Start working', 'Mark resolved']) await expect(viewer.getByRole('button', { name, exact: true })).toHaveCount(0);
    await expect(viewer.getByLabel('Who is handling this')).toHaveCount(0);
    expect((await post(viewer, '/api/tickets', { subject: 'Forbidden', type: 'complaint', priority: 'medium', sourceChannel: 'manual' })).status).toBe(403);
    await viewer.screenshot({ path: 'docs/system-workflow/readiness-proof/employee-view-only.png' });
  } finally { await context.close(); }
});

test('customer draft load failure is visible and retry returns the persisted outcome', async ({ page }) => {
  await login(page, 'owner'); const id = await create(page, 'Customer follow-up recovery');
  expect((await post(page, `/api/tickets/${id}/status`, { toStatus: 'resolved', note: 'Issue corrected. Follow-up needs review.' })).status).toBe(200);
  let fail = true;
  await page.route(`**/api/tickets/${id}/closure-draft`, route => fail && route.request().method() === 'GET' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: 'Customer follow-up temporarily unavailable' } }) }) : route.continue());
  await openTabByLabel(page, 'Tickets');
  await expect(page.getByRole('alert').filter({ hasText: 'Customer follow-up temporarily unavailable' })).toBeVisible();
  fail = false; await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByLabel('Message for the customer')).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Customer follow-up temporarily unavailable' })).toHaveCount(0);
});

test('owner hands unfinished work to a named colleague before reducing employee access', async ({ page }) => {
  await login(page, 'owner');
  const id = await create(page, 'Departure handover issue', 'sales_member');
  await openTabByLabel(page, 'Workspace');
  await page.getByRole('tab', { name: 'Team', exact: true }).click();
  await page.getByRole('button', { name: 'Change access for sales_member', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Viewer', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Team & Invites' }).getByRole('alert')).toBeVisible();
  expect(snapshot().workspaceMembers!.find(member => member.userId === `${company}_sales_member`)?.role).toBe('sales_member');
  await page.getByRole('button', { name: 'Hand over 1 ticket', exact: true }).click();
  await expect(page.getByText('Hand over work from sales_member', { exact: true })).toBeVisible();
  await page.getByLabel('Who is handling this').selectOption(`${company}_admin`);
  await expect(page.getByText('No unfinished tickets left to hand over', { exact: true })).toBeVisible();
  await expect(page.getByText(/no longer matches your work view/)).toBeVisible();
  expect(snapshot().tickets!.find(ticket => ticket.id === id)?.assignedTo).toBe(`${company}_admin`);
  await page.getByRole('button', { name: 'Return to team', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Team', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: 'Team & Invites' })).toBeVisible();
  await page.getByRole('button', { name: 'Change access for sales_member', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Viewer', exact: true }).click();
  await expect(page.getByText('sales_member is now Viewer.', { exact: false })).toBeVisible();
  expect(snapshot().workspaceMembers!.find(member => member.userId === `${company}_sales_member`)?.role).toBe('viewer');
  expect(snapshot().tickets!.find(ticket => ticket.id === id)?.assignedTo).toBe(`${company}_admin`);
});
