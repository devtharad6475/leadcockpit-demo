/**
 * measure-pg.ts (CEO-loop session 3) — measure the Postgres read cost that the
 * UA-1 P0 was about: readAll() (~57 findMany calls) plus the per-collection
 * reads the common API routes actually make.
 *
 * Run: PERSISTENCE_PROVIDER=prisma npx tsx <this file>
 */
import { createRepositories } from "@/repositories";

const WS = "workspace_demo";

async function time<T>(label: string, fn: () => Promise<T>): Promise<number> {
  const t0 = performance.now();
  const out = await fn();
  const ms = performance.now() - t0;
  const size = Array.isArray(out) ? `${out.length} rows` : typeof out === "object" && out ? `${Object.keys(out).length} collections` : "";
  console.log(`  ${label.padEnd(34)} ${ms.toFixed(0).padStart(7)} ms   ${size}`);
  return ms;
}

async function main() {
  const repos = createRepositories();
  console.log(`provider=${process.env.PERSISTENCE_PROVIDER}  db=${(process.env.DATABASE_URL || "").replace(/:\/\/[^@]*@/, "://***@")}`);

  console.log("\n--- cold (first call, includes connection setup) ---");
  await time("readAll()", () => repos.readAll!());
  await time("lead.listLeads(ws)", () => repos.lead.listLeads(WS, {}));
  await time("quote.list(ws)", () => repos.quote.listByWorkspace(WS));
  await time("order.list(ws)", () => repos.order.listByWorkspace(WS));

  console.log("\n--- warm (5 x readAll) ---");
  const warm: number[] = [];
  for (let i = 0; i < 5; i++) warm.push(await time(`readAll() #${i + 1}`, () => repos.readAll!()));
  warm.sort((a, b) => a - b);
  console.log(`\n  readAll warm: min ${warm[0].toFixed(0)} ms · median ${warm[2].toFixed(0)} ms · max ${warm[4].toFixed(0)} ms`);

  console.log("\n--- scoped reads (what a per-endpoint fix would cost instead) ---");
  const scoped: number[] = [];
  for (let i = 0; i < 3; i++) scoped.push(await time(`lead.listLeads #${i + 1}`, () => repos.lead.listLeads(WS, {})));
  scoped.sort((a, b) => a - b);
  console.log(`\n  scoped lead read: median ${scoped[1].toFixed(0)} ms`);
  process.exit(0);
}

main().catch((e) => { console.error("MEASURE FAILED:", e); process.exit(1); });
