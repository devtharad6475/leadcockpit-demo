/**
 * Example Playwright smoke test — login flow in demo mode.
 *
 * This is the harness's "hello world" — it proves the browser can boot the
 * app, see the login screen, click the demo button, and land on the
 * dashboard. Future UI tests will follow the same shape: navigate → assert
 * visible content → interact → assert result → assert empty/error paths.
 *
 * Skill v2 (Phase 3b): a UI feature is NOT done until a Playwright test
 * clicks through it. This file exists so that precondition is met for the
 * harness itself; the next UI feature that lands will add its own .spec.ts
 * alongside this one.
 *
 * Run:  npm run test:e2e
 *
 * ---------------------------------------------------------------------------
 * HYDRATION BLOCKER RESOLVED 2026-07-21 (M0):
 * The two tests below were `test.fixme` from 2026-07-19 because the App
 * Router's internal RSC bootstrap scripts (self.__next_r / self.__next_f)
 * were being blocked by the strict CSP `script-src 'self'`, killing React
 * hydration entirely. Root cause + fix are documented in docs/DECISIONS.md
 * (2026-07-21 M0). The fix moves CSP generation into src/middleware.ts
 * with a per-request nonce on script-src; Next.js auto-attaches the nonce
 * to its generated inline scripts, so they execute normally.
 *
 * Both tests are now live. They will catch any future regression that
 * re-introduces the hydration failure.
 * ---------------------------------------------------------------------------
 */
import { test, expect } from "@playwright/test";

test.describe("Demo-mode login", () => {
  test("login screen renders with the expected H1 and demo button", async ({ page }) => {
    // Smoke test — verifies the SSR render. Useful as a smoke that the
    // page boots at all.
    await page.goto("/");
    await expect(page.locator("h1")).toContainText("Agent-assisted B2B lead generation");
    await expect(page.getByRole("button", { name: /Continue in Demo Mode/i })).toBeVisible();
  });

  test("login screen renders and demo button opens the dashboard", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toContainText("Agent-assisted B2B lead generation");

    const demoButton = page.getByRole("button", { name: /Continue in Demo Mode/i });
    await demoButton.waitFor({ state: "visible" });
    await demoButton.click();

    // 2026-08-19 — this used to require an H1 reading "LeadCockpit" and the text
    // "Demo Owner". The 2026-08-17 navigation redesign moved "LeadCockpit" into
    // the sidebar brand (no longer a heading at all) and made the H1 the queue
    // status — "8 things need you" / "Nothing needs you". Separately, the demo
    // owner is now named "Owner". Both assertions had been failing.
    //
    // Deliberately STRUCTURAL now. This is the login smoke: its job is to prove
    // the app shell mounted after the demo button, not to police copy. Asserting
    // on wording is what made a UI rename look like a login failure, and the
    // data-content assertions belong in the specs that are about data.
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    await expect(page.getByText("LeadCockpit").first()).toBeVisible();
  });

  test("no hard console errors after login", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    const demoButton = page.getByRole("button", { name: /Continue in Demo Mode/i });
    await demoButton.click();

    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(2000);

    const hardErrors = errors.filter((msg) =>
      !msg.includes("hydration") &&
      !msg.includes("did not match") &&
      !msg.includes("server-rendered HTML")
    );
    expect(hardErrors, `Unexpected page errors: ${hardErrors.join("; ")}`).toEqual([]);
  });
});
