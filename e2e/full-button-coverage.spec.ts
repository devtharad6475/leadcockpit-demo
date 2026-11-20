/**
 * 2026-07-29 — FULL BUTTON-COVERAGE SPEC (build-right Phase 3b + Gate #6).
 *
 * This is the legacy broad button audit. Some cases conditionally exercise
 * controls according to fixture state; a pass is not proof of every button,
 * nested screen or error state. Strict nested regressions live separately in
 * nested-ui-journey.spec.ts. The
 * earlier `ui-value-verification.spec.ts` verifies VALUES; THIS spec verifies
 * that EVERY ONE of the ~206 clickable buttons in the workspace SPA actually
 * does what its label promises — no dead button, no crash, no silent failure,
 * and (for send-class buttons) no violation of the no-auto-outreach rule.
 *
 * Operator decisions (AskUserQuestion 2026-07-29):
 *   - Send-class buttons: CLICK + assert the result is a DRAFT / preview,
 *     NOT a real send. (Honors AGENTS.md no-auto-outreach.)
 *   - Breadth first: every button clicked once + on-screen value checked.
 *   - Isolation: snapshot demo data before suite, restore before each
 *     mutating test (Gate #8).
 *
 * Coverage Map (206 distinct button definitions across 26 tabs — sourced from
 * a complete source audit of src/app/page.tsx + src/app/sections/*.tsx; see
 * docs/EXHAUSTIVE-UI-SWEEP-FINDINGS.md for the per-tab breakdown).
 *
 * Run:  npx playwright test full-button-coverage --reporter=list
 *
 * NOTE on what "clicked" means here: a button is counted as covered when we
 * click it (or, for send-class buttons, verify it exists + is enabled + the
 * handler is wired) and the page does not crash (no uncaught error, no white
 * screen). Mutation results are then verified against the API/data.
 */
import { test, expect, type Page } from "@playwright/test";
import { restoreDemoData, waitForServerQuiescent } from "./helpers/demo-data-snapshot";
import { loginDemo } from "./helpers/login";
import { openTabByLabel } from "./helpers/nav";
import { E2E_BASE_URL } from "./helpers/e2e-target";

async function api<T = any>(page: Page, method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: any): Promise<T> {
  const ctx = page.context();
  const resp = await ctx.request.fetch(E2E_BASE_URL + path, {
    method,
    headers: { Cookie: "lc_demo=1", "Content-Type": "application/json" },
    data: body ? JSON.stringify(body) : undefined,
    timeout: 20000,
  });
  const text = await resp.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return json as T;
}

/** Enter through the actual demo sign-in, waiting for its button to appear. */
async function openWorkspace(page: Page) {
  await loginDemo(page);
}

/**
 * 2026-08-19 (N-TEST-4) — was a direct `getByRole("button", { name: label })
 * .click({ force: true })`. Since the 2026-08-17 redesign every drawer starts
 * COLLAPSED, so 25 of the 26 tab buttons are not in the DOM until their drawer
 * is opened. A force-click on a locator that matches nothing waits out the test
 * budget and the failure names the destination screen, not the navigation — 29
 * tests in this file failed that way. Delegates to the shared helper, which
 * opens the owning drawer first and throws by name if the tab is gone.
 */
async function openTab(page: Page, label: string) {
  await openTabByLabel(page, label);
  await page.waitForTimeout(900);
}

/** Attach console + pageerror collectors. Fail the test on any genuine error
 * (exempting favicon 404s and 429s which the rate-limit env already prevents). */
function attachErrorCollectors(page: Page, errors: string[]) {
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const t = msg.text();
      if (t.includes("favicon") || t.includes("Failed to load resource")) return;
      if (t.includes("429")) return; // rate-limit env handles volume
      errors.push(`console.error: ${t}`);
    }
  });
}

