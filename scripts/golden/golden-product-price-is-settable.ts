/**
 * Golden test — an owner must be able to set a product's price.
 *
 * WHY THIS EXISTS (2026-09-08, session 54)
 * ----------------------------------------
 * Found by walking the live demo as a customer would, not by a test.
 *
 * `ProductSetting` has carried `price` and `priceUnit` since 2026-07-19,
 * documented there as "Owner-controlled factual data; the AI never guesses a
 * price". The Catalogue screen renders a "Base price" column, tells the owner
 * these are "the details the AI needs before it can quote anyone", and offers a
 * price-change preview that needs an old price to compare against.
 *
 * Nothing in the product could ever WRITE those two fields:
 *
 *   - the Products tab of Business settings rendered Name, Category, Material,
 *     Packaging, MOQ, both dispatch times, a customization checkbox, use-case
 *     tags and Notes — and no price;
 *   - `ProductSettingsDraftService`, which turns pasted product notes into rows,
 *     had no pattern for the word "price" at all.
 *
 * So every workspace on every substrate showed "No price set" against every
 * product for ever, the price-change preview could not run on a real number,
 * and a quote could not carry a price the owner had actually stated. This is
 * the "a screen that reads a field nothing writes" shape — the read side was
 * built, reviewed and shipped, and the write side was never there.
 *
 *   CASE A — the pasted-notes parser extracts a price and its unit, in the
 *     three forms people actually write ("price: Rs 300 per Kg", "price: 300/kg",
 *     "Price = 1,250"), and does NOT invent one when none was written.
 *
 *   CASE B — a product with no price still parses, and the draft warns about the
 *     missing price the same way it warns about a missing MOQ. Silence is what
 *     let this survive; the warning is the fix that generalises.
 *
 *   CASE C — static control-presence guard: the editor offers both labelled
 *     price and price-unit inputs. The actual write contract is exercised by
 *     e2e/nested-ui-journey.spec.ts: decimal typing, save, reload, unit, zero,
 *     clearing and invalid-input rejection. Do not pin an internal setter:
 *     converting each keystroke prevented owners from typing decimals.
 *
 * Runs on neither substrate: pure parsing plus a source read. No I/O.
 */
import { draftProductSettingsFromNotes } from "../../src/services/ProductSettingsDraftService";
import { readSource } from "./_helpers/read-source";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// 2026-09-30: the product editor moved from Settings to Catalogue → "Add or edit products".
const EDITOR = "src/app/sections/ProductEditor.tsx";

async function main() {
  console.log("=== GOLDEN: a product price is settable ===\n");

  // ---------------------------------------------------------------- CASE A
  {
    const notes = [
      "Kasab Zari Thread - category: Metallic zari thread, MOQ: 50 Kg, packaging: 250 g cones, dispatch: 1 to 2 days, price: Rs 300 per Kg",
      "Cording Thread - category: Fancy cording dori, MOQ: 100 Kg, packaging: 15 cones per bag, dispatch: 5 to 7 days, price: 245/kg",
      "Metallic Zari Thread - category: Metallic zari, MOQ: 50 Kg, packaging: carton, dispatch: 1 to 2 days, Price = 1,250",
    ].join("\n");

    const { products } = draftProductSettingsFromNotes(notes);
    assert(products.length === 3, `CASE A: expected 3 product rows, got ${products.length}`);

    const [kasab, cording, metallic] = products;

    assert(kasab.price === 300, `CASE A: "price: Rs 300 per Kg" must parse to 300, got ${JSON.stringify(kasab.price)}`);
    assert(kasab.priceUnit === "per Kg", `CASE A: the unit must survive as "per Kg", got ${JSON.stringify(kasab.priceUnit)}`);

    assert(cording.price === 245, `CASE A: "price: 245/kg" must parse to 245, got ${JSON.stringify(cording.price)}`);
    assert(cording.priceUnit === "per kg", `CASE A: "245/kg" must yield "per kg", got ${JSON.stringify(cording.priceUnit)}`);

    assert(metallic.price === 1250, `CASE A: "Price = 1,250" must parse to 1250, got ${JSON.stringify(metallic.price)}`);

    console.log("✅ CASE A — price and unit are parsed from the three forms owners actually write");
  }

  // ---------------------------------------------------------------- CASE B
  {
    const { products, warnings } = draftProductSettingsFromNotes(
      "Neem Zari Thread - category: Metallic zari thread, MOQ: 50 Kg, packaging: 250 g cones, dispatch: 1 to 2 days",
    );
    assert(products.length === 1, `CASE B: expected 1 product row, got ${products.length}`);
    assert(
      products[0].price === undefined,
      `CASE B: no price was written, so none may be invented — got ${JSON.stringify(products[0].price)}`,
    );
    assert(
      warnings.some((w) => /price was not detected/i.test(w)),
      `CASE B: a missing price must be warned about, like a missing MOQ. Warnings: ${JSON.stringify(warnings)}`,
    );
    console.log("✅ CASE B — a missing price is reported, never guessed");
  }

  // ---------------------------------------------------------------- CASE C
  {
    const source = readSource(EDITOR);
    assert(
      source.includes('label="Price (number only)"'),
      `CASE C: ${EDITOR} must offer the labelled price input; its real save/reload contract is checked by the nested browser suite.`,
    );
    assert(
      source.includes('label="Price per (kg, piece, metre)"'),
      `CASE C: ${EDITOR} must offer the price-unit input — a bare number is not a price.`,
    );
    console.log("✅ CASE C — both labelled price controls exist; browser CI verifies their saved values");
  }

  console.log("\n✅✅✅ All product-price golden cases PASSED (A–C). ✅✅✅");
}

main().catch((err) => {
  console.error("\n❌ GOLDEN FAILED:", err);
  process.exit(1);
});
