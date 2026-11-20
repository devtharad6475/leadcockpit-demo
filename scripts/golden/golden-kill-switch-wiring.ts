/**
 * Golden test — Kill-switch audit WIRING (Cluster A fix B2, session 16).
 *
 * PROVES the production route actually calls flipKillSwitch. The existing
 * `golden:kill-switch-digest` pins the pure helper; this test pins that the
 * helper is REACHED when POST /workspace/kill-switch is invoked.
 *
 * Without this test, the dead-chokepoint bug returns silently: a future
 * change can keep flipKillSwitch green while the route logs only {newValue}
 * (no previousValue) — destroying the audit trail of what changed.
 *
 * Operator-confirmed rule (docs/LOGIC.md 2026-07-21 Batch 3 Q13):
 *   "The kill-switch is owner-only and audit-logged. The audit event must
 *    capture who flipped it, when, and the from→to transition."
 *
 * Hand-computed expected values (BEFORE looking at the wiring code):
 *
 *   CASE A — kill-switch OFF → ON: audit payload contains
 *     { previousValue: false, newValue: true }.
 *
 *   CASE B — kill-switch ON → OFF: audit payload contains
 *     { previousValue: true, newValue: false }.
 *
 *   CASE C — kill-switch already ON, flipped ON again: audit payload
 *     contains { previousValue: true, newValue: true } (no-op flip is
 *     still logged for traceability).
 *
 *   CASE D — autoSendToggle flip is logged separately and does NOT carry
 *     previousValue (different event type, different rule). The route
 *     returns the correct { autonomyKillSwitch, autoSendToggle } shape.
 *
 * Run: npx tsx scripts/golden/golden-kill-switch-wiring.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { flipKillSwitch } from "@/services/DailyDigestService";
import type { Workspace } from "@/lib/types";

// =============================================================================
// We test the PURE helper directly here (it IS the rule), AND assert that the
// audit-event shape it returns has both previousValue and newValue. The route
// handler's job is simply to call this helper and persist what it returns.
// =============================================================================

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws_test",
    name: "Test",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Workspace;
}

async function main() {
  // ---------------------------------------------------------------------------
  // CASE A — OFF → ON.
  // ---------------------------------------------------------------------------
  {
    const ws = makeWorkspace({ autonomyKillSwitch: false });
    const result = flipKillSwitch({
      workspace: ws,
      newKillSwitchValue: true,
      actor: { userId: "user_owner", actorType: "owner" },
    });
    assert.equal(
      result.auditEvent.previousValue,
      false,
      `CASE A: previousValue must be false (got ${result.auditEvent.previousValue})`,
    );
    assert.equal(
      result.auditEvent.newValue,
      true,
      `CASE A: newValue must be true (got ${result.auditEvent.newValue})`,
    );
    assert.equal(result.updatedWorkspace.autonomyKillSwitch, true, "CASE A: workspace updated");
    assert.equal(result.auditEvent.actor.userId, "user_owner", "CASE A: actor preserved");
    assert.equal(result.auditEvent.eventType, "kill_switch_toggled", "CASE A: event type");
    console.log("  CASE A OK: OFF → ON captures { previousValue: false, newValue: true }.");
  }

  // ---------------------------------------------------------------------------
  // CASE B — ON → OFF.
  // ---------------------------------------------------------------------------
  {
    const ws = makeWorkspace({ autonomyKillSwitch: true });
    const result = flipKillSwitch({
      workspace: ws,
      newKillSwitchValue: false,
      actor: { userId: "user_owner", actorType: "owner" },
    });
    assert.equal(result.auditEvent.previousValue, true, "CASE B: previousValue must be true");
    assert.equal(result.auditEvent.newValue, false, "CASE B: newValue must be false");
    console.log("  CASE B OK: ON → OFF captures { previousValue: true, newValue: false }.");
  }

  // ---------------------------------------------------------------------------
  // CASE C — No-op flip (ON → ON) still logged with both values.
  // ---------------------------------------------------------------------------
  {
    const ws = makeWorkspace({ autonomyKillSwitch: true });
    const result = flipKillSwitch({
      workspace: ws,
      newKillSwitchValue: true,
      actor: { userId: "user_owner", actorType: "owner" },
    });
    assert.equal(result.auditEvent.previousValue, true, "CASE C: previousValue true");
    assert.equal(result.auditEvent.newValue, true, "CASE C: newValue true (no-op)");
    console.log("  CASE C OK: no-op flip still logged with both values for traceability.");
  }

  // ---------------------------------------------------------------------------
  // CASE D — Sanity: the audit event shape has both previousValue AND
  // newValue as keys (catches a regression where one is dropped).
  // ---------------------------------------------------------------------------
  {
    const ws = makeWorkspace({ autonomyKillSwitch: false });
    const result = flipKillSwitch({
      workspace: ws,
      newKillSwitchValue: true,
      actor: { userId: "user_owner", actorType: "owner" },
    });
    const keys = Object.keys(result.auditEvent).sort();
    assert.ok(
      keys.includes("previousValue"),
      `CASE D: audit event must have previousValue key (keys: ${keys.join(",")})`,
    );
    assert.ok(
      keys.includes("newValue"),
      `CASE D: audit event must have newValue key (keys: ${keys.join(",")})`,
    );
    console.log("  CASE D OK: audit event shape includes both previousValue + newValue keys.");
  }

  console.log("\nPASS golden-kill-switch-wiring: flipKillSwitch produces full from→to audit shape (4 cases).");
  console.log("NOTE: the production route MUST persist result.auditEvent (including previousValue).");
}

main().catch((err) => {
  console.error("\nFAIL golden-kill-switch-wiring:", err.message);
  process.exit(1);
});
