/**
 * e2e-harness-hygiene.ts — the two static checks that pin N-TEST-4 and N-TEST-5.
 *
 * WHY A STATIC CHECK RATHER THAN A TEST
 * -------------------------------------
 * Both bugs these detectors look for share an unpleasant property: they do not
 * fail where they are. They fail somewhere else, later, in a way that reads as a
 * product defect.
 *
 *   N-TEST-5 — a spec hard-codes `.leadgen-data/app-data.json` and reads it to
 *   check that a save persisted. The suite's server writes to
 *   `.leadgen-data-e2e/app-data.json`. The assertion then reports
 *   `Expected: "approved" / Received: "pending"` — which looks exactly like the
 *   API silently dropping a field. Forty-four tests said that at once, and not
 *   one of them named the real cause.
 *
 *   N-TEST-4 — a spec clicks a navigation tab directly, e.g.
 *   `getByRole("button", { name: "Leads" }).click()`. Since the 2026-08-17
 *   redesign the drawers start COLLAPSED, so that button is not in the DOM until
 *   its drawer is opened. The click waits out the test budget and the failure
 *   points at the Leads screen, which is fine.
 *
 * Neither can be pinned by an ordinary regression test, because the regression
 * IS a test. So they are pinned by reading the suite's own source. The detectors
 * live here, apart from the golden that calls them, so the golden can hand them
 * a file that breaks the rule on purpose — a detector nobody has watched fire is
 * worth as much as a test nobody has watched fail.
 */

export type SourceFile = { path: string; source: string };
export type Finding = { path: string; line: number; text: string; why: string };

/** Strip `//` and block comments so a comment ABOUT the old code is not a hit. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * Specs that name the product data directory in a path expression.
 *
 * The narrow rule is deliberate: mentioning `.leadgen-data` is fine (the fix
 * comments do it constantly). Building a PATH out of it inside a spec is what
 * puts a second, wrong data file in play.
 */
