import {test, expect} from "@playwright/test";
import {loginDemo} from "./helpers/login";
import {openTabByLabel} from "./helpers/nav";
import {restoreDemoData, waitForServerQuiescent} from "./helpers/demo-data-snapshot";
import {readAppData} from "./helpers/app-data";

const headers = {cookie: "lc_demo=1"};
test.beforeEach(async () => {await waitForServerQuiescent(); restoreDemoData(); await waitForServerQuiescent();});
test.afterEach(async ({page}) => {await page.close(); await waitForServerQuiescent();});

async function chooseBackup(page: import("@playwright/test").Page, backup: unknown) {
  await page.locator('input[type="file"][accept=".json,application/json"]').setInputFiles({
    name: "company-copy.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)),
  });
  await page.getByRole("textbox", {name: "Type RESTORE to confirm"}).fill("RESTORE");
}

test("restore refuses unsupported records visibly and leaves customers intact after refresh", async ({page, request}) => {
  const before = readAppData().leads;
  await loginDemo(page); await openTabByLabel(page, "Export / Backup");
  await expect(page.getByText(/uploaded file contents and Assistant job history are not included/)).toBeVisible();
  await chooseBackup(page, {leads: before, interactions: [{id: "unsupported", workspaceId: "workspace_demo"}]});
  const response = page.waitForResponse(r => new URL(r.url()).pathname === "/api/data/restore");
  await page.getByRole("button", {name: "Restore this workspace", exact: true}).click();
  expect((await response).status()).toBe(400);
  await expect(page.getByRole("main").getByText(/This file contains sections that cannot be restored/)).toBeVisible();
  expect(readAppData().leads).toEqual(before);
  await page.screenshot({path: "docs/system-workflow/readiness-proof/week-four-restore-refusal.png"});
  await page.reload(); await openTabByLabel(page, "Leads");
  await expect(page.getByText(before[0].companyName, {exact: true}).first()).toBeVisible();
  const list = await request.get("/api/leads", {headers}); expect(list.ok()).toBe(true);
  expect(readAppData().leads).toEqual(before);
});

test("successful restore keeps the customer identity and shows the saved value after refresh", async ({page}) => {
  const original = readAppData().leads[0];
  const restored = {...original, campaignId: undefined, icpId: undefined, companyName: "Restored Week Four Customer"};
  await loginDemo(page); await openTabByLabel(page, "Export / Backup");
  await chooseBackup(page, {leads: [restored]});
  const response = page.waitForResponse(r => new URL(r.url()).pathname === "/api/data/restore");
  await page.getByRole("button", {name: "Restore this workspace", exact: true}).click();
  const saved = await response; expect(saved.ok(), await saved.text()).toBe(true);
  await expect(page.getByText("Restored 1 record.", {exact: true})).toBeVisible();
  expect(readAppData().leads).toHaveLength(1);
  expect(readAppData().leads[0].id).toBe(original.id);
  await page.reload(); await openTabByLabel(page, "Leads");
  await expect(page.getByText(restored.companyName, {exact: true}).first()).toBeVisible();
  await page.screenshot({path: "docs/system-workflow/readiness-proof/week-four-restored-customer.png"});
});

test("malformed backup rows are rejected before deleting existing records", async ({request}) => {
  const before = readAppData();
  for (const backup of [{leads: [null]}, {leads: "unreadable", campaigns: []}, {workspaces: []}]) {
    const response = await request.post("/api/data/restore", {headers, data: {confirm: "RESTORE", backup}});
    expect(response.status()).toBe(422);
    expect(readAppData().leads).toEqual(before.leads);
  }
  expect(readAppData().outreachActivities).toEqual(before.outreachActivities);
});
