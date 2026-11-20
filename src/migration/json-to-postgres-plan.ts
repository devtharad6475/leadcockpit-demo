/**
 * json-to-postgres-plan.ts — N-DATA-2, the planning half of the JSON → Postgres move.
 *
 * PURE. No database, no file system, no repositories, no clock. It takes two
 * snapshots — what is in the JSON store, and what is in Postgres — and returns
 * a description of what a migration WOULD do. Nothing here writes anything.
 *
 * WHY THIS IS SPLIT OUT AT ALL. The dangerous part of this migration is not the
 * writing, it is the deciding: both substrates use the same workspace id
 * (`workspace_demo`, src/lib/db.ts:38) and therefore the same row ids, so a
 * replay is an UPSERT ONTO LIVE ROWS, not an import into empty space. An
 * upsert that silently replaces a Postgres row with a JSON row of the same id
 * is indistinguishable from a successful migration right up until someone looks
 * for the row that used to be there. Making the decision a pure function means
 * it can be pinned by a golden with fixtures, offline, before a single byte is
 * written to the ship database.
 *
 * The four outcomes a row can have, and why each exists:
 *
 *   CREATE     — id exists in JSON, not in Postgres. Safe. This is the bulk of
 *                the move (the 523 knowledge answers are all of this kind).
 *   IDENTICAL  — id exists in both and the content matches. A no-op, counted
 *                separately so a re-run reads as "nothing to do" rather than
 *                "1268 rows written again".
 *   OVERWRITE  — id exists in both with DIFFERENT content. This is the one that
 *                needs a human decision. It is never silently applied: the
 *                planner records the differing field names so the report can
 *                say what would change, and the executor refuses unless the
 *                collection's policy explicitly allows it.
 *   POSTGRES_ONLY — id exists only in Postgres. NEVER touched. A migration that
 *                deletes rows it did not bring is a destructive operation
 *                wearing an import's clothes.
 *
 * A row's id is not the only thing that has to be free. Thirty models carry a
 * second unique constraint, so a CREATE can be perfectly valid by id and still
 * be rejected by the database — see src/migration/unique-keys.ts, which is what
 * makes those collisions part of the PLAN rather than a write-time surprise.
 *
 * Note on IDENTICAL: comparison is by JSON serialisation of the shared fields,
 * which is order-sensitive for arrays and therefore conservative — it can call
 * two equivalent rows OVERWRITE, but it cannot call two different rows
 * IDENTICAL. Erring toward "ask a human" is the correct direction for a
 * function whose job is to decide what may be replaced.
 */

import { findUniqueCollisions, type UniqueCollision } from "./unique-keys";

/** How a collection is allowed to move. Declared per collection, never inferred. */
export type MovePolicy =
  /** Rows go through repos.mutateAll → persistSnapshot, one transaction. */
  | "snapshot"
  /** Rows go through that collection's own repository. */
  | "repository"
  /** Deliberately not moved. `reason` is required and is printed in the report. */
  | "skip";

export interface CollectionRule {
  policy: MovePolicy;
  /** Required for `skip`, and for any collection allowed to overwrite. */
  reason?: string;
  /**
   * Whether an OVERWRITE may be applied. Defaults to false everywhere: a
   * collection has to opt in, in writing, to having its Postgres rows replaced.
   */
  allowOverwrite?: boolean;
}

export type RowOutcome = "create" | "identical" | "overwrite" | "postgres_only";

export interface RowPlan {
  id: string;
  outcome: RowOutcome;
  /** Field names that differ AND that the migration can actually write. Only populated for `overwrite`. */
  changedFields?: string[];
  /**
   * Field names Postgres has and the JSON row does not. Reported for visibility,
   * never blocking — see `unmigratableFields`. A row whose ONLY differences are
   * these is counted IDENTICAL, because as far as the migration is concerned it
   * is finished: re-running it would produce byte-for-byte the same row.
   */
  unmigratableFields?: string[];
}

export interface CollectionPlan {
  collection: string;
  policy: MovePolicy;
  reason?: string;
  allowOverwrite: boolean;
  rows: RowPlan[];
  counts: Record<RowOutcome, number>;
  /**
   * Rows planned as CREATE whose non-id unique tuple is already held by a
   * different Postgres row. Always blocking — there is no policy that makes
   * writing them possible, the constraint would simply reject them.
   */
  collisions: UniqueCollision[];
  /** True when this collection would overwrite rows it is not allowed to, or has a collision. */
  blocked: boolean;
}

export interface MigrationPlan {
  collections: CollectionPlan[];
  totals: Record<RowOutcome, number>;
  /** Collections present in the JSON snapshot with no rule declared. */
  undeclared: string[];
  /** True when any collection is blocked. The executor must refuse to run. */
  blocked: boolean;
}

type Row = Record<string, unknown>;
type Snapshot = Record<string, unknown>;