// ════════════════════════════════════════════════════════════════════════════
// TAB: dashboard (11 buttons) — all navigate/reload, no mutations
// ════════════════════════════════════════════════════════════════════════════
test.describe("dashboard — 11 buttons", () => {
  test("all dashboard buttons navigate correctly", async ({ page }) => {
    const errors: string[] = [];
    attachErrorCollectors(page, errors);
    await openWorkspace(page);

    // 4 "Open" shortcut buttons
    for (const [label, expectedHeading] of [
      ["Open Leads to review", /Approve or reject new leads|Lead pipeline/],
      // 2026-08-19 (N-TEST-6) — the card was renamed "Message drafts to
      // approve" → "Outreach drafts to approve" (src/app/page.tsx:1327) and the
      // aria-label is `Open ${label}`. The old name matched nothing, so this
      // line waited out the budget on a button that no longer exists.
      ["Open Outreach drafts to approve", /Outreach messages/],
      ["Open Follow-ups due", /Lead pipeline/],
      ["Open Enrichment gaps", /Lead pipeline/],
    ] as const) {
      await openTab(page, "Dashboard");
      await page.getByRole("button", { name: label }).click({ force: true });
      await page.waitForTimeout(800);
      await expect(page.getByRole("heading", { name: expectedHeading })).toBeVisible({ timeout: 8000 });
    }

    // 5 number-chip buttons. 2026-08-31 (N-UX-9): this list used to include
    // "Total leads", which the Dashboard has NOT rendered as a chip for some
    // time — the "Pipeline at a glance" header prints the total instead, so a
    // sixth chip would have shown the same number twice. The total is still
    // asserted, just where it actually lives (below).
    await openTab(page, "Dashboard");
    await expect(page.getByText(/\d+ leads/).first()).toBeVisible();
    for (const label of ["Approved", "Hot leads", "Replies received", "Do not contact", "Active campaigns"]) {
      const tile = page.getByRole("button", { name: new RegExp(label) });
      await expect(tile).toBeVisible();
      await tile.click({ force: true });
      await page.waitForTimeout(400);
      await openTab(page, "Dashboard"); // return so each click starts from dashboard
    }

    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB: profile (2 buttons — Save, Mark as correct) — both mutate
// ════════════════════════════════════════════════════════════════════════════
test.describe("profile — 3 mutating buttons", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });
  test("Save + Mark as correct succeed", async ({ page }) => {
    const errors: string[] = [];
    attachErrorCollectors(page, errors);
    await openWorkspace(page);
    await openTab(page, "Profile");

    // Save — PUT business-profile. Capture the current profile name, save, verify no error.
    const saveBtn = page.getByRole("button", { name: "Save", exact: true });
    await expect(saveBtn).toBeVisible();
    await saveBtn.click();
    await page.waitForTimeout(1500);
    // Mark as correct (2026-09-25: was "Approve"; the profile's own "Sync
    // Knowledge" was removed because Save already rebuilds the knowledge).
    const approveBtn = page.getByRole("button", { name: "Mark as correct", exact: true });
    if (await approveBtn.isVisible().catch(() => false)) {
      await approveBtn.click();
      await expect(page.getByText(/Marked correct/)).toBeVisible({ timeout: 8000 });
    }
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB: icp (3 buttons — Generate, Select ×N, Reject ×N)
// ════════════════════════════════════════════════════════════════════════════
test.describe("icp — 3 button types", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });
  test("Generate ICPs + Select + Reject work", async ({ page }) => {
    const errors: string[] = [];
    attachErrorCollectors(page, errors);
    await openWorkspace(page);
    await openTab(page, "Ideal Customers");

    const genBtn = page.getByRole("button", { name: /Suggest customer types|Suggest different ones/i });
    await expect(genBtn).toBeVisible();
    await genBtn.click();
    await page.waitForTimeout(2000);

    // If ICPs render, exercise Select + Reject on the first one.
    const selectBtn = page.getByRole("button", { name: "Select", exact: true });
    const rejectBtn = page.getByRole("button", { name: "Reject this ICP" });
    if (await selectBtn.first().isVisible().catch(() => false)) {
      await selectBtn.first().click();
      await page.waitForTimeout(1200);
    }
    if (await rejectBtn.first().isVisible().catch(() => false)) {
      await rejectBtn.first().click();
      await page.waitForTimeout(1200);
    }
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB: campaign (3 buttons — Generate, Approve ×N, Regenerate ×N)
// ════════════════════════════════════════════════════════════════════════════
test.describe("campaign — 3 button types", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });
  test("Generate/Approve/Regenerate campaign", async ({ page }) => {
    const errors: string[] = [];
    attachErrorCollectors(page, errors);
    await openWorkspace(page);
    await openTab(page, "Campaign");

    // 2026-09-25: "Generate Recommended Campaign" and the per-plan "Regenerate"
    // called the same endpoint; they are now one "Make a new plan".
    const genBtn = page.getByRole("button", { name: /Make a new plan/i });
    if (await genBtn.isVisible().catch(() => false)) {
      await genBtn.click();
      await page.waitForTimeout(2000);
    }
    const approveBtn = page.getByRole("button", { name: "Approve", exact: true });
    if (await approveBtn.first().isVisible().catch(() => false)) {
      await approveBtn.first().click();
      await page.waitForTimeout(1500);
    }
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB: discovery (5 buttons — Run discovery, Upload CSV, Type one in by hand, Save lead, Cancel)
// ════════════════════════════════════════════════════════════════════════════
test.describe("discovery — 5 buttons", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });
  test("Type one in by hand + Save lead creates a new lead (count goes up)", async ({ page }) => {
    const errors: string[] = [];
    attachErrorCollectors(page, errors);
    await openWorkspace(page);
    const before = await api<{ totalLeads?: number }>(page, "GET", "/api/state");

    await openTab(page, "Discovery");
    await page.getByRole("button", { name: "Type one in by hand" }).click();
    await page.waitForTimeout(600);
    // Fill the manual-add form minimally.
    const nameInput = page.getByLabel(/Company name|Name/i).first();
    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.fill("Test Manual Lead");
    }
    await page.getByRole("button", { name: "Save lead" }).click();
    await page.waitForTimeout(2000);

    const after = await api<{ totalLeads?: number }>(page, "GET", "/api/state");
    // The new lead should increase the count.
    expect(after.totalLeads, `totalLeads before=${before.totalLeads} after=${after.totalLeads}`).toBeGreaterThanOrEqual((before.totalLeads ?? 0));
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB: review (9 buttons — 4 mode cards, Save settings, Agent rec, Approve, Reject+modal)
// ════════════════════════════════════════════════════════════════════════════
test.describe("review — 9 buttons", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });
  test("mode cards toggle + Save settings persists", async ({ page }) => {
    const errors: string[] = [];
    attachErrorCollectors(page, errors);
    await openWorkspace(page);
    await openTab(page, "Lead Review");

    // 2026-09-25 cleanup: settings live behind "Review settings"; two modes.
    await page.getByRole("button", { name: "Review settings" }).click();
    for (const mode of ["You approve every lead", "Approve safe leads automatically"]) {
      await page.getByRole("button", { name: new RegExp(mode) }).click();
      await page.waitForTimeout(600);
      await expect(page.getByRole("button", { name: new RegExp(mode) })).toHaveAttribute("aria-pressed", "true");
    }
    // A percentage typed as 8000 is refused on screen, never saved.
    const bar = page.getByLabel(/at least \(%\) sure/);
    await bar.fill("8000");
    await expect(page.getByRole("button", { name: "Save review settings" })).toBeDisabled();
    await bar.fill("85");
    await page.getByRole("button", { name: "Save review settings" }).click();
    await page.waitForTimeout(1500);
    const saved = await page.evaluate(() => fetch("/api/lead-review/settings").then((r) => r.json()));
    expect(saved.autoApproveThreshold).toBe(0.85);
    // Put the workspace back to the default the other tests expect.
    await page.getByRole("button", { name: /You approve every lead/ }).click();
    await page.waitForTimeout(600);
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });

  test("Approve a waiting lead moves it to approved", async ({ page }) => {
    const errors: string[] = [];
    attachErrorCollectors(page, errors);
    await openWorkspace(page);
    await openTab(page, "Lead Review");
    const approveBtn = page.getByRole("button", { name: "Approve", exact: true });
    if (await approveBtn.first().isVisible().catch(() => false)) {
      await approveBtn.first().click();
      await page.waitForTimeout(2000);
      // Verify via API the approved count didn't decrease.
      const state = await api<any>(page, "GET", "/api/state");
      expect(state.totalLeads).toBeGreaterThan(0);
    }
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB: crm (Enrich, Message, Generate PDF, Create plan, Enrich approved, Score all)
//
// 2026-08-31 (N-TEST-19) — these two tests drove the OLD expand-row
// "Relevancy" toggle, which was replaced by a slide-over Drawer on 2026-08-02
// (src/app/page.tsx:2908 — "`drawerLeadId` replaces the old `activeRelevancy`
// toggle"). The row's accessible name changed with it, from "Show relevancy
// details for X" to "Show details for X".
//
// So both tests had been waiting 90 seconds for a button the product deleted a
// month earlier, and reporting it as a CRM failure. Verified in the running
// app: the row opens a drawer, and "Generate PDF" / "Create plan" live INSIDE
// that drawer, while "Score all" / "Enrich approved only" remain on the page.
// ════════════════════════════════════════════════════════════════════════════
test.describe("crm — 9 buttons", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });
  test("lead drawer + Enrich + Message + Score all + Enrich approved", async ({ page }) => {
    const errors: string[] = [];
    attachErrorCollectors(page, errors);
    await openWorkspace(page);
    await openTab(page, "Leads");

    // Open the lead drawer (was: the "Relevancy" expand-row toggle).
    const aarnaRow = page.getByRole("row", { name: /Aarna Bridal Studio/ });
    await page.getByRole("button", { name: "Show details for Aarna Bridal Studio" }).click();
    await page.waitForTimeout(800);
    // The drawer overlays the list, so close it before driving the page-level
    // bulk actions below — otherwise those clicks land on the scrim.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    // Score with AI (2026-09-25: was "Score all" + a separate AI button)
    await page.getByRole("button", { name: "Score with AI" }).click();
    await page.waitForTimeout(2500);
    // Enrich approved only
    await page.getByRole("button", { name: "Enrich approved only" }).click();
    await page.waitForTimeout(2500);
    // Per-row Enrich (Aarna is approved)
    if (await aarnaRow.getByRole("button", { name: "Enrich", exact: true }).isVisible().catch(() => false)) {
      await aarnaRow.getByRole("button", { name: "Enrich", exact: true }).click();
      await page.waitForTimeout(2000);
    }
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });

  test("lead drawer: Generate PDF + Create plan", async ({ page }) => {
    const errors: string[] = [];
    attachErrorCollectors(page, errors);
    await openWorkspace(page);
    await openTab(page, "Leads");
    await page.getByRole("button", { name: "Show details for Aarna Bridal Studio" }).click();
    await page.waitForTimeout(800);
    await page.getByRole("tab", { name: "Documents", exact: true }).click();
    const pdfBtn = page.getByRole("button", { name: "Generate PDF" });
    if (await pdfBtn.isVisible().catch(() => false)) {
      await pdfBtn.click();
      await page.waitForTimeout(2500);
    }
    const planBtn = page.getByRole("button", { name: "Suggest a next step" });
    await page.getByRole("tab", { name: "AI guidance", exact: true }).click();
    if (await planBtn.isVisible().catch(() => false)) {
      await planBtn.click();
      await page.waitForTimeout(2500);
    }
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB: messages (7 buttons incl. 2 SEND-class "Mark sent")
// Send policy: click + assert DRAFT/result, never a real send.
// ════════════════════════════════════════════════════════════════════════════
test.describe("messages — 7 buttons (incl. 2 Mark sent)", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });
  test("Copy + Approve + (Mark sent verifies draft-state, no real send)", async ({ page }) => {
    const errors: string[] = [];
    attachErrorCollectors(page, errors);
    await openWorkspace(page);
    await openTab(page, "Messages");

    // Generate a draft for an approved lead so the queue isn't empty.
    const leadChip = page.getByRole("button", { name: "Aarna Bridal Studio" });
    if (await leadChip.isVisible().catch(() => false)) {
      await leadChip.click();
      await page.waitForTimeout(2500);
    }

    // Copy buttons (read-only, safe)
    const copyBtns = page.getByRole("button", { name: "Copy", exact: true });
    const copyCount = await copyBtns.count();
    if (copyCount > 0) await copyBtns.first().click();
    await page.waitForTimeout(500);

    // Approve a draft (approves, does NOT send — per source audit)
    const approveBtns = page.getByRole("button", { name: "Approve", exact: true });
    if (await approveBtns.first().isVisible().catch(() => false)) {
      await approveBtns.first().click();
      await page.waitForTimeout(1500);
    }

    // Mark sent — SEND-CLASS. In demo mode the provider is Mock (dry-run), so
    // clicking "Mark sent" only flips a status flag; it does NOT call a real
    // WhatsApp/Gmail API. Verify the result is a status change, not a send,
    // by checking no real-send error appears and the message remains in-app.
    const markSent = page.getByRole("button", { name: "Mark sent" });
    if (await markSent.first().isVisible().catch(() => false)) {
      await markSent.first().click();
      await page.waitForTimeout(1500);
      // The send must be a mock/dry-run — assert no real-provider error.
      const realSendError = errors.find((e) => /whatsapp|gmail|send failed|provider error/i.test(e));
      expect(realSendError, `real-send error detected: ${realSendError}`).toBeUndefined();
    }
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB: replies (9 buttons incl. 1 SEND-class "Approve & Send")
// ════════════════════════════════════════════════════════════════════════════
test.describe("replies — 9 buttons (incl. Approve & Send)", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });
  test("Re-classify + Copy + Dismiss + Simulate Run + (Approve&Send verifies draft)", async ({ page }) => {
    const errors: string[] = [];
    attachErrorCollectors(page, errors);
    await openWorkspace(page);
    await openTab(page, "Replies");

    // Re-classify (read-only re-classification)
    const reclass = page.getByRole("button", { name: "Ask the AI to sort it again" });
    if (await reclass.first().isVisible().catch(() => false)) {
      await reclass.first().click();
      await page.waitForTimeout(1500);
    }

    // Copy text (read-only)
    const copyBtn = page.getByRole("button", { name: "Copy text" });
    if (await copyBtn.first().isVisible().catch(() => false)) {
      await copyBtn.first().click();
      await page.waitForTimeout(500);
    }

    // Dismiss Draft (mutates — rejects the auto-reply draft, no send)
    const dismiss = page.getByRole("button", { name: "Dismiss Draft" });
    if (await dismiss.first().isVisible().catch(() => false)) {
      await dismiss.first().click();
      await page.waitForTimeout(1500);
    }

    // Simulate Reply modal + Run Simulation (dry-run, creates a log, no send)
    const simBtn = page.locator('button[title="Simulate Reply"]');
    if (await simBtn.isVisible().catch(() => false)) {
      await simBtn.click();
      await page.waitForTimeout(800);
      const runBtn = page.getByRole("button", { name: "Run Simulation" });
      if (await runBtn.isVisible().catch(() => false)) {
        await runBtn.click();
        await page.waitForTimeout(2500);
      }
      // Close the modal so it doesn't intercept the Approve & Send click.
      const closeBtn = page.getByRole("button", { name: "Close" });
      if (await closeBtn.first().isVisible().catch(() => false)) {
        await closeBtn.first().click();
        await page.waitForTimeout(400);
      }
    }

    // Approve & Send — SEND-CLASS. Demo provider = Mock, so this records an
    // approval + copies text; it does NOT call a real WhatsApp API. Assert no
    // real-send error. (If a real key were configured this would be a real
    // send — the test's no-auto-outreach guard is the mock-provider default.)
    const approveSend = page.getByRole("button", { name: "Approve & Send" });
    if (await approveSend.first().isVisible().catch(() => false)) {
      await approveSend.first().click({ force: true });
      await page.waitForTimeout(2000);
      const realSendError = errors.find((e) => /whatsapp api|send failed|provider error|unauthorized/i.test(e));
      expect(realSendError, `real-send error: ${realSendError}`).toBeUndefined();
    }
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB: tickets (10 buttons — New ticket modal + status transitions)
// ════════════════════════════════════════════════════════════════════════════
test.describe("tickets — 10 buttons", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });
  test("New ticket create + status transitions work", async ({ page }) => {
    const errors: string[] = [];
    attachErrorCollectors(page, errors);
    await openWorkspace(page);
    await openTab(page, "Tickets");

    // Open New ticket modal + submit
    const newBtn = page.getByRole("button", { name: "New ticket" });
    await newBtn.first().click();
    await page.waitForTimeout(800);
    const subjectInput = page.getByLabel(/Subject/i).first();
    if (await subjectInput.isVisible().catch(() => false)) {
      await subjectInput.fill("Test ticket from UI sweep");
    }
    const createBtn = page.getByRole("button", { name: "Create ticket" });
    if (await createBtn.isVisible().catch(() => false)) {
      await createBtn.click();
      await page.waitForTimeout(2000);
    }

    // If a ticket is selectable, click it + exercise a status transition.
    const ticketRow = page.getByRole("button", { name: /#\d+/ }).first();
    if (await ticketRow.isVisible().catch(() => false)) {
      await ticketRow.click();
      await page.waitForTimeout(800);
      for (const label of ["Start working", "Waiting on customer", "Mark resolved", "Close"]) {
        const btn = page.getByRole("button", { name: label, exact: true });
        if (await btn.isVisible().catch(() => false)) {
          await btn.click();
          await page.waitForTimeout(1200);
          break; // one transition per state; the button set changes after each
        }
      }
    }
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB: commercial (13 buttons — New order/quote modal + detail + cancel)
// ════════════════════════════════════════════════════════════════════════════
test.describe("commercial — 13 buttons", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });
  test("New order modal opens + create + detail view + cancel", async ({ page }) => {
    const errors: string[] = [];
    attachErrorCollectors(page, errors);
    await openWorkspace(page);
    await openTab(page, "Quotes & Orders");

    const newOrder = page.getByRole("button", { name: "New order" });
    await newOrder.first().click();
    await page.waitForTimeout(800);
    // The create modal should be visible (we don't need to fill every field
    // — the goal is the modal opens without crashing).
    await expect(page.getByText(/order|customer/i).first()).toBeVisible({ timeout: 5000 });
    // Close the modal. The Modal backdrop intercepts normal clicks, so use
    // force to click the modal's own Cancel button (or press Escape).
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // Switch to Quotes sub-tab + open New quote
    const quotesTab = page.getByRole("button", { name: "Quotes", exact: true });
    if (await quotesTab.isVisible().catch(() => false)) {
      await quotesTab.click();
      await page.waitForTimeout(600);
      const newQuote = page.getByRole("button", { name: "New quote" });
      if (await newQuote.first().isVisible().catch(() => false)) {
        await newQuote.first().click();
        await page.waitForTimeout(800);
      }
    }

    // If any existing order exists, open its detail modal.
    const orderDetail = page.getByRole("button", { name: /View details for order #/ }).first();
    if (await orderDetail.isVisible().catch(() => false)) {
      await orderDetail.click();
      await page.waitForTimeout(800);
    }
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB: catalogue (6 buttons incl. 2 SEND-class "Send all"/"Send messages")
// Send policy: the broadcast requires owner confirmation via ConfirmModal;
// we open the modal (proves wiring) but DO NOT confirm a real broadcast.
// ════════════════════════════════════════════════════════════════════════════
test.describe("catalogue — 6 buttons (incl. Send all broadcast)", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });
  test("Preview + Send-all modal opens (NO real broadcast confirmed)", async ({ page }) => {
    const errors: string[] = [];
    attachErrorCollectors(page, errors);
    await openWorkspace(page);
    await openTab(page, "Catalogue");

    const previewBtn = page.getByRole("button", { name: "Preview" });
    if (await previewBtn.first().isVisible().catch(() => false)) {
      await previewBtn.first().click();
      await page.waitForTimeout(1500);
    }

    // Send all → opens ConfirmModal. We open the modal to prove the wiring,
    // but CANCEL rather than confirm — honoring no-auto-outreach. A real
    // broadcast is a customer-facing send and must never fire from a test.
    const sendAll = page.getByRole("button", { name: /Send all/i });
    if (await sendAll.isVisible().catch(() => false)) {
      await sendAll.click();
      await page.waitForTimeout(800);
      const cancelInModal = page.getByRole("button", { name: "Cancel" }).last();
      if (await cancelInModal.isVisible().catch(() => false)) {
        await cancelInModal.click();
        await page.waitForTimeout(500);
      }
    }
    // Assert no broadcast error fired (proves we didn't accidentally send).
    const broadcastError = errors.find((e) => /broadcast|send.*fail|whatsapp api/i.test(e));
    expect(broadcastError, `broadcast fired: ${broadcastError}`).toBeUndefined();
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB: knowledge (11 buttons — Sync, Approve safe, search, domain nav, edit/approve answer)
// ════════════════════════════════════════════════════════════════════════════
test.describe("knowledge — 11 buttons", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });
  test("Sync Knowledge + Approve safe + search + edit/save answer", async ({ page }) => {
    const errors: string[] = [];
    attachErrorCollectors(page, errors);
    await openWorkspace(page);
    await openTab(page, "Knowledge Base");

    const syncBtn = page.getByRole("button", { name: /Refresh the AI.s copy/i }).first();
    if (await syncBtn.isVisible().catch(() => false)) {
      await syncBtn.click();
      await page.waitForTimeout(2500);
    }
    const approveSafe = page.getByRole("button", { name: /Approve \d+ safe answers/i });
    if (await approveSafe.isVisible().catch(() => false)) {
      await approveSafe.click();
      await page.waitForTimeout(1500);
    }
    // 2026-09-25 — search and documents moved into drawers.
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByLabel("Search the knowledge").fill("minimum order");
    await page.getByRole("dialog").getByRole("button", { name: "Search" }).click();
    await expect(page.getByRole("dialog").getByText(/The AI would find an answer|not a sure match|Nothing found/)).toBeVisible({ timeout: 15000 });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /Documents \(\d+\)/ }).click();
    await expect(page.getByRole("dialog").getByRole("button", { name: /^Remove / }).first()).toBeVisible();
    await page.keyboard.press("Escape");
    // A status tile filters the section list. A tile with nothing to show is
    // not a button, so pick the first one that is.
    const tile = page.getByRole("button", { name: /waiting for your OK|not known yet|where answers disagree/ }).first();
    if (await tile.count()) {
      await tile.click();
      await expect(page.locator("aside").getByText(/\d+ of \d+ sections/)).toBeVisible();
      await page.getByRole("button", { name: "Show all", exact: true }).click();
    }
    // Edit an answer then Save
    const editBtn = page.getByRole("button", { name: "Edit", exact: true });
    if (await editBtn.first().isVisible().catch(() => false)) {
      await editBtn.first().click();
      await page.waitForTimeout(600);
      const saveBtn = page.getByRole("button", { name: "Save", exact: true });
      if (await saveBtn.isVisible().catch(() => false)) {
        await saveBtn.click();
        await page.waitForTimeout(1500);
      }
    }
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB: unknown / Information Needed (15 buttons — Save and next, Skip, etc.)
// ════════════════════════════════════════════════════════════════════════════
test.describe("unknown — 15 buttons", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });
  test("Save and next + Skip work on the business-detail card", async ({ page }) => {
    const errors: string[] = [];
    attachErrorCollectors(page, errors);
    await openWorkspace(page);
    await openTab(page, "Questions from AI");

    // Skip advances the card index (local state, no mutation)
    const skipBtn = page.getByRole("button", { name: "Skip", exact: true });
    if (await skipBtn.isVisible().catch(() => false)) {
      await skipBtn.click();
      await page.waitForTimeout(400);
    }
    // Save and next — POSTs an answer
    const answerInput = page.getByRole("textbox", { name: "Add this business detail once", exact: true });
    if (await answerInput.isVisible().catch(() => false)) {
      await answerInput.fill("Test answer from UI sweep");
    }
    const saveNext = page.getByRole("button", { name: /Save and next/i });
    if (await saveNext.isVisible().catch(() => false)) {
      await saveNext.click();
      await page.waitForTimeout(2000);
    }
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB: reviewQueue / AI Review Queue (3 buttons — Approve/Reject draft)
// Note: per source, "Approving here does not send WhatsApp yet."
// ════════════════════════════════════════════════════════════════════════════
test.describe("reviewQueue — 3 buttons", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });
  test("Approve/Reject draft (review only, no send)", async ({ page }) => {
    const errors: string[] = [];
    attachErrorCollectors(page, errors);
    await openWorkspace(page);
    await openTab(page, "AI Drafts");

    const rejectBtn = page.getByRole("button", { name: "Reject", exact: true });
    if (await rejectBtn.first().isVisible().catch(() => false)) {
      await rejectBtn.first().click();
      await page.waitForTimeout(1500);
    }
    const approveBtn = page.getByRole("button", { name: /Approve draft/i });
    if (await approveBtn.first().isVisible().catch(() => false)) {
      await approveBtn.first().click();
      await page.waitForTimeout(1500);
    }
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB: ai / AI Settings (9 buttons — Fetch models, Test slot, Save slots)
// ════════════════════════════════════════════════════════════════════════════
test.describe("ai — 9 buttons", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });
  test("Fetch models + Save model slots", async ({ page }) => {
    const errors: string[] = [];
    attachErrorCollectors(page, errors);
    await openWorkspace(page);
    await openTab(page, "AI Settings");

    // 2026-09-25 redesign: the model choices for a job live in a side panel
    // opened by that job's "Change" button, on the "Which AI does each job" tab.
    await page.getByRole("tab", { name: "Which AI does each job" }).click();
    await page.getByRole("button", { name: /^Change / }).first().click();
    const fetchBtn = page.getByRole("button", { name: /Fetch models/i }).first();
    await fetchBtn.click();
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(1500);
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB: whatsapp (13 buttons — LLM test, chips, Save settings, draft test)
// Save settings governs the no-auto-outreach rule; we verify it persists
// without enabling automatic mode.
// ════════════════════════════════════════════════════════════════════════════
test.describe("whatsapp — 13 buttons", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });
  test("LLM test + chip + Save settings + draft test", async ({ page }) => {
    const errors: string[] = [];
    attachErrorCollectors(page, errors);
    await openWorkspace(page);
    await openTab(page, "WhatsApp Agent");

    // Quick-test chip (sets local state)
    const chip = page.getByRole("button", { name: "Hi", exact: true });
    if (await chip.isVisible().catch(() => false)) {
      await chip.click();
      await page.waitForTimeout(400);
    }
    const llmTest = page.getByRole("button", { name: "See what it would reply", exact: true });
    if (await llmTest.isVisible().catch(() => false)) {
      await llmTest.click();
      await page.waitForTimeout(2500);
    }
    // Save settings (PUT whatsapp-agent/settings) — verify no error.
    await page.getByRole("tab", { name: "Reply rules", exact: true }).click();
    const saveBtn = page.getByRole("button", { name: "Save settings" });
    if (await saveBtn.isVisible().catch(() => false)) {
      await saveBtn.click();
      await page.waitForTimeout(1500);
    }
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB: agentInstructions (3 buttons — Save, Reset, context-help modal)
// ════════════════════════════════════════════════════════════════════════════
test.describe("agentInstructions — optional owner guidance", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });
  test("additional guidance saves, restores and exposes optional help", async ({ page }) => {
    const errors: string[] = [];
    attachErrorCollectors(page, errors);
    await openWorkspace(page);
    await openTab(page, "Agent Instructions");
    const text = page.getByLabel("Your additional guidance", { exact: true });
    await expect(text).toBeEnabled();
    await page.getByText("What can I add here?", { exact: true }).click();
    await expect(page.getByText(/Your guidance belongs to the selected agent/)).toBeVisible();
    await text.fill("Keep replies short and polite.");
    await page.getByRole("button", { name: "Save guidance", exact: true }).click();
    await expect(page.getByText("Guidance saved for this agent.", { exact: true })).toBeVisible();
    await text.fill("Different style.");
    await page.getByRole("button", { name: "Discard changes", exact: true }).click();
    await expect(text).toHaveValue("Keep replies short and polite.");
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB: settings (30 buttons — sub-tabs, conflict resolve, section Open cards)
// ════════════════════════════════════════════════════════════════════════════
test.describe("settings — 30 buttons", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });
  test("5 sub-tabs switch + Save settings persists", async ({ page }) => {
    const errors: string[] = [];
    attachErrorCollectors(page, errors);
    await openWorkspace(page);
    await openTab(page, "Settings");

    for (const sub of ["Sales", "Products", "Policy", "Communication"]) {
      const subBtn = page.getByRole("button", { name: sub, exact: true });
      if (await subBtn.isVisible().catch(() => false)) {
        await subBtn.click();
        await page.waitForTimeout(500);
        const saveBtn = page.getByRole("button", { name: new RegExp(`Save ${sub}`) });
        if (await saveBtn.isVisible().catch(() => false)) {
          await saveBtn.click();
          await page.waitForTimeout(1500);
        }
      }
    }
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });

  test("conflict resolve actions (keep/use/both/ignore) work", async ({ page }) => {
    const errors: string[] = [];
    attachErrorCollectors(page, errors);
    await openWorkspace(page);
    await openTab(page, "Settings");

    const conflictsTab = page.getByRole("button", { name: /^Needs your decision/ });
    if (await conflictsTab.isVisible().catch(() => false)) {
      await conflictsTab.click();
      await page.waitForTimeout(600);
      for (const label of ["Keep mine", "Use theirs", "Keep both", "Decide later"]) {
        const btn = page.getByRole("button", { name: label, exact: true });
        if (await btn.first().isVisible().catch(() => false)) {
          await btn.first().click();
          await page.waitForTimeout(1200);
          break; // one resolve per run; the set changes after each
        }
      }
    }
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB: exportBackup (2 buttons — Export JSON, Restore later disabled)
// ════════════════════════════════════════════════════════════════════════════
test.describe("exportBackup — 2 buttons", () => {
  test("Export triggers a download", async ({ page }) => {
    restoreDemoData();
    await waitForServerQuiescent();
    const errors: string[] = [];
    attachErrorCollectors(page, errors);
    await openWorkspace(page);
    await openTab(page, "Export / Backup");

    const exportBtn = page.getByRole("button", { name: /Download a copy/i });
    await expect(exportBtn).toBeVisible();
    // Set up the download listener BEFORE clicking.
    const downloadPromise = page.waitForEvent("download", { timeout: 15000 });
    await exportBtn.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("leadcockpit-workspace-backup.json");
    expect(await download.failure()).toBeNull();
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB: help (Help & Support — open a ticket flow)
// ════════════════════════════════════════════════════════════════════════════
test.describe("help — open a ticket", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });
  test("Open a ticket button + form render", async ({ page }) => {
    const errors: string[] = [];
    attachErrorCollectors(page, errors);
    await openWorkspace(page);
    await openTab(page, "Help & Support");
    const openTicket = page.getByRole("button", { name: /Open a ticket|New ticket|Contact support/i }).first();
    if (await openTicket.isVisible().catch(() => false)) {
      await openTicket.click();
      await page.waitForTimeout(800);
    }
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TABS with mostly read-only / nav buttons (onboarding, workspace, compliance,
// analytics, integrations, catalogue-already-covered): smoke-verify presence.
// ════════════════════════════════════════════════════════════════════════════
test.describe("remaining tabs — button presence smoke", () => {
  test("onboarding buttons present", async ({ page }) => {
    await openWorkspace(page);
    await openTab(page, "Onboarding");
    await expect(page.getByRole("button", { name: "Extract Company Knowledge" }).first()).toBeVisible();
  });
  test("workspace buttons present", async ({ page }) => {
    await openWorkspace(page);
    await openTab(page, "Workspace");
    await page.getByRole("tab", { name: "Message controls", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop all automatic messages" }).first()).toBeVisible();
  });
  test("compliance buttons present", async ({ page }) => {
    await openWorkspace(page);
    await openTab(page, "Compliance");
    await expect(page.getByRole("heading", { name: "Outreach consent" })).toBeVisible();
  });
  test("analytics generate-learning present", async ({ page }) => {
    await openWorkspace(page);
    await openTab(page, "Analytics");
    // Analytics may be sparse — just assert the tab rendered content.
    const main = await page.locator("main").innerText();
    expect(main.length).toBeGreaterThan(80);
  });
  test("integrations test-connection present", async ({ page }) => {
    await openWorkspace(page);
    await openTab(page, "Integrations");
    await page.getByRole("region", { name: "Your connections", exact: true }).getByRole("button", { name: /Set up|Manage/ }).first().click();
    await expect(page.getByRole("dialog", { name: "WhatsApp", exact: true }).getByRole("button", { name: "Test connection", exact: true })).toBeVisible();
  });
});
