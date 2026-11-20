/**
 * prod-prisma-every-screen.spec.ts — the read-only Postgres walk (2026-09-05, session 52).
 *
 * THE GAP THIS CLOSES
 * -------------------
 * The 238-test browser suite runs against the JSON file substrate. That is a
 * deliberate, correct choice — its isolation mechanism is "copy a JSON file back
 * over app-data.json between tests", which does nothing against a database, so
 * pointing the mutating specs at Postgres would let them edit and delete rows in
 * the real one with nothing restoring anything. playwright.config.ts explains
 * this at length and it is right.
 *
 * The cost of that choice is a blind spot, and session 52 found four bugs living
 * in it. Every one existed ONLY on Postgres — a removal that the file substrate
 * performs and the database silently discards, a NOT NULL column the file
 * repository defaults and the database repository does not. The browser suite
 * could not have seen any of them, because it never looked at that substrate.
 *
 * `prod-prisma-smoke.spec.ts` looks, but at four screens out of twenty-seven.
 *
 * WHAT THIS ADDS. Every screen in the product, opened against the real database,
 * asserting the three things that are true of a working screen regardless of
 * what is on it:
 *
 *   1. it mounts — a heading renders;
 *   2. nothing on it says the software broke — no error banner, no Next.js dev
 *      overlay, no raw "Error:" text;
 *   3. no request it fired came back 4xx or 5xx, and nothing was logged to the
 *      console as an error.
 *
 * Point 3 is the one that earns this spec. A screen can render perfectly while
 * the call behind it fails, and the failure then shows up as an empty list that
 * looks like "no data yet" — which is exactly how a substrate bug hides.
 *
 * WHY IT IS SAFE TO RUN AGAINST THE REAL DATABASE. It only navigates. It fills
 * nothing in, saves nothing, and presses no button that writes. The isolation
 * problem that keeps the rest of the suite away from Postgres does not apply to
 * a reader, so this needs no test database and destroys nothing.
 *
 * The one thing it deliberately tolerates: some screens perform an idempotent
 * top-up on load (the question framework syncs missing questions when the
 * Questions from AI screen is opened). That is what a real visitor causes, it is
 * the product's own behaviour, and refusing to allow it would mean testing a
 * screen nobody actually opens.
 *
 * HOW TO RUN: `E2E_TARGET=prisma npx playwright test prod-prisma-every-screen`
 */
import { test, expect, type Page } from "@playwright/test";
import { TAB_GROUP, openTabByLabel } from "./helpers/nav";

/**
 * Every screen, in the order the navigation lists them.
 *
 * TAB_GROUP holds the 26 screens that live inside the six drawers. The
 * twenty-seventh is "Needs you", the always-visible leaf the app lands on after
 * sign-in — it is not in TAB_GROUP because it needs no drawer opened, which
 * would make it the one screen a drawer-driven walk quietly skipped. It is
 * covered below as the landing screen, before the loop starts.
 */
const EVERY_TAB = Object.keys(TAB_GROUP);
const LANDING_SCREEN = "Needs you (landing)";

/**
 * How long to let a screen settle before judging it.
 *
 * This was an unbounded `waitForLoadState("networkidle")`, and that is wrong for
 * this app on purpose rather than by accident: the shell polls (the AI status
 * chip refreshes on a timer), so the network NEVER goes idle and the wait ran to
 * Playwright's 30-second default on every screen. Twenty-seven screens x 30s of
 * silence is a thirteen-minute run that looks hung and prints nothing.
 *
 * So networkidle is treated as what it actually is here — a settling hint that
 * usually arrives quickly and sometimes never does. Four seconds is well past
 * the point where a screen's own fetches have landed on a warm dev server.
 */
const SETTLE_MS = 4_000;

// Twenty-seven screens, each compiled on first open by the dev server.
test.describe.configure({ timeout: 900_000, mode: "serial" });

