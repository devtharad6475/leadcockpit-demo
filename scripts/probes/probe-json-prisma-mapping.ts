/**
 * probe-json-prisma-mapping.ts — N-DATA-2 scoping probe (2026-08-18).
 *
 * READ-ONLY. Opens no database connection and writes nothing anywhere. It reads
 * `.leadgen-data/app-data.json` and `prisma/schema.prisma` as text and answers
 * the one question N-DATA-2 has never had a number for:
 *
 *   "If we move the JSON dataset onto Postgres, how much of it can actually
 *    land, and where exactly does it not fit?"
 *
 * WHY THIS EXISTS. N-DATA-2 records two candidate fixes — enable the upsert
 * path in `import-json-to-postgres.ts`, or make `seed-demo-prisma.ts` consume
 * `buildDemoData()`. Both were written down before anyone had measured the
 * drift, so neither could be costed. `seed-demo-prisma.ts:43-47` documents
 * field drift for `Lead` alone; nobody had checked the other 47 collections.
 *
 * A note on the matching. Collection-to-model matching is name-based
 * (`leads` → `Lead`) and therefore a HEURISTIC, not a proof. It is good enough
 * to size the job and to find the collections that have no home at all, which
 * is what this probe is for. It deliberately reports "NO MODEL" loudly and
 * "matched" quietly, because a false "matched" costs a debugging session and a
 * false "NO MODEL" costs one grep.
 *
 * Run: npx tsx scripts/probes/probe-json-prisma-mapping.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

/** Prisma model names, plus the scalar fields declared inside each model. */
function readPrismaModels(): Map<string, Set<string>> {
  const schema = readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf8");
  const models = new Map<string, Set<string>>();
  // Model bodies are brace-delimited and never nested in Prisma's grammar, so a
  // non-greedy match to the first closing brace at column 0 is exact here.
  for (const match of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, name, body] = match;
    const fields = new Set<string>();
    for (const line of body.split("\n")) {
      const field = line.trim().match(/^(\w+)\s+\S/);
      // Skip block attributes (@@index, @@map) — they match the field shape.
      if (field && !line.trim().startsWith("@@")) fields.add(field[1]);
    }
    models.set(name, fields);
  }
  return models;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Collections whose Prisma model is a RENAME, not a plural. A name-based
 * matcher cannot find these and must be told. Kept tiny and explicit: every
 * entry here is a place where the two substrates disagree about what a thing
 * is called, which is worth seeing rather than hiding behind cleverer regex.
 */
const RENAMES: Record<string, string> = {
  doNotContactRegistry: "DoNotContactEntry",
  processedWebhookMessageIds: "ProcessedWebhookMessage",
};

/**
 * Candidate singular forms for a JSON collection name, best guess first.
 *
 * The `(ch|sh|ss|x|z|s)es$` rule is not decoration — without it
 * `knowledgeExtractionBatches` singularises to `...Batche`, which matches
 * nothing, and this probe reported a 75-row collection as having NO PRISMA
 * MODEL when `KnowledgeExtractionBatch` exists at `schema.prisma:1736`. That
 * was a false alarm in the first run of this file, and a false "no model"
 * points a build at work that does not need doing.
 */
function singulars(collection: string): string[] {
  return [
    collection.replace(/ies$/, "y"),
    collection.replace(/(ch|sh|ss|x|z)es$/, "$1"),
    collection.replace(/s$/, ""),
    collection,
  ];
}

