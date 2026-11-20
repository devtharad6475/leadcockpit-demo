/**
 * Golden test — SCHEMA WIRING (2026-08-05, audit finding F-7).
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * `src/validation/schemas.ts` had 9 schemas that were fully written, correct,
 * and reviewed — and never imported anywhere. `businessProfileUpdateSchema`
 * is the clearest case: it validates `websiteUrl`/`contactEmail` format, and
 * the DEMO WORKSPACE'S OWN DATA has `websiteUrl: "not-a-url"` and
 * `contactEmail: "bad-email"` right now — live proof the dead schema would
 * have caught exactly this.
 *
 * A schema with no import is not validation. It's a comment that happens to
 * be syntactically valid TypeScript. This test makes that class of drift
 * impossible to reintroduce silently: every export from schemas.ts must be
 * referenced somewhere in the route handler, or this test fails and names
 * the orphan.
 *
 * ─── WHAT THIS DOES NOT CHECK ──────────────────────────────────────────────
 *
 * It does not verify a schema is called CORRECTLY (right body shape, right
 * error path) — that's what golden:rbac-map and the feature-specific goldens
 * are for. This test only proves the schema is REACHABLE from the route file,
 * closing the specific "written but orphaned" failure mode.
 *
 * Both the static top-level import and a dynamic `await import(...)` count as
 * wiring (several routes intentionally lazy-load their schema alongside their
 * service — see the orders/quotes POST handlers).
 *
 * Run: npm run golden:schema-wiring
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { readFileSync } from "node:fs";
import path from "node:path";

const schemasPath = path.resolve(process.cwd(), "src/validation/schemas.ts");
const routePath = path.resolve(process.cwd(), "src/app/api/[[...path]]/route.ts");

const schemasSrc = readFileSync(schemasPath, "utf8");
const routeSrc = readFileSync(routePath, "utf8");

// Every top-level `export const xSchema = ...` or `export const xSchema:` in
// schemas.ts. Deliberately excludes helper exports like `sanitizeStrictShape`
// (not a schema) by requiring the "Schema" suffix, matching this file's own
// naming convention.
const exportPattern = /export const (\w*Schema)\b/g;
const allSchemas: string[] = [];
let match: RegExpExecArray | null;
while ((match = exportPattern.exec(schemasSrc)) !== null) {
  allSchemas.push(match[1]);
}

if (allSchemas.length === 0) {
  console.error("GOLDEN CRASHED: found zero schema exports — the regex or the file path is wrong.");
  process.exit(1);
}

// Each schema's OWN source block: from its `export const` to the next one
// (or EOF). Used to check composition without false-matching a later,
// unrelated schema that happens to share a substring.
const exportStarts = allSchemas.map((name) => ({ name, at: schemasSrc.indexOf(`export const ${name}`) })).sort((a, b) => a.at - b.at);
function ownBlock(name: string): string {
  const idx = exportStarts.findIndex((e) => e.name === name);
  const start = exportStarts[idx].at;
  const end = idx + 1 < exportStarts.length ? exportStarts[idx + 1].at : schemasSrc.length;
  return schemasSrc.slice(start, end);
}

function isWiredInRoute(name: string): boolean {
  return (routeSrc.match(new RegExp(`\\b${name}\\b`, "g")) || []).length > 0;
}

/**
 * Schemas that are deliberately unwired, each with a real reason recorded at
 * its definition in schemas.ts (grep the name there before trusting this
 * list — it must never grow without that paper trail). Currently one entry:
 * `adminImpersonateSchema` belongs to a documented 503 stub (F-P1-4) with no
 * live route to validate yet.
 */
const KNOWN_UNWIRED = new Set<string>(["adminImpersonateSchema"]);

const orphaned = allSchemas.filter((name) => {
  if (KNOWN_UNWIRED.has(name)) return false;
  if (isWiredInRoute(name)) return false;
  // COMPOSED into another schema within schemas.ts (e.g.
  // orderLineItemInputSchema is used inside orderCreateSchema's OWN block via
  // `z.array(orderLineItemInputSchema)` — it has no route to import it
  // directly because it's a sub-shape, not a top-level body schema). Reachable
  // iff that parent is itself wired in route.ts (one level of composition,
  // the only pattern this file actually uses).
  const composedInto = allSchemas.filter((other) => other !== name && new RegExp(`\\b${name}\\b`).test(ownBlock(other)));
  return !composedInto.some((parent) => isWiredInRoute(parent));
});

console.log("GOLDEN: schema wiring (audit F-7)");
console.log("");
console.log(`  ${allSchemas.length} schemas exported from validation/schemas.ts`);

if (orphaned.length === 0) {
  console.log("");
  console.log(`=== SCHEMA WIRING: all ${allSchemas.length} schemas are referenced by route.ts ✅ ===`);
  process.exit(0);
}

console.log("");
console.log(`=== SCHEMA WIRING: ${orphaned.length} orphaned schema(s) ❌ ===`);
console.log("");
for (const name of orphaned) {
  console.log(`  ✗ ${name} — exported, never imported, validates nothing`);
}
console.log("");
console.log("  Either wire the schema into the route that accepts this body shape,");
console.log("  or delete it if the endpoint no longer exists. A schema nobody calls");
console.log("  is dead code that LOOKS like a safety control — worse than none,");
console.log("  because a reviewer sees it and assumes the input is checked.");
process.exit(1);
