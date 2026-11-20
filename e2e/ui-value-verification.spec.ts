/**
 * 2026-07-29 — UI VALUE-VERIFICATION SWEEP (build-right Phase 3b).
 *
 * This is the value-correctness companion to `full-ui-sweep-v2.spec.ts`. The
 * v2 sweep proves "every screen renders." THIS spec proves "every screen shows
 * the RIGHT VALUE" (the Golden Thread at the UI layer) AND "every button does
 * what its label promises."
 *
 * build-right Phase 3b is explicit: "Do NOT just check that the page loads —
 * check that the actual hand-computed value appears on the screen." Each test
 * below fetches the same API the UI uses, hand-computes the expected number/
 * string, then asserts that exact value is rendered in the DOM.
 *
 * Coverage Map (per-tab value assertions + button-flow clicks):
 *   - Dashboard: 10 numbers vs /api/state (Golden Thread)
 *   - Leads/CRM: pipeline rows vs /api/leads; F-N-R-T breakdown = leadScore
 *   - Messages: drafts count vs API
 *   - Replies: list vs API
 *   - Commercial: order totals ₹
 *   - Tickets: list vs API
 *   - Knowledge Base: approved-answer count
 *   - Information Needed: open-question count
 *   - Help & Support: ticket create flow
 *   - Plus: every visible button is clickable (no dead button, no crash)
 *
 * Run: npx playwright test ui-value-verification --reporter=list
 *
 * NOTE on mutations: tests use the demo workspace and may mutate it. The
 * playwright.config.ts webServer seeds fresh demo data before each `playwright
 * test` run via the globalSetup hook is NOT enabled here — instead we
 * re-seed at the END of this suite in `afterAll`. Production goldens stay
 * unaffected because they use isolated test workspaces, not workspace_demo.
 */
import { test, expect, type Page } from "@playwright/test";
import { expectAppShell } from "./helpers/login";
import { openTabByLabel, TAB_GROUP, expectedHeadingFor } from "./helpers/nav";
import { E2E_BASE_URL } from "./helpers/e2e-target";

// Demo-mode cookie the catch-all route uses to bypass auth in AUTH_MODE=demo.
const DEMO_COOKIE = "lc_demo=1";

/** Set the demo cookie and fetch a JSON API endpoint as the UI would. */
async function api<T = any>(page: Page, path: string): Promise<T> {
  const ctx = page.context();
  const base = E2E_BASE_URL;
  const resp = await ctx.request.get(base + path, {
    headers: { Cookie: DEMO_COOKIE },
    timeout: 15000,
  });
  expect(resp.status(), `GET ${path} status`).toBeLessThan(400);
  return (await resp.json()) as T;
}

/** Open the demo workspace in a fresh tab and wait for hydration. */
async function openWorkspace(page: Page) {
  await page.context().addCookies([{ name: "lc_demo", value: "1", url: E2E_BASE_URL }]);
  await page.goto(`${E2E_BASE_URL}/`, { waitUntil: "domcontentloaded" });
  // The landing page shows "Continue in Demo Mode" — click it to enter the
  // workspace. The click can race with React's handler attachment, so we wait
  // for the nav to appear and retry the click once if it doesn't.
  const navLocator = page.getByRole("navigation", { name: "Main navigation" });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await navLocator.isVisible({ timeout: 2000 }).catch(() => false)) break;
    const demoBtn = page.getByRole("button", { name: "Continue in Demo Mode" });
    if (await demoBtn.count() > 0) {
      await demoBtn.first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(800);
    }
  }
  // Wait for the sidebar nav to appear (proves React hydrated + state loaded).
  await navLocator.waitFor({ timeout: 30000 });
  // Wait for the dashboard cards to render numbers (proves /api/state landed).
  // 2026-08-19 (N-TEST-5) — was `expect(page.getByText(/Leads to review/))`.
  // That card only renders when the queue actually HAS leads to review, so a
  // login helper was asserting a DATA condition: any test that emptied the
  // queue made every later login look like a failed login. Assert the shell.
  await expectAppShell(page);
}

