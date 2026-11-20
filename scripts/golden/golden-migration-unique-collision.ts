/**
 * golden-migration-unique-collision.ts — N-DATA-2 pin (2026-08-18, CEO-loop session 7).
 *
 * THE RISK THIS PINS
 * ------------------
 * The migration plan decides create/overwrite/identical by ID. That is the only
 * question it used to ask, and it is not enough: a row can be a legitimate
 * CREATE by id and still be impossible to write, because a DIFFERENT row already
 * holds one of its non-id unique tuples. Postgres then rejects the insert at
 * write time, mid-transaction, after the plan has already been reviewed and
 * approved by a human.
 *
 * That is not hypothetical. A real --write run against the ship database died
 * with:
 *
 *     Unique constraint failed on the fields: (`workspace_id`,`order_number`)
 *
 * because `scripts/seed-demo-prisma.ts` had left `seed_order_1` holding order
 * number 1 in the same workspace that the JSON source wanted `order_demo_1` to
 * occupy. Three rows collided that way (two orders, one quote). The plan had
 * called all three plain creates.
 *
 * `findUniqueCollisions` moves that failure from write time to plan time. This
 * golden pins the thing that check DEPENDS ON and cannot verify itself: that
 * `UNIQUE_KEYS` is a faithful transcription of the constraints Postgres will
 * actually enforce. A constraint present in the schema and missing from
 * `UNIQUE_KEYS` is invisible to the checker, and the checker returning `[]`
 * looks exactly like "no collisions" — the vacuous pass is the whole danger.
 *
 * WHY IT RUNS OFFLINE. It reads prisma/schema.prisma from disk and compares it
 * to the exported constants. No database, no clock. The schema file IS the
 * source of truth for what Postgres enforces (Prisma generates the migrations
 * from it), so comparing against it is comparing against the real constraints.
 *
 * HAND-COMPUTED CONTRACT:
 *
 *   CASE A — every collection in MIGRATION_RULES names a model in
 *            COLLECTION_MODELS, and that model exists in the schema. A
 *            collection the checker cannot resolve to a model gets no unique
 *            check at all, silently.
 *   CASE B — UNIQUE_KEYS matches the schema EXACTLY, in both directions. A
 *            missing entry means an unchecked constraint (write-time crash); an
 *            invented entry means a collision reported that Postgres would have
 *            allowed (a plan blocked for no reason). Both are failures.
 *   CASE C — the schema parse found a plausible number of models and resolved
 *            every declared one. Without this floor, a parser that silently
 *            matched nothing would make CASE A and CASE B pass vacuously.
 *   CASE D — a synthetic colliding pair IS detected, and names both ids.
 *   CASE E — the same tuple held by the SAME id is NOT a collision. A row
 *            planned as an overwrite shares its id with the Postgres row, so it
 *            is the same row and cannot collide with itself; without this, every
 *            settings singleton in the dataset would be reported as blocked.
 *   CASE F — a null component makes the tuple non-comparable and is skipped,
 *            because SQL unique constraints do not treat NULLs as equal.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { MIGRATION_RULES } from "@/migration/migration-rules";
import { COLLECTION_MODELS, UNIQUE_KEYS, findUniqueCollisions } from "@/migration/unique-keys";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message.split("\n").join("\n        ")}`);
  }
}

/**
 * Unique constraints per model, read straight out of prisma/schema.prisma.
 *
 * Two forms count: a `@@unique([a, b])` block attribute, and a field-level
 * `@unique` on a single column. `id` is excluded — it is the primary key, and
 * the plan already compares by id, so re-reporting it would turn every ordinary
 * overwrite into a collision.
 */
function uniqueKeysFromSchema(): Record<string, string[][]> {
  const src = readFileSync("prisma/schema.prisma", "utf8").replace(/\r\n/g, "\n");
  const models: Record<string, string[][]> = {};
  const modelBlock = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = modelBlock.exec(src)) !== null) {
    const keys: string[][] = [];
    for (const raw of m[2].split("\n")) {
      const line = raw.trim();
      if (line.startsWith("@@unique")) {
        const arr = line.slice(line.indexOf("(")).match(/\[([^\]]*)\]/);
        if (arr) keys.push(arr[1].split(",").map((s) => s.trim()).filter(Boolean));
      } else if (/^\w+\s+\S/.test(line) && /\s@unique\b/.test(line)) {
        const field = line.split(/\s+/)[0];
        if (field !== "id") keys.push([field]);
      }
    }
    models[m[1]] = keys;
  }
  return models;
}

