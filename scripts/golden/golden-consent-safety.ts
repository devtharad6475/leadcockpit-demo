/**
 * Golden test — Outreach consent storage + safety classifier (Stage 4 Batch 3).
 *
 * Phase 1.5 / skill v2 — written BEFORE the service code.
 *
 * Operator-confirmed rules (docs/LOGIC.md, 2026-07-21):
 *   - Default consent basis = "none" for new prospects. Workspace upgrades
 *     explicitly to legitimate_interest/consent/inbound before outreach.
 *   - Safety classifier blocks 4 categories: prices, warranty/guarantee,
 *     delivery promises, legal/credit/financial commitments.
 *
 * Hand-computed expected values:
 *
 *   CASE A — New prospect gets basis="none" by default.
 *
 *   CASE B — Workspace upgrades basis to "legitimate_interest"; record has
 *     basis + evidence + grantedAt.
 *
 *   CASE C — Withdraw consent: sets withdrawnAt, future sends blocked.
 *
 *   CASE D — AutoSendGate rejects basis="none".
 *
 *   CASE E — Safety classifier: message with "₹450" → blocked (price).
 *
 *   CASE F — Safety classifier: message with "warranty" → blocked.
 *
 *   CASE G — Safety classifier: message with "delivered in 2 days" → blocked
 *     (delivery promise).
 *
 *   CASE H — Safety classifier: message with "30-day credit" → blocked
 *     (credit/financial).
 *
 *   CASE I — Safety classifier: clean message → passes.
 *
 *   CASE J — Multiple violations in one message → all reasons returned.
 *
 *   CASE K — Currency variations: "$10", "rs 500", "Rs. 450/kg" → all blocked.
 *
 * Run: npx tsx scripts/golden/golden-consent-safety.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import {
  createDefaultConsent,
  upgradeConsentBasis,
  withdrawConsent,
  isConsentActive,
  classifyMessageSafety,
} from "@/services/ConsentService";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main() {
  // === CASE A — New prospect → basis="none" ===
  const fresh = createDefaultConsent({
    workspaceId: "ws1",
    leadId: "lead1",
    sourceChannel: "prospecting",
  });
  assert(fresh.basis === "none", `CASE A: fresh prospect basis must be "none", got ${fresh.basis}`);
  assert(fresh.grantedAt === undefined, `CASE A: no grantedAt until upgraded`);
  console.log(`  CASE A OK: new prospect → basis="none".`);

  // === CASE B — Upgrade to legitimate_interest ===
  const upgraded = upgradeConsentBasis(fresh, {
    basis: "legitimate_interest",
    evidence: "B2B outreach to textile buyer in same industry",
    classifierVersion: "v1",
  });
  assert(upgraded.basis === "legitimate_interest", `CASE B: basis upgraded`);
  assert(upgraded.grantedAt !== undefined, `CASE B: grantedAt set on upgrade`);
  assert(upgraded.evidence === "B2B outreach to textile buyer in same industry", `CASE B: evidence recorded`);
  console.log(`  CASE B OK: upgraded to legitimate_interest with evidence.`);

  // === CASE C — Withdraw consent ===
  const withdrawn = withdrawConsent(upgraded, { reason: "customer opted out" });
  assert(withdrawn.withdrawnAt !== undefined, `CASE C: withdrawnAt set`);
  assert(isConsentActive(withdrawn) === false, `CASE C: withdrawn consent is not active`);
  console.log(`  CASE C OK: withdrawn consent is inactive.`);

  // === CASE D — AutoSendGate rejects basis="none" ===
  const activeNone = isConsentActive(fresh); // fresh has basis="none"
  assert(activeNone === false, `CASE D: basis="none" is not active for sending`);
  console.log(`  CASE D OK: basis="none" fails the active check.`);

  // === CASE E — Price claim → blocked ===
  const priceBlock = classifyMessageSafety("Hi! Our zari is ₹450 per kg. Interested?");
  assert(priceBlock.passed === false, `CASE E: price message should be blocked`);
  assert(priceBlock.reasons.some((r) => r.category === "price"), `CASE E: price reason returned`);
  console.log(`  CASE E OK: "₹450" blocked.`);

  // === CASE F — Warranty claim → blocked ===
  const warrantyBlock = classifyMessageSafety("We offer a 1-year warranty on all products.");
  assert(warrantyBlock.passed === false, `CASE F: warranty message should be blocked`);
  assert(warrantyBlock.reasons.some((r) => r.category === "warranty"), `CASE F: warranty reason`);
  console.log(`  CASE F OK: "warranty" blocked.`);

  // === CASE G — Delivery promise → blocked ===
  const deliveryBlock = classifyMessageSafety("Order now, delivered in 2 days guaranteed.");
  assert(deliveryBlock.passed === false, `CASE G: delivery-promise message should be blocked`);
  assert(deliveryBlock.reasons.some((r) => r.category === "delivery_promise"), `CASE G: delivery reason`);
  console.log(`  CASE G OK: "delivered in 2 days" blocked.`);

  // === CASE H — Credit/financial → blocked ===
  const creditBlock = classifyMessageSafety("We offer 30-day credit terms for bulk orders.");
  assert(creditBlock.passed === false, `CASE H: credit message should be blocked`);
  assert(creditBlock.reasons.some((r) => r.category === "credit_financial"), `CASE H: credit reason`);
  console.log(`  CASE H OK: "30-day credit" blocked.`);

  // === CASE I — Clean message → passes ===
  const clean = classifyMessageSafety("Hi Anil, I'm reaching out from Balaji Zari Udyog. We supply zari threads to textile manufacturers. Would you be open to a quick call this week?");
  assert(clean.passed === true, `CASE I: clean message should pass, got reasons: ${JSON.stringify(clean.reasons)}`);
  assert(clean.reasons.length === 0, `CASE I: no reasons on clean message`);
  console.log(`  CASE I OK: clean introductory message passes.`);

  // === CASE J — Multiple violations → all reasons returned ===
  const multi = classifyMessageSafety("Our zari is ₹450/kg with 1-year warranty and 2-day delivery, plus 30-day credit.");
  assert(multi.passed === false, `CASE J: multi-violation should be blocked`);
  assert(multi.reasons.length >= 3, `CASE J: at least 3 reasons, got ${multi.reasons.length}`);
  const cats = multi.reasons.map((r) => r.category).sort();
  assert(cats.includes("price") && cats.includes("warranty") && cats.includes("delivery_promise"), `CASE J: price + warranty + delivery all detected`);
  console.log(`  CASE J OK: ${multi.reasons.length} violations detected in one message.`);

  // === CASE K — Currency variations ===
  for (const txt of ["$10 per piece", "rs 500 per kg", "Rs. 450/kg", "₹1000"]) {
    const r = classifyMessageSafety(`Price: ${txt}`);
    assert(r.passed === false, `CASE K: "${txt}" should be blocked`);
    assert(r.reasons.some((x) => x.category === "price"), `CASE K: "${txt}" → price reason`);
  }
  console.log(`  CASE K OK: $10, rs 500, Rs. 450/kg, ₹1000 all blocked.`);

  console.log("PASS golden-consent-safety: all 11 cases match operator-confirmed rules.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