const EMPTY_COUNTS = (): Record<RowOutcome, number> => ({
  create: 0, identical: 0, overwrite: 0, postgres_only: 0,
});

/**
 * Fields that differ between two rows for the same id.
 *
 * Compares the UNION of both rows' keys, not just the JSON row's: a field that
 * Postgres has and JSON does not is still a difference, and it is the direction
 * that loses data, so it must not be invisible. `updatedAt` is excluded because
 * every write moves it and including it would mark every row as changed,
 * drowning the real differences — the exact failure that makes a diff tool
 * stop being read.
 *
 * Values are compared CANONICALLY (see `canonical` below), not by raw
 * JSON.stringify: object key order is not data on a JSONB column, and treating
 * it as data marked every JSON-bearing row as changed.
 */
export function changedFields(jsonRow: Row, postgresRow: Row): string[] {
  return compareRows(jsonRow, postgresRow).changed;
}

/**
 * Fields that differ but which THIS MIGRATION CANNOT AFFECT: the JSON row has
 * no such field at all, and Postgres has a value.
 *
 * WHY THEY ARE SPLIT OUT (N-DATA-2, 2026-08-18). They used to count as ordinary
 * differences, on the stated grounds that Postgres-has / JSON-lacks is the
 * direction that loses data and "must not be invisible". That reasoning is
 * right and is preserved — these fields are still computed, still reported, and
 * still printed. What changed is that they no longer BLOCK.
 *
 * They cannot block, because they cannot be resolved. The migration writes the
 * JSON row through the repositories, and a field the JSON row does not have is
 * simply not in the write — so Postgres keeps its value and the next re-plan
 * reports exactly the same difference. Counting them as overwrites gave the
 * verifier a success condition it could never reach: a real run finished with 0
 * write errors and 844 rows correct, and still reported 414 rows "not migrated"
 * — every one of them a Postgres column default (false, {}) that JSON never had
 * an opinion about. A verifier that can only ever say FAILED is one nobody
 * reads, which is the same failure mode updatedAt was excluded to avoid.
 *
 * The reverse direction — JSON has a field Postgres lacks — is NOT here. That
 * one the migration can fix, and if it did not, that is a genuine failure.
 */
export function unmigratableFields(jsonRow: Row, postgresRow: Row): string[] {
  return compareRows(jsonRow, postgresRow).unmigratable;
}

function compareRows(jsonRow: Row, postgresRow: Row): { changed: string[]; unmigratable: string[] } {
  const keys = new Set([...Object.keys(jsonRow), ...Object.keys(postgresRow)]);
  keys.delete("updatedAt");
  const changed: string[] = [];
  const unmigratable: string[] = [];
  for (const key of keys) {
    if (canonical(jsonRow[key]) === canonical(postgresRow[key])) continue;
    // Absent on the JSON side. Not "null on the JSON side" — an explicit null is
    // an opinion the migration can and does write, so it stays a difference.
    if (!(key in jsonRow) || jsonRow[key] === undefined) unmigratable.push(key);
    else changed.push(key);
  }
  return { changed: changed.sort(), unmigratable: unmigratable.sort() };
}

/**
 * A comparable string for one field value.
 *
 * Sorts object keys before serialising, because Postgres JSONB does not
 * preserve the key order it was written with — it stores keys sorted by length
 * then bytes and hands them back that way. A value written as
 * `{"confidenceScore":0.2,"chunks":[]}` reads back as
 * `{"chunks":[],"confidenceScore":0.2}`: identical data, different JSON.stringify
 * output. Comparing the raw serialisation marked every row with a non-trivial
 * JSONB column as changed, which is a verifier that cannot be read.
 *
 * Array order is NOT sorted — in an array, order is data.
 *
 * `undefined` and `null` both collapse to null: "the field is absent" and "the
 * field is explicitly empty" are the same fact here, and Postgres has no way to
 * express the first.
 */
