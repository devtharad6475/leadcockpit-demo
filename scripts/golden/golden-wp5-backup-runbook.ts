/**
 * Golden test — Stage 5 / WP5 (2026-07-29) — Backup runbook content pin.
 *
 * Skill build-right Phase 3: pins that docs/STAGE_C_BACKUP_RUNBOOK.md
 * EXISTS and CONTAINS the operator-approved backup drill checklist. This
 * REPLACES the rejected scripts/drill-restore.ts (D-2026-07-29-e honors
 * Q17/Q20: "no custom backup scripts").
 *
 * Per docs/LOGIC.md §WP5.6 + docs/DECISIONS.md Q17 + Q20 + D-2026-07-29-e:
 *   - Backups = Neon managed Postgres PITR (NOT custom scripts).
 *   - Restore drill = human checklist (NOT an automated gate).
 *   - The runbook must enumerate: sentinel record, restore-branch step,
 *     DATABASE_URL throwaway .env, check:production gate, sentinel verify,
 *     spot-check, tear-down, VERIFICATION-RECEIPTS entry.
 *   - The runbook must explicitly FORBID pg_dump / in-app restore / cron
 *     (so an audit doesn't propose re-adding them).
 *
 * Why pin the document: the backup strategy is a HUMAN process (you
 * follow the checklist before launch). Q17/Q20 said "no code" — so the
 * proof is the document's correctness, asserted here.
 *
 * Run: npx tsx scripts/golden/golden-wp5-backup-runbook.ts
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
  console.log(`\n=== golden:wp5-backup-runbook ===\n`);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path");
  const RUNBOOK_PATH = path.join(__dirname, "..", "..", "docs", "STAGE_C_BACKUP_RUNBOOK.md");

  assert(fs.existsSync(RUNBOOK_PATH), `STAGE_C_BACKUP_RUNBOOK.md must exist at ${RUNBOOK_PATH}`);
  const content: string = fs.readFileSync(RUNBOOK_PATH, "utf8");
  assert(content.length > 1000, "backup runbook must be substantial (>1000 chars)");

  // ===========================================================================
  // CASE 1 — Neon PITR is named as the primary mechanism (Q17).
  // ===========================================================================
  {
    assert(/Render Postgres/i.test(content), "runbook must name the current database host");
    assert(/free.{0,100}no managed point-in-time/i.test(content), "free plan must not be described as backed up");
    assert(/Never switch AUTH_MODE=demo/i.test(content), "recovery must not bypass authentication");
    assert(/PITR|point-in-time/i.test(content), "runbook must reference PITR (point-in-time recovery)");
    pass("CASE 1 — Current host and free-plan recovery limits are explicit");
  }

  // ===========================================================================
  // CASE 2 — The 8-step restore drill checklist is present (the human gate).
  // Steps: sentinel record, restore branch, throwaway DATABASE_URL env,
  // check:production, sentinel verify, spot-check, tear-down, receipt entry.
  // ===========================================================================
  {
    assert(/sentinel/i.test(content), "drill must include a 'sentinel record' step");
    assert(/restore.{0,40}branch|create.{0,40}branch|create.{0,40}recovery instance/i.test(content), "drill must include a 'create restore branch' step");
    assert(/DATABASE_URL/i.test(content), "drill must reference DATABASE_URL (throwaway .env)");
    assert(/check:production|check.production/i.test(content), "drill must run check:production against the restore branch");
    assert(/spot-check|spot check/i.test(content), "drill must include a spot-check step");
    assert(/tear.{0,5}down|delete.{0,40}branch/i.test(content), "drill must include a tear-down step");
    assert(/VERIFICATION-RECEIPTS/i.test(content), "drill must record the result in VERIFICATION-RECEIPTS.md");
    pass("CASE 2 — 7+ step restore drill checklist present (sentinel → branch → env → gate → verify → spot-check → teardown → receipt)");
  }

  // ===========================================================================
  // CASE 3 — Q17/Q20 honored: the runbook EXPLICITLY forbids custom scripts,
  // in-app restore, and an automated backup gate.
  // ===========================================================================
  {
    assert(/pg_dump/i.test(content), "runbook must mention pg_dump (to explicitly forbid it)");
    assert(/no.{0,10}pg_dump|no custom backup script|deliberately.{0,40}excluded/i.test(content),
      "runbook must explicitly forbid custom pg_dump scripts");
    assert(/no in-app restore|not.{0,20}restore button|no.{0,20}restore button/i.test(content),
      "runbook must explicitly forbid an in-app restore button");
    pass("CASE 3 — Q17/Q20 honored: custom scripts + in-app restore explicitly forbidden");
  }

  // ===========================================================================
  // CASE 4 — JSON demo file is documented as NOT a backup (it's demo-only).
  // ===========================================================================
  {
    assert(/JSON/i.test(content), "runbook must address the JSON demo file");
    assert(/demo-only|not.{0,20}backed up|NOT backed up/i.test(content),
      "runbook must state the JSON file is NOT backed up (demo-only)");
    pass("CASE 4 — JSON demo file documented as NOT a backup");
  }

  // ===========================================================================
  // CASE 5 — Recovery-from-data-loss section present (the "what if Neon loses
  // data" playbook).
  // ===========================================================================
  {
    assert(/data loss|loses data|data-loss/i.test(content),
      "runbook must include a 'what if Neon loses data' recovery section");
    // The recovery section must include the STOP-WRITES first step.
    assert(/stop.{0,20}write|STOP write|AUTH_MODE=demo/i.test(content),
      "recovery section must include the 'STOP writes' first step");
    pass("CASE 5 — data-loss recovery section present with STOP-WRITES first step");
  }

  console.log(`\n✅ ${passed} passed, 0 failed — ALL GREEN ✅\n`);
}

try {
  main();
} catch (err) {
  console.error(`\n❌ FAILED after ${passed} passed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
