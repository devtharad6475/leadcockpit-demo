import fs from 'node:fs';
import {test, expect, type Page, type APIRequestContext} from '@playwright/test';
import {loginDemo} from './helpers/login';
import {readAppData} from './helpers/app-data';
import {E2E_DATA_FILE} from './helpers/data-dir';
import {E2E_TARGET} from './helpers/e2e-target';
import {restoreDemoData, waitForServerQuiescent} from './helpers/demo-data-snapshot';

const headers = {cookie: 'lc_demo=1'};
test.beforeEach(async () => {
  test.skip(E2E_TARGET !== 'json', 'These fixtures are confined to the disposable JSON substrate.');
  restoreDemoData();
  await waitForServerQuiescent();
});

async function seedPlan(request: APIRequestContext, status = 'awaiting_confirmation') {
  const response = await request.post('/api/copilot/conversations', {headers, data: {}});
  expect(response.ok()).toBe(true);
  const conversation = await response.json();
  await waitForServerQuiescent();
  const data = readAppData();
  const now = new Date().toISOString();
  const id = `week1-job-${Date.now()}`;
  const plan = {summary: 'Review approved company facts without sending anything.', subtasks: [
    {id: 'facts', agent: 'knowledge-base-agent', instruction: 'Read approved company facts. State missing facts honestly. Do not send any message.', dependsOn: []},
  ]};
  data.jobRuns ??= [];
  data.jobRuns.push({id, workspaceId: conversation.workspaceId, jobType: 'orchestration', status,
    payload: {goal: plan.summary, plan, problems: [], maxCalls: 10, maxSearches: 0, conversationId: conversation.id, runDeadlineMs: 1000},
    attempts: 0, maxAttempts: 1, createdAt: now, updatedAt: now,
    ...(status === 'running' ? {startedAt: new Date(Date.now() - 60 * 60_000).toISOString()} : {}),
  });
  data.ownerCopilotMessages ??= [];
  data.ownerCopilotMessages.push({id: `proposal-${id}`, workspaceId: conversation.workspaceId, conversationId: conversation.id,
    role: 'copilot', kind: 'copilot_confirm', tier: 'T3', language: 'en', text: plan.summary,
    pendingAction: {intent: 'orchestrated_job', entityId: id, entityType: 'orchestration_job'}, createdAt: now});
  fs.writeFileSync(E2E_DATA_FILE, JSON.stringify(data, null, 2));
  return {id, conversation};
}

async function openAssistant(page: Page) {
  await loginDemo(page);
  await page.getByRole('button', {name: 'Assistant', exact: true}).click();
  await expect(page.getByRole('textbox', {name: 'Message your assistant'})).toBeEnabled({timeout:30_000});
}

test('confirmed plan stores an honest report, reopens after refresh and cannot execute twice', async ({page, request}) => {
  test.setTimeout(120_000);
  const {id, conversation} = await seedPlan(request);
  const initial = readAppData();
  const outreachBefore = initial.outreachActivities;
  await openAssistant(page);
  await expect(page.getByRole('button', {name: 'Run this plan', exact: true})).toBeVisible();
  const confirmed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/copilot/confirm');
  await page.getByRole('button', {name: 'Run this plan', exact: true}).click();
  const confirmation = await confirmed;
  expect(confirmation.ok(), await confirmation.text()).toBe(true);
  const jobResponse = await request.get(`/api/copilot/jobs/${id}`, {headers});
  expect(jobResponse.ok()).toBe(true);
  const job = await jobResponse.json();
  expect(['completed', 'partial']).toContain(job.status);
  expect(job.result.outcomes).toHaveLength(1);
  expect(job.result.text).toContain('Nothing was sent to any customer.');
  const messages = readAppData().ownerCopilotMessages.filter((m: {conversationId: string}) => m.conversationId === conversation.id);
  expect(messages.some((m: {text: string}) => m.text === job.result.text)).toBe(true);
  await page.reload({waitUntil: 'domcontentloaded'});
  await page.getByRole('button', {name: 'Assistant', exact: true}).click();
  await expect(page.getByText('Nothing was sent to any customer.', {exact: false}).last()).toBeVisible();
  await page.getByRole('button', {name: /How it was done/}).click();
  await page.getByRole('button', {name: 'Show full instructions', exact: true}).click();
  await expect(page.getByText('Read approved company facts. State missing facts honestly. Do not send any message.', {exact: true})).toBeVisible();
  const replay = await request.post('/api/copilot/confirm', {headers, data: {conversationId: conversation.id, intent: 'orchestrated_job', pendingActionId: id}});
  expect(replay.ok()).toBe(false);
  expect(readAppData().outreachActivities).toEqual(outreachBefore);
  await page.screenshot({path: 'docs/system-workflow/readiness-proof/week1-job-report.png'});
});

test('discard is persisted and a discarded plan cannot run', async ({page, request}) => {
  const {id} = await seedPlan(request);
  await openAssistant(page);
  await page.getByRole('button', {name: 'Discard', exact: true}).click();
  await expect(page.getByText('Discarded', {exact: true})).toBeVisible();
  const run = await request.post(`/api/copilot/jobs/${id}/run`, {headers, data: {}});
  expect(run.ok()).toBe(true);
  expect((await run.json()).ran).toBe(false);
  const job = await (await request.get(`/api/copilot/jobs/${id}`, {headers})).json();
  expect(job.status).toBe('cancelled');
  expect(job.startedAt).toBeUndefined();
  await page.reload({waitUntil: 'domcontentloaded'});
  await page.getByRole('button', {name: 'Assistant', exact: true}).click();
  await expect(page.getByText('Discarded', {exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Run this plan', exact: true})).toHaveCount(0);
});

test('interrupted execution settles honestly and retry creates a fresh unexecuted plan', async ({page, request}) => {
  const {id} = await seedPlan(request, 'running');
  await openAssistant(page);
  await expect(page.getByText(/This job was interrupted before it finished/)).toBeVisible();
  const original = await (await request.get(`/api/copilot/jobs/${id}`, {headers})).json();
  expect(original.status).toBe('failed');
  const copiedResponse = page.waitForResponse(r => new URL(r.url()).pathname === `/api/copilot/jobs/${id}/again`);
  await page.getByRole('button', {name: 'Run it again', exact: true}).click();
  const copied = await (await copiedResponse).json();
  expect(copied.jobId).not.toBe(id);
  await expect(page.getByRole('button', {name: 'Run this plan', exact: true})).toBeVisible();
  const fresh = await (await request.get(`/api/copilot/jobs/${copied.jobId}`, {headers})).json();
  expect(fresh.status).toBe('awaiting_confirmation');
  expect(fresh.payload.copiedFrom).toBe(id);
  expect(fresh.startedAt).toBeUndefined();
  expect(fresh.result).toBeUndefined();
  expect((await (await request.get(`/api/copilot/jobs/${id}`, {headers})).json()).status).toBe('failed');
  await page.reload({waitUntil: 'domcontentloaded'});
  await page.getByRole('button', {name: 'Assistant', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Run this plan', exact: true})).toBeVisible();
  const persistedProposal = readAppData().ownerCopilotMessages.find((m: {pendingAction?: {entityId?: string}}) => m.pendingAction?.entityId === copied.jobId);
  expect(persistedProposal.kind).toBe('copilot_confirm');
  expect((await (await request.get(`/api/copilot/jobs/${copied.jobId}`, {headers})).json()).status).toBe('awaiting_confirmation');
  await page.screenshot({path: 'docs/system-workflow/readiness-proof/week1-job-recovery.png'});
});
