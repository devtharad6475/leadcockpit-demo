/**
 * golden-product-settings-draft.ts — ProductSettingsDraftService pin (NEW, 2026-07-27).
 *
 * WHY THIS TEST EXISTS:
 *   ProductSettingsDraftService turns free-text owner notes into structured
 *   ProductSetting rows. It had NO golden test (DARK service). Two silent
 *   failures hurt: (1) a blank/garbled note silently returns an empty product
 *   list with no guidance, so the operator thinks the draft worked; (2) the
 *   T1.2 (2026-07-20) fix changed variants from `string[]` to `ProductVariant[]`
 *   ({id,name} stubs) — a regression would put raw strings back and crash every
 *   downstream consumer that reads variant.id.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat — these are the rules, not the code):
 *
 *   SECTION-SPLITTING TRUTH (verified by reading splitProductSections):
 *     - Blank-line-separated blocks (\n\s*\n) with ≥2 blocks → each BLOCK is a
 *       section (multi-line allowed; FIELD_PATTERNS scan the whole block).
 *     - A single block with no blank line → each LINE becomes its own section
 *       (one-product-per-line mode).
 *     - A single line → one section.
 *     So ALL multi-field cases below use 2-block input to hit the block path.
 *
 *   CASE A — blank input. draftProductSettingsFromNotes("") →
 *     { products: [], warnings: ["Add product details before creating a draft."] }.
 *     Hand-computed from line 21: cleaned is "" → early return.
 *
 *   CASE B — multi-block notes (blank-line-separated) → multiple products.
 *     Input has 2 blocks → products.length === 2, names "Zari Gold Yarn" and
 *     "Zari Silver Yarn". (block path: blockSections.length > 1.)
 *
 *   CASE C — FIELD_PATTERNS extract category/material/packaging/moq/dispatch/
 *     notes correctly. Block 1 of a 2-block input carries all 6 fields; we
 *     assert each maps to the right ProductSetting key:
 *       category → "Electrical Material"
 *       material → "Pure Copper"
 *       packaging → "25 kg coils"
 *       moq → "200 kg"
 *       inStockDispatchTime → "48 hours"   (the "dispatch:" pattern)
 *       notes → "High conductivity grade"
 *
 *   CASE D — per-product warnings fire when MOQ/packaging/dispatch missing.
 *     Block 1 = "Brass Fitting" with ONLY category → 3 warnings:
 *       "Brass Fitting: MOQ was not detected."
 *       "Brass Fitting: packaging was not detected."
 *       "Brass Fitting: dispatch time was not detected."
 *     Block 2 = a complete product → 0 extra warnings, except the price one.
 *     Total warnings === 5 (2026-09-08: a missing price is now warned about too).
 *
 *   CASE E — variants/sizes/colors map to {id, name} stubs (T1.2 fix), NOT raw
 *     strings. Block 1 has "variants: Gold, Silver, Copper" →
 *     product.variants === [{id:"<pid>_v0", name:"Gold"},
 *                            {id:"<pid>_v1", name:"Silver"},
 *                            {id:"<pid>_v2", name:"Copper"}].
 *     Each entry MUST be an object with id+name (regression guard for T1.2).
 *
 * REAL PIPELINE: imports the REAL draftProductSettingsFromNotes from
 *   @/services/ProductSettingsDraftService. No mocks. Each case builds its own
 *   literal input string (Ironclad Gate #8 — clean slate per case).
 *
 * Run: `npm run golden:product-settings-draft`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { draftProductSettingsFromNotes } from "@/services/ProductSettingsDraftService";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

// --- CASE A: blank input ------------------------------------------------------
test("CASE A — blank input returns products: [] + the documented warning", async () => {
  // Hand-computed: cleaned = "".trim() === "" → early return at line 21.
  const result = draftProductSettingsFromNotes("");
  assert.deepStrictEqual(result.products, [], "blank input yields zero products");
  assert.ok(Array.isArray(result.warnings), "warnings is an array");
  assert.strictEqual(result.warnings.length, 1, "blank input yields exactly one warning");
  assert.strictEqual(
    result.warnings[0],
    "Add product details before creating a draft.",
    'blank-input warning is the documented literal',
  );

  // Whitespace-only is ALSO blank (cleaned trims to "").
  const ws = draftProductSettingsFromNotes("   \n\t  \n  ");
  assert.deepStrictEqual(ws.products, [], "whitespace-only yields zero products");
  assert.strictEqual(ws.warnings[0], "Add product details before creating a draft.", "whitespace-only yields same warning");
});

// --- CASE B: multi-block notes → multiple products ---------------------------
test("CASE B — multi-block (blank-line-separated) notes produce multiple products", async () => {
  // Two blocks separated by a blank line → block path → 2 sections → 2 products.
  const notes = [
    "Zari Gold Yarn",
    "category: Metallic Yarn",
    "moq: 100 kg",
    "",
    "Zari Silver Yarn",
    "category: Metallic Yarn",
    "moq: 50 kg",
  ].join("\n");
  const result = draftProductSettingsFromNotes(notes);
  assert.ok(Array.isArray(result.products), "products is an array");
  assert.strictEqual(result.products.length, 2, "two blank-line-separated blocks → 2 products");
  assert.strictEqual(result.products[0].name, "Zari Gold Yarn", "block 1 name");
  assert.strictEqual(result.products[1].name, "Zari Silver Yarn", "block 2 name");
});

// --- CASE C: FIELD_PATTERNS extract all documented fields --------------------
test("CASE C — FIELD_PATTERNS extract category/material/packaging/moq/dispatch/notes", async () => {
  // Block 1 carries all 6 fields; block 2 is a minimal second product to force
  // the block-splitting path (blockSections.length > 1).
  const notes = [
    "Copper Wire",
    "category: Electrical Material",
    "material: Pure Copper",
    "packaging: 25 kg coils",
    "moq: 200 kg",
    "dispatch: 48 hours",
    "notes: High conductivity grade",
    "",
    "Second Product",
    "moq: 10 kg",
  ].join("\n");
  const result = draftProductSettingsFromNotes(notes);
  const product = result.products[0];
  assert.ok(product, "block 1 produced a product");
  assert.strictEqual(product.name, "Copper Wire", "product name from first line of block");
  // Hand-computed field-by-field from FIELD_PATTERNS (ProductSettingsDraftService.ts:9-17).
  assert.strictEqual(product.category, "Electrical Material", "category extracted");
  assert.strictEqual(product.material, "Pure Copper", "material extracted");
  assert.strictEqual(product.packaging, "25 kg coils", "packaging extracted");
  assert.strictEqual(product.moq, "200 kg", "moq extracted");
  assert.strictEqual(product.inStockDispatchTime, "48 hours", "dispatch → inStockDispatchTime");
  assert.strictEqual(product.notes, "High conductivity grade", "notes extracted");
});

// --- CASE D: per-product warnings when MOQ/packaging/dispatch missing --------
test("CASE D — per-product warnings fire when MOQ/packaging/dispatch are missing", async () => {
  // Block 1 = incomplete product (only category). Block 2 = complete product.
  const notes = [
    "Brass Fitting",
    "category: Sanitary Fittings",
    "",
    "Copper Wire",
    "packaging: 25 kg coils",
    "moq: 200 kg",
    "dispatch: 48 hours",
  ].join("\n");
  const result = draftProductSettingsFromNotes(notes);
  assert.strictEqual(result.products.length, 2, "two blocks → two products");
  assert.strictEqual(result.products[0].name, "Brass Fitting", "incomplete product is block 1");
  // Hand-computed: Brass Fitting has no moq/packaging/dispatch → 3 warnings,
  // and NEITHER product states a price → 1 more warning each.
  //
  // 2026-09-08: the price warning is new. `price` and `priceUnit` had existed on
  // ProductSetting since 2026-07-19 and nothing in the product could write them
  // — no field in the editor, no pattern in this parser — so the Catalogue
  // screen showed "No price set" against every product for ever and never said
  // why. A missing price is now reported exactly the way a missing MOQ is.
  assert.strictEqual(
    result.warnings.length,
    5,
    "3 warnings from Brass Fitting (MOQ, packaging, dispatch) + 1 price warning per product",
  );
  assert.ok(
    result.warnings.includes("Brass Fitting: price was not detected."),
    "price-missing warning fires for Brass Fitting",
  );
  assert.ok(
    result.warnings.includes("Copper Wire: price was not detected."),
    "price-missing warning fires for Copper Wire — complete on every other field, but still unquotable",
  );
  assert.ok(
    result.warnings.includes("Brass Fitting: MOQ was not detected."),
    "MOQ-missing warning fires for Brass Fitting",
  );
  assert.ok(
    result.warnings.includes("Brass Fitting: packaging was not detected."),
    "packaging-missing warning fires for Brass Fitting",
  );
  assert.ok(
    result.warnings.includes("Brass Fitting: dispatch time was not detected."),
    "dispatch-missing warning fires for Brass Fitting",
  );
});

// --- CASE E: variants map to {id, name} stubs (T1.2 fix) ---------------------
test("CASE E — variants/sizes/colors map to {id, name} stubs (T1.2 fix), NOT raw strings", async () => {
  // Block 1 lists 3 variants. Block 2 forces the block-splitting path.
  const notes = [
    "Zari Thread",
    "variants: Gold, Silver, Copper",
    "",
    "Second Product",
    "moq: 5 kg",
  ].join("\n");
  const result = draftProductSettingsFromNotes(notes);
  const product = result.products[0];
  assert.ok(product, "block 1 produced a product");
  assert.strictEqual(product.name, "Zari Thread", "product name");
  // Hand-computed: splitList("Gold, Silver, Copper") → ["Gold","Silver","Copper"],
  // each mapped to { id: `${product.id}_v${index}`, name }.
  assert.ok(Array.isArray(product.variants), "variants is an array");
  assert.strictEqual(product.variants.length, 3, "3 variants parsed");
  // T1.2 regression guard: each entry MUST be an object with id+name, not a string.
  for (const v of product.variants) {
    assert.strictEqual(typeof v, "object", "variant is an object (T1.2), not a raw string");
    assert.ok(v !== null, "variant is non-null");
    assert.ok(typeof v.id === "string" && v.id.length > 0, "variant has a non-empty string id");
    assert.ok(typeof v.name === "string" && v.name.length > 0, "variant has a non-empty string name");
  }
  assert.strictEqual(product.variants[0].name, "Gold", "variant 0 name");
  assert.strictEqual(product.variants[1].name, "Silver", "variant 1 name");
  assert.strictEqual(product.variants[2].name, "Copper", "variant 2 name");
  // id format: "<productId>_v<index>".
  assert.ok(product.variants[0].id.endsWith("_v0"), `variant 0 id ends with "_v0" (got "${product.variants[0].id}")`);
  assert.ok(product.variants[1].id.endsWith("_v1"), `variant 1 id ends with "_v1"`);
  assert.ok(product.variants[2].id.endsWith("_v2"), `variant 2 id ends with "_v2"`);
});

// --- RUNNER ---------------------------------------------------------------------
(async () => {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log("");
  console.log(`product-settings-draft: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