/** Order-insensitive rendering, so `[["a","b"]]` compares equal however it was written. */
function normalise(keys: string[][]): string {
  return keys.map((k) => k.join("+")).sort().join(" | ") || "(none)";
}

function main() {
  console.log("");
  console.log("=== GOLDEN migration-unique-collision (N-DATA-2) ===");
  console.log("");

  const schema = uniqueKeysFromSchema();

  check("CASE C — the schema parse is not vacuous", () => {
    // 86 models at the time of writing. The floor is deliberately well below
    // that: this guards a BROKEN parse (0, or a handful), not schema growth.
    assert.ok(
      Object.keys(schema).length >= 60,
      `parsed only ${Object.keys(schema).length} models out of prisma/schema.prisma — the parser is broken, and every other case here would pass vacuously`,
    );
    // At least one real multi-column constraint must have come through, or the
    // parser could be matching model names and nothing inside them.
    assert.deepStrictEqual(
      schema.Order,
      [["workspaceId", "orderNumber"]],
      "the constraint that actually crashed the first --write run must be visible to the parser",
    );
  });

  check("CASE A — every migrated collection resolves to a real schema model", () => {
    for (const [collection, rule] of Object.entries(MIGRATION_RULES)) {
      if (rule.policy === "skip") continue;
      const model = COLLECTION_MODELS[collection];
      assert.ok(
        model,
        `collection "${collection}" has policy "${rule.policy}" but no entry in COLLECTION_MODELS — findUniqueCollisions cannot check it and would return [] silently`,
      );
      assert.ok(
        model in schema,
        `collection "${collection}" names model "${model}", which does not exist in prisma/schema.prisma`,
      );
    }
  });

  check("CASE B — UNIQUE_KEYS matches the schema exactly", () => {
    for (const [collection, model] of Object.entries(COLLECTION_MODELS)) {
      const fromSchema = normalise(schema[model] ?? []);
      const declared = normalise(UNIQUE_KEYS[collection] ?? []);
      assert.strictEqual(
        declared,
        fromSchema,
        `"${collection}" (model ${model}): UNIQUE_KEYS says ${declared}, the schema says ${fromSchema}. ` +
          `A constraint in the schema and not here is one the plan cannot see, and the write will fail instead; ` +
          `a constraint here and not in the schema blocks a plan Postgres would have accepted.`,
      );
    }
    // And nothing may be declared for a collection that is not mapped at all.
    for (const collection of Object.keys(UNIQUE_KEYS)) {
      assert.ok(
        collection in COLLECTION_MODELS,
        `UNIQUE_KEYS declares "${collection}", which has no model — it can never be checked against anything`,
      );
    }
  });

  check("CASE D — a genuine collision is detected and names both ids", () => {
    // The real one, reduced to its bones: JSON wants to create order_demo_1,
    // and seed_order_1 already holds order number 1 in the same workspace.
    const collisions = findUniqueCollisions(
      "orders",
      new Set(["order_demo_1"]),
      [{ id: "order_demo_1", workspaceId: "workspace_demo", orderNumber: 1 }],
      [{ id: "seed_order_1", workspaceId: "workspace_demo", orderNumber: 1 }],
    );
    assert.strictEqual(collisions.length, 1, "the collision that crashed the real run must be found");
    assert.strictEqual(collisions[0].jsonId, "order_demo_1");
    assert.strictEqual(collisions[0].postgresId, "seed_order_1",
      "the report has to name the row already holding the tuple, or nobody can act on it");
    assert.deepStrictEqual(collisions[0].key, ["workspaceId", "orderNumber"]);
  });

  check("CASE E — the same tuple under the SAME id is not a collision", () => {
    const collisions = findUniqueCollisions(
      "ticketSlaSettings",
      new Set(["tss_demo"]),
      [{ id: "tss_demo", workspaceId: "workspace_demo" }],
      [{ id: "tss_demo", workspaceId: "workspace_demo" }],
    );
    assert.deepStrictEqual(collisions, [],
      "a row cannot collide with itself; treating this as a collision would block every workspace singleton");
  });

  check("CASE F — a null component is skipped, matching SQL NULL semantics", () => {
    const collisions = findUniqueCollisions(
      "orders",
      new Set(["order_a"]),
      [{ id: "order_a", workspaceId: "workspace_demo", orderNumber: null }],
      [{ id: "order_b", workspaceId: "workspace_demo", orderNumber: null }],
    );
    assert.deepStrictEqual(collisions, [],
      "Postgres does not consider two NULLs equal, so reporting this would be a collision that cannot happen");
  });

  console.log("");
  console.log(`=== GOLDEN migration-unique-collision: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
