/**
 * golden-utils-format.ts — pins 2 DARK pure-logic utility libs
 * (Session 7 Coverage Map, 2026-07-28):
 *   1. src/lib/format.ts → formatFileSize
 *   2. src/lib/company-size.ts → normalizeCompanySizeBucket
 *
 * WHY: formatFileSize renders upload sizes to the operator; a regression shows
 * "NaN MB" or wrong units. normalizeCompanySizeBucket feeds segmentation + the
 * lead-rules pipeline; a regression mis-buckets company size (affects ICP).
 * Both DARK. This golden pins their pure-logic contracts.
 *
 * HAND-COMPUTED (anti-cheat):
 *   formatFileSize: 1 → "1 byte"; 840 → "840 bytes"; 15625999 → 14.9 MB;
 *     null/undefined/NaN → "Unknown size".
 *   normalizeCompanySizeBucket: "Solo/Small Business" → solo_small_business;
 *     "Medium-Company" → medium_company; "Micro" → unknown; null → unknown.
 *
 * Run: `npm run golden:utils-format`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { formatFileSize } from "@/lib/format";
import { normalizeCompanySizeBucket } from "@/lib/company-size";
import { formatINR, formatINRNumber } from "@/lib/money";

async function main() {
  console.log("golden-utils-format: pinning formatFileSize + company-size normalization...\n");

  // === formatFileSize =======================================================
  // F1 — singular vs plural at the byte boundary.
  assert.strictEqual(formatFileSize(1), "1 byte", "F1: 1 → '1 byte' (singular)");
  assert.strictEqual(formatFileSize(840), "840 bytes", "F1: 840 → '840 bytes' (plural)");
  console.log("  F1 OK: byte singular/plural boundary correct.");

  // F2 — KB / MB / GB scaling (hand-computed: 15625999/1048576 = 14.897... → 14.9 MB).
  const mb = formatFileSize(15625999);
  assert.ok(/14\.9\s*MB/i.test(mb), `F2: 15625999 → "14.9 MB", got "${mb}"`);
  const kb = formatFileSize(2048);
  assert.ok(/2\.0\s*KB/i.test(kb), `F2: 2048 → "2.0 KB", got "${kb}"`);
  console.log(`  F2 OK: KB/MB scaling correct ("${kb}", "${mb}").`);

  // F3 — null/undefined/NaN → "Unknown size" (never "NaN undefined").
  assert.strictEqual(formatFileSize(null), "Unknown size", "F3: null → Unknown size");
  assert.strictEqual(formatFileSize(undefined), "Unknown size", "F3: undefined → Unknown size");
  assert.strictEqual(formatFileSize(Number.NaN), "Unknown size", "F3: NaN → Unknown size");
  console.log("  F3 OK: null/undefined/NaN → 'Unknown size' (no NaN render).");

  // === normalizeCompanySizeBucket ===========================================
  // C1 — solo/small variants collapse to solo_small_business.
  assert.strictEqual(normalizeCompanySizeBucket("Solo/Small Business"), "solo_small_business", "C1: 'Solo/Small Business' → solo_small_business");
  assert.strictEqual(normalizeCompanySizeBucket("solo"), "solo_small_business", "C1: 'solo' → solo_small_business");
  assert.strictEqual(normalizeCompanySizeBucket("Small Business"), "solo_small_business", "C1: 'Small Business' → solo_small_business");
  console.log("  C1 OK: solo/small variants → solo_small_business.");

  // C2 — small/medium/large company buckets.
  assert.strictEqual(normalizeCompanySizeBucket("Small Company"), "small_company", "C2: 'Small Company' → small_company");
  assert.strictEqual(normalizeCompanySizeBucket("Medium-Company"), "medium_company", "C2: 'Medium-Company' → medium_company (hyphen handled)");
  assert.strictEqual(normalizeCompanySizeBucket("Large Company"), "large_company", "C2: 'Large Company' → large_company");
  console.log("  C2 OK: small/medium/large company buckets + hyphen handling.");

  // C3 — unknown / null / unrecognized → unknown (never throws, never undefined).
  assert.strictEqual(normalizeCompanySizeBucket("Micro"), "unknown", "C3: 'Micro' → unknown (unrecognized)");
  assert.strictEqual(normalizeCompanySizeBucket(""), "unknown", "C3: empty → unknown");
  assert.strictEqual(normalizeCompanySizeBucket(null), "unknown", "C3: null → unknown");
  assert.strictEqual(normalizeCompanySizeBucket(undefined), "unknown", "C3: undefined → unknown");
  console.log("  C3 OK: unrecognized/null/empty → unknown (no throw, no undefined).");

  // === formatINR (2026-08-02 audit P2-1 — the shared money DISPLAY formatter)
  // The whole point of ONE formatter: every money field renders IDENTICALLY.
  // Hand-computed BEFORE writing the assertions (anti-cheat):
  //   123456  → Indian grouping + 2 decimals → "₹1,23,456.00" (NOT "123,456.00" US)
  //   1500    → "₹1,500.00" (the create-form showed "₹1500.00" before — wrong)
  //   1500.5  → "₹1,500.50" (2 decimals always, even when .50)
  //   0       → "₹0.00" (never empty / "₹")
  //   null/undefined/NaN → "₹0.00" (defensive — a missing field must never
  //     render "₹NaN" or throw; the operator sees a clean zero).
  // M1 — Indian grouping (lakhs, not thousands): 1,23,456 not 123,456.
  assert.strictEqual(formatINR(123456), "₹1,23,456.00", "M1: 123456 → ₹1,23,456.00 (Indian grouping)");
  assert.strictEqual(formatINR(1234567), "₹12,34,567.00", "M1: 1234567 → ₹12,34,567.00 (Indian grouping, lakhs)");
  console.log("  M1 OK: Indian grouping (1,23,456 not 123,456).");

  // M2 — always 2 decimals (the create-order form's toFixed(2) was right on
  // decimals but wrong on grouping; the order detail was right on grouping but
  // wrong on decimals — formatINR unifies both).
  assert.strictEqual(formatINR(1500), "₹1,500.00", "M2: 1500 → ₹1,500.00 (grouping + 2 decimals)");
  assert.strictEqual(formatINR(1500.5), "₹1,500.50", "M2: 1500.5 → ₹1,500.50");
  assert.strictEqual(formatINR(0), "₹0.00", "M2: 0 → ₹0.00");
  console.log("  M2 OK: always 2 decimals + grouping unified.");

  // M3 — defensive: null/undefined/NaN → ₹0.00 (never ₹NaN, never throw).
  assert.strictEqual(formatINR(null), "₹0.00", "M3: null → ₹0.00");
  assert.strictEqual(formatINR(undefined), "₹0.00", "M3: undefined → ₹0.00");
  assert.strictEqual(formatINR(Number.NaN), "₹0.00", "M3: NaN → ₹0.00");
  console.log("  M3 OK: null/undefined/NaN → ₹0.00 (no NaN render, no throw).");

  // M4 — formatINRNumber (no symbol) matches formatINR minus the ₹.
  assert.strictEqual(formatINRNumber(123456), "1,23,456.00", "M4: formatINRNumber matches formatINR minus ₹");
  assert.strictEqual(formatINRNumber(0), "0.00", "M4: formatINRNumber 0 → 0.00");
  console.log("  M4 OK: formatINRNumber (symbol-less variant) consistent.");

  console.log("\nPASS golden-utils-format: formatFileSize (3) + company-size (3) + formatINR (4).");
}

main().catch((err) => {
  console.error("\nFAIL golden-utils-format:", err.message);
  process.exit(1);
});
