/**
 * screen-walk.ts — visit EVERY operator screen, every inner view, and every
 * dialog reachable without side effects, and report what is wrong with each.
 *
 * WHY THIS IS A SCRIPT AND NOT A SPEC (2026-09-01)
 * ------------------------------------------------
 * The obvious move was another Playwright spec. It would have been the wrong
 * one. An audit that reports findings but cannot decide which of them is a
 * failure is a test that passes without asserting — precisely the failure mode
 * audit A-7 exists to hunt. So this is a data-collection tool: it produces a
 * JSON report, and each real defect it finds earns a NARROW assertion in the
 * e2e suite once it is fixed. The tool finds; the suite pins.
 *
 * It is also re-runnable, which is the point: the same command produces the
 * "before" and the "after", so the second verification pass is a diff rather
 * than a fresh act of trust.
 *
 * SAFETY (N-SAFETY-1 discipline)
 * ------------------------------
 * The walk clicks only things that CANNOT change data: openers matched by an
 * allowlist, and never anything matching the destructive/side-effect denylist
 * (Erase, Delete, Send, Approve, Generate, Save, ...). Dialogs are closed with
 * Escape, never with their own confirm button. If a click is ambiguous, it is
 * skipped and recorded as skipped — an unexplored screen is a gap in the
 * report; an accidental Erase is a gap in the customer's data.
 *
 * Usage:  npx tsx scripts/screen-walk.ts [--base http://localhost:3010] [--out <file>]
 */
import { chromium, type Page, type Browser } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

const argv = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const BASE = arg("--base", process.env.WALK_BASE_URL || "http://localhost:3010");
const OUT = arg("--out", path.join(".leadgen-data", "walk-report.json"));
const ONLY = arg("--only", "");

/** The IA, transcribed from src/app/page.tsx `tabGroups`. */
const TAB_GROUP: Record<string, string> = {
  Replies: "Conversations",
  Messages: "Conversations",
  Tickets: "Conversations",
  "AI Drafts": "Conversations",
  Leads: "Customers",
  "Quotes & Orders": "Customers",
  "Ideal Customers": "Prospecting",
  Campaign: "Prospecting",
  Discovery: "Prospecting",
  "Lead Review": "Prospecting",
  Onboarding: "Knowledge",
  Profile: "Knowledge",
  "Knowledge Base": "Knowledge",
  Catalogue: "Knowledge",
  "Questions from AI": "Knowledge",
  Dashboard: "Business performance",
  Analytics: "Business performance",
  "AI Settings": "AI & channels",
  "WhatsApp Agent": "AI & channels",
  "Agent Instructions": "AI & channels",
  Integrations: "AI & channels",
  Workspace: "Workspace & admin",
  Compliance: "Workspace & admin",
  Settings: "Workspace & admin",
  "Export / Backup": "Workspace & admin",
  "Help & Support": "Workspace & admin",
};

type Finding = {
  surface: string;
  kind: string;
  detail: string;
};

type SurfaceReport = {
  surface: string;
  kind: "tab" | "inner-view" | "dialog";
  parent?: string;
  buttons: number;
  findings: Finding[];
};

/**
 * The audit itself. Runs inside the page so it can read layout, not just DOM.
 *
 * 2026-09-03 — THIS USED TO BE A STRING (`const AUDIT_FN = \`...\`` handed to
 * `page.evaluate` as source text). That cost five separate breakages in two
 * weeks, all the same one: the body is ~260 lines of regex-heavy JavaScript,
 * and inside a template literal every `\b` becomes a BACKSPACE character,
 * every `\d` a literal "d", and every `\"` an unescaped quote. The failures
 * were the bad kind — twice the walk did not crash, it just quietly matched
 * nothing and reported a confident zero across 38 screens.
 *
 * Playwright serialises a real function for you: `page.evaluate(fn, arg)` sends
 * `fn.toString()` over the wire, so nothing is lost by writing it as code. What
 * is GAINED is that TypeScript now parses it. A missing bracket or a broken
 * regex is a compile error instead of a runtime SyntaxError discovered 26
 * screens into a five-minute walk — or, worse, not discovered at all.
 *
 * The only constraint is the one every `page.evaluate` body has: it runs in the
 * browser, so it may close over NOTHING from this module. Everything it needs
 * arrives as the single serialisable argument.
 */
