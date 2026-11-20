/**
 * probe-migration-rules-coverage.ts — offline completeness check for the
 * migration RULES registry.
 *
 * WHY. `buildMigrationPlan` BLOCKS the whole migration if any JSON collection
 * has no declared rule. That is the correct behaviour, but it means the real
 * dry run cannot even report its row counts until the registry is complete —
 * and the real dry run needs Postgres to be up. This probe answers the one
 * question that does NOT need a database: does the registry in
 * scripts/migrate-json-to-postgres.ts cover every collection that actually
 * holds rows in the JSON store?
 *
 * It compares against an EMPTY Postgres side on purpose. Every row then reads
 * as `create`, which is meaningless as a migration plan and is not printed as
 * one — the only outputs are the undeclared list, the rules that match nothing,
 * and the row totals per collection. Read-only: opens no database connection.
 */
import io from "node:fs";
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { readData } from "@/lib/db";
import { buildMigrationPlan, type CollectionRule } from "@/migration/json-to-postgres-plan";

/**
 * The registry is parsed out of the executor rather than imported, because the
 * executor connects to Postgres at module scope-adjacent code paths and this
 * probe must stay offline. Parsing means the two can drift; the drift is
 * exactly what the "declared but not in JSON" list below would show.
 */
function loadRules(): Record<string, CollectionRule> {
  const src = io.readFileSync("scripts/migrate-json-to-postgres.ts", "utf8");
  const body = src.slice(src.indexOf("const RULES"), src.indexOf("\nasync function main"));
  const rules: Record<string, CollectionRule> = {};
  for (const m of body.matchAll(/^\s{2}(\w+):\s*\{([^}]*)\}/gm)) {
    const [, name, inner] = m;
    const policy = /policy:\s*"(\w+)"/.exec(inner)?.[1] as CollectionRule["policy"];
    if (!policy) continue;
    rules[name] = { policy, allowOverwrite: /allowOverwrite:\s*true/.test(inner) };
  }
  return rules;
}

async function main() {
  const rules = loadRules();
  const json = (await readData()) as unknown as Record<string, unknown>;

  const jsonCollections = Object.keys(json)
    .filter((k) => Array.isArray(json[k]) && (json[k] as unknown[]).length > 0)
    .sort();

  const plan = buildMigrationPlan(json, {}, rules);

  console.log("=== MIGRATION RULES COVERAGE (offline, no database) ===\n");
  console.log(`rules declared      : ${Object.keys(rules).length}`);
  console.log(`JSON collections    : ${jsonCollections.length} (non-empty)`);
  console.log(`rows in JSON store  : ${jsonCollections.reduce((n, c) => n + (json[c] as unknown[]).length, 0)}`);
  console.log("");

  if (plan.undeclared.length) {
    console.log(`UNDECLARED — these would BLOCK the migration (${plan.undeclared.length}):`);
    for (const c of plan.undeclared) {
      console.log(`  - ${c}  (${(json[c] as unknown[]).length} rows)`);
    }
  } else {
    console.log("UNDECLARED: none. Every non-empty JSON collection has a declared rule. ✅");
  }
  console.log("");

  const unusedRules = Object.keys(rules).filter((r) => !jsonCollections.includes(r)).sort();
  console.log(`Declared but empty/absent in JSON (harmless, listed for drift) : ${unusedRules.length}`);
  if (unusedRules.length) console.log(`  ${unusedRules.join(", ")}`);
  console.log("");

  const byPolicy = { snapshot: 0, repository: 0, skip: 0 } as Record<string, number>;
  for (const c of plan.collections) byPolicy[c.policy] += c.rows.length;
  console.log(`rows by route  snapshot=${byPolicy.snapshot}  repository=${byPolicy.repository}  skip=${byPolicy.skip}`);
  console.log(`plan blocked   : ${plan.blocked}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
