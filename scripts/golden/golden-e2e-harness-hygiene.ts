/**
 * golden-e2e-harness-hygiene.ts — N-TEST-4 / N-TEST-5 pin (2026-08-19, CEO-loop session 8).
 *
 * WHAT WENT WRONG
 * ---------------
 * Two harness bugs put 44 and ~30 tests into the red respectively, and neither
 * failure named its own cause:
 *
 *   N-TEST-5 — nine `depth-*` specs read `.leadgen-data/app-data.json` off disk
 *   to prove a save persisted, while the suite's dev server had been moved onto
 *   `.leadgen-data-e2e/app-data.json` (so it would stop destroying the product's
 *   demo data set). Every one of those assertions read a file the test had never
 *   written to, and reported it as the API dropping the field.
 *
 *   N-TEST-4 — specs clicked navigation tabs directly. The 2026-08-17 redesign
 *   made every drawer start collapsed, so those buttons are not in the DOM until
 *   the drawer is opened. The clicks waited out the budget and blamed the screen.
 *
 * WHY IT IS PINNED THIS WAY
 * -------------------------
 * The regression here IS a test, so there is no runtime behaviour to assert on.
 * The pin is therefore a static check over the suite's own source — and the risk
 * with a static check is that it passes because it found nothing ANYWHERE,
 * including in code that is broken. So the detectors are exercised against
 * synthetic files that break each rule on purpose (CASE A, CASE D) before the
 * real suite is checked (CASE C, CASE E). If a detector stops detecting, A or D
 * fails first and says so.
 *
 * HAND-COMPUTED CONTRACT:
 *
 *   CASE A — the data-path detector flags a spec that hard-codes .leadgen-data.
 *   CASE B — it does NOT flag a spec that imports E2E_DATA_FILE, nor a comment
 *            that merely mentions the old path (every fix comment does).
 *   CASE C — no real e2e spec hard-codes the product data directory.
 *   CASE D — the nav detector flags a direct click on a known tab, and does NOT
 *            flag a non-click assertion about the same button.
 *   CASE E — no real e2e spec clicks a navigation tab directly.
 *   CASE F — the tab-label list is parsed from nav.ts and is non-trivial (a
 *            detector fed an empty label list finds nothing and looks green).
 *   CASE H — the local-helper detector flags a spec-private openTab() that does
 *            not delegate, and accepts one that wraps openTabByLabel.
 *   CASE I — no real e2e spec has a non-delegating local navigation helper.
 *   CASE G — the suite's data directory is still isolated from the product's.
 *   CASE J — the nav-table detector flags a spec that keeps its own list of tab
 *            labels, and does NOT flag a spec that names one or two tabs it
 *            visits, nor one that derives the list from TAB_GROUP.
 *   CASE K — no real e2e spec keeps a second copy of the navigation.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { E2E_DATA_DIR, PRODUCT_DATA_DIR, assertE2EDataDirIsIsolated } from "../../e2e/helpers/data-dir";
import {
  findHardCodedDataPaths,
  findLocalNavHelpers,
  findNavLabelTables,
  findRawNavClicks,
  parseTabLabels,
  type SourceFile,
} from "../lib/e2e-harness-hygiene";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message.split("\n").join("\n        ")}`);
  }
}

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const E2E_DIR = path.join(REPO_ROOT, "e2e");

function readSpecs(): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "visual-shots") continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      // data-dir.ts is the ONE file allowed to name both directories: it is
      // where the split is defined.
      if (full.endsWith(path.join("helpers", "data-dir.ts"))) continue;
      out.push({ path: path.relative(REPO_ROOT, full).replace(/\\/g, "/"), source: fs.readFileSync(full, "utf8") });
    }
  };
  walk(E2E_DIR);
  return out;
}

function render(findings: { path: string; line: number; text: string; why: string }[]): string {
  return findings.map((f) => `  ${f.path}:${f.line}\n    ${f.text}\n    → ${f.why}`).join("\n");
}

console.log("");
console.log("=== GOLDEN e2e-harness-hygiene (N-TEST-4 / N-TEST-5) ===");
console.log("");

const specs = readSpecs();
const navSource = fs.readFileSync(path.join(E2E_DIR, "helpers", "nav.ts"), "utf8");
const labels = parseTabLabels(navSource);

check("CASE A — the detector flags a spec that hard-codes the product data path", () => {
  const findings = findHardCodedDataPaths([
    {
      path: "synthetic/bad.spec.ts",
      source: `const DATA_FILE = path.join(REPO_ROOT, ".leadgen-data", "app-data.json");`,
    },
  ]);
  assert.strictEqual(findings.length, 1, "the exact line that broke 44 tests must be flagged");
  assert.match(findings[0].why, /never wrote to/, "the finding has to explain the consequence, not just point");
});

check("CASE B — it does not flag the fixed form, nor a comment about the old one", () => {
  const findings = findHardCodedDataPaths([
    {
      path: "synthetic/good.spec.ts",
      source: [
        `import { E2E_DATA_FILE } from "./helpers/data-dir";`,
        `// was path.join(REPO_ROOT, ".leadgen-data", "app-data.json") — see N-TEST-5`,
        `const DATA_FILE = E2E_DATA_FILE;`,
        `const dir = E2E_DATA_DIR; // .leadgen-data-e2e`,
      ].join("\n"),
    },
  ]);
  assert.deepStrictEqual(
    findings,
    [],
    "THIS is the case a blunt `includes('.leadgen-data')` check fails: every one of the " +
      "nine fixes left a comment naming the old path, so a detector that cannot tell code " +
      "from commentary flags all nine fixed files and gets switched off",
  );
});

check("CASE C — no real e2e spec hard-codes the product data directory", () => {
  const findings = findHardCodedDataPaths(specs);
  assert.deepStrictEqual(
    findings.map((f) => `${f.path}:${f.line}`),
    [],
    `a spec is reading or writing the PRODUCT data set:\n${render(findings)}`,
  );
});

check("CASE D — the nav detector flags a direct tab click, but not an assertion", () => {
  const flagged = findRawNavClicks(
    [
      {
        path: "synthetic/bad.spec.ts",
        source: `await page.getByRole("button", { name: "Leads" }).first().click({ force: true });`,
      },
    ],
    labels,
  );
  assert.strictEqual(flagged.length, 1, "a direct click on a collapsed-drawer tab must be flagged");

  const notFlagged = findRawNavClicks(
    [
      {
        path: "synthetic/ok.spec.ts",
        source: [
          `await expect(nav.getByRole("button", { name: "Leads", exact: true })).toHaveCount(0);`,
          `await openTabByLabel(page, "Leads");`,
        ].join("\n"),
      },
    ],
    labels,
  );
  assert.deepStrictEqual(
    notFlagged,
    [],
    "navigation.spec.ts asserts that a collapsed drawer's tab is ABSENT — that is the test " +
      "which proves the drawers start collapsed, and a detector that flags it deletes its own evidence",
  );
});

check("CASE E — no real e2e spec clicks a navigation tab directly", () => {
  const findings = findRawNavClicks(specs, labels);
  assert.deepStrictEqual(
    findings.map((f) => `${f.path}:${f.line}`),
    [],
    `a spec navigates by clicking a tab that a collapsed drawer hides:\n${render(findings)}`,
  );
});

check("CASE F — the tab labels come from nav.ts and are non-trivial", () => {
  assert.ok(
    labels.length >= 20,
    `parsed only ${labels.length} tab labels from e2e/helpers/nav.ts. CASE E compares against ` +
      `this list, so a short or empty list makes it pass by knowing about nothing`,
  );
  for (const expected of ["Leads", "Quotes & Orders", "AI Settings", "Lead Review"]) {
    assert.ok(labels.includes(expected), `TAB_GROUP no longer lists "${expected}"`);
  }
});

check("CASE H — the local-helper detector flags a non-delegating openTab, and accepts a wrapper", () => {
  const flagged = findLocalNavHelpers([
    {
      path: "synthetic/bad.spec.ts",
      source: [
        "async function openTab(page: Page, label: string) {",
        '  await page.getByRole("button", { name: label }).first().click({ force: true });',
        "  await page.waitForTimeout(900);",
        "}",
      ].join("\n"),
    },
  ]);
  assert.strictEqual(flagged.length, 1, "the shape that hid the bug in 66 tests must be flagged");

  const notFlagged = findLocalNavHelpers([
    {
      path: "synthetic/ok.spec.ts",
      source: [
        "async function openTab(page: Page, label: string, heading: RegExp) {",
        "  await openTabByLabel(page, label);",
        "  await expect(page.getByRole('heading', { name: heading })).toBeVisible();",
        "}",
      ].join("\n"),
    },
  ]);
  assert.deepStrictEqual(
    notFlagged,
    [],
    "a spec is allowed its own wrapper — three of them add waits and heading checks. The rule " +
      "is about delegating the sidebar's behaviour, not about banning the function name",
  );
});

check("CASE I — no real e2e spec re-derives how the sidebar works", () => {
  // e2e/helpers/nav.ts is the one file that MAY define openTab() without
  // delegating: it is what everything else delegates TO. Excluding it here
  // rather than inside the detector keeps the rule ("nobody has private
  // navigation") separate from the single exception to it.
  const findings = findLocalNavHelpers(specs.filter((f) => !f.path.endsWith("e2e/helpers/nav.ts")));
  assert.deepStrictEqual(
    findings.map((f) => `${f.path}:${f.line}`),
    [],
    `a spec navigates by its own private rules:
${render(findings)}`,
  );
});

check("CASE J — the nav-table detector flags a spec's own list of tabs, not an ordinary mention", () => {
  const flagged = findNavLabelTables(
    [
      {
        path: "synthetic/bad.spec.ts",
        source: [
          "const PAGES = [",
          '  ["dashboard", "Dashboard"],',
          '  ["replies", "Replies"],',
          '  ["tickets", "Tickets"],',
          '  ["crm", "Leads"],',
          '  ["commercial", "Quotes & Orders"],',
          "];",
        ].join("\n"),
      },
    ],
    labels,
  );
  assert.strictEqual(flagged.length, 1, "a second copy of the navigation must be flagged");
  assert.match(flagged[0].why, /TAB_GROUP/, "the finding has to say where the real list lives");

  const notFlagged = findNavLabelTables(
    [
      {
        path: "synthetic/ok.spec.ts",
        source: [
          "const ALL_TABS: readonly string[] = Object.keys(TAB_GROUP);",
          'await openTabByLabel(page, "Dashboard");',
          'await openTabByLabel(page, "Leads");',
          'await expect(page.getByRole("heading", { name: "Replies" })).toBeVisible();',
        ].join("\n"),
      },
    ],
    labels,
  );
  assert.deepStrictEqual(
    notFlagged,
    [],
    "deriving the list from TAB_GROUP is the FIX — a detector that flags the fixed form is worse " +
      "than no detector, and naming a couple of tabs a spec actually visits is normal",
  );
});

check("CASE K — no real e2e spec keeps a second copy of the navigation", () => {
  const findings = findNavLabelTables(
    specs.filter((f) => !f.path.endsWith("e2e/helpers/nav.ts")),
    labels,
  );
  assert.deepStrictEqual(
    findings.map((f) => `${f.path}:${f.line}`),
    [],
    `a spec maintains its own table of tab labels:\n${render(findings)}`,
  );
});

check("CASE G - the suite's data directory is still isolated from the product's", () => {
  assertE2EDataDirIsIsolated();
  assert.notStrictEqual(path.resolve(E2E_DATA_DIR), path.resolve(PRODUCT_DATA_DIR));
  for (const unsafe of [PRODUCT_DATA_DIR, path.join(PRODUCT_DATA_DIR, "fixture"), REPO_ROOT, path.dirname(REPO_ROOT), path.join(REPO_ROOT, ".leadgen-data-e2e")]) {
    assert.throws(() => assertE2EDataDirIsIsolated(unsafe), /fixture must be outside/);
  }
  if (process.platform === "win32") assert.throws(() => assertE2EDataDirIsIsolated(PRODUCT_DATA_DIR.toUpperCase()), /fixture must be outside/);
});

console.log("");
console.log(`=== GOLDEN e2e-harness-hygiene: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