/** Text that means the software broke, as opposed to text a screen legitimately shows. */
const BROKEN_TEXT = [
  /Application error/i,
  /Unhandled Runtime Error/i,
  /Something went wrong on our side/i,
  /Internal Server Error/i,
  /TypeError:/,
  /ReferenceError:/,
  /Cannot read propert/i,
  /is not a function/i,
  /undefined is not/i,
];

/**
 * Console noise that is not a product defect. Kept short and specific on
 * purpose — a broad ignore list is how a console check stops being one.
 */
const IGNORABLE_CONSOLE = [
  /favicon/i,
  /hmr|hot reload|webpack|turbopack/i,
  /Failed to load resource/i,           // covered far better by the network check
  /Download the React DevTools/i,
];

/**
 * SELF-TEST HOOK (L51 — a new check's first green is a claim about the CHECK).
 *
 * This spec's whole value is its three detectors: a failing request, a console
 * error, and broken text on the page. A run where none of them fires is
 * indistinguishable from a run where none of them WORKS, and the second is the
 * more likely of the two for a check nobody has ever seen fire.
 *
 * So the sensitisation is built in rather than done by hand and deleted:
 *
 *     SENSITISE_EVERY_SCREEN=1 E2E_TARGET=prisma npx playwright test prod-prisma-every-screen
 *
 * injects one of each fault into the FIRST screen of the walk and nothing else.
 * The run must then fail, naming that screen and all three detectors. If it
 * passes, the detectors are broken and every green this spec has ever produced
 * meant nothing. Anyone can re-prove that in one command, which is the point of
 * keeping it here instead of describing it in a comment.
 */
const SENSITISE = process.env.SENSITISE_EVERY_SCREEN === "1";

async function injectFaults(page: Page) {
  await page.evaluate(() => {
    console.error("SENSITISE: injected console error");
    const marker = document.createElement("div");
    marker.id = "__sensitise_marker__";
    marker.textContent = "TypeError: injected by SENSITISE_EVERY_SCREEN";
    document.body.appendChild(marker);
    // Fire and forget: the response listener records it whenever it lands.
    void fetch("/api/__sensitise_no_such_route__").catch(() => {});
  });
  // Give the injected request time to come back 404 before the screen is judged.
  await page.waitForTimeout(1500);
}

type ScreenReport = {
  tab: string;
  consoleErrors: string[];
  failedRequests: string[];
  brokenText: string[];
  /** Set when the screen could not be opened or did not mount at all. */
  didNotOpen?: string;
};

async function demoLogin(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Continue in Demo Mode/i }).click();
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => {});
}