function canonical(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function rowsOf(snapshot: Snapshot, collection: string): Row[] {
  const value = snapshot[collection];
  return Array.isArray(value) ? (value.filter((r) => r && typeof r === "object") as Row[]) : [];
}

/**
 * Build the plan. `rules` declares how each collection may move; any collection
 * holding rows in the JSON snapshot without a rule is reported as `undeclared`
 * rather than being given a default, because a default here is exactly how a
 * collection gets migrated by accident.
 */
export function buildMigrationPlan(
  json: Snapshot,
  postgres: Snapshot,
  rules: Record<string, CollectionRule>,
): MigrationPlan {
  const collections: CollectionPlan[] = [];
  const totals = EMPTY_COUNTS();
  const undeclared: string[] = [];

  const jsonCollections = Object.keys(json)
    .filter((key) => Array.isArray(json[key]) && rowsOf(json, key).length > 0)
    .sort();

  for (const collection of jsonCollections) {
    const rule = rules[collection];
    if (!rule) {
      undeclared.push(collection);
      continue;
    }
    if (rule.policy === "skip") {
      collections.push({
        collection, policy: "skip", reason: rule.reason,
        allowOverwrite: false, rows: [], counts: EMPTY_COUNTS(), collisions: [], blocked: false,
      });
      continue;
    }

    const allowOverwrite = rule.allowOverwrite === true;
    const postgresRows = new Map(rowsOf(postgres, collection).map((r) => [String(r.id), r]));
    const counts = EMPTY_COUNTS();
    const rows: RowPlan[] = [];

    for (const jsonRow of rowsOf(json, collection)) {
      const id = String(jsonRow.id);
      const existing = postgresRows.get(id);
      if (!existing) {
        rows.push({ id, outcome: "create" });
        counts.create++;
        continue;
      }
      postgresRows.delete(id);
      const { changed, unmigratable } = compareRows(jsonRow, existing);
      const extra = unmigratable.length ? { unmigratableFields: unmigratable } : {};
      if (changed.length === 0) {
        rows.push({ id, outcome: "identical", ...extra });
        counts.identical++;
      } else {
        rows.push({ id, outcome: "overwrite", changedFields: changed, ...extra });
        counts.overwrite++;
      }
    }

    // Whatever is left in the map exists only in Postgres. Recorded so the
    // report can show it, never acted on.
    for (const id of postgresRows.keys()) {
      rows.push({ id, outcome: "postgres_only" });
      counts.postgres_only++;
    }

    // A row planned as CREATE claims nothing like it exists. Until now that
    // claim was checked against `id` alone, so a row could be planned as a
    // clean create and still be rejected by a unique constraint on some other
    // column — which is what happened on the first real run (see unique-keys.ts).
    const collisions = findUniqueCollisions(
      collection,
      new Set(rows.filter((r) => r.outcome === "create").map((r) => r.id)),
      rowsOf(json, collection),
      rowsOf(postgres, collection),
    );

    for (const outcome of Object.keys(counts) as RowOutcome[]) totals[outcome] += counts[outcome];
    collections.push({
      collection, policy: rule.policy, reason: rule.reason,
      allowOverwrite, rows, counts, collisions,
      blocked: (counts.overwrite > 0 && !allowOverwrite) || collisions.length > 0,
    });
  }

  return {
    collections,
    totals,
    undeclared,
    blocked: collections.some((c) => c.blocked) || undeclared.length > 0,
  };
}

/** Human-readable report. Kept here so the script and the golden print the same thing. */
export function formatMigrationPlan(plan: MigrationPlan): string {
  const lines: string[] = [];
  for (const c of plan.collections) {
    if (c.policy === "skip") {
      lines.push(`  SKIP       ${c.collection.padEnd(34)} ${c.reason ?? "(no reason given)"}`);
      continue;
    }
    const flag = c.blocked ? "BLOCKED" : c.policy === "snapshot" ? "snapshot" : "repo";
    lines.push(
      `  ${flag.padEnd(10)} ${c.collection.padEnd(34)}` +
      ` create=${c.counts.create} identical=${c.counts.identical}` +
      ` overwrite=${c.counts.overwrite} pgOnly=${c.counts.postgres_only}`,
    );
    if (c.counts.overwrite > 0) {
      for (const row of c.rows.filter((r) => r.outcome === "overwrite")) {
        lines.push(`               ↳ ${row.id}: ${(row.changedFields ?? []).join(", ")}`);
      }
    }
    // Non-blocking, but printed: the fields Postgres holds and the JSON source
    // has no opinion on. Summarised by field name rather than per row — it is
    // the same handful of columns across hundreds of rows, and one line each
    // would bury the differences that DO block.
    const unmigratable = new Map<string, number>();
    for (const row of c.rows) {
      for (const f of row.unmigratableFields ?? []) unmigratable.set(f, (unmigratable.get(f) ?? 0) + 1);
    }
    for (const [field, n] of [...unmigratable].sort()) {
      lines.push(`               · ${field}: Postgres has a value on ${n} row(s), JSON has no such field (not migratable)`);
    }
    for (const x of c.collisions) {
      lines.push(
        `               ✗ ${x.jsonId} cannot be created: (${x.key.join(", ")}) = ` +
        `(${x.values.join(", ")}) is already held by ${x.postgresId}`,
      );
    }
  }
  if (plan.undeclared.length) {
    lines.push("", `  UNDECLARED collections (no rule — refusing to guess): ${plan.undeclared.join(", ")}`);
  }
  lines.push("");
  lines.push(
    `  TOTALS  create=${plan.totals.create} identical=${plan.totals.identical}` +
    ` overwrite=${plan.totals.overwrite} postgresOnly=${plan.totals.postgres_only}`,
  );
  return lines.join("\n");
}
