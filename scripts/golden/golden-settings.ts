/**
 * golden-settings.ts — SettingsService round-trip pin (NEW coverage, 2026-07-27).
 *
 * WHY THIS TEST EXISTS:
 *   SettingsService had NO golden test. It is the thin service layer over the
 *   4 settings repositories (sales / product / policy / communication). The
 *   load-bearing contract is the ROUND-TRIP: a value the operator sets via
 *   updateX must come back verbatim from getX, and a partial second update
 *   must NOT erase fields the first update set (Object.assign merge). A silent
 *   round-trip bug means the operator's policy text / MOQ rules / tone vanish
 *   on the next page load. We pin all 4 areas + the merge + workspace scoping.
 *
 * HAND-COMPUTED CONTRACT (the anti-cheat — these are the rules, not the code):
 *
 *   CASE A — sales settings round-trip + partial-update merge.
 *     updateSalesSettings({ defaultMOQ: "100 kg", standardCreditPeriod: "30 days" })
 *     → getSalesSettings returns BOTH fields. Then a second
 *     updateSalesSettings({ advancePaymentRule: "50% advance" }) must NOT
 *     erase defaultMOQ / standardCreditPeriod (Object.assign merges). Hand-
 *     computed: after both calls, the row has all 3 fields.
 *
 *   CASE B — product settings round-trip (the products[] array + price).
 *     updateProductSettings({ products: [{ name: "Zari Gold", price: 450,
 *     priceUnit: "per kg" }] }) → getProductSettings returns the product with
 *     its price intact. The price is owner-controlled factual data; a round-
 *     trip bug here loses the headline price the agent quotes from.
 *
 *   CASE C — policy settings round-trip (long-form policy text).
 *     updatePolicySettings({ paymentPolicy: "Payment via UPI/NEFT within 7 days",
 *     returnReplacementPolicy: "Returns accepted within 7 days of delivery" })
 *     → getPolicySettings returns both texts verbatim. Long-form text is the
 *     most likely to be silently truncated/dropped by a buggy setter.
 *
 *   CASE D — communication settings round-trip (tone + arrays + fallback).
 *     updateCommunicationSettings({ tone: "Professional", defaultFallbackReply:
 *     "Let me check and revert.", allowedAutoReplyTopics: ["pricing",
 *     "catalogue"] }) → getCommunicationSettings returns tone, the fallback
 *     string, AND the array with both entries. Array round-trips are a common
 *     drop point.
 *
 *   CASE E — workspace scoping: workspace A's settings are NOT visible to
 *     workspace B. setSalesSettings on WS_A, then getSalesSettings on WS_B
 *     returns undefined. This is the multi-tenant isolation rule (Cluster 1
 *     fixed the same pattern for other collections).
 *
 * REAL PIPELINE: imports the 8 real exported getters/setters + the real JSON
 * repo. Each case uses a unique timestamped workspace so demo data stays clean.
 *
 * Run: `npm run golden:settings`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import {
  getSalesSettings, updateSalesSettings,
  getProductSettings, updateProductSettings,
  getPolicySettings, updatePolicySettings,
  getCommunicationSettings, updateCommunicationSettings,
} from "@/services/SettingsService";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories/interfaces";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

function caseWorkspace(slug: string): string {
  return `ws_golden_settings_${slug}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

// --- CASE A: sales settings round-trip + partial-update merge ------------------
test("CASE A — sales settings round-trip + a partial second update does NOT erase prior fields", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("A");

  // First update sets two fields.
  await updateSalesSettings(WS, {
    defaultMOQ: "100 kg",
    standardCreditPeriod: "30 days",
  }, repos);
  let s = await getSalesSettings(WS, repos);
  assert.ok(s, "sales settings row created");
  assert.strictEqual(s.defaultMOQ, "100 kg", "defaultMOQ round-trips");
  assert.strictEqual(s.standardCreditPeriod, "30 days", "standardCreditPeriod round-trips");

  // Second PARTIAL update adds a third field — must NOT erase the first two.
  await updateSalesSettings(WS, { advancePaymentRule: "50% advance" }, repos);
  s = await getSalesSettings(WS, repos);
  assert.ok(s, "sales settings row still present after second update");
  // Hand-computed: Object.assign merges → all 3 fields present.
  assert.strictEqual(s.defaultMOQ, "100 kg", "defaultMOQ PRESERVED across partial update");
  assert.strictEqual(s.standardCreditPeriod, "30 days", "standardCreditPeriod PRESERVED across partial update");
  assert.strictEqual(s.advancePaymentRule, "50% advance", "advancePaymentRule round-trips");
});

// --- CASE B: product settings round-trip (products[] + price) -----------------
test("CASE B — product settings round-trip preserves the products[] array + price", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("B");

  await updateProductSettings(WS, {
    products: [
      { id: "p1", name: "Zari Gold", price: 450, priceUnit: "per kg" },
      { id: "p2", name: "Zari Silver", price: 380, priceUnit: "per kg" },
    ],
  }, repos);
  const s = await getProductSettings(WS, repos);
  assert.ok(s, "product settings row created");
  assert.ok(Array.isArray(s.products), "products is an array");
  assert.strictEqual(s.products.length, 2, "both products round-tripped");
  // The price is the load-bearing owner-stamped fact.
  const gold = s.products.find((p) => p.name === "Zari Gold");
  assert.ok(gold, "Zari Gold product present");
  assert.strictEqual(gold.price, 450, "Zari Gold price round-trips (450)");
  assert.strictEqual(gold.priceUnit, "per kg", "Zari Gold priceUnit round-trips");
});

// --- CASE C: policy settings round-trip (long-form text) ----------------------
test("CASE C — policy settings round-trip preserves long-form policy text verbatim", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("C");
  const payment = "Payment via UPI/NEFT within 7 days of invoice. Goods dispatched after payment realisation.";
  const returns = "Returns accepted within 7 days of delivery for manufacturing defects only.";

  await updatePolicySettings(WS, {
    paymentPolicy: payment,
    returnReplacementPolicy: returns,
  }, repos);
  const s = await getPolicySettings(WS, repos);
  assert.ok(s, "policy settings row created");
  // Hand-computed: verbatim round-trip of long-form text.
  assert.strictEqual(s.paymentPolicy, payment, "paymentPolicy round-trips verbatim");
  assert.strictEqual(s.returnReplacementPolicy, returns, "returnReplacementPolicy round-trips verbatim");
});

// --- CASE D: communication settings round-trip (tone + fallback + array) ------
test("CASE D — communication settings round-trip preserves tone, fallback string, AND arrays", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("D");
  const topics = ["pricing", "catalogue", "delivery"];

  await updateCommunicationSettings(WS, {
    tone: "Professional",
    defaultFallbackReply: "Let me check with my team and revert shortly.",
    allowedAutoReplyTopics: topics,
  }, repos);
  const s = await getCommunicationSettings(WS, repos);
  assert.ok(s, "communication settings row created");
  assert.strictEqual(s.tone, "Professional", "tone round-trips");
  assert.strictEqual(s.defaultFallbackReply, "Let me check with my team and revert shortly.", "defaultFallbackReply round-trips verbatim");
  // Array round-trip — common silent-drop point.
  assert.ok(Array.isArray(s.allowedAutoReplyTopics), "allowedAutoReplyTopics is an array");
  assert.deepStrictEqual(s.allowedAutoReplyTopics, topics, "allowedAutoReplyTopics array round-trips with all 3 entries");
});

// --- CASE E: workspace scoping (multi-tenant isolation) -----------------------
test("CASE E — settings are workspace-scoped (WS_A's sales settings invisible to WS_B)", async () => {
  const repos = createJsonRepos();
  const WS_A = caseWorkspace("E_A");
  const WS_B = caseWorkspace("E_B");

  await updateSalesSettings(WS_A, { defaultMOQ: "50 kg" }, repos);

  const a = await getSalesSettings(WS_A, repos);
  const b = await getSalesSettings(WS_B, repos);
  // Hand-computed: WS_A sees its row; WS_B sees nothing.
  assert.ok(a, "WS_A sees its sales settings");
  assert.strictEqual(a.defaultMOQ, "50 kg", "WS_A's defaultMOQ is set");
  assert.strictEqual(b, undefined, "WS_B sees NO sales settings for WS_A (workspace-scoped)");
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
  console.log(`settings: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
