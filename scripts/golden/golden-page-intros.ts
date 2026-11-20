/**
 * Golden test — every screen introduces itself the same way (N-UX-10).
 *
 * WHY THIS EXISTS (2026-09-03)
 * ----------------------------
 * The operator's report was that the product could not be read at a glance:
 * "every page should behave just with a glance. I should know what to do here."
 * The agreed fix has four rules; two of them are structural and belong in a
 * test, because copy rules decay the moment somebody adds the 27th screen in a
 * hurry:
 *
 *   RULE 1 — the heading states the JOB, not the feature. The nav already told
 *            the operator which item they clicked; repeating it as the biggest
 *            text on the page spends the most valuable line on the screen
 *            saying nothing.
 *   RULE 2 — exactly ONE sentence of explanation, underneath the heading and
 *            visually quieter, so a reader takes in what the page is for first
 *            and reads on only if they want to.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. It can prove coverage (no screen without
 * an intro, no intro without a screen), that the copy obeys the shape rules,
 * and — by reading the shell's source — that the table is actually rendered
 * rather than sitting there decoratively. It CANNOT prove a sentence is true of
 * its screen; that was done by reading each screen's code when the table was
 * written, and stays a human obligation. So this golden deliberately does not
 * pin the wording of any single entry: pinning prose would make it a
 * spell-checker that fails on every honest improvement.
 *
 * Run: npx tsx scripts/golden/golden-page-intros.ts
 */
import { readFileSync } from "node:fs";
import { PAGE_INTROS } from "@/app/page-intros";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

let passed = 0;
function pass(name: string) {
  console.log(`  ✓ ${name}`);
  passed += 1;
}

