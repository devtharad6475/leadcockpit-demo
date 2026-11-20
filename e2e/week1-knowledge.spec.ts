import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { loginDemo } from './helpers/login';
import { openTabByLabel } from './helpers/nav';
import { restoreDemoData, waitForServerQuiescent } from './helpers/demo-data-snapshot';
import { E2E_DATA_FILE } from './helpers/data-dir';
import { E2E_TARGET } from './helpers/e2e-target';

test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });
const headers = { cookie: 'lc_demo=1' };

test('grouped answer approval, correction and sync preserve the exact owner fact after refresh', async ({ page, request }) => {
  test.skip(E2E_TARGET !== 'json', 'This controlled unapproved-answer fixture belongs to the disposable JSON substrate.');
  const listResponse = await request.get('/api/knowledge/question-answers', { headers });
  expect(listResponse.ok()).toBe(true);
  const list = await listResponse.json();
  const answer = list.find((item: {questionKey:string}) => item.questionKey === 'legal_company_name');
  expect(answer).toBeTruthy();
  // Fixture represents an extracted candidate awaiting owner approval; no product data is touched.
  const data = JSON.parse(fs.readFileSync(E2E_DATA_FILE, 'utf8'));
  const stored = data.knowledgeQuestionAnswers.find((item: {id:string}) => item.id === answer.id);
  Object.assign(stored, { answer: 'Pilot Loom Supplies', answerStatus: 'needs_review', isUserApproved: false, humanReviewRequired: true, confidenceScore: 0.9 });
  fs.writeFileSync(E2E_DATA_FILE, JSON.stringify(data));
  await loginDemo(page);
  await openTabByLabel(page, 'Knowledge Base');
  // Select the real area using its answer rather than depending on presentation names.
  const area = page.locator('aside button').filter({ hasText: /Company facts|Company profile|Factual company/i }).first();
  await area.click();
  await page.getByRole('button', { name: `Approve the answer to: ${answer.question}`, exact: true }).click();
  await expect.poll(async () => (await (await request.get('/api/knowledge/question-answers', { headers })).json()).find((item:{id:string}) => item.id === answer.id).isUserApproved).toBe(true);
  await page.getByRole('button', { name: `Edit the answer to: ${answer.question}`, exact: true }).click();
  await page.getByRole('textbox', { name: `Answer: ${answer.question}`, exact: true }).fill('Pilot Loom Supplies Private Limited');
  const save = page.waitForResponse(r => new URL(r.url()).pathname === `/api/knowledge/question-answers/${answer.id}` && r.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await save).ok()).toBe(true);
  const sync = page.waitForResponse(r => new URL(r.url()).pathname === '/api/knowledge/sync');
  await page.getByRole('button', { name: "Refresh the AI's copy", exact: true }).click();
  const syncResult = await sync;
  expect(syncResult.ok()).toBe(true);
  const summary = await syncResult.json();
  expect(summary.knowledgeBase.synced).toBe(true);
  expect(summary.knowledgeBase.chunks).toBeGreaterThan(0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openTabByLabel(page, 'Knowledge Base');
  await page.locator('aside button').filter({ hasText: /Company facts|Company profile|Factual company/i }).first().click();
  await expect(page.getByText('Pilot Loom Supplies Private Limited', { exact: true }).first()).toBeVisible();
  const persisted = (await (await request.get('/api/knowledge/question-answers', { headers })).json()).find((item:{id:string}) => item.id === answer.id);
  expect(persisted.answer).toBe('Pilot Loom Supplies Private Limited');
  expect(persisted.isUserApproved).toBe(true);
  const search = await request.post('/api/knowledge/search', { headers, data: { query: 'Pilot Loom Supplies Private Limited' } });
  expect(search.ok()).toBe(true);
  expect(JSON.stringify(await search.json())).toContain('Pilot Loom Supplies Private Limited');
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/week1-knowledge-corrected.png' });
});

test('knowledge load failure is visible and Try again restores the actual grouped answers', async ({ page }) => {
  await loginDemo(page);
  let fail = true;
  await page.route('**/api/knowledge/question-answers', route => fail ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success:false,error:{code:'TEMPORARY',message:'Knowledge is temporarily unavailable'} }) }) : route.continue());
  await openTabByLabel(page, 'Knowledge Base');
  await expect(page.getByText("Couldn't load", { exact: true })).toBeVisible();
  await expect(page.getByText('Knowledge is temporarily unavailable', { exact: true })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByTestId('kb-ai-coverage')).toBeVisible();
  await expect(page.locator('aside button').first()).toBeVisible();
});

