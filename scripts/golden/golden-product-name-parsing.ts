/**
 * golden-product-name-parsing.ts — N-BUG pin (2026-09-08).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * Pasting two product lines out of the operator's own company document into
 * Settings → Products → "Paste product details in your words" produced this,
 * measured on the live deployment:
 *
 *   name:  "Cloud ERP System: A comprehensive enterprise resource planning
 *           system for medium"
 *   notes: "to large businesses."
 *
 * and three warnings addressed to a product whose name is half a sentence:
 *
 *   "Cloud ERP System: A comprehensive enterprise resource planning system for
 *    medium: MOQ was not detected."
 *
 * Two faults, one visible symptom:
 *
 *   1. extractName split the first line on /\s[-:|]\s/ — a separator with
 *      whitespace on BOTH sides. "Name: description" — a colon with no space
 *      before it, which is how everyone writes it and how the operator's own
 *      document writes it — never matched, so the entire sentence became the
 *      product name.
 *   2. cleanName then capped it with .slice(0, 80), cutting mid-sentence. The
 *      remainder was not discarded but handed to buildNotes, which subtracts
 *      the name from the section and returned the leftover fragment.
 *
 * The second product on the same paste ("AI CRM: ...", 72 characters) came back
 * whole, which is why this reads as an occasional oddity rather than a parser
 * that cannot read the most common product line there is.
 *
 * HAND-COMPUTED CONTRACT (written BEFORE the fix was run):
 *
 *   CASE A — the exact live input. Two products, named "Cloud ERP System" and
 *   "AI CRM", with the descriptions in notes. This is the whole defect.
 *
 *   CASE B — no name may be a truncated sentence. Every name is either the
 *   full text up to its separator or, past the 80-character cap, cut at a word
 *   boundary — never mid-word. And a name that HAD to be truncated keeps the
 *   operator's full text in notes rather than a leftover fragment.
 *
 *   CASE C — a colon is a separator, not a licence to strip everything after
 *   one. "MOQ: 500 pieces" as a first line must not produce a product called
 *   "MOQ", and "T-shirt: cotton" must keep its hyphen. A fix that split on
 *   every colon would pass CASE A and fail here.
 *
 *   CASE D — the numbered list the operator's document actually uses
 *   ("1. Cloud ERP System: ...") drops the marker. "1." is not part of a name.
 *
 *   CASE E — the separator forms that already worked still work. " - ", " | "
 *   and explicit "Product: X" are unchanged, because this file is a fix, not a
 *   rewrite.
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { draftProductSettingsFromNotes } from "@/services/ProductSettingsDraftService";

type Case = { name: string; fn: () => void };
const cases: Case[] = [];
function test(name: string, fn: () => void) { cases.push({ name, fn }); }

/** Verbatim from the operator's uploaded company_profile.txt. */
const LIVE_PASTE = `Cloud ERP System: A comprehensive enterprise resource planning system for medium to large businesses.
AI CRM: A customer relationship management tool with AI-driven analytics.`;

test("CASE A — the live paste yields real product names, not half-sentences", () => {
  const { products } = draftProductSettingsFromNotes(LIVE_PASTE);
  assert.strictEqual(products.length, 2, `two lines, two products, got ${products.length}`);

  assert.strictEqual(
    products[0].name,
    "Cloud ERP System",
    "the name ends at the colon — this is the exact value that shipped as a truncated sentence",
  );
  assert.strictEqual(
    products[0].notes,
    "A comprehensive enterprise resource planning system for medium to large businesses.",
    "the description belongs in notes, whole — not the fragment 'to large businesses.'",
  );

  assert.strictEqual(products[1].name, "AI CRM");
  assert.strictEqual(products[1].notes, "A customer relationship management tool with AI-driven analytics.");
});

test("CASE B — no name is a truncated sentence, and truncation never loses text", () => {
  const { products, warnings } = draftProductSettingsFromNotes(LIVE_PASTE);
  for (const product of products) {
    assert.ok(product.name.length <= 80, `${product.name} exceeds the 80-char cap`);
    assert.ok(!/\bfor medium$/.test(product.name), "the exact mid-sentence cut that shipped");
  }
  // The warnings quote the name, so a bad name is a bad warning.
  assert.ok(
    warnings.includes("Cloud ERP System: MOQ was not detected."),
    `warnings must address the product by its name, got: ${warnings[0]}`,
  );

  // A genuinely over-long single name is still capped — at a word boundary, and
  // with the operator's full text preserved.
  const longName = "Industrial Grade Reinforced Multi Layer Corrugated Export Packaging Carton Assembly Unit Mark Four";
  const long = draftProductSettingsFromNotes(longName).products[0];
  assert.ok(long.name.length <= 80, `capped, got ${long.name.length}`);
  assert.ok(longName.startsWith(long.name), "the cap takes a prefix of what was typed");
  assert.ok(
    longName.slice(long.name.length).startsWith(" "),
    `the cut must land on a word boundary, so the remainder starts with a space — got "...${long.name.slice(-20)}"`,
  );
  assert.strictEqual(long.notes, longName, "a truncated name keeps the operator's full text in notes");
});

test("CASE C — a colon separator does not swallow field lines or hyphenated names", () => {
  const fieldLine = draftProductSettingsFromNotes("MOQ: 500 pieces").products[0];
  assert.notStrictEqual(fieldLine.name, "MOQ", "a field label is not a product name");

  const hyphen = draftProductSettingsFromNotes("T-shirt: cotton, screen printed").products[0];
  assert.strictEqual(hyphen.name, "T-shirt", "an internal hyphen is part of the name, not a separator");

  const url = draftProductSettingsFromNotes("Widget Pro (see https://example.com/widget)").products[0];
  assert.strictEqual(url.name, "Widget Pro (see https://example.com/widget)", "a colon with no space after it is not a separator");
});

test("CASE D — the numbered list the source document uses drops its markers", () => {
  const numbered = draftProductSettingsFromNotes(
    "1. Cloud ERP System: A comprehensive planning system.\n2) AI CRM: Analytics tool.\n- Widget: A widget.",
  );
  assert.deepStrictEqual(
    numbered.products.map((p) => p.name),
    ["Cloud ERP System", "AI CRM", "Widget"],
    "'1.', '2)' and '-' are list markers, not part of any product name",
  );
});

test("CASE E — the separator forms that already worked are unchanged", () => {
  const dash = draftProductSettingsFromNotes("Zari Gold Yarn - category: Textile, moq: 200 kg").products[0];
  assert.strictEqual(dash.name, "Zari Gold Yarn");
  assert.strictEqual(dash.category, "Textile");
  assert.strictEqual(dash.moq, "200 kg");

  const pipe = draftProductSettingsFromNotes("Brass Fitting | material: Brass").products[0];
  assert.strictEqual(pipe.name, "Brass Fitting");

  const explicit = draftProductSettingsFromNotes("Product: Copper Wire, material: Pure Copper").products[0];
  assert.strictEqual(explicit.name, "Copper Wire");
  assert.strictEqual(explicit.material, "Pure Copper");
});

// --- RUNNER ---------------------------------------------------------------------
(() => {
  console.log("golden-product-name-parsing — N-BUG (a pasted 'Name: description' line must yield the name, not the sentence)\n");
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log("");
  console.log(`product-name-parsing: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