function auditSurface(surfaceName: string) {
  const findings: Array<{ surface: string; kind: string; detail: string }> = [];
  const add = (kind: string, detail: string) => findings.push({ surface: surfaceName, kind, detail });

  // A CLOSED dialog is still in the DOM (the Copilot panel is one), so
  // "is there a [role=dialog]" is the wrong question — it rooted the whole
  // audit inside an empty node and reported every screen as "0 buttons, no
  // heading". Only a dialog that is actually on screen counts.
  const onScreen = (el: any) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  };
  const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(onScreen) || null;
  // Outside a dialog, audit the CONTENT region only. <main> also contains the
  // sidebar, so auditing it would score the navigation's 28 buttons against
  // every screen and report the nav's own text as each screen's text.
  const shell = dialog || document.querySelector("main > section") || document.querySelector("main") || document.body;
  // The sticky header (search / refresh / sign out / user chip) is shell chrome
  // that appears on all 26 screens. Auditing it once per screen reports the
  // same three buttons 26 times as if each screen owned them, and folds the
  // workspace name into every screen's "empty state" text. Scan the content
  // under the header, not the header itself.
  const kids = Array.from(shell.children).filter((c: any) => c.tagName !== "HEADER");
  const root = !dialog && kids.length === 1 ? kids[0] : shell;

  const nameOf = (el: any) => {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const t = labelledby.split(/\s+/).map((id: any) => document.getElementById(id))
        .filter(Boolean).map((n: any) => n.textContent || "").join(" ").trim();
      if (t) return t;
    }
    const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (txt) return txt;
    const title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();
    return "";
  };

  const visible = (el: any) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };

  const buttons = Array.from(root.querySelectorAll("button, [role=button], a[href]"))
    .filter(visible)
    .filter((b: any) => dialog || (!b.closest("header") && !b.closest("nav")));

  // 1. Controls with no accessible name at all.
  const nameless = buttons.filter((b: any) => !nameOf(b) && !b.querySelector("svg[aria-label]"));
  if (nameless.length) {
    add("nameless-control", nameless.length + " control(s) with no accessible name: " +
      nameless.slice(0, 5).map((b: any) => (b.className || "").toString().slice(0, 60)).join(" | "));
  }

  // 2. Icon-only controls that lean on title= instead of aria-label. A title
  //    attribute is a tooltip, not a name a screen reader reliably announces.
  const titleOnly = buttons.filter((b: any) =>
    !(b.textContent || "").trim() && !b.getAttribute("aria-label") && b.getAttribute("title"));
  if (titleOnly.length) {
    add("title-instead-of-aria-label",
      titleOnly.length + " icon control(s) named only by title=: " +
      titleOnly.slice(0, 6).map((b: any) => b.getAttribute("title")).join(" | "));
  }

  // 3. Duplicate control labels. Two "Edit" buttons are fine; twenty-six
  //    identical "Replies" buttons mean neither the operator nor a screen
  //    reader can tell which row they are about to act on.
  const counts: Record<string, number> = {};
  for (const b of buttons) {
    const n = nameOf(b);
    if (!n || n.length > 40) continue;
    counts[n] = (counts[n] || 0) + 1;
  }
  const ambiguous = Object.entries(counts).filter(([, c]) => c > 2)
    .sort((a, b) => b[1] - a[1]).map(([n, c]) => n + " x" + c);
  if (ambiguous.length) add("ambiguous-controls", ambiguous.join(", "));

  // 4. Form fields with nothing naming them.
  const fields = (Array.from(root.querySelectorAll("input, select, textarea")) as HTMLInputElement[]).filter(visible)
    .filter((f) => f.type !== "hidden");
  const unlabelled = fields.filter((f) => {
    if (f.getAttribute("aria-label") || f.getAttribute("aria-labelledby")) return false;
    if (f.closest("label")) return false;
    if (f.id && document.querySelector('label[for="' + CSS.escape(f.id) + '"]')) return false;
    if (f.getAttribute("placeholder")) return false;
    return true;
  });
  if (unlabelled.length) {
    add("unlabelled-field", unlabelled.length + " field(s) with no label: " +
      unlabelled.slice(0, 5).map((f) => f.tagName.toLowerCase() + (f.name ? "[name=" + f.name + "]" : "")).join(" | "));
  }

  const text = ((root as HTMLElement).innerText || "").replace(/\u00a0/g, " ");

  // 5. Backend codes reaching the screen. src/lib/display-labels.ts exists to
  //    stop exactly this.
  const snake = Array.from(new Set((text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || [])));
  if (snake.length) add("backend-code-leak", "snake_case on screen: " + snake.slice(0, 10).join(", "));

  // 6. Raw field names de-camel-cased into fake labels ("mql Count"), which is
  //    what a key.replace(/([A-Z])/g," $1") produces.
  //
  //    TIGHTENED 2026-09-01: this used to scan the surface's whole innerText,
  //    which matched ordinary prose ("Boutiques in India", "connect to Meta")
  //    and — worse — matched ACROSS two adjacent labels: a value of "Not set"
  //    followed by a heading "Shipping policy" read as the field name
  //    "set Shipping". 28 of the baseline run's 98 findings were that noise.
  //    A real de-camel-cased label is the ENTIRE text of one leaf element, so
  //    that is what is checked now.
  const decamelPattern = /^[a-z][a-z0-9]*(?: [A-Z][a-z0-9]+){1,4}$/;
  const decamel = [];
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (el.children.length) continue;
    const label = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (label.length > 44 || !decamelPattern.test(label)) continue;
    if (decamel.indexOf(label) === -1) decamel.push(label);
  }
  if (decamel.length) add("raw-field-name", "de-camel-cased field names: " + decamel.slice(0, 10).join(", "));

  // 7. Section structure. A screen with no heading gives a screen-reader user
  //    no way to skim it.
  const headings = Array.from(root.querySelectorAll("h1,h2,h3")).filter(visible);
  if (!headings.length) add("no-heading", "surface renders no h1/h2/h3");

  // 7b. N-UX-10 — the page title printed twice.
  //     The shell renders the page <h1>. A panel or card underneath that
  //     repeats it spends the screen's second-most prominent line saying what
  //     the first one already said, and it reads as though the two are
  //     different things. Compares against the SHELL h1 (outside the audit
  //     root), so a
  //     panel legitimately named after a sub-part is not flagged.
  //
  //     2026-09-04 — this compared exact lowercased strings and therefore
  //     missed the clearest example in the product: a page headed "Help and
  //     support" whose first card was titled "Help & Support". To a reader
  //     those are the same words twice; to a string comparison they are not.
  //     Normalising "&" to "and" and dropping punctuation is enough to catch
  //     the ways a title gets re-typed. It stays a whole-string comparison, so
  //     a panel legitimately named after a sub-part is still not flagged.
  const normaliseTitle = (t: string) => t
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const shellHeading = document.querySelector("main h1") as HTMLElement | null;
  const pageTitle = shellHeading ? normaliseTitle(shellHeading.innerText || "") : "";
  if (pageTitle) {
    const echoes = headings
      .filter((h) => h !== shellHeading)
      .map((h) => ((h as HTMLElement).innerText || "").trim())
      .filter((t) => t && normaliseTitle(t) === pageTitle);
    if (echoes.length) add("duplicate-page-title", 'the page heading "' + echoes[0] + '" is repeated inside the screen');
  }

  // 7c. N-UX-10 — number soup.
  //     Counts the numeric tokens a reader is shown at once. Past roughly a
  //     dozen an operator cannot tell which number is the one they need, and
  //     repeated or disagreeing totals actively erode trust in all of them.
  //     Questions from AI measured 22 before this rule existed and 9 after.
  //     Reported as an observation with the count, not a pass/fail line in the
  //     sand: a dense table of real data is not the same fault as four
  //     restatements of the same twelve.
  // NOTE: double-escaped on purpose. This whole function is the body of a
  //       TEMPLATE LITERAL, so a single \b here reaches the browser as a
  //       BACKSPACE character and \d as a literal "d" — the regex then
  //       silently matches nothing and the check reports a confident zero.
  //       That happened on the first run of this check; see line 188 for the
  //       same escaping on \u00a0.
  // Dates and clock times are stripped first. They are not numbers an operator
  // has to reconcile against each other, and counting "9/1/2026" as three
  // separate numbers made the Dashboard look like the worst screen in the
  // product (59) when almost half its count was date components. A check that
  // misreports which screen is worst is worse than no check.
  const withoutDates = text
    .replace(/\d{1,4}[/-]\d{1,2}[/-]\d{1,4}/g, " ")
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, " ");
  const numericTokens = withoutDates.match(/\b\d[\d,.]*\b/g) || [];
  if (numericTokens.length > 18) {
    // Report the most-repeated value too. A high count of DISTINCT figures is
    // usually a real table; the same figure restated many times is the actual
    // defect this check exists to find (Questions from AI showed one "12"
    // four different ways). The detail tells the two apart without a re-walk.
    const freq: Record<string, number> = {};
    for (const n of numericTokens) freq[n] = (freq[n] || 0) + 1;
    let worstValue = "";
    let worstCount = 0;
    for (const key of Object.keys(freq)) if (freq[key] > worstCount) { worstCount = freq[key]; worstValue = key; }
    add("number-soup", numericTokens.length + " numbers on one surface (excluding dates); most repeated: '" + worstValue + "' appears " + worstCount + " times");
  }

  // 8. Dead ends: an empty state that tells the operator to go somewhere and
  //    gives them no way to get there.
  if (!dialog) {
    const emptyish = /\bno [a-z ]{2,30}\b(yet|found)?/i.test(text);
    if (buttons.length === 0 && emptyish) {
      add("dead-end-empty-state", "empty state with " + buttons.length + " control(s): " + text.slice(0, 120).replace(/\s+/g, " "));
    }
    // The old empty-state-no-shortcut branch lived here. It fired whenever a
    // screen mentioned "Settings →" and had no button whose name contained
    // "go/open/settings/add" — which flagged Onboarding, a screen with a form
    // and several buttons. A check that cannot tell a dead end from a working
    // screen produces noise that hides the real ones, so it is gone rather
    // than tuned: the zero-control check above catches the case that mattered
    // (the Catalogue), and catches it precisely.
  }

  // 9. Selected-state semantics on chip/segment rows. Colour alone is not a
  //    state; aria-pressed / role=tab is.
  const chipRows = new Map();
  for (const b of buttons) {
    if (b.tagName !== "BUTTON") continue;
    const n = nameOf(b);
    if (!n || n.length > 28) continue;
    const p = b.parentElement;
    if (!p) continue;
    const sibs = Array.from(p.children).filter((c: any) => c.tagName === "BUTTON");
    if (sibs.length < 3) continue;
    chipRows.set(p, sibs);
  }
  // TIGHTENED 2026-09-01: a row of three buttons is not necessarily a filter.
  // "Approve & Send / Dismiss Draft / Copy text" is a row of ACTIONS, and
  // demanding aria-pressed of it is wrong — 32 of the baseline run's findings
  // were rows like that. What distinguishes a SELECTION row is that exactly one
  // member is painted differently from its siblings, because that colour is
  // carrying the selected state. THAT is worth flagging: state expressed only
  // as a colour disappears for a screen reader, and can disappear in
  // high-contrast mode too.
  for (const [, sibs] of chipRows) {
    const semantic = sibs.some((b: any) =>
      b.hasAttribute("aria-pressed") || b.getAttribute("role") === "tab" || b.hasAttribute("aria-current") || b.hasAttribute("aria-selected"));
    if (semantic) continue;
    // A selection row is made of NOUNS ("Sales / Products / Policy"); an action
    // row contains VERBS ("Save / Approve / Sync Knowledge"), and one of those
    // is painted differently simply because it is the primary action. Demanding
    // (2026-09-04: "try" and "preview" were missing from this list. The AI
    // Settings row -- "Try Fast Reply", "Try Daily Workhorse" ... -- is four
    // buttons that each run a test, and the one painted differently is simply
    // the one the walk had just clicked and left focused. Focus is not
    // selection, and demanding aria-pressed of it would be wrong.)
    // aria-pressed of an action row would be wrong, so verbs disqualify the row.
    const actionVerb = /^(save|approve|reject|send|delete|erase|remove|add|create|new|edit|generate|regenerate|run|start|stop|pause|resume|sync|import|export|download|upload|refresh|retry|test|copy|dismiss|cancel|close|open|apply|confirm|submit|clear|reset|extract|scan|fetch|enrich|score|convert|publish|invite|connect|disconnect|try|preview)\b/i;
    if (sibs.some((b: any) => actionVerb.test(nameOf(b)))) continue;
    // A DISABLED button is painted differently too, and that difference is not
    // a selection. Messages renders one "draft a message" button per lead and
    // disables the do-not-contact ones; without this the row read as a selector
    // that had lost its selected state.
    if (sibs.some((b: any) => b.disabled || b.getAttribute("aria-disabled") === "true")) continue;
    const tally: Record<string, number> = {};
    for (const b of sibs) {
      const st = getComputedStyle(b);
      const paint = st.backgroundColor + "|" + st.color + "|" + st.borderColor;
      tally[paint] = (tally[paint] || 0) + 1;
    }
    const distinct = Object.entries(tally);
    const looksSelected = distinct.length === 2 && distinct.some((entry) => entry[1] === 1);
    if (!looksSelected) continue;
    add("chip-row-without-state", "row of " + sibs.length + " chips marks the selected one only with a colour, no aria-pressed/role=tab: " +
      sibs.map((b: any) => nameOf(b)).slice(0, 8).join(" / "));
    break;
  }

  // 10. Horizontal overflow — the page body must never scroll sideways.
  if (document.documentElement.scrollWidth > window.innerWidth + 2) {
    add("horizontal-overflow", "scrollWidth " + document.documentElement.scrollWidth + " > viewport " + window.innerWidth);
  }

  // 11. Bare ids and timestamps shown as-is.
  const rawIds = Array.from(new Set((text.match(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/g) || [])));
  if (rawIds.length) add("raw-uuid", rawIds.length + " raw UUID(s) shown to the operator");
  const isoDates = Array.from(new Set((text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g) || [])));
  if (isoDates.length) add("raw-timestamp", isoDates.length + " raw ISO timestamp(s): " + isoDates.slice(0, 4).join(", "));

  return { findings, buttons: buttons.length, headings: headings.length };
}

