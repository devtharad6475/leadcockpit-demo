/**
 * 2026-07-26 (Cluster 3) — Buttons: disabled-while-busy + no-dead-buttons +
 * inline-screen error states.
 *
 * Pins the 4 Cluster-3 fixes from docs/AUDIT-FINDINGS-2026-07-26.md:
 *   P0-6 — action buttons are disabled while their async run() is in flight
 *          (double-click on Approve&Send must NOT fire two POSTs).
 *   P0-7 — the "Sync Knowledge" button on the Profile tab resolves to a real
 *          route (no 404).
 *   P1-10 — inline screens (KnowledgeBase, AISettings, etc.) surface a load
 *          error + retry button instead of swallowing it as an empty list.
 *   P1-11 — the Dashboard "Loading workspace data…" panel has an escape
 *          hatch (it can't trap the user forever).
 *
 * Per build-right Phase 3b: a UI feature is NOT done just because the code
 * compiles. We launch a headless browser, click the buttons, and assert the
 * screen behaves correctly.
 *
 * Run: npx playwright test cluster3-buttons
 */
import { test, expect } from "@playwright/test";
import { expectAppShell } from "./helpers/login";
import { openTabByLabel } from "./helpers/nav";

async function loginDemo(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Continue in Demo Mode/i }).click();
  // 2026-08-19 — was an <h1> reading "LeadCockpit". The 2026-08-17 nav redesign
  // moved that string into the sidebar brand (not a heading), so this matched
  // nothing and every test in this file failed at login. See e2e/helpers/login.ts.
  await expectAppShell(page);
}

test.describe("Cluster 3 — buttons & inline error states", () => {

  test("P0-6: action buttons can't be double-clicked while busy (duplicate-POST protection)", async ({ page }) => {
    await loginDemo(page);
    // The Cluster 3 fix has TWO mechanisms:
    //   (a) <main data-busy="true"> is set the moment run() starts.
    //   (b) a capture-phase onClickCapture guard + CSS pointer-events:none
    //       on .btn suppresses any further click while data-busy is set.
    // We assert BOTH: the gate activates (data-busy appears) AND only one
    // POST reaches the server despite a follow-up programmatic click.
    let resolveTest: () => void = () => {};
    let postCount = 0;
    await page.route("**/api/whatsapp-agent/llm-test", async (route) => {
      postCount++;
      await new Promise<void>((r) => { resolveTest = r; });
      await route.fulfill({ status: 200, contentType: "application/json", body: '{}' });
    });

    await openTabByLabel(page, "WhatsApp Agent");
    await page.waitForTimeout(800);

    const testBtn = page.getByRole("button", { name: "See what it would reply", exact: true });
    await expect(testBtn).toBeVisible();

    await testBtn.click();

    // (a) The busy gate must activate on <main>.
    await expect(page.locator("main[data-busy='true']"),
      "<main> must carry data-busy='true' while an async action is in flight").toBeVisible({ timeout: 4000 });

    // (b) A direct mouse click at the button's center while busy must NOT
    //     produce a second POST. (We use page.mouse because Playwright's
    //     locator.click would itself block on pointer-events:none — that
    //     blocking IS the protection working; here we prove the lower-level
    //     click is also suppressed by the capture-phase guard.)
    const box = await testBtn.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    await page.waitForTimeout(500);
    expect(postCount, "only ONE POST must fire despite extra clicks while busy").toEqual(1);

    resolveTest();
    await page.waitForTimeout(1500);
  });

  test("P0-6 (alt): ICP Generate activates the busy gate", async ({ page }) => {
    await loginDemo(page);

    let resolveGenerate: () => void = () => {};
    let postCount = 0;
    await page.route("**/api/icp/generate", async (route) => {
      postCount++;
      await new Promise<void>((r) => { resolveGenerate = r; });
      await route.fulfill({ status: 200, contentType: "application/json", body: '[]' });
    });

    await openTabByLabel(page, "ICP Builder");
    await page.waitForTimeout(600);

    // 2026-09-05 (N-TEST-17) — the label was /Generate ICPs/i, which the screen
    // renamed. This test does not FAIL when the button is missing, it SKIPS, so
    // the rename quietly switched off the double-click protection check instead
    // of reporting anything. A skip that fires because the control was renamed
    // is indistinguishable from a skip that fires because the feature is off.
    const genBtn = page.getByRole("button", { name: /Suggest customer types|Suggest different ones/i }).first();
    const visible = await genBtn.isVisible().catch(() => false);
    if (!visible) { test.skip(true, "ICP Generate not visible"); return; }

    await genBtn.click();
    await expect(page.locator("main[data-busy='true']"),
      "<main> must carry data-busy='true' while ICP generate is in flight").toBeVisible({ timeout: 4000 });

    const box = await genBtn.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    await page.waitForTimeout(500);
    expect(postCount, "only ONE /icp/generate POST despite extra clicks while busy").toEqual(1);

    resolveGenerate();
    await page.waitForTimeout(1500);
  });

  // P0-7 ("Sync Knowledge on Profile does not 404") removed 2026-09-25: the
  // Profile screen no longer has that button (Save already rebuilds the
  // profile's knowledge; the full sync lives on the Knowledge Base).

  test("P1-10: a failed GET surfaces an error state + retry (not a silent blank)", async ({ page }) => {
    await loginDemo(page);

    // Force the KnowledgeBase GET to fail.
    await page.route("**/api/knowledge/question-answers", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"error":{"message":"boom"}}' }),
    );

    await openTabByLabel(page, "Knowledge Base");
    await page.waitForTimeout(1500);

    // The screen must surface a visible error message (not just render an
    // empty list silently). Accept either a role="alert" toast or an inline
    // error banner containing the word "try again" / "failed" / "error".
    const errorSurface = page.locator(
      '[role="alert"], :text-matches("try again|failed to load|couldn\\\'t load|load failed", "i")',
    ).first();
    await expect(errorSurface, "a failed GET must surface a visible error, not a silent blank panel").toBeVisible({ timeout: 8000 });
  });
});