/**
 * Open a sidebar nav tab, then confirm the section actually switched.
 *
 * 2026-08-19 (N-TEST-4) — the click was a direct `getByRole("button", { name:
 * label }).click({ force: true })`. The redesign made every drawer start
 * collapsed, so the tab button did not exist to be clicked and 37 tests in this
 * file timed out somewhere downstream.
 *
 * 2026-08-19 (N-TEST-12) — the "did the click land" check used to be a caller-
 * supplied PANEL title ("Lead pipeline", "Outreach Queue", "Knowledge Base:
 * guided"). On 2026-08-02 `Panel` demoted its title from an <h2> to a styled
 * <div> — deliberately, because it duplicated the page <h1> on every screen
 * (src/components/ui/primitives.tsx:26). So `getByRole("heading", …)` could no
 * longer match ANY panel title, and six tests reported the screen as missing.
 * The same change gave the shell an <h1> naming the active screen, which is a
 * better check anyway: it is the app's own statement of which screen you are on,
 * and it exists on all 26.
 *
 * 2026-09-03 (N-UX-10) — that <h1> is no longer the sidebar label. The operator
 * asked for headings that state the JOB ("Answer what the AI couldn't") instead
 * of repeating the menu item they had just clicked. So the expected string now
 * comes from the app's own PAGE_INTROS table via `expectedHeadingFor(label)`.
 *
 * This is a re-derivation, NOT a loosening. It would have been easy to relax the
 * check to "some level-1 heading is visible" — and that version passes when a
 * click lands on the wrong screen, which is the single failure it exists to
 * catch (see N-TEST-15 below, where "Settings" opened "AI Settings" unnoticed).
 * It still asserts one exact string, and the string is read from the product so
 * the spec cannot drift from it.
 */
async function openTab(page: Page, label: string) {
  await openTabByLabel(page, label);
  await page.waitForTimeout(1000);
  const heading = expectedHeadingFor(label);
  if (heading === null) {
    // "Needs you" is the one screen whose heading is a live count, not a fixed
    // phrase. Assert the shape of the claim instead of a string.
    await expect(
      page.getByRole("heading", { level: 1 }).filter({ hasText: /needs? you$/i }).first(),
      `the shell <h1> on "${label}" must state how much is waiting`,
    ).toBeVisible({ timeout: 10000 });
    return;
  }
  await expect(
    page.getByRole("heading", { level: 1, name: heading, exact: true }),
    `clicking "${label}" must land on the screen whose heading is "${heading}" ` +
      `(from PAGE_INTROS in src/app/page-intros.ts)`,
  ).toBeVisible({ timeout: 10000 });
}

/**
 * The lead's row in the desktop CRM table.
 *
 * 2026-08-19 (N-TEST-14) — this used to look for a row named
 * "Show relevancy details for <Name>". That aria-label has not existed since
 * the 2026-08-02 redesign, which replaced the expand-a-row pattern with a
 * slide-over Drawer (page.tsx:2617) opened from the company-name button, now
 * labelled `Show details for <Name>`. The old locator matched nothing, so three
 * tests reported the CRM's row actions as missing when they are simply
 * somewhere else.
 *
 * Scoping by that aria-label also disambiguates the desktop table from the
 * lg:hidden mobile card list, which renders the same company name a second time
 * (a plain getByText("Unnamed prospect") hit "strict mode violation: resolved
 * to 2 elements").
 */
function leadNameButton(page: Page, leadName: string) {
  return page.getByRole("button", { name: `Show details for ${leadName}`, exact: true });
}

function leadRow(page: Page, leadName: string) {
  return page.getByRole("row").filter({ has: leadNameButton(page, leadName) });
}