async function main() {
  console.log("\n=== golden:page-intros ===\n");
  const page = readFileSync("src/app/page.tsx", "utf8");

  // ===========================================================================
  // CASE A — Coverage, in BOTH directions.
  //
  // The tab ids are parsed out of the `tabs` table in page.tsx rather than
  // imported, because TabId is a type (erased at runtime) and the whole point
  // is to catch a tab added to that table and nowhere else.
  // ===========================================================================
  const tabsBlock = page.slice(page.indexOf("const tabs = ["), page.indexOf("] as const;", page.indexOf("const tabs = [")));
  assert(tabsBlock.length > 100, "could not locate the `tabs` table in src/app/page.tsx — this golden's source parse needs updating, not the code");
  const tabIds = [...tabsBlock.matchAll(/^\s*\["([a-zA-Z]+)",/gm)].map((m) => m[1]);
  assert(tabIds.length >= 26, `parsed only ${tabIds.length} tabs — the source parse is broken, not the code`);

  const missing = tabIds.filter((id) => !PAGE_INTROS[id]);
  assert(
    missing.length === 0,
    `CASE A: these screens have no entry in PAGE_INTROS, so they would fall back to a bare nav label with no explanation: [${missing.join(", ")}]`,
  );
  const orphaned = Object.keys(PAGE_INTROS).filter((id) => !tabIds.includes(id));
  assert(
    orphaned.length === 0,
    `CASE A: these PAGE_INTROS entries do not match any screen — dead copy that will drift: [${orphaned.join(", ")}]`,
  );
  pass(`CASE A — all ${tabIds.length} screens have an intro, and there are no orphans`);

  // ===========================================================================
  // CASE B — RULE 2: the blurb is exactly one sentence.
  //
  // "One sentence" is the rule the operator asked for and the reason the blurb
  // works: it is short enough to be absorbed without a decision to read it.
  // Two sentences is a paragraph, and a paragraph gets skipped.
  // ===========================================================================
  for (const [id, intro] of Object.entries(PAGE_INTROS)) {
    assert(intro.blurb.endsWith("."), `CASE B: ${id} — the blurb must be a full sentence ending in a period`);
    const interior = intro.blurb.slice(0, -1);
    assert(
      !/[.?!]\s+[A-Z]/.test(interior),
      `CASE B: ${id} — the blurb must be ONE sentence, not a paragraph. Got: "${intro.blurb}"`,
    );
    assert(
      intro.blurb.length <= 150,
      `CASE B: ${id} — the blurb is ${intro.blurb.length} characters. Over ~150 it stops being glanceable. Got: "${intro.blurb}"`,
    );
  }
  pass("CASE B — every blurb is exactly one sentence, and short enough to take in at a glance");

  // ===========================================================================
  // CASE C — RULE 1: the heading is a heading, not a sentence or a label with
  // punctuation, and it is short enough to survive at h1 size on a phone.
  // ===========================================================================
  for (const [id, intro] of Object.entries(PAGE_INTROS)) {
    assert(intro.heading.length > 0, `CASE C: ${id} — heading must not be empty`);
    assert(
      !/[.!?]$/.test(intro.heading),
      `CASE C: ${id} — a heading does not end in punctuation. Got: "${intro.heading}"`,
    );
    assert(
      intro.heading.length <= 45,
      `CASE C: ${id} — the heading is ${intro.heading.length} characters and will wrap badly at h1 size. Got: "${intro.heading}"`,
    );
  }
  pass("CASE C — every heading is a short, unpunctuated phrase");

  // ===========================================================================
  // CASE D — No numbers in the intro copy.
  //
  // A count baked into static copy is a claim nobody re-checks: it cannot be
  // recomputed, so it silently becomes false the first time the data changes.
  // Counts belong in the screen, next to the list they describe, where the
  // operator can see the number and the thing it counts at the same time. This
  // is the same failure as the Questions from AI screen printing "12" four
  // different ways and four totals that disagreed.
  // ===========================================================================
  for (const [id, intro] of Object.entries(PAGE_INTROS)) {
    const withDigits = `${intro.heading} ${intro.blurb}`.match(/\d+/g);
    assert(
      withDigits === null,
      `CASE D: ${id} — intro copy must not contain numbers (found ${withDigits?.join(", ")}). A number in static copy cannot be recomputed and goes stale silently.`,
    );
  }
  pass("CASE D — no counts baked into static copy");

  // ===========================================================================
  // CASE E — The table is actually WIRED. A copy table nothing renders is
  // worse than no table: it looks like the problem was solved.
  // ===========================================================================
  assert(
    /from "@\/app\/page-intros"/.test(page),
    "CASE E: src/app/page.tsx must import PAGE_INTROS — otherwise this table is decorative",
  );
  assert(
    /PAGE_INTROS\[active\]/.test(page),
    "CASE E: the shell must look the intro up by the ACTIVE tab, so every screen gets its own heading and blurb",
  );
  assert(
    /\.blurb/.test(page),
    "CASE E: the shell must render the blurb, not just the heading — the one-sentence explanation is half the rule",
  );
  pass("CASE E — the shell imports the table and renders both the heading and the blurb");

  // ===========================================================================
  // CASE F — the e2e suite's label -> tab-id transcription matches the product.
  //
  // WHY. Three specs (ui-value-verification, visual-audit-sweep) confirm a nav
  // click landed by asserting the shell <h1> is EXACTLY the heading the screen
  // should have. Before this change that expected string was the sidebar label
  // itself, so it could not drift. It now comes from PAGE_INTROS, looked up
  // through a hand-written label -> id map in e2e/helpers/nav.ts.
  //
  // A hand-written map can go stale, and the failure would be nasty: rename a
  // tab, and every one of those assertions starts comparing against the wrong
  // screen's heading — or against `undefined`, which quietly degrades into "any
  // heading", which is precisely the loosening the assertion exists to prevent.
  // So the map is checked against the `tabs` table in BOTH directions here,
  // where it costs a second, rather than in a 250-test browser run.
  // ===========================================================================
  const navHelper = readFileSync("e2e/helpers/nav.ts", "utf8");
  const mapBlock = navHelper.slice(
    navHelper.indexOf("export const TAB_ID_BY_LABEL"),
    navHelper.indexOf("};", navHelper.indexOf("export const TAB_ID_BY_LABEL")),
  );
  assert(
    mapBlock.length > 100,
    "CASE F: could not locate TAB_ID_BY_LABEL in e2e/helpers/nav.ts — this golden's source parse needs updating, not the code",
  );
  const e2eMap = new Map<string, string>(
    [...mapBlock.matchAll(/^\s*"([^"]+)":\s*"([a-zA-Z]+)",/gm)].map((m) => [m[1], m[2]]),
  );
  assert(
    e2eMap.size >= 26,
    `CASE F: parsed only ${e2eMap.size} entries out of TAB_ID_BY_LABEL — the source parse is broken, not the code`,
  );

  // The product's own label -> id pairs, from the same `tabs` table CASE A read.
  const productPairs = [...tabsBlock.matchAll(/^\s*\["([a-zA-Z]+)",\s*"([^"]+)"/gm)].map((m) => ({ id: m[1], label: m[2] }));
  assert(
    productPairs.length === tabIds.length,
    `CASE F: parsed ${productPairs.length} label pairs but ${tabIds.length} tab ids — the source parse is broken, not the code`,
  );

  for (const { id, label } of productPairs) {
    const mapped = e2eMap.get(label);
    assert(
      mapped !== undefined,
      `CASE F: the sidebar offers "${label}" but e2e/helpers/nav.ts TAB_ID_BY_LABEL has no entry for it, so expectedHeadingFor("${label}") would throw and every nav assertion for that screen would fail. Add it.`,
    );
    assert(
      mapped === id,
      `CASE F: e2e/helpers/nav.ts maps "${label}" to tab "${mapped}", but the product's tab for that label is "${id}". The e2e suite would assert the WRONG screen's heading — which passes on the wrong screen, the exact bug this assertion exists to catch.`,
    );
  }
  for (const label of e2eMap.keys()) {
    assert(
      productPairs.some((p) => p.label === label),
      `CASE F: e2e/helpers/nav.ts maps "${label}", which is not a tab the product offers any more. Dead entry — remove it or fix the label.`,
    );
  }
  pass(`CASE F — the e2e label→tab map matches all ${productPairs.length} screens, both directions`);

  console.log(`\n✅ ${passed} passed, 0 failed — ALL GREEN ✅\n`);
}

main().catch((err) => {
  console.error(`\n❌ FAILED after ${passed} passed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
