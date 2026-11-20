/**
 * probe-active-substrate.ts — which substrate does the app ACTUALLY bind to,
 * and what is really in each one?
 *
 * WHY THIS EXISTS
 * ---------------
 * N-DATA-2 concluded "the demo data lives on JSON, the app runs on Postgres".
 * Then a contradiction turned up: `.env:1` says PERSISTENCE_PROVIDER="prisma",
 * yet scripts/load-fixture-knowledge.ts — which calls loadEnvConfig() BEFORE
 * importing the repositories — produced 523 knowledge answers that landed in
 * `.leadgen-data/app-data.json`, i.e. in the JSON substrate.
 *
 * Both statements cannot be true at once. This probe settles it by observation
 * rather than by reading code, because the whole point of N-DATA-2 is that
 * reading one substrate's code told a misleading story.
 *
 * It prints the SAME counts from both substrates side by side, so the gap is a
 * measurement rather than an argument, plus the workspace list (N-DATA-2 found
 * 10 leftover `sp-*-prisma-ws` scratch workspaces sitting in the ship database).
 *
 * READ-ONLY. Opens a Prisma connection but issues no writes.
 *
 * Run: npx tsx scripts/probes/probe-active-substrate.ts
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const WS = "workspace_demo";

/** [label, prisma delegate name, json collection name] */
const TABLES: Array<[string, string, string]> = [
  ["leads", "lead", "leads"],
  ["businessProfiles", "businessProfile", "businessProfiles"],
  ["llmModelRoutings", "lLMModelRouting", "llmModelRoutings"],
  ["knowledgeQuestionAnswers", "knowledgeQuestionAnswer", "knowledgeQuestionAnswers"],
  ["knowledgeExtractionSources", "knowledgeExtractionSource", "knowledgeExtractionSources"],
  ["knowledgeBaseDocuments", "knowledgeBaseDocument", "knowledgeBaseDocuments"],
  ["agentRuns", "agentRun", "agentRuns"],
  ["orders", "order", "orders"],
  ["quotes", "quote", "quotes"],
  ["aiUsageLimits", "aIUsageLimit", "aiUsageLimits"],
];

function pad(s: string, n: number) {
  return s + " ".repeat(Math.max(0, n - s.length));
}

async function main() {
  console.log("=== env as seen by this process ===");
  console.log("  PERSISTENCE_PROVIDER =", JSON.stringify(process.env.PERSISTENCE_PROVIDER));
  console.log("  DATABASE_URL set     =", Boolean(process.env.DATABASE_URL));

  const { getPersistenceProvider, createRepositories } = await import("@/repositories");
  const provider = getPersistenceProvider();
  console.log("  getPersistenceProvider() =", provider);
  const repos = createRepositories();
  console.log("  lead repo class      =", repos.lead?.constructor?.name);

  // ─── JSON side ─────────────────────────────────────────────────────────────
  const file = path.join(process.cwd(), ".leadgen-data", "app-data.json");
  const json = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const jsonCount = (k: string) =>
    (json[k] || []).filter((r: { workspaceId?: string }) => r.workspaceId === WS).length;

  // ─── Postgres side ─────────────────────────────────────────────────────────
  // The generated client lives at src/generated/prisma (see prisma/schema.prisma:3),
  // and src/lib/prisma.ts already wires the driver adapter + DATABASE_URL. Reuse it
  // rather than constructing a second client with different connection settings.
  const { prisma } = await import("@/lib/prisma");

  const rows: Array<[string, number, number]> = [];
  for (const [label, delegate, collection] of TABLES) {
    let pg = -1;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pg = await (prisma as any)[delegate].count({ where: { workspaceId: WS } });
    } catch {
      pg = -1; // delegate name wrong or table has no workspaceId
    }
    rows.push([label, pg, jsonCount(collection)]);
  }

  console.log("\n=== same counts, both substrates, workspace_demo ===");
  console.log(`  ${pad("collection", 30)} ${pad("POSTGRES", 10)} JSON`);
  console.log(`  ${"-".repeat(30)} ${"-".repeat(10)} ----`);
  for (const [label, pg, js] of rows) {
    const flag = pg === 0 && js > 0 ? "   <-- exists only on JSON" : "";
    console.log(`  ${pad(label, 30)} ${pad(pg < 0 ? "(n/a)" : String(pg), 10)} ${pad(String(js), 4)}${flag}`);
  }

  // Identity check — the single clearest tell.
  const pgProfile = await prisma.businessProfile.findFirst({ where: { workspaceId: WS } }).catch(() => null);
  const jsProfile = (json.businessProfiles || []).find((p: { workspaceId?: string }) => p.workspaceId === WS);
  const pgWs = await prisma.workspace.findUnique({ where: { id: WS } }).catch(() => null);
  console.log("\n=== identity ===");
  console.log("  POSTGRES workspace.name  =", pgWs?.name ?? "(no workspace row)");
  console.log("  POSTGRES businessProfile =", pgProfile?.companyName ?? "(none)");
  console.log("  JSON     businessProfile =", jsProfile?.companyName ?? "(none)");

  // N-DATA-2 pollution check.
  const allWs = await prisma.workspace.findMany({ select: { id: true, name: true } }).catch(() => []);
  const scratch = allWs.filter((w) => /^sp-|-prisma-ws$/.test(w.id) || w.name === "Renamed WS");
  console.log("\n=== ship-database hygiene ===");
  console.log("  total workspaces in Postgres =", allWs.length);
  console.log("  scratch/test workspaces      =", scratch.length, scratch.length ? `(${scratch.slice(0, 5).map((w) => w.id).join(", ")}${scratch.length > 5 ? ", …" : ""})` : "");

  await prisma.$disconnect();

  console.log("\n=== verdict ===");
  console.log(`  Repository layer is bound to: ${provider.toUpperCase()}`);
  const onlyJson = rows.filter(([, pg, js]) => pg === 0 && js > 0);
  if (provider === "prisma" && onlyJson.length) {
    console.log(`  ${onlyJson.length} collection(s) exist ONLY on JSON while the app reads Postgres.`);
    console.log("  => every demo asset in those collections is invisible to the running app.");
  }
}

main().catch((e) => {
  console.error("PROBE FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