test('partial sync is described as incomplete and a subsequent real sync recovers', async ({ page }) => {
  await loginDemo(page);
  await openTabByLabel(page, 'Knowledge Base');
  await expect(page.getByTestId('kb-ai-coverage')).toBeVisible();
  await page.route('**/api/knowledge/sync', route => route.fulfill({ contentType:'application/json', body:JSON.stringify({status:'partial',timestamp:'2026-10-03T00:00:00.000Z',profile:{synced:true,chunks:1},settings:{},knowledgeBase:{synced:false,error:'The searchable copy could not be saved'},sourcesIndexed:{indexed:false,documents:1,chunks:2,failed:2},agentsAffected:[],conflictsPending:0}) }));
  await page.getByRole('button', { name: "Refresh the AI's copy", exact: true }).click();
  await expect(page.getByText('Knowledge sync needs attention', { exact: true })).toBeVisible();
  await expect(page.getByText('Knowledge sync completed', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/The searchable copy could not be saved/)).toBeVisible();
  await expect(page.getByText('1 documents refreshed; 2 could not be refreshed and need another attempt', { exact:true })).toBeVisible();
  await expect(page.getByText(/Some knowledge could not be refreshed/).first()).toBeVisible();
  await page.unroute('**/api/knowledge/sync');
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/knowledge/sync');
  await page.getByRole('button', { name: "Refresh the AI's copy", exact: true }).click();
  const actual = await response;
  expect(actual.ok()).toBe(true);
  expect((await actual.json()).knowledgeBase.synced).toBe(true);
  await expect(page.getByText(/The searchable copy could not be saved/)).toHaveCount(0);
});

test('uploaded text is actually read and extraction reports its real runtime outcome honestly', async ({ page }) => {
  test.setTimeout(120_000);
  await loginDemo(page);
  await openTabByLabel(page, 'Onboarding');
  await page.getByRole('textbox', { name: 'Website URL', exact:true }).fill('');
  const text = 'Company: Pilot Loom Supplies. We supply cotton yarn to textile manufacturers. Our public office is in Surat. Minimum order is 25 kg. We do not offer credit. Contact sales at sales@example.invalid.';
  await page.getByLabel('Select files (PDF, DOCX, TXT, MD, CSV)', { exact:true }).setInputFiles({ name:'pilot-company.txt', mimeType:'text/plain', buffer:Buffer.from(text) });
  const read = page.waitForResponse(r => new URL(r.url()).pathname === '/api/documents/extract-file-text');
  const extracted = page.waitForResponse(r => new URL(r.url()).pathname === '/api/onboarding/extract-company-knowledge');
  await page.getByRole('button', { name:'Extract Company Knowledge', exact:true }).click();
  const readResponse = await read;
  expect(readResponse.ok()).toBe(true);
  expect((await readResponse.json()).files[0].extractedText).toContain('We do not offer credit');
  const result = await extracted;
  const body = await result.json();
  if (!result.ok()) {
    expect(result.status()).toBe(409);
    expect(body.error.code).toBe('NEEDS_ACTION');
    expect(body.error.message).toBe('No AI key is set up yet — add one in AI Settings. AI analysis stopped before finishing. Uploaded source text and any completed batches may already be saved. Check the extraction status and saved answers before retrying; your existing approved answers are kept.');
    await expect(page.getByText(/Nothing was read from this document/)).toHaveCount(0);
    await expect(page.getByText(/Your website and documents have been analyzed together/)).toHaveCount(0);
    await expect(page.getByRole('button', { name:'Extract Company Knowledge', exact:true })).toBeEnabled();
  } else {
    expect(JSON.stringify(body)).toContain('pilot-company.txt');
    await expect(page.getByText(/Your website and documents have been analyzed together/)).toBeVisible();
    await expect(page.getByText(/sample\/mock answers only|sample data \(backup mode\)|Sample data \(backup\)/).first()).toBeVisible();
  }
  await page.screenshot({ path:'docs/system-workflow/readiness-proof/week1-upload-outcome.png' });
});
