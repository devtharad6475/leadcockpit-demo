import { test, expect } from '@playwright/test';
import { loginDemo } from './helpers/login';
import { openTabByLabel } from './helpers/nav';
import { restoreDemoData, waitForServerQuiescent } from './helpers/demo-data-snapshot';
import { readAppData } from './helpers/app-data';
import type { Campaign, ICP } from '../src/lib/types';
import fs from 'node:fs';
import { E2E_DATA_FILE } from './helpers/data-dir';
import type { AppData } from '../src/lib/types';

// All mutations use the configuration's disposable JSON company; provider
// keys and outbound send tokens are blank. Error injection exercises recovery,
// while successful saves below use the real application API.
test.beforeEach(async ({ page }) => {
  restoreDemoData();
  await waitForServerQuiescent();
  await loginDemo(page);
});

test('Assistant previews a previous answer revision, saves only approval and survives refresh', async ({ page }) => {
  const data = readAppData() as AppData;
  const answer = data.knowledgeQuestionAnswers!.find(item => item.workspaceId === 'workspace_demo' && item.answer?.trim())!;
  expect(answer).toBeTruthy();
  const original = 'we make zari thread n also trade laces, only b2b';
  const clean = 'The company manufactures zari thread and also trades laces. It sells to businesses only.';
  Object.assign(answer, { answer: original, answerStatus: 'answered', isUserApproved: true, sourceSnippet: original });
  const marker = `${answer.domainKey}/${answer.questionKey}`;
  const time = new Date().toISOString();
  const conversationId = 'revision_browser_trial';
  data.ownerCopilotConversations = [{ id: conversationId, workspaceId: 'workspace_demo', ownerUserId: 'user_owner', clarifyBatchCount: 0, createdAt: time, updatedAt: time }];
  data.ownerCopilotMessages = [{ id: 'revision_preview', conversationId, workspaceId: 'workspace_demo', role: 'copilot', kind: 'copilot_question', language: 'en', tier: 'T1', createdAt: time,
    text: `Currently saved: "${original}"\n\nSuggested wording: "${clean}"\n\nPlease check that the meaning is unchanged. Nothing has changed yet; the next question can wait.`,
    pendingAction: { intent: 'confirm_setup_answer', entityType: 'knowledge_answer_confirm', entityId: marker,
      proposal: { answer: clean, ownerWords: original, previousAnswer: original, revision: true, askedMarker: marker } } }];
  const replacement = `${E2E_DATA_FILE}.revision-fixture`;
  fs.writeFileSync(replacement, JSON.stringify(data));
  const deadline = Date.now() + 1500;
  for (;;) { try { fs.renameSync(replacement, E2E_DATA_FILE); break; } catch (error) {
    if (!['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code || '') || Date.now() >= deadline) throw error;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  } }
  await page.reload();
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save revised answer', exact: true })).toBeVisible();
  expect((readAppData() as AppData).knowledgeQuestionAnswers!.find(item => item.id === answer.id)?.answer).toBe(original);
  await page.screenshot({ path: 'test-results/assistant-revision-preview.png', fullPage: true });
  await page.getByRole('button', { name: 'Save revised answer', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Conversation', exact: true }).getByText(/Saved under/)).toBeVisible();
  const saved = (readAppData() as AppData).knowledgeQuestionAnswers!.find(item => item.id === answer.id)!;
  expect(saved.answer).toBe(clean);
  expect(saved.sourceSnippet).toBe(original);
  await page.reload();
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Conversation', exact: true }).getByText(/Saved under/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save revised answer', exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/assistant-revision-saved.png', fullPage: true });
});

test('Analytics shows exact source records and opens the correct customer', async ({ page }) => {
  const data = readAppData() as AppData;
  const campaign = data.campaigns[0];
  const prospects = data.leads.filter(item => item.campaignId === campaign.id && item.workspaceId === campaign.workspaceId);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openTabByLabel(page, 'Analytics');
  await expect(page.getByLabel('Campaign to review')).toHaveValue(campaign.id);
  await expect(page.getByRole('button', { name: `Prospects found: ${prospects.length} — view records`, exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/analytics-overview.png', fullPage: true });
  await page.getByRole('button', { name: `Prospects found: ${prospects.length} — view records`, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Prospects found', exact: true });
  await expect(drawer.getByText(`Showing 1–${prospects.length} of ${prospects.length} matching records.`)).toBeVisible();
  await page.screenshot({ path: 'test-results/analytics-sources.png', fullPage: true });
  const named = prospects.find(item => item.companyName === 'Aarna Bridal Studio')!;
  await drawer.getByRole('listitem').filter({ hasText: named.companyName }).getByRole('button', { name: 'Open customer', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: named.companyName, exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Back to campaign results', exact: true }).click();
  await expect(page.getByLabel('Campaign to review')).toHaveValue(campaign.id);
  expect(errors).toEqual([]);
});

test('Analytics explains conversion, reply records and separates saved lessons', async ({ page }) => {
  const data = readAppData() as AppData;
  const campaign = data.campaigns[0];
  const prospects = data.leads.filter(item => item.campaignId === campaign.id);
  const qualified = prospects.filter(item => ['mql', 'sql', 'hot_lead', 'won'].includes(item.status));
  await openTabByLabel(page, 'Analytics');
  await page.getByRole('tab', { name: 'Sales progress', exact: true }).click();
  await page.getByRole('button', { name: `Conversion rate: ${Math.round(qualified.length / prospects.length * 100)}% — view records`, exact: true }).click();
  await expect(page.getByText(`${qualified.length} qualifying prospects out of ${prospects.length} total prospects.`)).toBeVisible();
  await page.getByRole('button', { name: 'View all prospects in the calculation', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Prospects found', exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close panel', exact: true }).click();
  await page.getByRole('tab', { name: 'Messages & replies', exact: true }).click();
  const replies = data.replies.filter(item => item.campaignId === campaign.id);
  await page.getByRole('button', { name: `Replies received: ${replies.length} — view records`, exact: true }).click();
  await expect(page.getByRole('dialog').getByText('Saved reply records, not unique customers. Several replies from one customer each count.')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close panel', exact: true }).click();
  await page.getByRole('tab', { name: 'Lessons & next steps', exact: true }).click();
  const learning = data.campaignLearnings.filter(item => item.campaignId === campaign.id).at(-1)!;
  await expect(page.getByText(learning.summary, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Work it out again', exact: true })).toBeEnabled();
});

test('Analytics report and source failures remain distinct from empty results and retry', async ({ page }) => {
  await page.route('**/api/analytics/campaign/*/details', route => route.fulfill({ status: 503, json: { error: { message: 'Sample temporary results failure' } } }));
  await openTabByLabel(page, 'Analytics');
  await expect(page.getByText('Sample temporary results failure', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Prospects found:/ })).toHaveCount(0);
  await page.unroute('**/api/analytics/campaign/*/details');
  await page.getByRole('button', { name: 'Retry results', exact: true }).click();
  await expect(page.getByRole('button', { name: /Prospects found:/ })).toBeVisible();
  await page.route('**/api/analytics/campaign/*/details?*', route => route.fulfill({ status: 503, json: { error: { message: 'Source failure' } } }));
  await page.getByRole('button', { name: /Prospects found:/ }).click();
  await expect(page.getByText('Source records could not be loaded. The result has not been treated as empty.')).toBeVisible();
  await page.unroute('**/api/analytics/campaign/*/details?*');
  await page.getByRole('button', { name: 'Retry source records', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Open customer', exact: true }).first()).toBeVisible();
});

test('Analytics campaign selection and late source reads never mix campaign records', async ({ page, request }) => {
  test.setTimeout(30000);
  // The server uses a disposable JSON fixture outside the checkout.
  expect(E2E_DATA_FILE).toContain('leadcockpit-e2e');
  const data = readAppData() as AppData;
  const original = data.campaigns[0];
  // Use normal repository-backed API writes, so background startup writes
  // cannot replace an out-of-band file fixture with their earlier snapshot.
  const headers = { cookie: 'lc_demo=1' };
  const created = await request.post('/api/campaigns', { headers, data: { icpId: original.icpId, name: 'Second sample campaign' } });
  expect(created.ok()).toBe(true);
  const second = await created.json();
  const customer = await request.post('/api/leads/manual', { headers, data: { companyName: 'Second campaign customer', campaignId: second.id } });
  expect(customer.ok()).toBe(true);
  await page.reload();
  await openTabByLabel(page, 'Analytics');
  await page.getByLabel('Campaign to review').selectOption(original.id);
  await expect(page.getByLabel('Campaign to review')).toHaveValue(original.id);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const waiting = page.waitForRequest(request => request.url().includes(`/api/analytics/campaign/${original.id}/details?`), { timeout: 5000 });
  await page.route(`**/api/analytics/campaign/${original.id}/details?*`, async route => { await held; await route.continue(); });
  await page.getByRole('button', { name: /Prospects found:/ }).click();
  await waiting;
  await page.getByRole('dialog').getByRole('button', { name: 'Close panel', exact: true }).click();
  await page.getByLabel('Campaign to review').selectOption(second.id);
  await expect(page.getByRole('button', { name: 'Prospects found: 1 — view records', exact: true })).toBeVisible();
  release();
  await page.getByRole('button', { name: 'Prospects found: 1 — view records', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('Second campaign customer', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Aarna Bridal Studio', { exact: true })).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Close panel', exact: true }).click();
  await page.getByRole('tab', { name: 'Sales progress', exact: true }).click();
  await page.getByRole('button', { name: 'Hot leads: 0 — view records', exact: true }).click();
  await expect(page.getByText("No records meet this result's criteria for this campaign.", { exact: true })).toBeVisible();
});

test('optional agent guidance keeps role drafts, saves only the selected role and clears on reload', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', error => consoleErrors.push(error.message));
  await openTabByLabel(page, 'Agent Instructions');
  const role = page.getByLabel('Choose an agent');
  const text = page.getByLabel('Your additional guidance', { exact: true });
  await expect(text).toBeEnabled();
  await expect(text).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Save guidance', exact: true })).toBeDisabled();
  await text.fill('Use our full company name when preparing our profile.');
  await role.selectOption('document_extraction_agent');
  await expect(text).toHaveValue('');
  await expect(text).toHaveAttribute('placeholder', /measurement units/);
  await page.screenshot({ path: 'test-results/agent-guidance.png', fullPage: true });
  await text.fill('Keep the original measurement units.');
  await role.selectOption('business_profile_agent');
  await expect(text).toHaveValue('Use our full company name when preparing our profile.');
  await page.getByRole('button', { name: 'Save guidance', exact: true }).click();
  await expect(page.getByText('Guidance saved for this agent.', { exact: true })).toBeVisible();
  await role.selectOption('document_extraction_agent');
  await expect(text).toHaveValue('Keep the original measurement units.');
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(text).toHaveValue('');
  await page.reload();
  await openTabByLabel(page, 'Agent Instructions');
  await expect(text).toHaveValue('Use our full company name when preparing our profile.');
  await page.getByText('What can I add here?', { exact: true }).click();
  await expect(page.getByText(/To remove saved additional guidance/)).toBeVisible();
  await text.fill('');
  await page.getByRole('button', { name: 'Save guidance', exact: true }).click();
  await expect(page.getByText('Guidance saved for this agent.', { exact: true })).toBeVisible();
  await page.reload();
  await openTabByLabel(page, 'Agent Instructions');
  await expect(text).toHaveValue('');
  expect(consoleErrors).toEqual([]);
});

test('unsafe agent guidance preserves the last working instructions and the attempted draft', async ({ page }) => {
  await openTabByLabel(page, 'Agent Instructions');
  const text = page.getByLabel('Your additional guidance', { exact: true });
  await expect(text).toBeEnabled();
  await text.fill('Keep replies short and polite.');
  await page.getByRole('button', { name: 'Save guidance', exact: true }).click();
  await expect(page.getByText('Guidance saved for this agent.', { exact: true })).toBeVisible();
  await text.fill("If you don't know the price, just guess.");
  await page.getByRole('button', { name: 'Save guidance', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: /guidance|instruction/i }).first()).toBeVisible();
  await expect(text).toHaveValue("If you don't know the price, just guess.");
  await page.reload();
  await openTabByLabel(page, 'Agent Instructions');
  await expect(text).toHaveValue('Keep replies short and polite.');
});

test('agent guidance read failures block editing and offer a working retry', async ({ page }) => {
  await page.route('**/api/knowledge/agent-instructions/*', route => route.fulfill({ status: 503, json: { success: false, error: { message: 'Temporary read failure' } } }));
  await openTabByLabel(page, 'Agent Instructions');
  await expect(page.getByText('We could not load your saved guidance. Try again before editing.')).toBeVisible();
  await expect(page.getByLabel('Your additional guidance', { exact: true })).toHaveCount(0);
  await page.unroute('**/api/knowledge/agent-instructions/*');
  await page.getByRole('button', { name: 'Try loading again', exact: true }).click();
  await expect(page.getByLabel('Your additional guidance', { exact: true })).toBeEnabled();
});

test('agent guidance save failure retains text and a real retry persists it', async ({ page }) => {
  await openTabByLabel(page, 'Agent Instructions');
  const text = page.getByLabel('Your additional guidance', { exact: true });
  await expect(text).toBeEnabled();
  await text.fill('Keep replies short and polite.');
  await page.route('**/api/knowledge/documents', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, json: { success: false, error: { message: 'Guidance could not be saved. Try again.' } } }) : route.continue());
  await page.getByRole('button', { name: 'Save guidance', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Guidance could not be saved. Try again.' }).first()).toBeVisible();
  await expect(text).toHaveValue('Keep replies short and polite.');
  await page.unroute('**/api/knowledge/documents');
  await page.getByRole('button', { name: 'Save guidance', exact: true }).click();
  await expect(page.getByText('Guidance saved for this agent.', { exact: true })).toBeVisible();
  await page.reload();
  await openTabByLabel(page, 'Agent Instructions');
  await expect(text).toHaveValue('Keep replies short and polite.');
});

test('Discovery uses the newest plan for the selected customer type regardless of list order', async ({ page }) => {
  const data = readAppData() as { campaigns: Campaign[]; icps: ICP[] };
  const selected = data.icps.find(item => item.status === 'selected') || data.icps[0];
  const base = data.campaigns[0];
  expect(base).toBeTruthy();
  const older = { ...base, id: 'sample_old_plan', icpId: selected.id, name: 'Older sample plan', createdAt: '2020-01-01T00:00:00.000Z', plan: { ...base.plan, searchQueries: ['Older sample search'] } };
  const latest = { ...older, id: 'sample_latest_plan', name: 'Latest sample plan', createdAt: '2026-10-07T00:00:00.000Z', plan: { ...base.plan, searchQueries: ['Latest sample search'] } };
  let ordered = [older, latest];
  await page.route('**/api/campaigns', async route => {
    if (route.request().method() === 'GET') await route.fulfill({ json: ordered });
    else await route.continue();
  });
  for (const entries of [[older, latest], [latest, older]]) {
    ordered = entries;
    await page.reload();
    await openTabByLabel(page, 'Discovery');
    await expect(page.getByText('Latest sample plan', { exact: true })).toBeVisible();
    await expect(page.getByText('Latest sample search', { exact: true })).toBeVisible();
    await expect(page.getByText('Older sample search', { exact: true })).toBeHidden();
  }
});

test('customer drawer separates details and resets its tab for another customer', async ({ page }) => {
  await openTabByLabel(page, 'Leads');
  await page.getByRole('button', { name: 'Show details for Aarna Bridal Studio' }).click();
  await expect(page.getByRole('tab', { name: 'Customer', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Documents', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Generate PDF', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Suggest a next step', exact: true })).toBeHidden();
  await page.getByRole('tab', { name: 'AI guidance', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Suggest a next step', exact: true })).toBeVisible();
  await page.screenshot({ path: 'readiness-proof/nested-customer-tabs-20261007.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Show details for/ }).nth(1).click();
  await expect(page.getByRole('tab', { name: 'Customer', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('product decimal prices persist and unfinished edits need explicit dismissal', async ({ page }) => {
  await openTabByLabel(page, 'Catalogue');
  await page.getByRole('button', { name: 'Add or edit products', exact: true }).click();
  const price = page.getByLabel('Price (number only)', { exact: true }).first();
  await price.fill('');
  await price.pressSequentially('2.5');
  await expect(price).toHaveValue('2.5');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Leave without saving your products?' })).toBeVisible();
  await page.screenshot({ path: 'readiness-proof/nested-product-confirmation-20261007.png' });
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(price).toHaveValue('2.5');
  const unit = page.getByLabel('Price per (kg, piece, metre)', { exact: true }).first();
  await unit.fill('per sample');
  const saved = page.waitForResponse(r => r.url().includes('/api/settings/products') && r.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save products', exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(page.getByText('Unsaved product changes', { exact: true })).toBeHidden();
  await page.keyboard.press('Escape');
  await page.reload();
  await openTabByLabel(page, 'Catalogue');
  await page.getByRole('button', { name: 'Add or edit products', exact: true }).click();
  await expect(price).toHaveValue('2.5');
  await expect(unit).toHaveValue('per sample');
  // A free sample and an unknown price are different business facts.
  // Exercise actual writes and fresh reads, not the editor's setter names.
  for (const amount of ['0', '']) {
    await price.fill(amount);
    const stored = page.waitForResponse(r => r.url().includes('/api/settings/products') && r.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Save products', exact: true }).click();
    expect((await stored).ok()).toBe(true);
    await expect(page.getByText('Unsaved product changes', { exact: true })).toBeHidden();
    await page.keyboard.press('Escape');
    await page.reload();
    await openTabByLabel(page, 'Catalogue');
    await page.getByRole('button', { name: 'Add or edit products', exact: true }).click();
    await expect(price).toHaveValue(amount);
    await expect(unit).toHaveValue('per sample');
  }
  await price.fill('-5');
  let writes = 0;
  page.on('request', r => { if (r.url().includes('/api/settings/products') && r.method() === 'PUT') writes++; });
  await page.getByRole('button', { name: 'Save products', exact: true }).click();
  await expect(page.getByText(/Enter a valid price of zero or more/)).toBeVisible();
  expect(writes).toBe(0);
  await page.getByRole('button', { name: /^Remove / }).first().click();
  await expect(page.getByRole('dialog', { name: 'Remove this product from the list?' })).toBeVisible();
  await page.getByRole('button', { name: 'Keep product', exact: true }).click();
  await expect(price).toHaveValue('-5');
});

test('saving one settings section preserves edits in another', async ({ page }) => {
  await openTabByLabel(page, 'Settings');
  const minimum = page.getByLabel('Default minimum order', { exact: true });
  await minimum.fill('Unfinished minimum order');
  await page.getByRole('button', { name: 'Policies', exact: true }).click();
  await page.getByRole('textbox', { name: 'Payment policy', exact: true }).fill('Sample policy: payment before dispatch');
  const saved = page.waitForResponse(r => r.url().includes('/api/settings/policy') && r.request().method() === 'PUT');
  await page.getByRole('button', { name: /Save policies/i }).click();
  expect((await saved).ok()).toBe(true);
  await page.getByRole('button', { name: 'Selling rules', exact: true }).click();
  await expect(minimum).toHaveValue('Unfinished minimum order');
  await page.reload();
  await openTabByLabel(page, 'Settings');
  await page.getByRole('button', { name: 'Policies', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Payment policy', exact: true })).toHaveValue('Sample policy: payment before dispatch');
});

test('failed settings loads cannot be saved as empty defaults and can retry', async ({ page }) => {
  let fail = true;
  await page.route('**/api/settings/policy', async route => {
    if (fail && route.request().method() === 'GET') await route.fulfill({ status: 503, json: { success: false, error: { code: 'TEST_UNAVAILABLE', message: 'Settings temporarily unavailable' } } });
    else await route.continue();
  });
  await openTabByLabel(page, 'Settings');
  await expect(page.getByText(/Couldn't load/)).toBeVisible();
  await expect(page.getByLabel('Default minimum order', { exact: true })).toBeHidden();
  fail = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByLabel('Default minimum order', { exact: true })).toBeVisible();
});

test('changing backup files requires a new confirmation without restoring anything', async ({ page }) => {
  await openTabByLabel(page, 'Export / Backup');
  const file = page.locator('input[type=file]');
  await file.setInputFiles({ name: 'first.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await page.getByLabel('Type RESTORE to confirm', { exact: true }).fill('RESTORE');
  await expect(page.getByRole('button', { name: 'Restore this workspace', exact: true })).toBeEnabled();
  await file.setInputFiles({ name: 'second.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await expect(page.getByText('second.json', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Type RESTORE to confirm', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Restore this workspace', exact: true })).toBeDisabled();
});

test('pending order save locks the form; failure keeps the entered order', async ({ page }) => {
  await openTabByLabel(page, 'Quotes & Orders');
  await page.getByRole('button', { name: 'New order', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'New order', exact: true });
  await modal.getByLabel(/Product \/ item name/).fill('Sample precision component');
  await modal.getByLabel('Quantity', { exact: false }).fill('3');
  await modal.getByLabel(/Unit price/).fill('12.5');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/orders', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    await held;
    await route.fulfill({ status: 503, json: { success: false, error: { code: 'TEST_UNAVAILABLE', message: 'Order temporarily unavailable' } } });
  });
  try {
    await modal.getByRole('button', { name: /Create order|Save order/ }).click();
    await expect(modal.getByLabel(/Product \/ item name/)).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(modal).toBeVisible();
  } finally { release(); }
  await expect(modal.getByRole('alert')).toContainText('Order temporarily unavailable');
  await expect(modal.getByLabel(/Product \/ item name/)).toHaveValue('Sample precision component');
  await expect(modal.getByLabel(/Product \/ item name/)).toBeEnabled();
});

test('a resolved policy conflict updates its form without wiping another policy draft', async ({ page }) => {
  await openTabByLabel(page, 'Settings');
  await page.getByRole('button', { name: 'Policies', exact: true }).click();
  await page.getByRole('textbox', { name: 'Credit policy', exact: true }).fill('Unfinished credit policy');
  await page.getByRole('button', { name: /Needs your decision/ }).click();
  const saved = page.waitForResponse(r => r.url().includes('/api/settings/conflicts/conflict_demo_1/resolve'));
  await page.getByRole('button', { name: 'Use theirs', exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(page.getByText('Decision saved.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Policies', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Payment policy', exact: true })).toHaveValue('50% advance, balance before dispatch');
  await expect(page.getByRole('textbox', { name: 'Credit policy', exact: true })).toHaveValue('Unfinished credit policy');
  await page.getByRole('button', { name: 'Save policies', exact: true }).click();
  await expect(page.getByText('Policies saved.', { exact: false })).toBeVisible();
  await page.reload();
  await openTabByLabel(page, 'Settings');
  await page.getByRole('button', { name: 'Policies', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Payment policy', exact: true })).toHaveValue('50% advance, balance before dispatch');
});

test('support conversation failures retry and reply drafts stay with their own tickets', async ({ page }) => {
  for (const subject of ['Sample ticket A', 'Sample ticket B']) {
    const result = await page.request.post('/api/platform-tickets', { data: { subject, description: 'Synthetic test issue', category: 'bug', priority: 'medium' } });
    expect(result.ok()).toBe(true);
  }
  let fail = true;
  await page.route('**/api/platform-tickets/*/events', async route => {
    if (fail) await route.fulfill({ status: 503, json: { success: false, error: { code: 'TEST_UNAVAILABLE', message: 'Conversation temporarily unavailable' } } });
    else await route.continue();
  });
  await openTabByLabel(page, 'Help & Support');
  await page.getByRole('button', { name: /Sample ticket A/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Conversation temporarily unavailable' })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Try conversation again', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Try conversation again', exact: true })).toBeHidden();
  const reply = page.getByLabel('Add a reply', { exact: true });
  await reply.fill('Unfinished answer for ticket A');
  await page.getByRole('button', { name: /Sample ticket B/ }).click();
  await expect(reply).toHaveValue('');
  await reply.fill('Unfinished answer for ticket B');
  await page.getByRole('button', { name: /Sample ticket A/ }).click();
  await expect(reply).toHaveValue('Unfinished answer for ticket A');
});

test('business answers stay with their own information area when skipping and returning', async ({ page }) => {
  await openTabByLabel(page, 'Questions from AI');
  const answer = page.getByRole('textbox', { name: 'Add this business detail once', exact: true });
  await expect(answer).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save and next', exact: true })).toBeDisabled();
  await answer.fill('Unfinished first area answer');
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(answer).toHaveValue('');
  await answer.fill('Unfinished second area answer');
  await page.getByRole('button', { name: /^Open questions about/ }).first().click();
  await expect(answer).toHaveValue('Unfinished first area answer');
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(answer).toHaveValue('Unfinished second area answer');
});

test('all pending reviews are reachable and failed review reads show a retry', async ({ page }) => {
  for (let n = 1; n <= 4; n++) {
    const saved = await page.request.post('/api/settings/pending-drafts', { data: {
      workspaceId: 'workspace_demo', kind: 'structured', sourceTitle: `Sample pending review ${n}`,
      sourceAnswer: 'Sample payment facts', policy: { paymentPolicy: 'Payment before dispatch' },
      fields: ['paymentPolicy'],
    } });
    expect(saved.ok()).toBe(true);
  }
  await openTabByLabel(page, 'Questions from AI');
  await page.getByRole('button', { name: 'Show all 4 pending reviews', exact: true }).click();
  for (let n = 1; n <= 4; n++) await expect(page.getByText(`Sample pending review ${n}`, { exact: true })).toBeVisible();
  await openTabByLabel(page, 'Catalogue');
  let fail = true;
  await page.route('**/api/settings/pending-drafts', async route => {
    if (fail && route.request().method() === 'GET') await route.fulfill({ status: 503, json: { success: false, error: { code: 'TEST_UNAVAILABLE', message: 'Pending reviews unavailable' } } });
    else await route.continue();
  });
  await openTabByLabel(page, 'Questions from AI');
  await expect(page.getByText(/Couldn't load/)).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show all 4 pending reviews', exact: true })).toBeVisible();
});

test('knowledge answer drafts survive other answer editors and require deliberate cancellation', async ({ page }) => {
  await openTabByLabel(page, 'Knowledge Base');
  const editors = page.getByRole('button', { name: /^Edit the answer to:/ });
  await expect(editors.first()).toBeVisible();
  await editors.first().click();
  const firstEditor = page.getByRole('textbox', { name: /^Answer:/ });
  const firstName = await firstEditor.getAttribute('aria-label');
  await firstEditor.fill('Unfinished sample knowledge answer');
  await editors.nth(1).click();
  await expect(page.getByRole('textbox', { name: firstName!, exact: true })).toBeHidden();
  await editors.first().click();
  await expect(page.getByRole('textbox', { name: firstName!, exact: true })).toHaveValue('Unfinished sample knowledge answer');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Discard this unfinished answer?', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByRole('textbox', { name: firstName!, exact: true })).toHaveValue('Unfinished sample knowledge answer');
});

test('a saved conflict with a failed refresh retries its read without resolving twice', async ({ page }) => {
  await openTabByLabel(page, 'Settings');
  await expect(page.getByLabel('Default minimum order', { exact: true })).toBeVisible();
  let fail = true;
  let decisions = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/conflicts/conflict_demo_1/resolve')) decisions++; });
  await page.route('**/api/settings/policy', async route => {
    if (fail && route.request().method() === 'GET') await route.fulfill({ status: 503, json: { success: false, error: { code: 'TEST_UNAVAILABLE', message: 'Saved policy temporarily unavailable' } } });
    else await route.continue();
  });
  await page.getByRole('button', { name: /Needs your decision/ }).click();
  await page.getByRole('button', { name: 'Use theirs', exact: true }).click();
  await expect(page.getByText(/Your decision was saved, but its updated value could not be loaded/)).toBeVisible();
  await page.getByRole('button', { name: 'Policies', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save policies', exact: true })).toBeDisabled();
  fail = false;
  await page.getByRole('button', { name: 'Retry saved decision', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Payment policy', exact: true })).toHaveValue('50% advance, balance before dispatch');
  await expect(page.getByRole('button', { name: 'Save policies', exact: true })).toBeEnabled();
  expect(decisions).toBe(1);
});

test('unsaved company details cannot be lost by marking the old profile as correct', async ({ page }) => {
  const profile = readAppData().businessProfiles.find((item: { workspaceId: string }) => item.workspaceId === 'workspace_demo');
  // Approval is a legitimate starting state in the shared demo. Explicitly
  // prepare the unapproved state whose action this test exercises.
  const prepared = await page.request.put(`/api/business-profile/${profile.id}`, { data: { status: 'draft' } });
  expect(prepared.ok()).toBe(true);
  await page.reload();
  await openTabByLabel(page, 'Profile');
  await expect(page.getByRole('button', { name: 'Mark as correct', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'City', exact: true }).fill('Unfinished company city');
  await expect(page.getByRole('button', { name: 'Mark as correct', exact: true })).toBeDisabled();
  await expect(page.getByText(/You have unsaved company details/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'City', exact: true })).toHaveValue('Unfinished company city');
});

test('filtering replies switches the active customer and ignores the old delayed summary', async ({ page }) => {
  const data = readAppData() as { leads: Array<{ id: string; companyName: string }>; autoReplyLogs: Array<Record<string, unknown>> };
  const customerA = data.leads.find(lead => lead.companyName === 'Zayna Wedding Couture')!;
  const customerB = data.leads.find(lead => lead.companyName === 'Meera Ethnic Wear')!;
  const logs = [customerA, customerB].map((lead, index) => ({ ...data.autoReplyLogs[0], id: `sample_log_${index}`, leadId: lead.id,
    incomingMessage: `Sample question for ${lead.companyName}`, createdAt: index === 0 ? '2026-10-07T10:00:00.000Z' : '2026-10-07T09:00:00.000Z' }));
  await page.route('**/api/auto-reply-logs', route => route.fulfill({ json: logs }));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/leads/*/conversation-summary', async route => {
    const old = route.request().url().includes(customerA.id);
    if (old) await held;
    await route.fulfill({ json: { summary: old ? 'Delayed summary belonging to customer A' : 'Current summary belonging to customer B', mode: 'fallback' } });
  });
  await page.reload();
  await openTabByLabel(page, 'Replies');
  try {
    await expect(page.getByRole('button', { name: 'View full profile for Zayna Wedding Couture', exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Search replies by message text or company name', exact: true }).fill('Meera');
    await expect(page.getByRole('button', { name: 'View full profile for Meera Ethnic Wear', exact: true })).toBeVisible();
    await expect(page.getByText('Current summary belonging to customer B', { exact: true })).toBeVisible();
    const oldResponse = page.waitForResponse(r => r.url().includes(customerA.id) && r.url().endsWith('/conversation-summary'));
    release();
    await oldResponse;
    await expect(page.getByText('Delayed summary belonging to customer A', { exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: 'View full profile for Meera Ethnic Wear', exact: true })).toBeVisible();
  } finally { release(); }
});

test('Assistant saved-conversation failures can retry without a blank dead end', async ({ page }) => {
  let fail = true;
  await page.route('**/api/copilot/conversations?list=1', async route => {
    if (fail) await route.fulfill({ status: 503, json: { success: false, error: { code: 'TEST_UNAVAILABLE', message: 'Saved conversations temporarily unavailable' } } });
    else await route.continue();
  });
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Saved conversations temporarily unavailable' })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Try conversations again', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Try conversations again', exact: true })).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Message your assistant', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Your AI team', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});
