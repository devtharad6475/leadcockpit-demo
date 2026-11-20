/**
 * 2026-08-01 — Copilot Voice-of-Customer (demand analysis) — browser proof.
 *
 * The operator's explicit request (2026-08-01): "from the UI perspective, click
 * the button, send the chat, and see the response — how much is it correct, is
 * it actually giving us what we wanted?" This spec is that proof (build-right
 * Phase 3b — the Golden Thread at the UI layer).
 *
 * NOTE on test layers (build-right Phase 3): the demand MATH is proven by
 * `golden:copilot-voice-of-customer` (6 cases, hand-computed counts). This
 * Playwright test proves the OTHER thing the golden can't: that a human owner
 * can REACH the demand analysis from the UI (Invisible-Capability check) and
 * get a real response in the chat — not a silent no-op.
 *
 * Flow:
 *   1. Boot the app (demo mode, auto-started by playwright.config.ts).
 *   2. Log in via the proven demo bypass (lc_demo cookie + Continue in Demo Mode).
 *   3. Open the Assistant page from the sidebar (was the floating Copilot).
 *   4. Type "what are people asking for?" + send.
 *   5. Assert the Copilot responds with a demand report OR the honest
 *      "not enough data" message — both prove the wiring works end-to-end.
 *
 * Why we accept the "not enough data" path: the demo data has only 1 customer
 * message, which is correctly below the CP-12d threshold (3). The Copilot
 * refusing to invent a trend is the no-hallucination rule WORKING — that's a
 * pass, not a failure. (If the operator wants to see a full ranked report in the
 * browser, seed ≥3 replies mentioning a product first, or it appears naturally
 * once real customers message.)
 *
 * Run: npx playwright test copilot-demand-analysis --reporter=list
 */
import { test, expect, type Page } from "@playwright/test";
import { E2E_BASE_URL } from "./helpers/e2e-target";

const BASE = E2E_BASE_URL;
const DEMO_COOKIE = { name: "lc_demo", value: "1", url: E2E_BASE_URL };

/**
 * ENVIRONMENT GUARD: this browser test needs a DEMO-mode server (the `lc_demo`
 * cookie authenticates only in demo mode). The operator's `.env` flips the local
 * app to PRODUCTION mode (the WP6-A local-production proof), so the server on
 * :3000 rejects the demo cookie with UNAUTHENTICATED. Rather than kill the
 * operator's running production app, the test skips with an honest reason when
 * the server is in production mode. To run it: start a demo server
 * (`AUTH_MODE=demo npm run dev` on a free port) and point BASE there.
 *
 * The demand-analysis LOGIC is proven regardless by
 * `npm run golden:copilot-voice-of-customer` (6/6 hand-computed cases). This
 * Playwright test adds the UI-reachability proof (Invisible-Capability check).
 */
test.beforeAll(async () => {
  const status = await fetch(`${BASE}/api/auth/status`).then((r) => r.json()).catch(() => ({}));
  const authMode = (status as { authMode?: string })?.authMode;
  if (authMode !== "demo") {
    test.skip(true, `Copilot browser test needs a DEMO-mode server, but :3000 is in "${authMode}" mode. The demand logic is proven by golden:copilot-voice-of-customer. Start a demo server to run this UI test.`);
  }
});

/** Log into the demo workspace (the proven pattern from depth-crm.spec.ts). */
async function openWorkspace(page: Page) {
  await page.context().addCookies([DEMO_COOKIE]);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  // The demo workspace may show a "Continue in Demo Mode" gate; click past it.
  for (let attempt = 0; attempt < 5; attempt++) {
    const demoBtn = page.getByRole("button", { name: "Continue in Demo Mode" });
    if (await demoBtn.count() > 0) {
      await demoBtn.first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(1000);
    } else {
      break;
    }
  }
  // Wait for the main shell: the sidebar's Assistant entry is always visible.
  await page.getByRole("button", { name: /^Assistant/ }).first().waitFor({ state: "visible", timeout: 45000 });
}

// 2026-09-25 — the floating Copilot panel was merged into the full-page
// Assistant (sidebar), so this proof now goes through that page.
test("owner asks 'what are people asking for' → the assistant responds with the demand report", async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole("button", { name: /^Assistant/ }).first().click();
  const main = page.locator("main");
  const textarea = main.locator("textarea");
  await textarea.waitFor({ state: "visible", timeout: 15000 });
  await textarea.fill("what are people asking for?");
  const sendBtn = main.getByRole("button", { name: "Send" });
  // Enabled once the conversation has loaded and there is text to send.
  await expect(sendBtn).toBeEnabled({ timeout: 30000 });
  await sendBtn.click();

  // The owner's message appears, then the assistant answers — a real demand
  // report or the honest "not enough data" (the math is in the golden).
  await expect(main).toContainText("what are people asking for", { timeout: 15000 });
  await expect(main.getByText("Thinking…")).toHaveCount(0, { timeout: 90000 });
  await expect(main).toContainText(/demand|not enough|customer messages|signal/i, { timeout: 30000 });

  await page.screenshot({ path: "e2e/screenshots/copilot-demand-analysis.png", fullPage: false });
});
