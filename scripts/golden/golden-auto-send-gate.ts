/**
 * Golden test — Stage 4 auto-send gate (11 conditions, fail-closed).
 *
 * Phase 1.5 / skill v2 — written BEFORE the gate code.
 *
 * Operator-confirmed rules (docs/LOGIC.md, 2026-07-20):
 *   - Daily scheduler runs 09:00 IST Mon–Fri.
 *   - Quiet hours: 21:00–09:00 IST.
 *   - Country allow-list: India only (default).
 *   - Daily send cap: 50 per workspace.
 *   - ALL 11 conditions must pass for any single auto-send. ANY one fail
 *     → lead stays in Review queue unsent. Fail closed.
 *   - Auto-send itself is a per-workspace toggle, default OFF.
 *
 * Hand-computed cases — each tests ONE condition failing (everything else
 * passing). Plus one baseline case where everything passes.
 *
 *   BASELINE — All 11 conditions pass → ALLOWED.
 *   CASE 1 — killSwitch ON → blocked.
 *   CASE 2 — lead below qualification threshold → blocked.
 *   CASE 3 — lead is DNC → blocked.
 *   CASE 4 — OutreachConsent basis = "none" → blocked.
 *   CASE 5 — country not in allow-list → blocked.
 *   CASE 6 — inside quiet hours → blocked.
 *   CASE 7 — workspace daily cap hit → blocked.
 *   CASE 8 — per-campaign daily cap hit → blocked.
 *   CASE 9 — no live WhatsApp/email configured → blocked.
 *   CASE 10 — safety classifier failed → blocked.
 *   CASE 11 — not using approved Meta template → blocked.
 *   CASE 12 — auto-send toggle OFF → blocked.
 *
 * Run: npx tsx scripts/golden/golden-auto-send-gate.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { evaluateAutoSendGate, type AutoSendGateInput } from "@/services/AutoSendGate";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const baseline: AutoSendGateInput = {
  killSwitchOn: false,
  leadQualified: true,
  leadIsDnc: false,
  consentBasis: "consent" as const,
  country: "IN",
  countryAllowList: ["IN"],
  insideQuietHours: false,
  workspaceDailyCap: 50,
  workspaceSendsToday: 10,
  campaignDailyCap: 20,
  campaignSendsToday: 5,
  liveProviderConfigured: true,
  safetyClassifierPassed: true,
  usesApprovedTemplate: true,
  autoSendToggleOn: true,
};

async function main() {
  // BASELINE — all 11 pass + toggle on → allowed.
  {
    const result = evaluateAutoSendGate(baseline);
    assert(result.allowed, `BASELINE: expected allowed, got blocked: ${result.reason}`);
    console.log(`  BASELINE OK: all conditions pass → allowed.`);
  }

  // CASE 1 — kill switch on.
  {
    const result = evaluateAutoSendGate({ ...baseline, killSwitchOn: true });
    assert(!result.allowed && /kill.?switch/i.test(result.reason || ""),
      `CASE 1: expected kill-switch block, got: ${result.reason}`);
    console.log(`  CASE 1 OK: kill switch → blocked.`);
  }

  // CASE 2 — lead not qualified.
  {
    const result = evaluateAutoSendGate({ ...baseline, leadQualified: false });
    assert(!result.allowed && /qualif/i.test(result.reason || ""),
      `CASE 2: expected qualification block, got: ${result.reason}`);
    console.log(`  CASE 2 OK: unqualified lead → blocked.`);
  }

  // CASE 3 — DNC.
  {
    const result = evaluateAutoSendGate({ ...baseline, leadIsDnc: true });
    assert(!result.allowed && /do.?not.?contact|dnc/i.test(result.reason || ""),
      `CASE 3: expected DNC block, got: ${result.reason}`);
    console.log(`  CASE 3 OK: DNC → blocked.`);
  }

  // CASE 4 — consent basis = none.
  {
    const result = evaluateAutoSendGate({ ...baseline, consentBasis: "none" as const });
    assert(!result.allowed && /consent|basis/i.test(result.reason || ""),
      `CASE 4: expected consent block, got: ${result.reason}`);
    console.log(`  CASE 4 OK: consent basis=none → blocked.`);
  }

  // CASE 5 — country not in allow-list.
  {
    const result = evaluateAutoSendGate({ ...baseline, country: "US" });
    assert(!result.allowed && /country|allow/i.test(result.reason || ""),
      `CASE 5: expected country block, got: ${result.reason}`);
    console.log(`  CASE 5 OK: country not in allow-list → blocked.`);
  }

  // CASE 6 — inside quiet hours.
  {
    const result = evaluateAutoSendGate({ ...baseline, insideQuietHours: true });
    assert(!result.allowed && /quiet/i.test(result.reason || ""),
      `CASE 6: expected quiet-hours block, got: ${result.reason}`);
    console.log(`  CASE 6 OK: quiet hours → blocked.`);
  }

  // CASE 7 — workspace daily cap.
  {
    const result = evaluateAutoSendGate({ ...baseline, workspaceSendsToday: 50 });
    assert(!result.allowed && /workspace.*cap|cap.*workspace/i.test(result.reason || ""),
      `CASE 7: expected workspace-cap block, got: ${result.reason}`);
    console.log(`  CASE 7 OK: workspace cap met → blocked.`);
  }

  // CASE 8 — campaign daily cap.
  {
    const result = evaluateAutoSendGate({ ...baseline, campaignSendsToday: 20 });
    assert(!result.allowed && /campaign.*cap|cap.*campaign/i.test(result.reason || ""),
      `CASE 8: expected campaign-cap block, got: ${result.reason}`);
    console.log(`  CASE 8 OK: campaign cap met → blocked.`);
  }

  // CASE 9 — no live provider.
  {
    const result = evaluateAutoSendGate({ ...baseline, liveProviderConfigured: false });
    assert(!result.allowed && /provider|live|whatsapp/i.test(result.reason || ""),
      `CASE 9: expected provider block, got: ${result.reason}`);
    console.log(`  CASE 9 OK: no live provider → blocked.`);
  }

  // CASE 10 — safety classifier failed.
  {
    const result = evaluateAutoSendGate({ ...baseline, safetyClassifierPassed: false });
    assert(!result.allowed && /safety|classifier/i.test(result.reason || ""),
      `CASE 10: expected safety block, got: ${result.reason}`);
    console.log(`  CASE 10 OK: safety classifier → blocked.`);
  }

  // CASE 11 — not using approved template.
  {
    const result = evaluateAutoSendGate({ ...baseline, usesApprovedTemplate: false });
    assert(!result.allowed && /template/i.test(result.reason || ""),
      `CASE 11: expected template block, got: ${result.reason}`);
    console.log(`  CASE 11 OK: not using approved template → blocked.`);
  }

  // CASE 12 — auto-send toggle OFF (the default).
  {
    const result = evaluateAutoSendGate({ ...baseline, autoSendToggleOn: false });
    assert(!result.allowed && /toggle|disabled|off/i.test(result.reason || ""),
      `CASE 12: expected toggle-off block, got: ${result.reason}`);
    console.log(`  CASE 12 OK: toggle OFF → blocked.`);
  }

  console.log("PASS golden-auto-send-gate: baseline + 12 fail-closed cases all match.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
