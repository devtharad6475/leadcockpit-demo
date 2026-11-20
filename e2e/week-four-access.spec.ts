import {test, expect, type Page} from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { E2E_DATA_DIR, REPO_ROOT } from "./helpers/data-dir";
import {readAppData} from "./helpers/app-data";
import {expectAppShell} from "./helpers/login";
import {openTabByLabel} from "./helpers/nav";

test.skip(process.env.WEEK_FOUR_AUTH_PROOF !== "1", "Uses the dedicated production-auth disposable server only.");
const password = "Disposable-week-four-password!";
const a = "week_four_company_a", b = "week_four_company_b";
function updateFixture(mode?: '--invalidate-b-owner') {
  const child = spawnSync(process.execPath, [path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(REPO_ROOT, 'e2e/helpers/week-four-fixture-seed.ts'), ...(mode ? [mode] : [])], {
    env: { ...process.env, LEADGEN_DATA_DIR: E2E_DATA_DIR, PERSISTENCE_PROVIDER: 'json', DATABASE_URL: '' },
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  expect(child.error, child.error?.message).toBeUndefined();
  expect(child.status, child.stderr || child.stdout).toBe(0);
}
test.beforeAll(() => { updateFixture(); });
async function expectBuyerRead(page: Page, workspaceId: string) {
  const response = await page.waitForResponse(read => new URL(read.url()).pathname === '/api/leads' && read.request().method() === 'GET');
  expect(response.ok(), await response.text()).toBe(true);
  const leads = await response.json() as { id: string; workspaceId: string }[];
  expect(leads.map(lead => lead.workspaceId)).toEqual([workspaceId]);
  expect(leads.map(lead => lead.id)).toEqual([workspaceId === a ? 'week_four_lead_a' : 'week_four_lead_b']);
}

test.afterEach(async ({page}) => {await page.close();});

async function signIn(page: Page, workspaceId: string, role: string, waitForBuyers = true) {
  await page.goto("/");
  await page.getByRole("button", {name: "Log in", exact: true}).click();
  await page.getByRole("textbox", {name: "Email", exact: true}).fill(`${workspaceId}_${role}@example.invalid`);
  await page.getByLabel("Password", {exact: true}).fill(password);
  const buyers = waitForBuyers ? expectBuyerRead(page, workspaceId) : null;
  const signedIn = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/login" && response.request().method() === "POST");
  await page.getByRole("button", {name: "Sign in", exact: true}).click();
  const response = await signedIn;
  expect(response.ok(), await response.text()).toBe(true);
  await expectAppShell(page, 30_000);
  if (buyers) await buyers;
  await openTabByLabel(page, "Leads");
}

test("signed-in companies see only their own buyer records, including after refresh", async ({page}) => {
  await signIn(page, a, "owner");
  await expect(page.getByText("Company A Private Buyer", {exact: true}).first()).toBeVisible();
  await expect(page.getByText("Company B Private Buyer", {exact: true})).toHaveCount(0);
  const foreign = await page.request.get("/api/leads/week_four_lead_b");
  expect(foreign.status()).toBe(404);
  expect((await page.request.get("/api/admin/health")).status()).toBe(401);
  const refreshedBuyers = expectBuyerRead(page, a);
  await page.reload();
  await refreshedBuyers;
  await openTabByLabel(page, "Leads");
  await expect(page.getByText("Company A Private Buyer", {exact: true}).first()).toBeVisible();
  await expect(page.getByText("Company B Private Buyer", {exact: true})).toHaveCount(0);
  await page.screenshot({path: "docs/system-workflow/readiness-proof/week-four-company-isolation.png"});
});

test("a late customer read from the signed-out company cannot overwrite the next company", async ({page}) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let captured!: () => void;
  const capturedRead = new Promise<void>(resolve => { captured = resolve; });
  let finished!: () => void;
  const finishedRead = new Promise<void>(resolve => { finished = resolve; });
  let first = true;
  await page.route('**/api/leads', async route => {
    if (!first) return route.continue();
    first = false;
    const response = await route.fetch();
    captured();
    await held;
    try { await route.fulfill({ response }); } finally { finished(); }
  });
  try {
    await signIn(page, a, 'owner', false);
    await capturedRead;
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill(`${b}_owner@example.invalid`);
    await page.getByLabel('Password', { exact: true }).fill(password);
    const nextCompanyBuyers = expectBuyerRead(page, b);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await nextCompanyBuyers;
    await expectAppShell(page);
    await openTabByLabel(page, 'Leads');
    await expect(page.getByText('Company B Private Buyer', { exact: true }).first()).toBeVisible();
    release();
    await finishedRead;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText('Company B Private Buyer', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Company A Private Buyer', { exact: true })).toHaveCount(0);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test("viewer signs in and reads records but cannot create customers or restore data", async ({page}) => {
  await signIn(page, a, "viewer");
  await expect(page.getByText("Company A Private Buyer", {exact: true}).first()).toBeVisible();
  const before = readAppData().leads;
  for (const [url, body] of [["/api/leads/manual", {companyName: "Forbidden buyer"}], ["/api/data/restore", {confirm: "RESTORE", backup: {leads: []}}]] as const) {
    const status = await page.evaluate(async ({url, body}) => (await fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)})).status, {url, body});
    expect(status).toBe(403);
  }
  expect(readAppData().leads).toEqual(before);
});