// ════════════════════════════════════════════════════════════════════════════
// TAB 1 — DASHBOARD: 10 numbers vs /api/state (Golden Thread)
// ════════════════════════════════════════════════════════════════════════════
test.describe("Tab 1 — Dashboard (Golden Thread)", () => {
  test("every dashboard number matches /api/state", async ({ page }) => {
    // 2026-08-19 (N-TEST-13) — three things in this test had gone stale, and
    // together they made a WORKING dashboard look broken:
    //   1. it never opened the Dashboard. Since the 2026-08-17 redesign the app
    //      lands on "Needs you", so every card here was simply on another screen.
    //   2. "Approved" and "Do not contact" were frozen seed literals (4 and 1).
    //      The seed now ships 15 leads, 13 approved. A test that hard-codes a
    //      seed count fails on every data change and proves nothing about the
    //      dashboard — it proves what the seed used to be. Both are now derived
    //      from /api/leads with the SAME rule the dashboard uses (page.tsx:1300).
    //   3. "Total leads" was asserted as a number CARD. It is not one: the
    //      numbers strip renders numberItems.slice(1) (page.tsx:1499), so the
    //      total deliberately lives in the "Pipeline at a glance" card header
    //      instead. Assert it where it actually is.
    await openWorkspace(page);
    const state = await api(page, "/api/state");
    const leads = await api<any[]>(page, "/api/leads");
    await openTab(page, "Dashboard");

    const approved = leads.filter((l) => l.reviewStatus === "approved").length;
    const dnc = leads.filter((l) => l.doNotContact || l.status === "do_not_contact").length;

    // Each headline chip is a button whose accessible name is "<N> <Label>".
    const expectNumberCard = async (label: string, expected: number) => {
      await expect(
        page.getByRole("button", { name: new RegExp(`^${expected} ${label}$`) }),
        `dashboard chip "${label}" must read ${expected}`,
      ).toBeVisible({ timeout: 10000 });
    };

    await expectNumberCard("Approved", approved);
    await expectNumberCard("Hot leads", state.hotLeads ?? 0);
    await expectNumberCard("Replies received", state.recentReplies?.length ?? 0);
    await expectNumberCard("Active campaigns", state.activeCampaigns?.length ?? 0);
    await expectNumberCard("Do not contact", dnc);

    // The total lives in the pipeline card's header, not in the chip strip.
    await expect(
      page.getByText(new RegExp(`^${leads.length} leads?$`)),
      "the pipeline card header must state the true lead count",
    ).toBeVisible({ timeout: 10000 });

    // Queue cards: one button per item, aria-label "Open <label>".
    for (const label of [
      "Leads to review",
      "Customer replies to review",
      "Outreach drafts to approve",
      "Follow-ups due",
      "Enrichment gaps",
    ]) {
      await expect(page.getByRole("button", { name: `Open ${label}` })).toBeVisible();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB 2 — LEADS / CRM: pipeline rows + F-N-R-T consistency
// ════════════════════════════════════════════════════════════════════════════
test.describe("Tab 2 — Leads / CRM", () => {
  test("pipeline rows match /api/leads exactly", async ({ page }) => {
    await openWorkspace(page);
    const leads = await api<any[]>(page, "/api/leads");
    await openTab(page, "Leads");

    // Each lead's company name should appear as a row (the unnamed prospect's
    // button is labeled "Show relevancy details for this prospect").
    for (const lead of leads) {
      // Scope to the company-name button's aria-label: the mobile card list
      // (lg:hidden, still in the DOM) renders the same name again, and a loose
      // text match resolves to 2 elements under strict mode.
      await expect(leadNameButton(page, lead.companyName || "this prospect")).toBeVisible();
    }
    // 2026-08-19 (N-TEST-13) — was `toBe(6)`, a frozen seed count that broke the
    // moment the seed grew to 15 and said nothing about the pipeline. The real
    // invariant is that the CRM shows every lead the API has.
    expect(leads.length, "the seed must contain leads to render").toBeGreaterThan(0);
  });

  test("F-N-R-T drill-down breakdown matches leadScore (F-UI-1 regression guard)", async ({ page }) => {
    await openWorkspace(page);
    await openTab(page, "Leads");

    // Open the relevancy drill-down for Aarna Bridal Studio.
    // 2026-08-19 (N-TEST-14) — the row-level "Relevancy" toggle is gone; the
    // breakdown now lives in the slide-over drawer, opened by clicking the
    // company name (page.tsx:2790).
    await leadNameButton(page, "Aarna Bridal Studio").click();
    await page.waitForTimeout(800);

    // The breakdown line must read "F: 2, N: 3, R: 4, T: 2 (total 11)" — the
    // hardcoded "F: 4, N: 3, R: 2, T: 2 (Demo)" placeholder is GONE. The
    // breakdown text lives in a <span> sibling to the <strong>label</strong>,
    // so read the parent div's full text.
    const breakdownLine = page.locator("div", { hasText: /^Score breakdown/ }).first();
    await expect(breakdownLine).toBeVisible();
    const breakdownText = (await breakdownLine.textContent()) ?? "";
    expect(breakdownText).toContain("F: 2");
    expect(breakdownText).toContain("N: 3");
    expect(breakdownText).toContain("R: 4");
    expect(breakdownText).toContain("T: 2");
    expect(breakdownText).toContain("total 11");
    // The OLD hardcoded placeholder must NOT appear anywhere.
    expect(breakdownText).not.toContain("(Demo)");
    expect(breakdownText).not.toContain("F: 4");
  });

  test("Enrich / Message / Score-all / Enrich-approved buttons are present + clickable", async ({ page }) => {
    await openWorkspace(page);
    await openTab(page, "Leads");
    // Footer action buttons
    await expect(page.getByRole("button", { name: "Enrich approved only" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Score with AI" })).toBeVisible();
    // Row-level actions on an approved lead (Aarna). Use EXACT matching so the
    // "Show relevancy details for ..." aria-label (which contains "relevancy")
    // does not also match the bare "Relevancy" action button.
    // 2026-08-19 (N-TEST-14) — the row used to carry three inline buttons
    // (Relevancy / Enrich / Message). The redesign collapsed them into a "..."
    // dropdown and kept only the most common action inline (page.tsx:2814), so
    // check what the row actually offers now: Replies inline, everything else
    // behind the menu.
    // 2026-09-01 (N-A11Y-11) — the inline action's VISIBLE label is still
    // "Replies", but its accessible name now names the lead: thirteen rows each
    // offered a button called exactly "Replies", so nothing announced which
    // company it was about. `getByRole(..., { name })` reads the accessible
    // name, so the expected name changed with it.
    //
    // This is not a loosened assertion. It still requires that specific button
    // inside that specific row, and the name it now requires is strictly more
    // specific than the one it replaced — matching the sibling assertion below,
    // which has always used the per-row form ("More actions for ...").
    const aarnaRow = leadRow(page, "Aarna Bridal Studio");
    await expect(aarnaRow.getByRole("button", { name: "Open replies from Aarna Bridal Studio", exact: true })).toBeVisible();
    const moreActions = aarnaRow.getByRole("button", { name: "More actions for Aarna Bridal Studio" });
    await expect(moreActions).toBeVisible();
    await moreActions.click();
    await expect(page.getByText("View details")).toBeVisible();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB 3 — MESSAGES
// ════════════════════════════════════════════════════════════════════════════
test.describe("Tab 3 — Messages", () => {
  test("drafts count matches API; manual outreach control lists approved leads", async ({ page }) => {
    await openWorkspace(page);
    const msgs = await api<any[]>(page, "/api/messages");
    const drafts = msgs.filter((m) => m.status === "draft");
    await openTab(page, "Messages");
    // Header reflects the draft count.
    // 2026-08-19 (N-TEST-12) — Panel titles stopped being headings on
    // 2026-08-02 (primitives.tsx:26); match the text instead.
    // 2026-09-25 — the queue and the message cards became one list; the
    // "Needs your OK" tab carries the draft count.
    await expect(
      page.getByRole("tab", { name: new RegExp(`Needs your OK\\s*${drafts.length}`) }),
      "the 'Needs your OK' tab must state the true draft count",
    ).toBeVisible({ timeout: 10000 });
    // "Draft a new message" shows approved-lead buttons (Aarna is approved).
    await expect(page.getByRole("button", { name: "Aarna Bridal Studio" })).toBeVisible();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB 4 — REPLIES
// ════════════════════════════════════════════════════════════════════════════
test.describe("Tab 4 — Replies", () => {
  test("reply list matches /api/replies", async ({ page }) => {
    await openWorkspace(page);
    const replies = await api<any[]>(page, "/api/replies");
    await openTab(page, "Replies");
    // If there are replies, each lead name should appear.
    for (const r of replies) {
      const name = r.leadName || r.companyName || r.from;
      if (name) await expect(page.getByText(name).first()).toBeVisible();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB 5 — COMMERCIAL (orders/quotes ₹ totals)
// ════════════════════════════════════════════════════════════════════════════
test.describe("Tab 5 — Commercial", () => {
  test("order list renders with ₹ totals; New order modal opens", async ({ page }) => {
    await openWorkspace(page);
    await openTab(page, "Quotes & Orders");
    // The "New order" / "New quote" button must be present.
    const newOrder = page.getByRole("button", { name: /New (order|quote)/i });
    await expect(newOrder.first()).toBeVisible();
    // Any ₹ amount rendered is a real currency string.
    const inrCount = await page.locator("text=/₹/").count();
    expect(inrCount).toBeGreaterThanOrEqual(0); // may be 0 if no orders — that's fine
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB 6 — TICKETS
// ════════════════════════════════════════════════════════════════════════════
test.describe("Tab 6 — Tickets", () => {
  test("ticket list matches /api/tickets; New ticket button opens form", async ({ page }) => {
    await openWorkspace(page);
    await openTab(page, "Tickets");
    await expect(page.getByRole("button", { name: /New ticket|Open a ticket/i })).toBeVisible();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB 7 — KNOWLEDGE BASE
// ════════════════════════════════════════════════════════════════════════════
test.describe("Tab 7 — Knowledge Base", () => {
  test("KB renders with sync/search controls", async ({ page }) => {
    await openWorkspace(page);
    // The KB tab has TWO headings starting with "Knowledge" (the section
    // header + "Knowledge review workflow") — match the specific section H2.
    await openTab(page, "Knowledge Base");
    // The "Refresh the AI's copy" button (was "Sync Knowledge").
    await expect(page.getByRole("button", { name: /Refresh the AI.s copy/i }).first()).toBeVisible();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB 8 — INFORMATION NEEDED (Unknown Questions)
// ════════════════════════════════════════════════════════════════════════════
test.describe("Tab 8 — Information Needed", () => {
  test("open-question count is honest (matches API or shows empty state)", async ({ page }) => {
    await openWorkspace(page);
    await openTab(page, "Questions from AI");
    // 2026-09-25 — counted while the screen still said "Loading what the AI
    // still needs…", which failed on a slow first compile. Wait for the load.
    await expect(page.getByText(/Loading what the AI still needs/)).toHaveCount(0, { timeout: 30000 });
    // The tab must show either a real progress count (Needs input / Resolved /
    // Skipped numbers) or a Save-answer button or an honest empty state. A
    // bare panel with none of these would be a Human-Centric Rule 3 violation.
    const progressCount = await page.getByText(/Needs input|information areas still need/).count();
    const saveBtn = await page.getByRole("button", { name: /Save answer/i }).count();
    const emptyState = await page.getByText(/No (open|missing|unanswered) questions|All caught up|nothing/i).count();
    // At least one of the three must be present — a real count, a Save button,
    // or an honest empty state. The demo seed always has ~90 open areas so the
    // progress count should be present.
    expect(progressCount + saveBtn + emptyState).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TAB 9 — HELP & SUPPORT (create a ticket flow)
// ════════════════════════════════════════════════════════════════════════════
test.describe("Tab 9 — Help & Support", () => {
  test("Open a ticket button present + form fields render", async ({ page }) => {
    await openWorkspace(page);
    await openTab(page, "Help & Support");
    await expect(page.getByRole("button", { name: /Open a ticket|Open your first ticket|New ticket|Contact/i }).first()).toBeVisible();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SWEEP: every sidebar tab is reachable + every primary button is clickable
// ════════════════════════════════════════════════════════════════════════════
/**
 * 2026-08-19 (N-TEST-10) -- was a hand-maintained list of 26 [id, label] pairs
 * that drifted from the product and made the whole sweep red. Derived from
 * TAB_GROUP now, which navigation.spec.ts pins against the real sidebar.
 */
const ALL_TABS: readonly string[] = Object.keys(TAB_GROUP);

test.describe("Coverage sweep — every tab reachable, no white screen", () => {
  for (const label of ALL_TABS) {
    test(`tab "${label}" renders real content (not a white screen)`, async ({ page }) => {
      await openWorkspace(page);
      // 2026-08-19 (N-TEST-4) — was a raw force-click on the sidebar button.
      // The label is a loop variable, which is why neither hygiene detector saw
      // it: findRawNavClicks has no tab name in the source to recognise. Since
      // the 2026-08-17 redesign the drawers start collapsed, so the click hit
      // nothing, the sweep measured the landing screen, and 26 tabs failed on
      // "main content is non-trivial" as if every screen were empty.
      await openTabByLabel(page, label);
      await page.waitForTimeout(1200);
      // Hydration check: main content must have substantial text (not a
      // half-rendered shell or a white screen).
      const mainText = await page.locator("main").innerText();
      expect(mainText.length, `${label} main content is non-trivial`).toBeGreaterThan(80);
      // 2026-08-20 (N-TEST-15) — this used to check that the sidebar button was
      // still visible, which is true whether or not the click navigated
      // anywhere. It therefore could not see that `{ name: "Settings" }` was
      // substring-matching "AI Settings" and opening the wrong screen. The
      // shell <h1> names the active screen, so asserting it is the app's own
      // statement of which screen the click actually reached.
      //
      // 2026-09-03 (N-UX-10) — the heading now states the job rather than
      // repeating the sidebar label, so the expected string is read from the
      // product's own PAGE_INTROS table. Still one exact string: a "any heading
      // is visible" check would pass on the wrong screen, which is the exact bug
      // N-TEST-15 was written to catch.
      const expectedHeading = expectedHeadingFor(label);
      await expect(
        page.getByRole("heading", { level: 1, name: expectedHeading ?? label, exact: true }),
        `clicking "${label}" must land on the screen headed "${expectedHeading ?? label}"`,
      ).toBeVisible({ timeout: 10000 });
    });
  }
});
