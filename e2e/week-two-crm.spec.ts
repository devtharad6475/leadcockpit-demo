import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { loginDemo } from './helpers/login';
import { openTabByLabel } from './helpers/nav';
import { restoreDemoData, waitForServerQuiescent } from './helpers/demo-data-snapshot';
import { E2E_DATA_FILE } from './helpers/data-dir';
import { E2E_TARGET } from './helpers/e2e-target';
import { readAppData as readSnapshot } from './helpers/app-data';
import type { AppData } from '@/lib/types';

const readAppData = (): AppData => readSnapshot();

const headers = { cookie: 'lc_demo=1' };
test.beforeEach(async () => {
  test.skip(E2E_TARGET !== 'json', 'Controlled fixtures use only disposable JSON.');
  // Drain requests from the preceding browser before replacing its fixture.
  // Restoring first lets an in-flight JSON snapshot write the old fixture back.
  await waitForServerQuiescent();
  restoreDemoData();
  await waitForServerQuiescent();
});
test.afterEach(async ({ page }) => { await page.close(); await waitForServerQuiescent(); });
function fixture(change: (data: ReturnType<typeof readAppData>) => void) {
  const data = readAppData(); change(data);
  fs.writeFileSync(E2E_DATA_FILE, JSON.stringify(data));
}
async function openCustomer(page: Page, name: string) {
  await openTabByLabel(page, 'Leads');
  await page.getByRole('button', { name: `More actions for ${name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'View details', exact: true }).click();
  await expect(page.getByTestId('reminders')).toBeVisible();
}

test('bulk approval reports eligible and permanently blocked buyers separately, persisting after refresh', async ({ page, request }) => {
  fixture(data => {
    const seed = data.leads.find(l => l.id === 'lead_review')!;
    data.leads.push({ ...seed, id: 'week_two_blocked', companyName: 'Blocked Loom Buyer', phone: '+910000000001', whatsappNumber: '+910000000002', reviewStatus: 'pending', status: 'needs_review', doNotContact: false });
    (data.doNotContactRegistry ||= []).push({ id: 'week_two_dnc', workspaceId: 'workspace_demo', normalizedPhone: '+910000000001', reason: 'Owner opt-out fixture', createdAt: new Date().toISOString() });
  });
  await loginDemo(page); await openTabByLabel(page, 'Lead Review');
  const name = readAppData().leads.find(l => l.id === 'lead_review')!.companyName;
  await page.getByRole('checkbox', { name: `Select ${name} for bulk action`, exact: true }).check();
  await page.getByRole('checkbox', { name: 'Select Blocked Loom Buyer for bulk action', exact: true }).check();
  await page.getByRole('button', { name: 'Approve selected', exact: true }).click();
  const resultWait = page.waitForResponse(r => new URL(r.url()).pathname === '/api/leads/bulk-approve');
  await page.getByRole('dialog').getByRole('button', { name: 'Approve', exact: true }).click();
  const result = await (await resultWait).json();
  expect(result.leads).toHaveLength(1); expect(result.skipped).toHaveLength(1);
  await expect(page.getByText('1 buyer approved; 1 skipped.', { exact: true })).toBeVisible();
  await expect(page.getByText(/Blocked Loom Buyer: Cannot approve a do-not-contact lead/)).toBeVisible();
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/week-two-bulk-result.png' });
  await page.reload(); await openTabByLabel(page, 'Lead Review');
  expect(readAppData().leads.find(l => l.id === 'lead_review')!.reviewStatus).toBe('approved');
  expect(readAppData().leads.find(l => l.id === 'week_two_blocked')!.reviewStatus).toBe('pending');
  const repeated = await request.post('/api/leads/bulk-approve', { headers, data: { ids: ['week_two_blocked', 'deleted-buyer'] } });
  const body = await repeated.json(); expect(body.leads).toHaveLength(0); expect(body.skipped).toHaveLength(2);
});

test('CSV import explains duplicate and blocked rows and repeated uploads do not duplicate buyers', async ({ page }) => {
  fixture(data => (data.doNotContactRegistry ||= []).push({ id: 'csv_dnc', workspaceId: 'workspace_demo', normalizedEmail: 'blocked@week-two.example', reason: 'Opt-out fixture', createdAt: new Date().toISOString() }));
  await loginDemo(page); await openTabByLabel(page, 'Discovery');
  const csv = 'company_name,email,city,country\nWeek Two Safe Loom,buyer@week-two.example,Surat,India\nWeek Two Blocked Loom,blocked@week-two.example,Surat,India\nWeek Two Safe Loom,buyer@week-two.example,Surat,India\n';
  const file = { name: 'week-two-buyers.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) };
  const upload = page.locator('input[type=file][accept=".csv,text/csv"]');
  const firstWait = page.waitForResponse(r => new URL(r.url()).pathname === '/api/leads/upload-csv');
  await upload.setInputFiles(file); const first = await (await firstWait).json();
  expect(first.created).toBe(1); expect(first.duplicatesSkipped).toBe(1); expect(first.doNotContactSkipped).toBe(1);
  await expect(page.getByText('Do not contact — skipped', { exact: true })).toBeVisible();
  const secondWait = page.waitForResponse(r => new URL(r.url()).pathname === '/api/leads/upload-csv');
  await upload.setInputFiles(file); const second = await (await secondWait).json();
  expect(second.created).toBe(0); expect(second.duplicatesSkipped).toBe(2); expect(second.doNotContactSkipped).toBe(1);
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/week-two-csv-result.png' });
  await page.reload(); await openTabByLabel(page, 'Leads');
  await expect(page.getByText('Week Two Safe Loom', { exact: true }).first()).toBeVisible();
  expect(readAppData().leads.filter(l => l.companyName === 'Week Two Safe Loom')).toHaveLength(1);
  expect(readAppData().leads.some(l => l.companyName === 'Week Two Blocked Loom')).toBe(false);
});

test('explicit missing or foreign target cannot silently create a campaign for another audience', async ({ request }) => {
  const before = readAppData().campaigns.length;
  const response = await request.post('/api/campaigns', { headers, data: { name: 'Stale audience campaign', icpId: 'icp_no_longer_available' } });
  expect(response.status()).toBe(400); expect((await response.json()).error.message).toContain('Select it again');
  expect(readAppData().campaigns.length).toBe(before);
});

test('customer reminder create, refresh, complete and remove keep the earliest open date accurate', async ({ page }) => {
  const lead = readAppData().leads.find(l => l.id === 'lead_hot')!;
  await loginDemo(page); await openCustomer(page, lead.companyName!);
  const panel = page.getByTestId('reminders');
  const firstDay = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const laterDay = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  for (const [note, day] of [['Call about sample availability', firstDay], ['Check catalogue interest', laterDay]]) {
    await panel.getByRole('textbox', { name: 'What to do', exact: true }).fill(note);
    await panel.getByLabel('When', { exact: true }).fill(day);
    const saved = page.waitForResponse(r => new URL(r.url()).pathname === `/api/leads/${lead.id}/follow-ups` && r.request().method() === 'POST');
    await panel.getByRole('button', { name: 'Remind me', exact: true }).click(); expect((await saved).ok()).toBe(true);
    await expect(panel.getByText(note, { exact: true })).toBeVisible();
  }
  expect(readAppData().leads.find(l => l.id === lead.id)!.nextFollowUpAt).toContain(firstDay);
  await page.reload(); await openCustomer(page, lead.companyName!);
  const first = panel.locator('li').filter({ hasText: 'Call about sample availability' });
  await first.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(first).toHaveCount(0);
  expect(readAppData().leads.find(l => l.id === lead.id)!.nextFollowUpAt).toContain(laterDay);
  await panel.locator('li').filter({ hasText: 'Check catalogue interest' }).getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(panel.getByText('No reminders.', { exact: true })).toBeVisible();
  expect(readAppData().leads.find(l => l.id === lead.id)!.nextFollowUpAt).toBeFalsy();
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/week-two-reminders.png' });
});

test('reminder request failure stays visible without saving a reminder', async ({ page }) => {
  const lead = readAppData().leads.find(l => l.id === 'lead_hot')!;
  await loginDemo(page); await openCustomer(page, lead.companyName!);
  await page.route(`**/api/leads/${lead.id}/follow-ups`, route => route.request().method() === 'POST' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'TEMPORARY', message: 'Reminders are temporarily unavailable' } }) }) : route.continue());
  const panel = page.getByTestId('reminders');
  await panel.getByRole('textbox', { name: 'What to do', exact: true }).fill('Call next week');
  await panel.getByLabel('When', { exact: true }).fill(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
  await panel.getByRole('button', { name: 'Remind me', exact: true }).click();
  await expect(panel.getByText('Reminders are temporarily unavailable', { exact: true })).toBeVisible();
  expect((readAppData().followUps || []).some(f => f.note === 'Call next week')).toBe(false);
});

test('failed bulk approval retains the selection for a successful retry', async ({ page }) => {
  await loginDemo(page); await openTabByLabel(page, 'Lead Review');
  const name = readAppData().leads.find(l => l.id === 'lead_review')!.companyName;
  await page.getByRole('checkbox', { name: `Select ${name} for bulk action`, exact: true }).check();
  await page.getByRole('button', { name: 'Approve selected', exact: true }).click();
  let fail = true;
  await page.route('**/api/leads/bulk-approve', route => fail ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'TEMPORARY', message: 'Buyer review is temporarily unavailable' } }) }) : route.continue());
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('Buyer review is temporarily unavailable', { exact: true }).first()).toBeVisible();
  expect(readAppData().leads.find(l => l.id === 'lead_review')!.reviewStatus).toBe('pending');
  await expect(dialog).toBeVisible();
  fail = false;
  const retry = page.waitForResponse(r => new URL(r.url()).pathname === '/api/leads/bulk-approve');
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
  expect((await retry).ok()).toBe(true);
  await expect(page.getByText('1 buyer approved; 0 skipped.', { exact: true })).toBeVisible({ timeout: 30000 });
  expect(readAppData().leads.find(l => l.id === 'lead_review')!.reviewStatus).toBe('approved');
});

test('reviewed buyer can receive a saved sample draft without sending anything', async ({ page }) => {
  fixture(data => { for (const lead of data.leads) if (lead.reviewStatus === 'approved') lead.reviewStatus = 'pending'; });
  await loginDemo(page); await openTabByLabel(page, 'Lead Review');
  await page.getByRole('button', { name: 'Show all leads', exact: true }).click();
  const lead = readAppData().leads.find(l => l.id === 'lead_review')!;
  await page.getByRole('button', { name: `Approve ${lead.companyName} for outreach`, exact: true }).click();
  await expect(page.getByRole('button', { name: `${lead.companyName} is already approved`, exact: true })).toBeVisible({ timeout: 30000 });
  await openTabByLabel(page, 'Messages');
  const before = readAppData().messageTemplates.length;
  const draftWait = page.waitForResponse(r => new URL(r.url()).pathname === '/api/messages/generate');
  await page.getByRole('button', { name: `Draft a WhatsApp message for ${lead.companyName}`, exact: true }).click();
  const draft = await (await draftWait).json();
  expect(draft.status).toBe('draft');
  await expect(page.getByText('Sample draft', { exact: true }).first()).toBeVisible();
  expect(readAppData().messageTemplates).toHaveLength(before + 1);
  expect(readAppData().leads.find(l => l.id === lead.id)!.status).toBe('message_ready');
  await page.reload(); await openTabByLabel(page, 'Messages');
  await expect(page.getByText(draft.body, { exact: true }).first()).toBeVisible();
  expect(readAppData().messageTemplates.find(m => m.id === draft.id)!.status).toBe('draft');
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/week-two-draft.png' });
});

test('an existing draft cannot be approved after a permanent contact block', async ({ page, request }) => {
  fixture(data => {
    const lead = data.leads.find(l => l.id === 'lead_hot')!;
    lead.companyName = 'Blocked Draft Buyer'; lead.doNotContact = false; lead.reviewStatus = 'approved';
    (data.doNotContactRegistry ||= []).push({ id: 'draft_dnc', workspaceId: 'workspace_demo', normalizedPhone: lead.whatsappNumber || lead.phone, reason: 'Customer opted out', createdAt: new Date().toISOString() });
    data.messageTemplates.push({ ...data.messageTemplates[0], id: 'template_week_two_blocked', leadId: lead.id, status: 'draft', body: 'Unsuitable for outreach after opt-out' });
  });
  const refused = await request.post('/api/messages/template_week_two_blocked/approve', { headers, data: {} });
  expect(refused.status()).toBe(409);
  expect(readAppData().messageTemplates.find(m => m.id === 'template_week_two_blocked')!.status).toBe('draft');
  // A record with its visible flag also set has unavailable actions in the UI.
  fixture(data => { data.leads.find(l => l.id === 'lead_hot')!.doNotContact = true; });
  await loginDemo(page); await openTabByLabel(page, 'Messages');
  const card = page.locator('div.rounded-lg.border').filter({ hasText: 'Unsuitable for outreach after opt-out' }).first();
  await expect(card.getByText('Outreach blocked for this buyer. This message is kept for your records.', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
  await expect(card.getByRole('button', { name: 'Copy', exact: true })).toBeDisabled();
});

test('unavailable search is labelled unavailable even when a connection was configured', async ({ page }) => {
  await loginDemo(page); await openTabByLabel(page, 'Discovery');
  // Controlled server-result fixture verifies presentation; live search is excluded.
  await page.route('**/api/leads/discover', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'completed', mode: 'search_unavailable', modeLabel: 'Search failed; no new buyers found', providerStatus: { serpApiConfigured: true, provider: 'serpapi' }, queries: [], leads: [], newLeadIds: [], created: 0, updated: 0, duplicatesAvoided: 0, scrapedWebsites: 0, runId: 'presentation-fixture', warnings: ['Search temporarily unavailable'] }) }));
  await page.getByRole('button', { name: 'Run prospect discovery', exact: true }).click();
  await expect(page.getByText('Search unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText('Live search ready', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Demo mode', { exact: true })).toHaveCount(0);
});

test('campaign plan retains its chosen target through approval and refresh; unapproved outreach is refused', async ({ page, request }) => {
  await loginDemo(page); await openTabByLabel(page, 'Campaign');
  const selected = readAppData().icps.find(i => i.status === 'selected')!;
  const createdWait = page.waitForResponse(r => new URL(r.url()).pathname === '/api/campaigns' && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Make a new plan', exact: true }).click();
  const createdResponse = await createdWait; expect(createdResponse.ok()).toBe(true);
  const campaign = await createdResponse.json(); expect(campaign.icpId).toBe(selected.id);
  expect(campaign.approvalStatus).toBe('needs_review');
  const before = readAppData().messageTemplates.length;
  const refused = await request.post('/api/messages/generate', { headers, data: { leadId: 'lead_hot', campaignId: campaign.id, channel: 'WhatsApp' } });
  const refusal = await refused.json();
  expect(refused.status(), JSON.stringify(refusal)).toBe(409);
  expect(refusal.error.message).toContain('Approve this campaign');
  expect(readAppData().messageTemplates).toHaveLength(before);
  const card = page.locator('div.rounded-lg.border').filter({ hasText: campaign.name }).filter({ has: page.getByRole('button', { name: 'Approve', exact: true }) }).first();
  const approval = page.waitForResponse(r => new URL(r.url()).pathname === `/api/campaigns/${campaign.id}/approve`);
  await card.getByRole('button', { name: 'Approve', exact: true }).click(); expect((await approval).ok()).toBe(true);
  await page.reload(); await openTabByLabel(page, 'Campaign');
  expect(readAppData().campaigns.find(c => c.id === campaign.id)!.approvalStatus).toBe('approved');
  expect(readAppData().campaigns.find(c => c.id === campaign.id)!.icpId).toBe(selected.id);
  await expect(page.getByText(campaign.name, { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/week-two-campaign.png' });
});
