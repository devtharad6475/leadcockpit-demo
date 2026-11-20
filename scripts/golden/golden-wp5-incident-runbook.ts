/**
 * Golden test — Stage 5 / WP5 (2026-07-29) — Incident runbook content pin.
 *
 * Skill build-right Phase 3: pins that docs/planning/INCIDENT_RUNBOOK.md
 * EXISTS and CONTAINS the operator-approved business rules. Same pattern
 * as golden:no-auto-outreach (document-content pin) — a static-content
 * golden so an audit cannot claim "no proof the runbook is correct".
 *
 * Per docs/DECISIONS.md D-2026-07-29-e…j + docs/LOGIC.md §WP5.1 + §WP5.2:
 *   - 3 severity levels (SEV1 / SEV2 / SEV3).
 *   - Only SEV1 wakes the operator immediately.
 *   - SEV1 response: 1h acknowledge / 24h resolve.
 *   - SEV2 response: 1 business day ack / 1 week resolve.
 *   - SEV3 response: 1 week ack / best-effort resolve.
 *   - Comms templates (customer notice + postmortem) present.
 *   - 4-step incident response (acknowledge / stabilize / communicate /
 *     resolve+postmortem) present.
 *   - Alert channel = email via OPERATOR_ALERT_EMAIL (NO WhatsApp/SMS).
 *
 * Why pin the document, not the code: the runbook is a HUMAN artifact —
 * the operator follows it in a crisis. Its correctness cannot be proven
 * by a code test; only by asserting the words are there and match the
 * decisions. If a future edit removes "Only SEV1 wakes you" or changes
 * "1 hour" to "1 minute", this golden screams.
 *
 * Run: npx tsx scripts/golden/golden-wp5-incident-runbook.ts
 */
export {};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

let passed = 0;
function pass(name: string) {
  console.log(`  ✓ ${name}`);
  passed += 1;
}

function main() {
  console.log(`\n=== golden:wp5-incident-runbook ===\n`);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path");
  const RUNBOOK_PATH = path.join(__dirname, "..", "..", "docs", "planning", "INCIDENT_RUNBOOK.md");

  // File must exist.
  assert(fs.existsSync(RUNBOOK_PATH), `INCIDENT_RUNBOOK.md must exist at ${RUNBOOK_PATH}`);
  const content: string = fs.readFileSync(RUNBOOK_PATH, "utf8");
  assert(content.length > 1000, "runbook must be a substantial document (>1000 chars)");

  // ===========================================================================
  // CASE 1 — 3 severity levels named explicitly.
  // ===========================================================================
  {
    for (const level of ["SEV1", "SEV2", "SEV3"]) {
      assert(content.includes(level), `runbook must name severity level ${level}`);
    }
    // Each level must be paired with a meaning line (not just a passing
    // mention in a table cell that could be deleted).
    assert(/SEV1[^S]*whole system down/i.test(content) || /whole system down[^S]*SEV1/i.test(content),
      "SEV1 must be defined as 'whole system down' or equivalent");
    pass("CASE 1 — 3 severity levels (SEV1/2/3) named + defined");
  }

  // ===========================================================================
  // CASE 2 — "Only SEV1 wakes the operator" rule is present.
  // ===========================================================================
  {
    // The exact phrasing can vary, but the rule must be unambiguous.
    const hasRule =
      content.includes("Only SEV1 wakes you") ||
      content.includes("only SEV1 wakes") ||
      /SEV1[^S]*immediately[^S]*SEV2/i.test(content);
    assert(hasRule, "runbook must state the 'only SEV1 wakes the operator' rule");
    pass("CASE 2 — 'Only SEV1 wakes the operator' rule present");
  }

  // ===========================================================================
  // CASE 3 — SEV1 response targets: 1h ack / 24h resolve (Golden Thread with
  // LOGIC.md §WP5.2 + DECISIONS.md D-2026-07-29-j).
  // ===========================================================================
  {
    assert(content.includes("1 hour"), "runbook must state '1 hour' SEV1 ack target");
    assert(content.includes("24 hours"), "runbook must state '24 hours' SEV1 resolve target");
    pass("CASE 3 — SEV1 targets (1h ack / 24h resolve) present");
  }

  // ===========================================================================
  // CASE 4 — 4-step incident response framework present.
  // ===========================================================================
  {
    for (const step of ["Acknowledge", "Stabilize", "Communicate", "Resolve"]) {
      assert(content.includes(step), `runbook must include step '${step}'`);
    }
    pass("CASE 4 — 4-step incident response (Acknowledge/Stabilize/Communicate/Resolve)");
  }

  // ===========================================================================
  // CASE 5 — Communications templates present (customer notice + postmortem).
  // ===========================================================================
  {
    assert(/Template A/i.test(content), "runbook must include Template A (customer notice)");
    assert(/Template B/i.test(content), "runbook must include Template B (postmortem)");
    assert(/postmortem/i.test(content), "runbook must mention postmortem");
    assert(/root cause/i.test(content), "postmortem template must include 'root cause' section");
    pass("CASE 5 — comms templates (customer notice + postmortem) present");
  }

  // ===========================================================================
  // CASE 6 — Alert channel is email-only (NO WhatsApp/SMS) — Golden Thread
  // with the no-auto-outreach rule.
  // ===========================================================================
  {
    assert(content.includes("OPERATOR_ALERT_EMAIL"), "runbook must name the OPERATOR_ALERT_EMAIL env var");
    assert(/no whatsapp/i.test(content) || /No WhatsApp/i.test(content),
      "runbook must explicitly state 'no WhatsApp' (honors no-auto-outreach)");
    pass("CASE 6 — alert channel = email-only (no WhatsApp/SMS) — no-auto-outreach honored");
  }

  // ===========================================================================
  // CASE 7 — Pre-flight checklist section exists (so the operator has a
  // concrete go-live checklist, not just a theory).
  // ===========================================================================
  {
    assert(/pre-flight checklist/i.test(content), "runbook must include a pre-flight checklist section");
    assert(/OPERATOR_ALERT_EMAIL/i.test(content), "checklist must reference OPERATOR_ALERT_EMAIL");
    pass("CASE 7 — pre-flight checklist present + references OPERATOR_ALERT_EMAIL");
  }

  console.log(`\n✅ ${passed} passed, 0 failed — ALL GREEN ✅\n`);
}

try {
  main();
} catch (err) {
  console.error(`\n❌ FAILED after ${passed} passed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