function main() {
  const models = readPrismaModels();
  const byNorm = new Map([...models.keys()].map((m) => [norm(m), m]));

  const raw = readFileSync(path.join(ROOT, ".leadgen-data", "app-data.json"), "utf8");
  const data = JSON.parse(raw) as Record<string, unknown>;

  const collections = Object.entries(data)
    .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]) && entry[1].length > 0)
    .sort((a, b) => b[1].length - a[1].length);

  const importOrder = new Set(
    [...readFileSync(path.join(ROOT, "scripts", "import-json-to-postgres.ts"), "utf8")
      .matchAll(/^\s*"(\w+)",$/gm)].map((m) => m[1]),
  );

  const matched: Array<{ collection: string; rows: number; model: string; unknownFields: string[] }> = [];
  const unmapped: Array<{ collection: string; rows: number }> = [];

  for (const [collection, rows] of collections) {
    const renamed = RENAMES[collection] ? norm(RENAMES[collection]) : undefined;
    const hit = renamed && byNorm.has(renamed)
      ? renamed
      : singulars(collection).map(norm).find((candidate) => byNorm.has(candidate));
    if (!hit) {
      unmapped.push({ collection, rows: rows.length });
      continue;
    }
    const model = byNorm.get(hit)!;
    const modelFields = models.get(model)!;
    // Union of keys across every row: a field present on only some rows is
    // still a field the writer has to handle.
    const jsonFields = new Set<string>();
    for (const row of rows) {
      if (row && typeof row === "object") for (const key of Object.keys(row)) jsonFields.add(key);
    }
    const unknownFields = [...jsonFields].filter((f) => !modelFields.has(f)).sort();
    matched.push({ collection, rows: rows.length, model, unknownFields });
  }

  const totalRows = collections.reduce((sum, [, rows]) => sum + rows.length, 0);
  const cleanCount = matched.filter((m) => m.unknownFields.length === 0).length;
  const driftedRows = matched.filter((m) => m.unknownFields.length > 0).reduce((s, m) => s + m.rows, 0);
  const unmappedRows = unmapped.reduce((s, u) => s + u.rows, 0);

  console.log("=== JSON → PRISMA MAPPING (read-only, no DB connection) ===\n");
  console.log(`prisma models declared:            ${models.size}`);
  console.log(`JSON collections holding rows:     ${collections.length}`);
  console.log(`total rows in the JSON store:      ${totalRows}\n`);

  console.log("--- collections with NO matching Prisma model (cannot land at all) ---");
  if (!unmapped.length) console.log("  (none)");
  for (const { collection, rows } of unmapped) {
    console.log(`  NO MODEL  ${collection.padEnd(34)}${String(rows).padStart(4)} row(s)`);
  }

  console.log("\n--- matched, but carrying fields the Prisma model does not declare ---");
  const drifted = matched.filter((m) => m.unknownFields.length > 0);
  if (!drifted.length) console.log("  (none)");
  for (const { collection, rows, model, unknownFields } of drifted) {
    console.log(`  DRIFT     ${collection.padEnd(34)}${String(rows).padStart(4)} row(s) → ${model}`);
    console.log(`            unknown to Prisma: ${unknownFields.join(", ")}`);
  }

  console.log("\n--- collections the existing importer does not even list ---");
  const notListed = collections.map(([c]) => c).filter((c) => !importOrder.has(c));
  console.log(notListed.length ? `  ${notListed.join(", ")}` : "  (none)");

  // --- The dimension that actually decides how N-DATA-2 gets built. ---
  //
  // Raw-schema drift (above) is an argument AGAINST hand-writing a JSON→Prisma
  // field mapping: 26 collections carry fields the schema does not declare, and
  // they are not really missing — the repository layer already translates them
  // (`orders.lineItems` → `lineItemsJson` at prisma/index.ts:3760 is the clearest
  // case). So the drift is against the RAW SCHEMA, not against the repositories.
  //
  // That makes the interesting question a different one: how much of the dataset
  // can be moved by the write path that ALREADY exists and is already proven?
  // `persistSnapshot` (prisma/index.ts:3438) batch-upserts a fixed set of
  // collections inside one transaction, chunked so it survives Neon's timeout.
  // Anything it covers is a solved problem. Anything it does not must go through
  // that collection's own repository — the in-code comment at :3162 warns that a
  // mutateAll write to an uncovered collection "will silently vanish".
  const PERSIST_SNAPSHOT_COVERS = new Set([
    "knowledgeQuestionAnswers", "auditLogs", "eventLogs", "unknownQuestions",
    "knowledgeEntries", "humanFallbackTasks", "processedWebhookMessageIds",
    "knowledgeExtractionRuns", "knowledgeExtractionBatches",
    "knowledgeExtractionSourceBundles", "knowledgeExtractionSources",
    "knowledgeBaseDocuments", "knowledgeBaseChunks", "users", "workspaceMembers",
  ]);

  const covered = collections.filter(([c]) => PERSIST_SNAPSHOT_COVERS.has(c));
  const uncovered = collections.filter(([c]) => !PERSIST_SNAPSHOT_COVERS.has(c));
  const coveredRows = covered.reduce((s, [, r]) => s + r.length, 0);
  const uncoveredRows = uncovered.reduce((s, [, r]) => s + r.length, 0);

  console.log("\n--- rows the EXISTING mutateAll/persistSnapshot path already writes ---");
  for (const [collection, rows] of covered) {
    console.log(`  COVERED   ${collection.padEnd(34)}${String(rows.length).padStart(4)} row(s)`);
  }
  console.log("\n--- rows needing that collection's own repository (mutateAll would vanish) ---");
  for (const [collection, rows] of uncovered) {
    console.log(`  NEEDS REPO ${collection.padEnd(33)}${String(rows.length).padStart(4)} row(s)`);
  }

  console.log("\n=== SUMMARY ===");
  const pct = (n: number) => `${((n / totalRows) * 100).toFixed(1)}%`;
  console.log(`already covered by persistSnapshot:       ${covered.length} collection(s), ${coveredRows} row(s) — ${pct(coveredRows)} of the dataset`);
  console.log(`needs per-collection repository writes:   ${uncovered.length} collection(s), ${uncoveredRows} row(s) — ${pct(uncoveredRows)} of the dataset`);
  console.log(`clean (model exists, every field known):  ${cleanCount} collection(s)`);
  console.log(`drifted (model exists, extra fields):     ${drifted.length} collection(s), ${driftedRows} row(s)`);
  console.log(`no model at all:                          ${unmapped.length} collection(s), ${unmappedRows} row(s)`);
  console.log(`importer omits from its ordered list:     ${notListed.length} collection(s)`);
}

main();
