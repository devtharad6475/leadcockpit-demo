/**
 * 2026-07-21 (Cluster H, session 20) — FULL UI SWEEP.
 *
 * This is the NEW mandatory Ironclad Gate added to build-right v3:
 * "The Full UI Sweep Rule (NO FALSE DONE) — Math tests prove numbers.
 *  They DO NOT prove the app works in a browser. Before you are allowed
 *  to say 'Done,' you MUST run a Playwright smoke that boots the app,
 *  logs in, visits EVERY single route/page, and asserts that it loads
 *  without crashing (HTTP 200, no console errors, no white screen)."
 *
 * Without this, every other fix could be silently broken on a screen
 * the golden/section tests don't visit.
 *
 * Method:
 *   - Boot the demo server.
 *   - Login via Demo Mode.
 *   - Click each of the 22 sidebar tabs in turn.
 *   - For each: assert the page body renders (not white screen), and
 *     collect any console error events.
 *   - At the end: assert ZERO console errors across the entire sweep.
 *
 * Run: npx playwright test full-ui-sweep
 */
import { test, expect } from "@playwright/test";
import { expectAppShell } from "./helpers/login";
import { openTabByLabel, TAB_GROUP } from "./helpers/nav";

/**
 * 2026-08-19 (N-TEST-10) — this file used to keep its OWN table of 26
 * {tab, label} pairs, "sourced from src/app/page.tsx and kept in sync
 * manually". The 2026-08-17 redesign renamed six of those labels and put every
 * tab behind a collapsed drawer, so all 26 lookups matched nothing and the
 * sweep reported:
 *
 *   Pages that failed to load: dashboard (nav button "^Dashboard$" not
 *   visible), tickets (nav button "^Tickets$" not visible), ... (all 26)
 *
 * which reads as "the whole app is broken" and was in fact "the test has a
 * stale copy of the navigation". Neither hygiene detector could see it: the
 * label is a loop variable, so findRawNavClicks has no tab name to recognise,
 * and the click is inline, so findLocalNavHelpers has no helper to inspect.
 *
 * The sweep now walks TAB_GROUP -- the single list of tabs, which
 * navigation.spec.ts compares against the sidebar the app actually renders.
 * A renamed tab now fails in ONE place with a readable diff instead of turning
 * every screen red.
 */
const PAGE_LABELS: readonly string[] = Object.keys(TAB_GROUP);

test.describe("Full UI Sweep — every page loads without crashing", () => {
  test("visit all 26 routes; assert no white screen + no console errors", async ({ page }) => {
    // Collect console errors across the entire sweep. Any error = fail.
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        // Ignore known-benign errors:
        // - favicon 404 (no favicon configured)
        // - dev-mode React DevTools suggestion
        const text = msg.text();
        if (/favicon/i.test(text)) return;
        if (/React DevTools/i.test(text)) return;
        consoleErrors.push(text);
      }
    });
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    // Login via Demo Mode.
    await page.goto("/");
    await page.getByRole("button", { name: /Continue in Demo Mode/i }).click();
    // 2026-08-19 — was an <h1> reading "LeadCockpit". The 2026-08-17 nav redesign
    // moved that string into the sidebar brand (not a heading), so this matched
    // nothing and every test in this file failed at login. See e2e/helpers/login.ts.
    await expectAppShell(page);

    const brokenPages: string[] = [];
    const visited: string[] = [];

    for (const label of PAGE_LABELS) {
      // openTabByLabel expands the drawer the tab lives in first, and THROWS
      // by name if the tab is gone -- so a missing tab is reported as itself
      // rather than as a white screen somewhere else.
      try {
        await openTabByLabel(page, label);
      } catch (e) {
        brokenPages.push(`${label} (could not open: ${(e as Error).message.split("\n")[0]})`);
        continue;
      }
      // Give the page time to fetch + render.
      await page.waitForTimeout(800);

      // Assert NO white screen: the main content area should have SOMETHING
      // rendered (text, panel, table, empty-state). We use the body's text
      // length as a proxy — a crashed page has near-empty body.
      const bodyTextLength = await page.evaluate(() => (document.body.innerText || "").trim().length);
      if (bodyTextLength < 50) {
        brokenPages.push(`${label} (white screen — body has only ${bodyTextLength} chars)`);
      } else {
        visited.push(label);
      }
    }

    // Report.
    console.log(`Visited ${visited.length} / ${PAGE_LABELS.length} pages successfully.`);
    if (brokenPages.length > 0) {
      console.log(`BROKEN PAGES:\n  - ${brokenPages.join("\n  - ")}`);
    }

    // Assertion: every page must render.
    expect(brokenPages, `Pages that failed to load: ${brokenPages.join(", ")}`).toEqual([]);

    // Assertion: zero console errors across the sweep.
    expect(consoleErrors, `Console errors detected:\n${consoleErrors.join("\n")}`).toEqual([]);
    expect(pageErrors, `Uncaught page errors detected:\n${pageErrors.join("\n")}`).toEqual([]);
  });
});
