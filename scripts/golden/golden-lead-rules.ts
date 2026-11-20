/**
 * golden-lead-rules.ts — pins src/lib/lead-rules.ts (Session 7 Coverage Map).
 *
 * WHY: lead-rules decides (a) the FNRT qualification score (Fit/Need/Reachability
 * /Timing) that gates auto-approve, and (b) how a reply classification maps to a
 * lead status — including the protected-status rule (a "contact_later" reply must
 * NOT downgrade an existing MQL/SQL). A regression here silently mis-qualifies
 * leads or downgrades hot prospects. It was DARK. This golden pins it.
 *
 * HAND-COMPUTED (anti-cheat — written from the spec, not the code):
 *   FNRT total = sum of 4 clamped-rounded sub-scores (each 0..5), so 0..20.
 *     Bands: ≤5 unqualified · ≤10 possible · ≤14 good_prospect · ≤17 mql · ≥18 sql.
 *   Example: fit 4.4→4, need 3, reach 2, timing 5 → 14 → good_prospect.
 *   Example: all 5 → 20 → sql.
 *   Classification: ask_price → hot_lead (even overrides a protected status);
 *     contact_later on a protected status → status UNCHANGED; unsubscribe → do_not_contact.
 *
 * Run: `npm run golden:lead-rules`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import {
  calculateFNRTScore,
  getLeadStatusFromReplyClassification,
  shouldProtectQualifiedStatus,
  canEnrichLead,
} from "@/lib/lead-rules";

async function main() {
  console.log("golden-lead-rules: pinning FNRT scoring + reply-classification mapping...\n");

  // === FNRT scoring =========================================================

  // F1 — fractional sub-score is rounded then summed: 4.4→4, 3, 2, 5 = 14 → good_prospect.
  {
    const r = calculateFNRTScore({ fitScore: 4.4, needScore: 3, reachabilityScore: 2, timingScore: 5 });
    assert.strictEqual(r.fitScore, 4, `F1: fit 4.4 rounds to 4, got ${r.fitScore}`);
    assert.strictEqual(r.totalScore, 14, `F1: total = 4+3+2+5 = 14, got ${r.totalScore}`);
    assert.strictEqual(r.qualificationStatus, "good_prospect", `F1: 14 → good_prospect, got ${r.qualificationStatus}`);
    console.log("  F1 OK: 4.4+3+2+5 = 14 → good_prospect (fractional rounded, not truncated).");
  }

  // F2 — perfect scores (all 5) → 20 → sql.
  {
    const r = calculateFNRTScore({ fitScore: 5, needScore: 5, reachabilityScore: 5, timingScore: 5 });
    assert.strictEqual(r.totalScore, 20, `F2: all-5 total = 20, got ${r.totalScore}`);
    assert.strictEqual(r.qualificationStatus, "sql", `F2: 20 → sql, got ${r.qualificationStatus}`);
    console.log("  F2 OK: all 5s → 20 → sql.");
  }

  // F3 — low scores → unqualified; sub-scores clamp to [0,5].
  {
    const r = calculateFNRTScore({ fitScore: 0, needScore: 1, reachabilityScore: 0, timingScore: 1 });
    assert.strictEqual(r.totalScore, 2, `F3: 0+1+0+1 = 2, got ${r.totalScore}`);
    assert.strictEqual(r.qualificationStatus, "unqualified", `F3: 2 → unqualified, got ${r.qualificationStatus}`);
    console.log("  F2 OK: 0+1+0+1 = 2 → unqualified.");
  }

  // F4 — out-of-range sub-scores clamp to [0,5] (a buggy 99 doesn't blow the total).
  {
    const r = calculateFNRTScore({ fitScore: 99, needScore: 5, reachabilityScore: 5, timingScore: 5 });
    assert.strictEqual(r.fitScore, 5, `F4: fit 99 clamps to 5, got ${r.fitScore}`);
    assert.ok(r.totalScore <= 20, `F4: clamped total ≤ 20, got ${r.totalScore}`);
    console.log(`  F4 OK: out-of-range (99) clamps to 5; total ${r.totalScore} (no overflow).`);
  }

  // === Reply-classification → status mapping ================================

  // R1 — ask_price → hot_lead (a pricing question is a strong buying signal).
  {
    const s = getLeadStatusFromReplyClassification("ask_price", "prospected");
    assert.strictEqual(s, "hot_lead", `R1: ask_price → hot_lead, got ${s}`);
    console.log("  R1 OK: ask_price → hot_lead.");
  }

  // R2 — ask_price OVERRIDES even a protected status (a price question is that strong).
  {
    const s = getLeadStatusFromReplyClassification("ask_price", "mql");
    assert.strictEqual(s, "hot_lead", `R2: ask_price overrides mql → hot_lead, got ${s}`);
    console.log("  R2 OK: ask_price overrides a protected status (mql) → hot_lead.");
  }

  // R3 — contact_later does NOT downgrade a protected status (mql stays mql).
  {
    const s = getLeadStatusFromReplyClassification("contact_later", "sql");
    assert.strictEqual(s, "sql", `R3: contact_later on sql → sql (protected, no downgrade), got ${s}`);
    console.log("  R3 OK: contact_later does NOT downgrade a protected status (sql stays sql).");
  }

  // R4 — unsubscribe → do_not_contact (the DNC path; always wins).
  {
    const s = getLeadStatusFromReplyClassification("unsubscribe", "sql");
    assert.strictEqual(s, "do_not_contact", `R4: unsubscribe → do_not_contact, got ${s}`);
    console.log("  R4 OK: unsubscribe → do_not_contact (overrides even sql).");
  }

  // === shouldProtectQualifiedStatus + canEnrichLead =========================

  // P1 — protected status set is the high-value late-funnel statuses.
  {
    assert.strictEqual(shouldProtectQualifiedStatus("mql"), true, "P1: mql is protected");
    assert.strictEqual(shouldProtectQualifiedStatus("sql"), true, "P1: sql is protected");
    assert.strictEqual(shouldProtectQualifiedStatus("prospected"), false, "P1: prospected is NOT protected");
    console.log("  P1 OK: mql/sql protected; prospected is not.");
  }

  // E1 — canEnrichLead blocks DNC + rejected leads (no enrichment of opted-out).
  {
    assert.strictEqual(canEnrichLead({ status: "prospected", reviewStatus: "approved", doNotContact: false }), true, "E1: clean approved lead can be enriched");
    assert.strictEqual(canEnrichLead({ status: "prospected", reviewStatus: "approved", doNotContact: true }), false, "E1: DNC lead cannot be enriched");
    assert.strictEqual(canEnrichLead({ status: "rejected", reviewStatus: "approved", doNotContact: false }), false, "E1: rejected lead cannot be enriched");
    console.log("  E1 OK: DNC + rejected leads are blocked from enrichment.");
  }

  console.log("\nPASS golden-lead-rules: FNRT (4) + classification (4) + protect/enrich (2).");
}

main().catch((err) => {
  console.error("\nFAIL golden-lead-rules:", err.message);
  process.exit(1);
});