test("invalidated saved login stops access and returns the browser to sign-in", async ({page}) => {
  await signIn(page, b, "owner");
  await expect(page.getByText("Company B Private Buyer", {exact: true}).first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  updateFixture('--invalidate-b-owner');
  expect((await page.request.get("/api/leads")).status()).toBe(401);
  await page.reload();
  await expect(page.getByRole("navigation", {name: "Main navigation"})).toHaveCount(0);
  await expect(page.getByRole("button", {name: "Log in", exact: true})).toBeVisible();
});

test("operator health screen says monitoring is unmeasured instead of zero errors", async ({page}) => {
  await page.goto("/admin");
  await page.getByLabel("Email", {exact: true}).fill("week_four_operator@example.invalid");
  await page.getByLabel("Password", {exact: true}).fill(password);
  const login = page.waitForResponse(r => new URL(r.url()).pathname === "/api/admin/auth/login");
  await page.getByRole("button", {name: "Sign in", exact: true}).click();
  const response = await login;
  expect(response.ok(), await response.text()).toBe(true);
  const status = await page.request.get("/api/admin/auth/status");
  expect((await status.json()).authenticated).toBe(true);
  expect((await page.request.get("/api/leads")).status()).toBe(401);
  await page.getByRole("button", {name: "System health", exact: true}).click();
  await expect(page.getByText("Not measured", {exact: true})).toBeVisible({timeout: 30_000});
  await expect(page.getByText(/Error monitoring is not connected or could not be read/)).toBeVisible();
  await expect(page.getByText("0 errors", {exact: true})).toHaveCount(0);
  await page.screenshot({path: "docs/system-workflow/readiness-proof/week-four-monitoring-honesty.png", fullPage: true});
});

test("owned upload serves exact bytes after browser refresh and rejects a foreign customer link", async ({page}) => {
  await signIn(page, a, "owner");
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFj0AAAAASUVORK5CYII=", "base64");
  const upload = async (leadId: string) => page.request.post("/api/media/upload", {
    headers: {origin: new URL(page.url()).origin},
    multipart: {leadId, title: "Week Four Owned Upload", category: "product_image",
      file: {name: "week-four.png", mimeType: "image/png", buffer: bytes}},
  });
  expect((await upload("week_four_lead_b")).status()).toBe(404);
  const response = await upload("week_four_lead_a"); expect(response.ok(), await response.text()).toBe(true);
  const item = await response.json();
  const file = await page.request.get(item.url); expect(file.ok()).toBe(true);
  expect(await file.body()).toEqual(bytes); expect(file.headers()["content-type"]).toBe("image/png");
  await page.goto(item.url); await expect(page.locator("img")).toBeVisible();
  await page.reload(); await expect(page.locator("img")).toBeVisible();
  expect(await page.locator("img").evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1);
  expect(await (await page.request.get(item.url)).body()).toEqual(bytes);
});
