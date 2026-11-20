/**
 * prod-prisma-smoke.spec.ts — L-2/L-4 (2026-08-04), retargeted 2026-08-19.
 *
 * THE GAP THIS CLOSES (build-right Gate #2, Full-UI-Sweep):
 *   The rest of the e2e suite was written against the JSON demo file. This spec
 *   is the production-prisma smoke: it expects the dev server to be running
 *   with `PERSISTENCE_PROVIDER=prisma`, logs in via the demo button, and asserts
 *   that what is IN Postgres is what is ON the screen — the Golden Thread.
 *
 * WHAT CHANGED ON 2026-08-19, AND WHY IT MATTERS MORE THAN THE FIX ITSELF:
 *   This spec used to hard-code the values it expected: "Balaji Zari Udyog",
 *   "Aarna Bridal Studio", "10,000", "confirm the current pricing". Those were
 *   rows written by `scripts/seed-demo-prisma.ts`. That seed debris was purged
 *   and the real demo data set migrated in (CEO-loop session 7), so:
 *
 *     - the workspace-name test was asserting a workspace that no longer exists;
 *     - the orders test was asserting ₹10,000 and ₹5,200, and the orders in the
 *       database are ₹6,000, ₹17,000 and ₹27,600;
 *     - the leads test and the replies test STILL PASSED — on strings the new
 *       data set happened to share. That is the dangerous half. A smoke test
 *       that goes green against data it was not written for is worse than one
 *       that fails, because nobody investigates a pass.
 *
 *   Re-hard-coding the new values would have bought exactly one data set's worth
 *   of correctness. So the expectations are now READ OUT OF POSTGRES at run
 *   time (`e2e/helpers/postgres-facts.ts`, via raw SQL — deliberately not
 *   through the repository layer that is itself under test). Change the data
 *   set again and this spec follows it.
 *
 * HOW TO RUN:
 *   1. `.env` needs `PERSISTENCE_PROVIDER=prisma` + `DATABASE_URL`.
 *   2. `npm run dev` (boots the prod-prisma server on :3000).
 *   3. The database must hold migrated data (`npm run migrate:json-to-postgres`).
 *   4. `npx playwright test prod-prisma-smoke --reporter=list`
 *
 * WHAT IT PROVES (and what it intentionally does NOT):
 *   - PROVES: the prod-prisma app boots, login works, and the Dashboard / Leads /
 *     Quotes & Orders / Replies tabs render real Postgres rows without crashing.
 *
 *   The tab labels above are the ones the 2026-08-17 navigation redesign left
 *   behind; this spec had been clicking "Commercial" and "CRM", which stopped
 *   existing that day. See e2e/helpers/nav.ts.
 *   - Does NOT run the full suite against prisma (that needs a dedicated test
 *     database). This is the smoke subset — the highest-traffic screens only.
 */
import { test, expect } from "@playwright/test";
import { readPostgresFacts, anyOf, escapeRegex, type PostgresFacts } from "./helpers/postgres-facts";
import { openTab, TAB } from "./helpers/nav";

// Dev-mode Next compiles a route the first time a test opens it, and this spec
// opens four. Measured on this machine: ~17s just to log in and mount, then
// several seconds per tab. The default 30s budget is a stopwatch on the Next
// compiler, not on the product, and it fails tabs in the order they happen to
// run rather than in the order anything is actually wrong.
test.describe.configure({ timeout: 120_000 });

let facts: PostgresFacts;

test.beforeAll(async () => {
  facts = await readPostgresFacts();
  // Print what we are about to require. When this spec fails, the first
  // question is always "what did it expect?", and the answer lives in a
  // database nobody has open.
  console.log("[prod-prisma-smoke] expecting from Postgres:");
  console.log(`  workspace       ${facts.workspaceName}`);
  console.log(`  leads (${facts.leadNames.length})      ${facts.leadNames.slice(0, 4).join(", ")}…`);
  console.log(`  order totals    ${facts.orderTotalsGrouped.join(", ")}`);
  console.log(`  quote totals    ${facts.quoteTotalsGrouped.join(", ")}`);
  console.log(`  inbound replies ${facts.incomingMessages.length}`);
});

async function demoLogin(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Continue in Demo Mode/i }).click();
  // Wait for the app shell to mount.
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
}

// Shared setup: every test logs in fresh so a failure in one doesn't cascade.
test.beforeEach(async ({ page }) => {
  await demoLogin(page);
});

test.describe("L-2/L-4: prod-prisma smoke (real Postgres data renders)", () => {
  test("Dashboard mounts + shows the workspace name that is in Postgres", async ({ page }) => {
    // The workspace's display name lives in the `workspaces` row. Rendering it
    // proves the app read the database, not a bundled default.
    await expect(page.locator("body")).toContainText(
      new RegExp(escapeRegex(facts.workspaceName), "i"),
      { timeout: 15_000 },
    );
  });

  test("Leads tab renders leads that are in Postgres", async ({ page }) => {
    await openTab(page, TAB.leads.group, TAB.leads.label);
    await page.waitForTimeout(1500); // let the leads fetch settle
    // At least one real company name must render. Not all of them: the pipeline
    // view paginates and filters by status, so requiring every lead would fail
    // on a UI decision rather than on a data problem.
    await expect(page.locator("body")).toContainText(anyOf(facts.leadNames), { timeout: 15_000 });
  });

  test("Quotes & Orders tab renders totals that are in Postgres", async ({ page }) => {
    await openTab(page, TAB.quotesAndOrders.group, TAB.quotesAndOrders.label);
    await page.waitForTimeout(1500);
    // formatINR renders "₹6,000.00" — match the grouped integer part, which is
    // stable across the two-decimals-or-not renderers used on different cards.
    // Orders and quotes share this tab; either proves the read.
    await expect(page.locator("body")).toContainText(
      anyOf([...facts.orderTotalsGrouped, ...facts.quoteTotalsGrouped]),
      { timeout: 15_000 },
    );
  });

  test("Replies tab renders the inbound messages that are in Postgres", async ({ page }) => {
    test.skip(facts.incomingMessages.length === 0, "no auto_reply_logs rows in this database");
    await openTab(page, TAB.replies.group, TAB.replies.label);
    await page.waitForTimeout(1500);
    // The Replies inbox renders AutoReplyLog entries. The stored incomingMessage
    // text is the value that came out of the database, so it is the one to look
    // for — the generated reply is regenerated and is not a stable expectation.
    await expect(page.locator("body")).toContainText(anyOf(facts.incomingMessages), {
      timeout: 15_000,
    });
  });

  test("No console errors across the smoke subset (Gate #2)", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
    });
    // Visit each smoke tab.
    for (const key of ["dashboard", "leads", "quotesAndOrders", "replies"] as const) {
      await openTab(page, TAB[key].group, TAB[key].label);
      await page.waitForTimeout(1000);
    }
    // Filter out known-benign noise (Next.js dev HMR, favicon 404s).
    const realErrors = errors.filter((e) =>
      !/favicon|404|hmr|hot reload|webpack/i.test(e) && !/Failed to load resource/i.test(e)
    );
    expect(realErrors, `Unexpected console errors: ${realErrors.join("; ")}`).toEqual([]);
  });
});