// ---------------------------------------------------------------------------
// Click safety
// ---------------------------------------------------------------------------
/** Anything that could write, send, spend money, or destroy. Never clicked. */
const UNSAFE =
  /\b(erase|delete|remove|discard|clear|reset|wipe|purge|revoke|send|approve|reject|decline|publish|submit|save|apply|confirm|create|add|new|generate|regenerate|run|start|stop|pause|resume|sync|import|export|download|upload|enrich|score|convert|cancel|refund|pay|charge|upgrade|subscribe|invite|connect|disconnect|sign out|log ?out|test|simulate|retry|archive|restore|merge|assign|escalate|resolve|close|reopen|mark|enable|disable|activate|deactivate|install|uninstall|seed|migrate|rebuild|refresh|draft|extract|crawl|analy[sz]e|write|suggest|summari[sz]e|learn|train|embed|research|discover)\b/i;

/** Things that only reveal something already there. */
const OPENER = /^(open|view|show|details?|edit|preview|see|manage|configure|customi[sz]e|expand|more|read|inspect|change)\b/i;

function isSafeOpener(name: string): boolean {
  if (!name) return false;
  if (UNSAFE.test(name)) return false;
  return OPENER.test(name) || /^(show details for|open )/i.test(name);
}

// ---------------------------------------------------------------------------
async function login(page: Page): Promise<void> {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  const demo = page.getByRole("button", { name: /Continue in Demo Mode/i });
  if (await demo.isVisible({ timeout: 15_000 }).catch(() => false)) {
    await demo.click();
  }
  await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 30_000 });
  await page.getByRole("navigation", { name: "Main navigation" }).waitFor({ timeout: 30_000 });
}

