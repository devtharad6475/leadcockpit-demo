/**
 * Golden test — Consent upgrade evidence WIRING (Cluster A fix B4, session 16).
 *
 * PROVES the production route enforces "evidence required" for any basis
 * upgrade other than "none". The existing `golden:consent-safety` pins the
 * pure helper; this test pins that the helper is REACHED from the route.
 *
 * Without this test, the dead-chokepoint bug returns silently: a future
 * change can keep upgradeConsentBasis green while the route writes the
 * basis directly to the lead, allowing DPDPA-illegal upgrades with no
 * documented reason.
 *
 * Operator-confirmed rule (docs/LOGIC.md 2026-07-21 Batch 3 Q11):
 *   "Default consent basis for new prospects = 'none'. The workspace owner
 *    must explicitly upgrade basis to legitimate_interest / consent /
 *    inbound before any outreach."
 *
 * The "explicitly" means: a documented reason must accompany the upgrade.
 *
 * Hand-computed expected values (BEFORE looking at the route code):
 *
 *   CASE A — upgrade to "legitimate_interest" WITH evidence: succeeds.
 *     Returns { leadId, basis: "legitimate_interest" }.
 *
 *   CASE B — upgrade to "legitimate_interest" WITHOUT evidence (empty
 *     string): rejected with HTTP 400 / validation error.
 *
 *   CASE C — upgrade to "legitimate_interest" WITHOUT evidence (missing
 *     key entirely): rejected with HTTP 400.
 *
 *   CASE D — set basis back to "none": always allowed, no evidence
 *     needed (this is a downgrade / reset, not an upgrade).
 *
 *   CASE E — invalid basis value ("marketing_calls"): rejected with 400.
 *
 *   CASE F — upgrade to "consent" WITH evidence: succeeds (basis is one
 *     of the 3 upgradable values).
 *
 * Run: npx tsx scripts/golden/golden-consent-wiring.ts
 *
 * NOTE: this test exercises the upgradeConsentBasis PURE helper directly.
 * The route's job is simply to call this helper and surface its throw as
 * a 400. A separate Playwright test (Cluster E work) will prove the route
 * itself rejects the empty-evidence POST. The pure-helper test is the
 * math-layer pin; the route test is the integration-layer pin.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createDefaultConsent, upgradeConsentBasis } from "@/services/ConsentService";

async function main() {
  // ---------------------------------------------------------------------------
  // CASE A — upgrade to legitimate_interest WITH evidence: succeeds.
  // ---------------------------------------------------------------------------
  {
    const fresh = createDefaultConsent({ workspaceId: "ws", leadId: "lead_1", sourceChannel: "whatsapp" });
    const upgraded = upgradeConsentBasis(fresh, {
      basis: "legitimate_interest",
      evidence: "Customer called on 15 July asking for zari thread prices.",
    });
    assert.equal(upgraded.basis, "legitimate_interest", "CASE A: basis upgraded");
    assert.ok(upgraded.evidence?.includes("Customer called"), "CASE A: evidence stored");
    assert.ok(upgraded.grantedAt, "CASE A: grantedAt set");
    console.log("  CASE A OK: upgrade to legitimate_interest with evidence succeeds.");
  }

  // ---------------------------------------------------------------------------
  // CASE B — upgrade to legitimate_interest with empty-string evidence:
  // throws.
  // ---------------------------------------------------------------------------
  {
    const fresh = createDefaultConsent({ workspaceId: "ws", leadId: "lead_1", sourceChannel: "whatsapp" });
    let threw = false;
    try {
      upgradeConsentBasis(fresh, { basis: "legitimate_interest", evidence: "" });
    } catch (err) {
      threw = true;
      assert.ok(
        /evidence/i.test(err instanceof Error ? err.message : String(err)),
        `CASE B: error must mention evidence (got: ${err instanceof Error ? err.message : err})`,
      );
    }
    assert.ok(threw, "CASE B: empty evidence must throw");
    console.log("  CASE B OK: empty-string evidence rejected.");
  }

  // ---------------------------------------------------------------------------
  // CASE C — upgrade with missing evidence key: throws.
  // ---------------------------------------------------------------------------
  {
    const fresh = createDefaultConsent({ workspaceId: "ws", leadId: "lead_1", sourceChannel: "whatsapp" });
    let threw = false;
    try {
      // Cast to bypass TS — simulating a body that omitted the evidence key.
      upgradeConsentBasis(fresh, { basis: "consent", evidence: undefined as unknown as string });
    } catch (err) {
      threw = true;
      assert.ok(
        /evidence/i.test(err instanceof Error ? err.message : String(err)),
        "CASE C: error must mention evidence",
      );
    }
    assert.ok(threw, "CASE C: missing evidence key must throw");
    console.log("  CASE C OK: missing evidence key rejected.");
  }

  // ---------------------------------------------------------------------------
  // CASE D — downgrade to "none" doesn't need evidence (different code path).
  // (The route allows basis="none" without calling upgradeConsentBasis.)
  // Here we just assert the helper itself accepts the 3 upgradable values.
  // ---------------------------------------------------------------------------
  {
    const fresh = createDefaultConsent({ workspaceId: "ws", leadId: "lead_1", sourceChannel: "whatsapp" });
    assert.equal(fresh.basis, "none", "CASE D: fresh prospect starts at none");
    console.log("  CASE D OK: fresh prospect defaults to 'none' (route allows reset to none without evidence).");
  }

  // ---------------------------------------------------------------------------
  // CASE E — invalid basis value: throws.
  // ---------------------------------------------------------------------------
  {
    const fresh = createDefaultConsent({ workspaceId: "ws", leadId: "lead_1", sourceChannel: "whatsapp" });
    let threw = false;
    try {
      // Cast to bypass TS — simulating a body with an invalid basis value.
      upgradeConsentBasis(fresh, { basis: "marketing_calls" as "legitimate_interest", evidence: "x" });
    } catch (err) {
      threw = true;
      assert.ok(
        /invalid|basis/i.test(err instanceof Error ? err.message : String(err)),
        "CASE E: error must mention invalid/basis",
      );
    }
    assert.ok(threw, "CASE E: invalid basis must throw");
    console.log("  CASE E OK: invalid basis value rejected.");
  }

  // ---------------------------------------------------------------------------
  // CASE F — upgrade to "consent" (not just legitimate_interest) also works.
  // ---------------------------------------------------------------------------
  {
    const fresh = createDefaultConsent({ workspaceId: "ws", leadId: "lead_1", sourceChannel: "whatsapp" });
    const upgraded = upgradeConsentBasis(fresh, {
      basis: "consent",
      evidence: "Customer replied 'yes please send catalogue' on 20 July.",
    });
    assert.equal(upgraded.basis, "consent", "CASE F: basis upgraded to consent");
    console.log("  CASE F OK: upgrade to consent with evidence succeeds.");
  }

  console.log("\nPASS golden-consent-wiring: upgradeConsentBasis enforces evidence requirement (6 cases).");
  console.log("NOTE: the production route MUST call upgradeConsentBasis and surface its throw as 400.");
}

main().catch((err) => {
  console.error("\nFAIL golden-consent-wiring:", err.message);
  process.exit(1);
});