test.describe("Every screen, against the real Postgres database (read-only)", () => {
  test("all 27 screens mount, show no error, and fire no failing request", async ({ page }) => {
    /**
     * Bound every click and wait inside this walk.
     *
     * Playwright's default is 30s per action, and nav.ts has no timeout of its
     * own, so ONE blocked click consumed the entire 15-minute test budget and
     * the run reported "test timeout" instead of "this screen would not open".
     * Twenty seconds is far longer than any screen here needs and short enough
     * that a stuck one is reported as a finding while the walk carries on.
     */
    page.setDefaultTimeout(20_000);

    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];

    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (IGNORABLE_CONSOLE.some((pattern) => pattern.test(text))) return;
      consoleErrors.push(text);
    });
    page.on("response", (response) => {
      const url = response.url();
      if (!url.includes("/api/")) return;
      if (response.status() < 400) return;
      failedRequests.push(`${response.status()} ${new URL(url).pathname}`);
    });

    await demoLogin(page);
    await page.waitForTimeout(1200);
    await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => {});

    const reports: ScreenReport[] = [];

    // The landing screen, blamed for what happened before any tab was clicked.
    // Everything from the login click onward belongs to it.
    {
      const body = (await page.locator("body").innerText().catch(() => "")) || "";
      reports.push({
        tab: LANDING_SCREEN,
        consoleErrors: [...consoleErrors],
        failedRequests: [...failedRequests],
        brokenText: BROKEN_TEXT.filter((pattern) => pattern.test(body)).map(String),
      });
    }

    for (const tab of EVERY_TAB) {
      // Take a mark of what had already been reported, so each screen is only
      // blamed for what happened while it was open.
      const consoleMark = consoleErrors.length;
      const requestMark = failedRequests.length;

      // Printed per screen on purpose: the first version of this spec waited
      // silently and a stall was indistinguishable from slow progress.
      console.log(`[every-screen] ${reports.length + 1}/${EVERY_TAB.length + 1} ${tab}`);

      let didNotOpen: string | undefined;
      let brokenText: string[] = [];
      try {
        await openTabByLabel(page, tab);
        // Let the screen's own fetches land. networkidle alone is unreliable on
        // a dev server that is still compiling the route.
        await page.waitForTimeout(1200);
        await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => {});
        if (SENSITISE && tab === EVERY_TAB[0]) await injectFaults(page);

        // A screen with no heading did not mount. Asserted as part of the report
        // rather than as a throw, so one dead screen does not hide the state of
        // the twenty-six after it.
        await page
          .getByRole("heading", { level: 1 })
          .first()
          .waitFor({ state: "visible", timeout: 20_000 });

        const body = (await page.locator("body").innerText().catch(() => "")) || "";
        brokenText = BROKEN_TEXT.filter((pattern) => pattern.test(body)).map(String);
        // The injected marker is a node in a single-page app: without this it
        // survives every later tab switch and the self-test reports 26 broken
        // screens instead of the one it faulted. Removing it here keeps the
        // sensitisation's own output readable.
        if (SENSITISE) await page.evaluate(() => document.getElementById("__sensitise_marker__")?.remove());
      } catch (error) {
        // Keep the first line only: the rest is a Playwright call log, which is
        // useful in the trace and unreadable in a summary.
        didNotOpen = String(error).split(/\r?\n/)[0].trim();
      }

      reports.push({
        tab,
        consoleErrors: consoleErrors.slice(consoleMark),
        failedRequests: failedRequests.slice(requestMark),
        brokenText,
        didNotOpen,
      });
    }

    // One report at the end rather than a throw on the first bad screen: the
    // question worth answering is "which screens are broken", and stopping at
    // the first one answers it twenty-six times slower.
    const bad = reports.filter(
      (report) =>
        report.didNotOpen || report.consoleErrors.length || report.failedRequests.length || report.brokenText.length,
    );

    console.log("");
    console.log(`[every-screen] walked ${reports.length} screens against Postgres · ${bad.length} with findings`);
    for (const report of bad) {
      console.log(`  ${report.tab}`);
      if (report.didNotOpen) console.log(`    did not open:     ${report.didNotOpen}`);
      if (report.failedRequests.length) console.log(`    failing requests: ${report.failedRequests.join(", ")}`);
      if (report.consoleErrors.length) console.log(`    console errors:   ${report.consoleErrors.join(" | ").slice(0, 500)}`);
      if (report.brokenText.length) console.log(`    broken-text:      ${report.brokenText.join(", ")}`);
    }
    console.log("");
    // A count assertion, because a walk that silently visited fewer screens than
    // the app has is the exact failure this spec exists to prevent elsewhere.
    expect(reports.length, "the walk must cover every screen the app offers").toBe(EVERY_TAB.length + 1);


    expect(
      bad.map((report) =>
        `${report.tab}: ${[
          report.didNotOpen ? `did not open — ${report.didNotOpen}` : "",
          report.failedRequests.length ? `requests ${report.failedRequests.join(", ")}` : "",
          report.consoleErrors.length ? `console ${report.consoleErrors.join(" | ").slice(0, 300)}` : "",
          report.brokenText.length ? `text ${report.brokenText.join(", ")}` : "",
        ].filter(Boolean).join(" · ")}`,
      ),
      "screens that would not open, failed a request, logged a console error, or showed broken text, running against the real Postgres database",
    ).toEqual([]);
  });
});
