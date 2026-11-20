import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { loginDemo } from './helpers/login';
import { restoreDemoData, waitForServerQuiescent } from './helpers/demo-data-snapshot';
import { E2E_DATA_FILE } from './helpers/data-dir';

const headers = { cookie: 'lc_demo=1' };
test.beforeEach(async () => { await waitForServerQuiescent(); restoreDemoData(); await waitForServerQuiescent(); });
test.afterEach(async ({ page }) => { await page.close(); await waitForServerQuiescent(); });
async function open(page: import('@playwright/test').Page) {
  await loginDemo(page); await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message your assistant' })).toBeEnabled({timeout:20000});
}

test('unavailable customer-profile generation keeps saved profiles and explains retry after refresh', async ({ page, request }) => {
  const data = JSON.parse(fs.readFileSync(E2E_DATA_FILE, 'utf8'));
  const before = data.icps.filter((r: { workspaceId: string }) => r.workspaceId === 'workspace_demo');
  expect(before.length).toBeGreaterThan(0);
  const convo = await (await request.post('/api/copilot/conversations', { headers, data: {} })).json();
  const proposal = await request.post('/api/copilot/message', { headers, data: { conversationId: convo.id, text: 'build my customer profile' } });
  expect(proposal.ok()).toBe(true);
  await open(page);
  await page.getByRole('button', { name: 'Yes, run it', exact: true }).click();
  const region = page.getByRole('region', { name: 'Conversation', exact: true });
  await expect(region).toContainText('could not produce a usable result');
  await expect(region).toContainText('were kept');
  const after = JSON.parse(fs.readFileSync(E2E_DATA_FILE, 'utf8')).icps.filter((r: { workspaceId: string }) => r.workspaceId === 'workspace_demo');
  expect(after).toEqual(before);
  await page.reload(); await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(region).toContainText('Make a new request and confirm it');
  await expect(page.getByRole('button', { name: 'Yes, run it', exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/week-five-generation-preserved.png' });
});

test('analysis asks for a saved customer reply instead of inventing an analysis', async ({ page, request }) => {
  const convo = await (await request.post('/api/copilot/conversations', { headers, data: {} })).json();
  await request.post('/api/copilot/message', { headers, data: { conversationId: convo.id, text: 'classify this reply' } });
  await open(page);
  const region = page.getByRole('region', { name: 'Conversation', exact: true });
  await expect(region).toContainText('Select a customer with a saved reply first');
  await expect(region).not.toContainText('"mock":');
  await page.screenshot({ path: 'docs/system-workflow/readiness-proof/week-five-analysis-missing.png' });
});

test('campaign generation with unusable model output creates no empty campaign', async ({ page, request }) => {
  const before = JSON.parse(fs.readFileSync(E2E_DATA_FILE, 'utf8')).campaigns;
  const convo = await (await request.post('/api/copilot/conversations', { headers, data: {} })).json();
  await request.post('/api/copilot/message', { headers, data: { conversationId: convo.id, text: 'plan a campaign' } });
  await open(page); await page.getByRole('button', { name: 'Yes, run it', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText('could not produce a usable result');
  expect(JSON.parse(fs.readFileSync(E2E_DATA_FILE, 'utf8')).campaigns).toEqual(before);
});


test('a slow conversation load shows progress and keeps customer actions disabled', async ({ page }) => {
  let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/copilot/conversations/*/messages',async route=>{await gate;await route.continue();});
  await loginDemo(page);await page.getByRole('button',{name:'Assistant',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Opening your conversation'})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Message your assistant'})).toBeDisabled();
  await expect(page.getByRole('heading',{name:'What should we work on?'})).toHaveCount(0);
  release();await expect(page.getByRole('textbox',{name:'Message your assistant'})).toBeEnabled({timeout:20000});
});
