/**
 * 2026-07-26 (Cluster 5) — Silent-catch family + inline error states.
 *
 * Pins the Cluster-5 fixes from docs/AUDIT-FINDINGS-2026-07-26.md:
 *   P1-2 (backend) — golden:safe-not-found pins the wrapper contract at the
 *     math layer; this file does NOT re-test the wrapper (the golden test
 *     owns that). It proves the END-TO-END effect: when a backend repo
 *     throws a non-not-found error, the user sees it instead of an empty
 *     list presented as the truth.
 *   P1-10 (UI) — the 7 inline screens (Integrations, AISettings,
 *     WhatsAppAgentSettings, KnowledgeBase, UnknownQuestions, AIReviewQueue,
 *     StructuredSettingsPanel) surface "Couldn't load" + a Try again button
 *     when their GET fails (was: silent blank panel forever).
 *   P1-11 (UI) — the Dashboard "Loading workspace data…" panel has an escape
 *     hatch. If /api/state hard-fails it shows "Couldn't load your workspace"
 *     + Try again (was: stuck on the loading panel forever).
 *
 * Per build-right Phase 3b: a UI feature is NOT done just because the code
 * compiles. We launch a headless browser, force the GET to fail, and assert
 * the user sees the error + can retry.
 *
 * Run: npx playwright test cluster5-silent-catch
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

test.describe("Cluster 5 — silent-catch family + inline error states", () => {

  test("P1-10: KnowledgeBase — failed GET shows 'Couldn't load' + Try again (not a silent blank)", async ({ page }) => {
    await loginDemo(page);

    // Force BOTH KnowledgeBase loads to fail. (KnowledgeBase calls two GETs:
    // /api/knowledge/documents and /api/knowledge/question-answers.)
    await page.route("**/api/knowledge/documents", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"error":{"message":"boom documents"}}' }),
    );
    await page.route("**/api/knowledge/question-answers", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"error":{"message":"boom answers"}}' }),
    );

    await openTabByLabel(page, "Knowledge Base");
    await page.waitForTimeout(2000);

    // The screen must surface the "Couldn't load" card + a Try again button.
    await expect(page.getByText(/couldn't load/i).first(),
      "KnowledgeBase must surface a visible 'Couldn't load' message when its GET fails").toBeVisible({ timeout: 8000 });
    await expect(page.getByRole("button", { name: /try again/i }).first(),
      "KnowledgeBase must offer a Try again button when its GET fails").toBeVisible({ timeout: 4000 });
  });

  test("P1-10: AISettings — failed GET shows 'Couldn't load' + Try again", async ({ page }) => {
    await loginDemo(page);

    await page.route("**/api/ai/settings", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"error":{"message":"ai settings boom"}}' }),
    );
    await page.route("**/api/ai/providers", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"error":{"message":"providers boom"}}' }),
    );

    await openTabByLabel(page, "AI Settings");
    await page.waitForTimeout(2000);

    await expect(page.getByText(/couldn't load/i).first(),
      "AISettings must surface a visible 'Couldn't load' message").toBeVisible({ timeout: 8000 });
    await expect(page.getByRole("button", { name: /try again/i }).first(),
      "AISettings must offer a Try again button").toBeVisible({ timeout: 4000 });
  });

  test("P1-10: Try again actually re-fetches (the button is wired)", async ({ page }) => {
    await loginDemo(page);

    // Phase 1: KnowledgeBase GET fails → screen shows error + Try again.
    let failKnowledge = true;
    await page.route("**/api/knowledge/documents", (route) => {
      if (failKnowledge) {
        return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":{"message":"boom"}}' });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route("**/api/knowledge/question-answers", (route) => {
      if (failKnowledge) {
        return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":{"message":"boom"}}' });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });

    await openTabByLabel(page, "Knowledge Base");
    await page.waitForTimeout(1500);
    await expect(page.getByRole("button", { name: /try again/i }).first()).toBeVisible({ timeout: 8000 });

    // Phase 2: flip the failure off, click Try again — the error card MUST
    // disappear (proving the click re-fetched and the new GET succeeded).
    failKnowledge = false;
    await page.getByRole("button", { name: /try again/i }).first().click();
    await page.waitForTimeout(2000);

    // The "Couldn't load" card should be gone — either the empty-state or the
    // knowledge base UI replaces it. (Both are fine; what matters is the error
    // card is NOT there anymore.)
    await expect(page.getByText(/couldn't load/i).first()).toHaveCount(0, { timeout: 8000 });
  });

  test("P1-11: Dashboard — if /api/state hard-fails, escape hatch shows (not infinite spinner)", async ({ page }) => {
    await loginDemo(page);

    // Force the load-bearing /api/state to fail. Other GETs succeed.
    await page.route("**/api/state", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"error":{"message":"state boom"}}' }),
    );

    // Navigate to dashboard (default after login) and trigger a reload.
    await openTabByLabel(page, "Dashboard");
    await page.getByRole("button", { name: /Refresh/i }).first().click();
    await page.waitForTimeout(2500);

    // The operator must be told the load failed and given a way to retry. It
    // must NOT be stuck on "Loading workspace data..." forever, and — the part
    // that actually bit us — it must not render a screen full of confident
    // numbers over data that never arrived.
    //
    // 2026-09-03 (N-SEC-3, N-UX-11). This used to look for the Dashboard's own
    // "Couldn't load" card. That card is gone: the check moved UP to the shell,
    // above the section switch, so ALL 26 screens are covered by one gate
    // instead of the Dashboard alone (Needs You used to show a green "Nothing
    // needs you" tick over the very same failed load). The strings below are
    // the new screen's real copy — re-pointed, not relaxed. A loosened version
    // (any "load" substring, or "some heading is visible") would pass on the
    // old broken behaviour too, which defeats the point of the test.
    await expect(
      page.getByRole("heading", { name: "Your workspace didn't load", exact: true }),
      "a failed /api/state must say so in the largest text on the screen",
    ).toBeVisible({ timeout: 8000 });
    await expect(
      page.getByRole("button", { name: "Try loading again", exact: true }),
      "and must offer a way out, not just an explanation",
    ).toBeVisible({ timeout: 8000 });

    // The old bug, in one assertion: the shell must not be claiming everything
    // is fine underneath the failure notice.
    await expect(page.getByText("Nothing needs you", { exact: true })).toHaveCount(0);
  });
});
