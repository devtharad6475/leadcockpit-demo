/**
 * golden-workspace-cascade-completeness.ts — N-DATA-3.
 *
 * Reads `prisma/schema.prisma` and fails if any model that carries a
 * `workspaceId` column does not also declare the cascading relation to
 * `Workspace`. No database, no repositories — this is a statement about the
 * schema, so it runs offline as a logic golden.
 *
 * ─── THE DEFECT THIS EXISTS TO PREVENT ────────────────────────────────────
 *
 * `WorkspaceRepository.delete` promises, in writing, that "deleting a
 * workspace removes every row belonging to it", and says Postgres gets this
 * from the schema because every workspace child relation declares
 * `onDelete: Cascade`. On 2026-08-18 that promise was measured against the
 * ship database and found false for TEN models, which carry a `workspaceId`
 * column and declare no relation at all. Postgres does not know the column
 * points at anything, so a workspace delete cascades straight past them.
 *
 * What was actually in the ship database when this was written:
 *
 *   ticket_events:          orphaned=57  total=57
 *   ticket_sla_settings:    orphaned=28  total=28
 *   platform_tickets:       orphaned=23  total=23
 *   platform_ticket_events: orphaned=138 total=138
 *
 * 246 rows, and in every one of those tables the orphan count EQUALS the
 * total — not one legitimate row among them. All of it debris from golden runs
 * whose cleanup deleted the workspace and could not reach these tables.
 *
 * ─── WHY A SCHEMA GOLDEN RATHER THAN A DATABASE ONE ───────────────────────
 *
 * A "count the orphans" test passes the moment somebody deletes the orphans,
 * and says nothing about the next table added. The defect is not the 246 rows;
 * it is that a table can be added with a `workspaceId` and no relation and
 * nothing notices. So the rule is enforced where it is decided.
 *
 * ─── AND WHY THE PARSE IS ITSELF ASSERTED (CASE C) ────────────────────────
 *
 * A regex that matches nothing passes this test vacuously — the most dangerous
 * possible outcome, because it reads as a green guarantee. The previous audit
 * failed in exactly this family: S4-9 certified "68 of 68 workspace child
 * relations cascade", which was true, and useless, because it counted only the
 * models that already HAD the relation. The denominator was drawn from the
 * answer. CASE C asserts the parse found a plausible number of models before
 * any conclusion is drawn from it.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = path.join(process.cwd(), "prisma", "schema.prisma");

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail: string) {
  if (condition) {
    passed++;
    console.log(`  OK   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}\n       ${detail}`);
  }
}

interface ModelInfo {
  name: string;
  table: string;
  /** The raw `workspaceId` field line, or undefined when the model has none. */
  workspaceIdLine?: string;
  nullable: boolean;
  hasRelation: boolean;
  cascades: boolean;
}

function parseModels(source: string): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const match of source.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const [, name, body] = match;
    const wsLine = body.match(/^[ \t]+workspaceId[ \t]+String\??.*$/m)?.[0];
    if (!wsLine) continue;
    // The relation may be declared on any line of the model, and Prisma allows
    // it to wrap, so the whole body is searched rather than a single line.
    const relation = body.match(/@relation\(fields:\s*\[workspaceId\][^)]*\)/)?.[0];
    out.push({
      name,
      table: body.match(/@@map\("(\w+)"\)/)?.[1] || name,
      workspaceIdLine: wsLine.trim(),
      nullable: /^\s*workspaceId\s+String\?/.test(wsLine),
      hasRelation: !!relation,
      cascades: !!relation && /onDelete:\s*Cascade/.test(relation),
    });
  }
  return out;
}

function main() {
  console.log("golden-workspace-cascade-completeness");

  const source = fs.readFileSync(SCHEMA, "utf8");
  const scoped = parseModels(source);

  // ── CASE C first: nothing below means anything if the parse is broken ────
  check(
    "CASE C — the schema parse actually found the workspace-scoped models",
    scoped.length >= 60,
    `only ${scoped.length} model(s) with a workspaceId column were found. Either the schema shrank ` +
      "dramatically or this golden's parse is broken — and a broken parse passes CASE A vacuously, " +
      "which is exactly how the previous audit certified a rule it could not see the exceptions to.",
  );
  check(
    "CASE C — the model regex found models at all",
    [...source.matchAll(/^model (\w+) \{/gm)].length >= 70,
    "the `model X {` regex matched almost nothing; the schema format has changed and this golden is blind",
  );

  // ── CASE A: every workspace-scoped model declares the relation ───────────
  const missing = scoped.filter((m) => !m.hasRelation);
  check(
    "CASE A — every model with a workspaceId declares a relation to Workspace",
    missing.length === 0,
    missing.length === 0
      ? ""
      : `${missing.length} model(s) carry a workspaceId that the database does not know is a foreign key, ` +
        "so deleting a workspace leaves their rows behind forever:\n       " +
        missing.map((m) => `${m.name} -> ${m.table}   (${m.workspaceIdLine})`).join("\n       "),
  );

  // ── CASE B: and the relation actually cascades ──────────────────────────
  // Split from CASE A on purpose: a relation with no `onDelete: Cascade`
  // RESTRICTS by default, which does not leak rows — it makes the workspace
  // delete fail outright. Different symptom, different fix, so it must not
  // hide inside the same assertion.
  const notCascading = scoped.filter((m) => m.hasRelation && !m.cascades);
  check(
    "CASE B — every workspace relation cascades on delete",
    notCascading.length === 0,
    notCascading.length === 0
      ? ""
      : `${notCascading.length} model(s) relate to Workspace without onDelete: Cascade. These do not leak ` +
        "rows — they make the workspace delete fail instead:\n       " +
        notCascading.map((m) => `${m.name} -> ${m.table}`).join("\n       "),
  );

  // ── Reporting, whatever the verdict ─────────────────────────────────────
  const nullableScoped = scoped.filter((m) => m.nullable);
  console.log("");
  console.log(`  workspace-scoped models: ${scoped.length}`);
  console.log(`    with cascading relation: ${scoped.filter((m) => m.cascades).length}`);
  console.log(`    nullable workspaceId (a row may legitimately have no tenant): ${nullableScoped.length}` +
    (nullableScoped.length ? ` — ${nullableScoped.map((m) => m.name).join(", ")}` : ""));

  console.log("");
  if (failed > 0) {
    console.log(`FAIL golden-workspace-cascade-completeness: ${passed} passed, ${failed} failed.`);
    process.exit(1);
  }
  console.log(
    `PASS golden-workspace-cascade-completeness: ${passed} passed, 0 failed — ` +
    `all ${scoped.length} workspace-scoped models cascade, so a deleted tenant cannot leave rows behind.`,
  );
}

main();
