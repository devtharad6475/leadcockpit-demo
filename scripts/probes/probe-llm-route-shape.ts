/**
 * N-TEST-10 receipt — does `golden-prisma-parity`'s RULE A route fixture
 * describe a row Postgres will accept?
 *
 * The golden is named for Prisma, its header claims "the same fixture runs
 * against either provider", and the A-7 census records it as `substrate: json`
 * with evidence `data-dir`. It has never opened a Postgres transaction, so the
 * shape of its route rows has never been checked against the real column set.
 *
 * This probe runs the OLD shape and the NEW shape through the real Prisma
 * repository against a throwaway clone of leadgen_golden_template, and drops
 * the clone afterwards. It creates and drops only its own database.
 *
 * SAFETY. DATABASE_URL is read out of `.env` as text and never printed; only
 * host:port and the scratch database name appear in the output.
 *
 * Run: npx tsx scripts/probes/probe-llm-route-shape.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

const TEMPLATE_DB = "leadgen_golden_template";
const SCRATCH = `pp_route_shape_${Date.now()}`;

function databaseUrl(): string {
  const raw = readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
  const line = raw.split(/\r?\n/).find((l) => /^\s*DATABASE_URL\s*=/.test(l));
  if (!line) throw new Error("DATABASE_URL is not set in .env");
  return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
}

function urlForDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

async function adminQuery(base: string, sql: string): Promise<void> {
  const client = new Client({ connectionString: base });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}

const OLD_SHAPE = [
  { slotId: "fast", provider: "openai", modelName: "gpt-4o-mini", modelTier: "fast", routeSource: "config", enableMockFallback: true },
  { slotId: "balanced", provider: "openai", modelName: "gpt-4o", modelTier: "balanced", routeSource: "config", enableMockFallback: true },
];

const NEW_SHAPE = [
  { taskName: "fast", provider: "openai", modelName: "gpt-4o-mini", modelTier: "fast", isEnabled: true, config: { enableMockFallback: true } },
  { taskName: "balanced", provider: "openai", modelName: "gpt-4o", modelTier: "balanced", isEnabled: true, config: { enableMockFallback: true } },
];

async function main() {
  const base = databaseUrl();
  const where = new URL(base);
  console.log(`server:   ${where.hostname}:${where.port}`);
  console.log(`scratch:  ${SCRATCH} (clone of ${TEMPLATE_DB})\n`);

  await adminQuery(base, `CREATE DATABASE "${SCRATCH}" TEMPLATE "${TEMPLATE_DB}"`);
  let oldFailed = false;
  try {
    process.env.DATABASE_URL = urlForDatabase(base, SCRATCH);
    process.env.PERSISTENCE_PROVIDER = "prisma";
    const { createRepositories } = await import("@/repositories");
    const repos = createRepositories();
    const WS = `ws_route_shape_${Date.now()}`;
    // llm_model_routing.workspace_id is a real foreign key on Postgres —
    // the JSON substrate has no such constraint, which is one more thing
    // this fixture has never been asked to satisfy.
    await repos.workspace.create({ id: WS, name: "Route Shape Probe", industry: "Testing" });

    try {
      await repos.llmModelRouting.replaceForWorkspace(WS, OLD_SHAPE as never);
      console.log("OLD SHAPE (slotId/routeSource/enableMockFallback): ACCEPTED — no error");
    } catch (error) {
      oldFailed = true;
      const message = (error as Error).message.split("\n").filter(Boolean).slice(-3).join(" | ");
      console.log(`OLD SHAPE (slotId/routeSource/enableMockFallback): REJECTED by Postgres`);
      console.log(`  ${message.slice(0, 300)}`);
    }

    const rows = await repos.llmModelRouting.replaceForWorkspace(WS, NEW_SHAPE);
    console.log(`\nNEW SHAPE (taskName + config): ACCEPTED — ${rows.length} row(s) written`);
    const back = await repos.llmModelRouting.listByWorkspace(WS);
    console.log(`  read back: ${back.length} row(s), taskName = ${back.map((r) => r.taskName).sort().join(", ")}`);
  } finally {
    await adminQuery(base, `DROP DATABASE IF EXISTS "${SCRATCH}" WITH (FORCE)`);
    console.log(`\ndropped ${SCRATCH}`);
  }
  console.log(oldFailed
    ? "\nRESULT: the fixture that shipped for months described a row Postgres refuses."
    : "\nRESULT: Postgres accepted the old shape — re-examine the claim.");
}

main().catch((error) => { console.error(error); process.exit(1); });