export function findHardCodedDataPaths(files: SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const lines = stripComments(file.source).split("\n");
    lines.forEach((raw, i) => {
      // `".leadgen-data"` as a path segment, or the literal path in one string.
      const isPathSegment = /["'`]\.leadgen-data["'`]/.test(raw);
      const isPathLiteral = /["'`][^"'`]*\.leadgen-data[\/\\][^"'`]*["'`]/.test(raw);
      if (!isPathSegment && !isPathLiteral) return;
      // `.leadgen-data-e2e` is the suite's own directory and is allowed — but
      // only e2e/helpers/data-dir.ts should be constructing it.
      if (/\.leadgen-data-e2e/.test(raw) && !/\.leadgen-data["'`\/\\]/.test(raw)) return;
      findings.push({
        path: file.path,
        line: i + 1,
        text: raw.trim(),
        why:
          "builds a path into the PRODUCT data directory. The suite's server writes to " +
          ".leadgen-data-e2e, so anything read from here is a file the test never wrote to. " +
          "Import E2E_DATA_FILE from e2e/helpers/data-dir instead.",
      });
    });
  }
  return findings;
}

/**
 * Specs that click a navigation tab directly instead of via `openTabByLabel`.
 *
 * Matches only a `getByRole("button", { name: <a known tab> })` that is clicked
 * in the same statement — an assertion ABOUT such a button (navigation.spec.ts
 * checks that a collapsed drawer's tab is absent) is not a navigation attempt
 * and is not a finding.
 */
export function findRawNavClicks(files: SourceFile[], tabLabels: string[]): Finding[] {
  const known = new Set(tabLabels.map((l) => l.toLowerCase()));
  const findings: Finding[] = [];
  const pattern = /getByRole\(\s*["']button["']\s*,\s*\{\s*name:\s*(?:["']([^"']+)["']|\/\^?([^/$]+)\$?\/[a-z]*)/g;

  for (const file of files) {
    const lines = stripComments(file.source).split("\n");
    lines.forEach((raw, i) => {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(raw)) !== null) {
        const label = (m[1] ?? m[2] ?? "").replace(/\\/g, "").trim();
        if (!known.has(label.toLowerCase())) continue;
        if (!/\.click\s*\(/.test(raw)) continue; // an assertion, not navigation
        findings.push({
          path: file.path,
          line: i + 1,
          text: raw.trim(),
          why:
            `clicks the "${label}" tab directly. The drawers start collapsed, so this button ` +
            "is not in the DOM until its drawer is opened; the click waits out the test budget " +
            "and the failure names the wrong screen. Use openTabByLabel() from e2e/helpers/nav.",
        });
      }
    });
  }
  return findings;
}

/**
 * The tab labels the suite knows about, read out of `e2e/helpers/nav.ts`.
 *
 * Parsed rather than imported because that module imports `@playwright/test`,
 * and a golden should not need the browser test runner on its module graph to
 * grep some strings. Parsed rather than re-listed because a second copy of the
 * navigation is the original sin here — see the header of navigation.spec.ts.
 */
export function parseTabLabels(navHelperSource: string): string[] {
  const block = navHelperSource.match(/export const TAB_GROUP[^=]*=\s*\{([\s\S]*?)\n\};/);
  if (!block) {
    throw new Error(
      "Could not find `export const TAB_GROUP = { … };` in e2e/helpers/nav.ts. " +
        "If it was renamed, update parseTabLabels — a silent empty label list would " +
        "make findRawNavClicks pass by finding nothing.",
    );
  }
  const labels: string[] = [];
  const entry = /^\s*(?:["']([^"']+)["']|([A-Za-z_$][\w$]*))\s*:/gm;
  let m: RegExpExecArray | null;
  while ((m = entry.exec(block[1])) !== null) labels.push(m[1] ?? m[2]);
  return labels;
}

/**
 * Spec-local navigation helpers that do not delegate to `openTabByLabel`.
 *
 * This is the hole the two detectors above do not cover, and it was worth
 * finding the hard way: `full-button-coverage.spec.ts` and
 * `ui-value-verification.spec.ts` — 66 of the 133 failures in the first full
 * measured run — each defined their OWN `openTab(page, label)` that clicked the
 * sidebar button directly. The label is a PARAMETER there, so there is no tab
 * name in the source for findRawNavClicks to recognise, and both files looked
 * clean while every test in them navigated nowhere.
 *
 * The rule is deliberately about delegation rather than about clicking: a spec
 * may absolutely have its own `openTab` wrapper (three do, for the waits and
 * heading checks they add). It may not have its own idea of how the sidebar
 * works.
 */
export function findLocalNavHelpers(files: SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  const decl = /(?:async\s+function|function)\s+(openTab|clickTab|gotoTab|navigateToTab)\b|(?:const|let)\s+(openTab|clickTab|gotoTab|navigateToTab)\s*=/g;

  for (const file of files) {
    const source = stripComments(file.source);
    decl.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = decl.exec(source)) !== null) {
      const name = m[1] ?? m[2];
      // Walk braces from the declaration to find the end of the body.
      let i = source.indexOf("{", m.index);
      if (i === -1) continue;
      let depth = 0;
      let end = source.length;
      for (let j = i; j < source.length; j++) {
        if (source[j] === "{") depth++;
        else if (source[j] === "}") {
          depth--;
          if (depth === 0) { end = j; break; }
        }
      }
      const body = source.slice(i, end);
      if (body.includes("openTabByLabel(")) continue;
      findings.push({
        path: file.path,
        line: source.slice(0, m.index).split("\n").length,
        text: `${name}(…)`,
        why:
          `defines its own ${name}() that does not go through openTabByLabel(). The label is a ` +
          "parameter, so the tab names never appear in the source and the collapsed-drawer bug " +
          "hides here in plain sight — this is exactly how 66 tests navigated nowhere. Wrap the " +
          "shared helper instead of re-deriving how the sidebar works.",
      });
    }
  }
  return findings;
}

/**
 * Specs that keep their OWN table of navigation labels.
 *
 * This is the third shape of the collapsed-drawer bug, and the one the two
 * detectors above are structurally blind to. `full-ui-sweep.spec.ts`,
 * `full-ui-sweep-v2.spec.ts` and `ui-value-verification.spec.ts` each declared
 * a 26-row table of sidebar labels and looped over it, clicking
 * `getByRole("button", { name: label })`. The tab name is a loop VARIABLE, so
 * findRawNavClicks has nothing to recognise; the click is inline, so
 * findLocalNavHelpers has no helper to inspect. All three sweeps went fully red
 * at the 2026-08-17 redesign with messages of the form
 * `dashboard (nav button "^Dashboard$" not visible)` — 26 lines that read as
 * "every screen in the product is broken" and meant "this file has a stale copy
 * of the navigation".
 *
 * The rule: a spec may name a tab it visits. It may not keep a LIST of them.
 * Object.keys(TAB_GROUP) is the list, and navigation.spec.ts is what keeps that
 * honest against the sidebar the app actually renders.
 *
 * Only labels inside array-literal rows count, so a spec that legitimately
 * visits eight named tabs one at a time is not flagged for it.
 */
export function findNavLabelTables(files: SourceFile[], tabLabels: string[], threshold = 5): Finding[] {
  const known = new Set(tabLabels);
  const findings: Finding[] = [];
  for (const file of files) {
    const lines = stripComments(file.source).split("\n");
    let runStart = -1;
    let run: string[] = [];
    const flush = (endLine: number) => {
      if (run.length >= threshold) {
        findings.push({
          path: file.path,
          line: runStart + 1,
          text: `${run.length} tab labels in one table: ${run.slice(0, 4).join(", ")}, ...`,
          why:
            `keeps its own list of ${run.length} navigation labels. That is a second copy of the ` +
            "sidebar, and it drifts silently: at the 2026-08-17 rename every entry stopped matching " +
            "and the whole sweep reported the product as broken. Derive the list from TAB_GROUP in " +
            "e2e/helpers/nav.ts, which navigation.spec.ts pins against the real sidebar.",
        });
      }
      runStart = -1;
      run = [];
      void endLine;
    };
    lines.forEach((raw, i) => {
      const trimmed = raw.trim();
      // A table row: an array element, or a [id, label] tuple row.
      const isRow = /^\[/.test(trimmed) || /^["'`]/.test(trimmed) || /^\{/.test(trimmed);
      if (!isRow) {
        // Allow the declaration line itself and the closing bracket to sit
        // between rows without breaking the run.
        if (/^(const|let|export|\]|\);|\] as const)/.test(trimmed) || trimmed === "") return;
        flush(i);
        return;
      }
      const hit = [...trimmed.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]).find((s) => known.has(s));
      if (!hit) { flush(i); return; }
      if (runStart === -1) runStart = i;
      if (!run.includes(hit)) run.push(hit);
    });
    flush(lines.length);
  }
  return findings;
}