/** Close anything modal that a previous click left open. */
async function dismissOverlays(page: Page): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(150);
  }
}

async function openTab(page: Page, label: string): Promise<void> {
  await dismissOverlays(page);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const leaf = nav.getByRole("button", { name: label, exact: true }).first();
  if (!(await leaf.isVisible().catch(() => false))) {
    const group = TAB_GROUP[label];
    await nav.getByRole("button", { name: group, exact: true }).first().click({ timeout: 10_000 });
    await leaf.waitFor({ state: "visible", timeout: 15_000 });
  }
  await leaf.click({ timeout: 10_000 });
  await settle(page);
}

/**
 * Wait for the screen to STOP CHANGING before auditing it.
 *
 * This replaces a flat 900ms wait, and it was not a refinement — it was a
 * correctness fix. On a run that followed a source edit, Turbopack recompiled
 * each route on first visit, so the audit photographed screens mid-load and
 * reported "No profile yet", "0 drafts waiting" and "renders no h1/h2/h3" for
 * screens whose data arrived a second later. Those readings were not findings;
 * they were the tool describing its own impatience, and they would have been
 * indistinguishable from real regressions in the report.
 *
 * Settled means: the content region's text is the same twice in a row, and the
 * screen has a heading (every real screen renders one). Capped, so a screen
 * that genuinely never settles is still audited rather than hanging the walk.
 */
