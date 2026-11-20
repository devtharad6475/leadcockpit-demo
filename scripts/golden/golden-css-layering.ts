/**
 * Golden test — the component classes stay inside @layer components (N-UX-14).
 *
 * WHY THIS EXISTS (2026-09-04)
 * ----------------------------
 * `@import "tailwindcss"` registers every utility inside `@layer utilities`.
 * CSS cascade layers beat specificity, and an UNLAYERED rule beats any layered
 * rule regardless of specificity or source order. So while `.btn` / `.input` /
 * `.icon-btn` / `.label` sat outside a layer, every Tailwind utility written
 * next to them was silently discarded:
 *
 *   class="input pl-9"          → icon rendered on top of the placeholder (N-UX-9)
 *   class="input h-8 py-1"      → 41px of content inside a 32px box; the text of
 *                                 eleven Compliance dropdowns sliced in half
 *   class="input w-24"          → full-width price field on Catalogue
 *   class="btn text-xs py-1 px-2" → nine buttons that never got smaller
 *
 * Each of those was found by eye, months apart, and fixed one at a time. The
 * root fix is one line — naming the layer — and this test is what stops it
 * being undone by a well-meaning tidy-up, because the failure mode is INVISIBLE
 * in source: the CSS looks right, the JSX looks right, and the browser quietly
 * ignores half of it.
 *
 * WHAT THIS CANNOT PROVE. It cannot prove a given screen looks correct; that is
 * what the screen walk and the visual sweep are for. It proves the one
 * structural fact that made a whole class of visual bug possible.
 *
 * Run: npx tsx scripts/golden/golden-css-layering.ts
 */
import { readFileSync } from "node:fs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

let passed = 0;
function pass(name: string) {
  console.log(`  ✓ ${name}`);
  passed += 1;
}

/** The component classes that Tailwind utilities are routinely written beside. */
const COMPONENT_CLASSES = [".btn", ".icon-btn", ".input", ".label"];

/**
 * The properties each component class sets that a utility is likely to fight.
 * A utility losing one of these is the exact shape of every bug listed above.
 */
const CONTESTED = ["padding", "width", "background", "border-radius", "font-size", "color"];

async function main() {
  console.log("\n=== golden:css-layering ===\n");
  const css = readFileSync("src/app/globals.css", "utf8");

  // ===========================================================================
  // CASE A — the layer exists, and Tailwind is imported before it.
  //
  // Order matters for the un-layered case only, but an import that comes AFTER
  // the layer block would mean Tailwind's own layer order statement lands late;
  // pinning the order keeps the file's intent unambiguous.
  // ===========================================================================
  const importAt = css.indexOf('@import "tailwindcss"');
  assert(importAt >= 0, 'CASE A: src/app/globals.css must @import "tailwindcss" — this golden is about how that import layers things');
  const layerAt = css.indexOf("@layer components {");
  assert(
    layerAt > importAt,
    "CASE A: globals.css must declare `@layer components { … }` after the Tailwind import. Without a layer, every utility written beside .btn/.input is silently discarded (see the file header for four real bugs this caused).",
  );
  pass("CASE A — @layer components exists, after the Tailwind import");

  // ===========================================================================
  // CASE B — every component class is INSIDE that layer.
  //
  // Parsed by brace-matching from the layer's opening brace rather than by
  // regex over the whole file, so a class defined after the layer closes is
  // caught rather than counted.
  // ===========================================================================
  let depth = 0;
  let end = -1;
  for (let i = css.indexOf("{", layerAt); i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  assert(end > 0, "CASE B: could not find the closing brace of @layer components — this golden's parse needs updating, not the code");
  const inside = css.slice(layerAt, end);
  const outside = css.slice(0, layerAt) + css.slice(end);

  for (const cls of COMPONENT_CLASSES) {
    // A definition is `<cls> {` or `<cls>.<variant> {` or `<cls>:focus {` at the
    // start of a selector — not a mention inside a comment.
    const defined = new RegExp(`(^|[\\s,])\\${cls}[\\w.:()-]*\\s*\\{`, "m");
    assert(
      defined.test(inside),
      `CASE B: ${cls} is not defined inside @layer components. Every Tailwind utility written beside it will be silently ignored.`,
    );
    const strayLine = outside
      .split("\n")
      .findIndex((line) => new RegExp(`^\\s*\\${cls}[\\w.:()-]*\\s*(,|\\{)`).test(line) && !line.trim().startsWith("*"));
    assert(
      strayLine === -1,
      `CASE B: ${cls} is ALSO defined outside @layer components (globals.css line ${strayLine + 1}). That unlayered copy beats every utility again, which is the whole bug — move it inside the layer.`,
    );
  }
  pass(`CASE B — all ${COMPONENT_CLASSES.length} component classes live inside the layer, and nowhere else`);

  // ===========================================================================
  // CASE C — the properties that actually caused the bugs are the ones being
  // protected. If a future edit moves `padding` or `width` out of the layer,
  // CASE B catches it; this case checks the layer is not an empty gesture.
  // ===========================================================================
  const missing = CONTESTED.filter((prop) => !new RegExp(`\\n\\s*${prop}\\s*:`).test(inside));
  assert(
    missing.length === 0,
    `CASE C: the layer does not set [${missing.join(", ")}] any more. Those are the properties utilities collide with; if they moved out of the layer they are unlayered again and win against utilities.`,
  );
  pass(`CASE C — the layer still owns the properties utilities collide with (${CONTESTED.join(", ")})`);

  // ===========================================================================
  // CASE D — the compact field exists and sets no fixed height.
  //
  // `h-8` plus padding is what sliced the Compliance dropdowns in half. A
  // compact variant that fixes its own height would reintroduce that exact
  // failure the first time someone changes the font size.
  // ===========================================================================
  assert(
    /\.input\.input-sm\s*\{/.test(inside),
    "CASE D: .input-sm must exist inside the layer — it is what dense table rows use instead of fighting .input with utilities",
  );
  const smBody = inside.slice(inside.indexOf(".input.input-sm"));
  const smRule = smBody.slice(0, smBody.indexOf("}"));
  assert(
    // `\bheight` also matches "line-height" — the word boundary sits after the
    // hyphen. It has to be an unhyphenated `height`, which is the one that
    // fixes the box regardless of what ends up inside it.
    !/(^|[^-\w])height\s*:/.test(smRule),
    "CASE D: .input-sm must NOT set a fixed height. Padding and line-height size it, so it can never be shorter than the text inside it — a fixed height is exactly what clipped eleven Compliance dropdowns.",
  );
  pass("CASE D — .input-sm exists and is sized by its content, not by a fixed height");

  console.log(`\n✅ ${passed} passed, 0 failed — ALL GREEN ✅\n`);
}

main().catch((err) => {
  console.error(`\n❌ FAILED after ${passed} passed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
