/**
 * ANGLE 6 VISUAL POLISH AUDIT — standalone screenshot sweep at 1440px.
 *
 * Navigates to the config's baseURL — :3001 under e2e/visual-audit.config.ts,
 * :3000 under the main config. It used to hard-code :3001, so under the main
 * suite it failed with `net::ERR_CONNECTION_REFUSED at http://localhost:3001/`
 * before it reached a single assertion. Logs in via the one-click demo entry,
 * then visits all 26 workspace tabs + screenshots each (full page) into
 * e2e/visual-shots/. Also dumps computed styles for representative
 * buttons/cards/badges so the auditor can compare token usage.
 *
 * Run:  npx playwright test --config=e2e/visual-audit.config.ts visual-audit-sweep
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { expectAppShell } from "./helpers/login";
import { openTabByLabel, TAB_GROUP, expectedHeadingFor } from "./helpers/nav";

/**
 * 2026-08-19 (N-TEST-10) -- was a hand-written table of 26 [id, label] rows
 * with a beforeAll() guard that checked each label still existed in TAB_GROUP.
 * The guard caught RENAMES but not ADDITIONS: a new tab simply went unswept,
 * silently, which is the same class of drift one step quieter. Derived from
 * TAB_GROUP now, so the sweep covers whatever the navigation actually offers
 * and the guard has nothing left to check.
 */
const toTabId = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const TABS: ReadonlyArray<[string, string]> = Object.keys(TAB_GROUP).map(
  (label) => [toTabId(label), label] as [string, string],
);

const SHOT_DIR = path.join(__dirname, "visual-shots");

test.beforeAll(() => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
});

// 26 tabs x (open drawer + navigate + settle 1.2s + networkidle + a full-page
// screenshot) does not fit the 90s default, and never could: the first real run
// died at `Test timeout of 90000ms exceeded` around tab 14 with 13 good shots on
// disk and no report. This is one long sweep by design — one context, one login,
// 26 screens — so the budget is per-sweep, not per-tab.
test.describe.configure({ timeout: 300_000 });

test("visual audit sweep — 26 tabs @ 1440px", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // --- login ---
  // Relative — resolved against the config's baseURL, so this file works
  // under both the standalone visual-audit config and the main suite.
  await page.goto("/");
  await page.getByRole("button", { name: /Continue in Demo Mode/i }).click();
  // 2026-08-19 — was an <h1> reading "LeadCockpit". The 2026-08-17 nav redesign
  // moved that string into the sidebar brand (not a heading), so this matched
  // nothing and every test in this file failed at login. See e2e/helpers/login.ts.
  await expectAppShell(page, 30_000);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1500);

  const report: Array<{ tab: string; status: string; note?: string }> = [];

  for (const [tabId, label] of TABS) {
    try {
      // dismiss any next dev overlay
      await page.locator("nextjs-portal button[aria-label='Close']").first().click({ timeout: 1500 }).catch(() => {});

      // 2026-08-19 (N-TEST-4) — was a direct click on the sidebar button. Since
      // the redesign the drawers start collapsed, so 25 of these 26 labels are
      // not in the DOM until their drawer is opened: the sweep screenshotted the
      // landing screen 26 times and reported FAIL on every tab.
      await openTabByLabel(page, label);
      await page.waitForTimeout(1200);
      await page.waitForLoadState("networkidle").catch(() => {});

      // 2026-08-20 (N-TEST-15) — a screenshot named after a tab it does not
      // show is worse than no screenshot: settings.png and ai-settings.png came
      // back byte-identical because the nav locator substring-matched. The
      // shell <h1> names the active screen, so check it before shooting.
      //
      // 2026-09-03 (N-UX-10) — the heading now states the screen's job instead
      // of repeating the sidebar label, so the expected string comes from the
      // product's own PAGE_INTROS table. Still exact: a screenshot is only
      // trustworthy if we proved WHICH screen it shows.
      const expectedHeading = expectedHeadingFor(label);
      await expect(
        page.getByRole("heading", { level: 1, name: expectedHeading ?? label, exact: true }),
        `screenshot "${tabId}.png" must be of the "${label}" screen (heading "${expectedHeading ?? label}")`,
      ).toBeVisible({ timeout: 10000 });

      await page.screenshot({ path: path.join(SHOT_DIR, `${tabId}.png`), fullPage: true });

      // also capture a viewport-only (above-the-fold) shot for header comparison
      await page.screenshot({ path: path.join(SHOT_DIR, `${tabId}-fold.png`), fullPage: false });

      report.push({ tab: `${tabId} (${label})`, status: "OK" });
    } catch (e) {
      await page.screenshot({ path: path.join(SHOT_DIR, `${tabId}-FAILED.png`), fullPage: true }).catch(() => {});
      report.push({ tab: `${tabId} (${label})`, status: "FAIL", note: (e as Error).message });
    }
  }

  // --- dump computed styles for representative elements on a few key screens ---
  const styleDump: Record<string, unknown> = {};

  // Dashboard: grab first Card + first .btn + first Badge
  const clickTab = async (label: string) => {
    await openTabByLabel(page, label);
    await page.waitForTimeout(900);
  };
  void clickTab;

  const styles = await page.evaluate(() => {
    const pick = (sel: string): Record<string, string> | null => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        class: el.className.toString().slice(0, 160),
        borderRadius: cs.borderRadius,
        background: cs.backgroundColor,
        color: cs.color,
        boxShadow: cs.boxShadow.slice(0, 120),
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
      };
    };
    const pickAll = (sel: string): Record<string, string>[] =>
      Array.from(document.querySelectorAll(sel))
        .slice(0, 4)
        .map((el) => {
          const cs = getComputedStyle(el as HTMLElement);
          return {
            tag: (el as HTMLElement).tagName.toLowerCase(),
            class: (el as HTMLElement).className.toString().slice(0, 120),
            borderRadius: cs.borderRadius,
            background: cs.backgroundColor,
            color: cs.color,
            fontSize: cs.fontSize,
            fontWeight: cs.fontWeight,
          };
        });
    return {
      // button kinds
      btnClass: pickAll("button.btn"),
      btnComponent: pickAll("button:not(.btn)"),
      // cards / panels
      sectionRoundedXl: pick("section.rounded-xl"),
      // badges
      badges: pickAll("span.rounded-full"),
      // headings
      h1: (() => { const el = document.querySelector("h1"); if (!el) return null; const cs = getComputedStyle(el); return { text: el.textContent, fontSize: cs.fontSize, fontWeight: cs.fontWeight }; })(),
      h2s: pickAll("h2"),
    };
  });
  styleDump.current = styles;

  fs.writeFileSync(path.join(SHOT_DIR, "styles.json"), JSON.stringify(styleDump, null, 2));
  fs.writeFileSync(path.join(SHOT_DIR, "report.json"), JSON.stringify(report, null, 2));

  console.log("\n=== VISUAL AUDIT SWEEP ===");
  for (const r of report) console.log(`${r.status.padEnd(4)} ${r.tab}${r.note ? "  -- " + r.note : ""}`);
  console.log(`Screenshots + styles.json in ${SHOT_DIR}\n`);

  await ctx.close();
  expect(report.every((r) => r.status === "OK")).toBeTruthy();
});