async function settle(page: Page, budgetMs = 12_000): Promise<void> {
  const started = Date.now();
  let previous = "";
  while (Date.now() - started < budgetMs) {
    await page.waitForTimeout(400);
    const current = await page.evaluate(() => {
      const el = document.querySelector("main > section") || document.querySelector("main") || document.body;
      const heading = el.querySelector("h1,h2,h3");
      return ((el as HTMLElement).innerText || "").slice(0, 3000) + "||" + (heading ? "H" : "-");
    }).catch(() => "");
    if (current && current === previous && current.endsWith("||H")) return;
    previous = current;
  }
}

async function audit(page: Page, surface: string): Promise<{ findings: Finding[]; buttons: number }> {
  return page.evaluate(auditSurface, surface) as Promise<{ findings: Finding[]; buttons: number }>;
}

/** A cheap fingerprint of what the main region is showing right now. */
async function signature(page: Page): Promise<string> {
  return page.evaluate(() => {
    const m = document.querySelector("main > section") || document.querySelector("main") || document.body;
    return ((m as HTMLElement).innerText || "").replace(/\s+/g, " ").slice(0, 400);
  });
}

async function walk(page: Page, tab: string, report: SurfaceReport[]): Promise<void> {
  await openTab(page, tab);

  const base = await audit(page, tab);
  report.push({ surface: tab, kind: "tab", buttons: base.buttons, findings: base.findings });

  const baseSig = await signature(page);

  // --- inner views (filter chips, segmented controls, sub-tabs) -------------
  const chipNames: string[] = await page.evaluate(() => {
    const main = document.querySelector("main > section") || document.querySelector("main");
    if (!main) return [];
    const out: string[] = [];
    const rows = new Map<Element, Element[]>();
    for (const b of Array.from(main.querySelectorAll("button"))) {
      const r = b.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const p = b.parentElement;
      if (!p) continue;
      const sibs = Array.from(p.children).filter((c) => c.tagName === "BUTTON");
      if (sibs.length >= 2 && sibs.length <= 12) rows.set(p, sibs);
    }
    for (const [, sibs] of rows) {
      for (const b of sibs) {
        const n = (b.textContent || "").replace(/\s+/g, " ").trim();
        if (n && n.length <= 30 && !out.includes(n)) out.push(n);
      }
    }
    return out;
  });

  const innerCandidates = chipNames.filter((n) => !UNSAFE.test(n)).slice(0, 14);
  for (const chip of innerCandidates) {
    try {
      const btn = page.locator("main > section").getByRole("button", { name: chip, exact: true }).first();
      if (!(await btn.isVisible({ timeout: 1500 }).catch(() => false))) continue;
      await btn.click({ timeout: 4000 });
      await settle(page, 6_000);

      const dialogOpen = await page.locator('[role="dialog"]:visible').first().isVisible().catch(() => false);
      const sig = await signature(page);
      if (!dialogOpen && sig === baseSig) continue; // nothing changed — not a view

      const name = `${tab} › ${chip}`;
      const r = await audit(page, name);
      report.push({
        surface: name,
        kind: dialogOpen ? "dialog" : "inner-view",
        parent: tab,
        buttons: r.buttons,
        findings: r.findings,
      });

      if (dialogOpen) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
      }
    } catch {
      /* a chip that will not open is recorded by its absence, not by a crash */
    }
  }

  // --- dialogs and drawers behind safe openers ------------------------------
  await openTab(page, tab); // back to the tab's default view
  const openerNames: string[] = await page.evaluate(() => {
    const main = document.querySelector("main > section") || document.querySelector("main");
    if (!main) return [];
    const seen = new Set<string>();
    for (const b of Array.from(main.querySelectorAll("button, [role=button]"))) {
      const r = b.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const n = (b.getAttribute("aria-label") || b.textContent || "").replace(/\s+/g, " ").trim();
      if (n) seen.add(n);
    }
    return Array.from(seen);
  });

  const openers = openerNames.filter(isSafeOpener).slice(0, 10);
  const seenDialogs = new Set<string>();
  for (const opener of openers) {
    try {
      const btn = page.locator("main > section").getByRole("button", { name: opener, exact: true }).first();
      if (!(await btn.isVisible({ timeout: 1500 }).catch(() => false))) continue;
      await btn.click({ timeout: 4000 });
      await settle(page, 6_000);

      const dlg = page.locator('[role="dialog"]:visible').first();
      if (!(await dlg.isVisible().catch(() => false))) {
        // Not a dialog — an inline expansion. Audit it, then click again to close.
        const sig = await signature(page);
        if (sig !== baseSig) {
          const name = `${tab} » ${opener}`;
          const r = await audit(page, name);
          report.push({ surface: name, kind: "inner-view", parent: tab, buttons: r.buttons, findings: r.findings });
        }
        // "More actions for order #1" opens a dropdown whose overlay
        // intercepts pointer events, so clicking the trigger again never lands
        // and Playwright waited its full 30 seconds — which reported the entire
        // Quotes & Orders screen as unwalkable. Escape closes an open menu; the
        // re-click is only a fallback, and it no longer gets 30 seconds.
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(250);
        await btn.click({ timeout: 2500 }).catch(() => {});
        await page.waitForTimeout(300);
        continue;
      }

      const heading = await dlg.locator("h1,h2,h3").first().innerText().catch(() => "");
      const key = (heading || opener).trim();
      if (!seenDialogs.has(key)) {
        seenDialogs.add(key);
        const name = `${tab} » ${key}`;
        const r = await audit(page, name);
        report.push({ surface: name, kind: "dialog", parent: tab, buttons: r.buttons, findings: r.findings });
      }
      await page.keyboard.press("Escape");
      await page.waitForTimeout(450);
      if (await dlg.isVisible().catch(() => false)) {
        // Escape did not close it — that is itself a finding.
        report.push({
          surface: `${tab} » ${key}`,
          kind: "dialog",
          parent: tab,
          buttons: 0,
          findings: [{ surface: `${tab} » ${key}`, kind: "escape-does-not-close", detail: "dialog still open after Escape" }],
        });
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForTimeout(1200);
        await openTab(page, tab);
      }
    } catch {
      /* skipped */
    }
  }
}

async function main(): Promise<void> {
  const browser: Browser = await chromium.launch();
  // N-SEC-4 (2026-09-03) — the walk announces itself as its own client.
  //
  // The front-door rate limit buckets callers by IP, and getClientIp() falls
  // back to the literal string "unknown" when no forwarding header is present —
  // which is every request from a browser on localhost. So this walk and the
  // operator's own browser were sharing ONE 300-per-minute allowance: a walk
  // over 26 screens locked the operator out of their own product for as long as
  // the block lasted, and they had no way to know why.
  //
  // A dedicated (documented, RFC 5737 TEST-NET-1, unroutable) address gives the
  // walk its own bucket. It does NOT raise or disable the limit — the walk is
  // still subject to the same 300/minute as anyone else, so the guard stays
  // genuinely exercised and a walk that floods still gets refused. It just
  // stops spending someone else's allowance.
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { "x-forwarded-for": "192.0.2.11" },
  });
  // esbuild (which is what `tsx` runs this file through) compiles with
  // keepNames, so every function it emits is wrapped as `__name(fn, "fn")` to
  // preserve `fn.name`. Playwright serialises `auditSurface` by taking its
  // SOURCE — the compiled source — so those `__name` calls travel to the browser
  // where the helper does not exist, and the audit dies with
  // `ReferenceError: __name is not defined` on every single screen.
  //
  // The shim is one line and is the whole fix: `__name` only ever returns its
  // first argument. Registered as an init script so it is in place before any
  // page script runs, on this navigation and every one after it.
  await ctx.addInitScript(() => {
    // @ts-expect-error — deliberately defining a compiler helper on the page.
    window.__name = window.__name || ((fn) => fn);
  });
  const page = await ctx.newPage();
  const report: SurfaceReport[] = [];
  const consoleErrors: string[] = [];
  const blockedWrites: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  });

  await login(page);

  // ------------------------------------------------------------------
  // THE REAL SAFETY GUARANTEE (2026-09-01).
  //
  // The first run of this walk was guarded only by a denylist of verbs, and
  // that was not enough: "Draft messages" and "Extract company knowledge" are
  // not in any list of destructive words, so the walk clicked them and fired
  // five real DeepSeek generations. A paid API call is not undone by an
  // apology, and a wordlist can never be complete.
  //
  // So the guarantee is now structural rather than lexical: after login, every
  // request that is not a GET or HEAD is ABORTED at the network layer. No
  // label, however innocent, can write a row, send a message, or spend money.
  // What each screen TRIED to write is recorded and reported, which is itself
  // worth knowing — a screen that POSTs when you merely look at it is a
  // finding, not an accident.
  // ------------------------------------------------------------------
  await ctx.route("**", async (route) => {
    const req = route.request();
    const method = req.method();
    if (method === "GET" || method === "HEAD") return route.continue();
    blockedWrites.push(method + " " + req.url().replace(BASE, ""));
    return route.abort();
  });

  const tabs = ONLY ? ONLY.split(",").map((s) => s.trim()) : Object.keys(TAB_GROUP);
  for (const tab of tabs) {
    process.stdout.write(`walking ${tab} ... `);
    try {
      await walk(page, tab, report);
      const n = report.filter((r) => r.surface === tab || r.parent === tab).reduce((a, r) => a + r.findings.length, 0);
      console.log(`${n} finding(s)`);
    } catch (e) {
      console.log(`FAILED: ${(e as Error).message.split("\n")[0]}`);
      report.push({
        surface: tab, kind: "tab", buttons: 0,
        findings: [{ surface: tab, kind: "walk-failed", detail: (e as Error).message.split("\n")[0] }],
      });
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(1500);
    }
  }

  await browser.close();

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const total = report.reduce((a, r) => a + r.findings.length, 0);
  fs.writeFileSync(
    OUT,
    JSON.stringify({ base: BASE, at: new Date().toISOString(), surfaces: report.length, findings: total, consoleErrors: Array.from(new Set(consoleErrors)).slice(0, 40), blockedWrites: Array.from(new Set(blockedWrites)), report }, null, 2),
  );
  console.log(`\n${report.length} surfaces walked, ${total} findings -> ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
