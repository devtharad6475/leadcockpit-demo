/**
 * Tell whoever is about to show the demo whether the demo still shows the
 * product they think it shows (N-OBS-1) — measured on THE SUBSTRATE THE APP IS
 * ACTUALLY CONFIGURED TO USE (N-OBS-2).
 *
 * THE BUG THIS EXISTS TO CLOSE (N-OBS-2, raised and fixed 2026-08-24 S16-7)
 * ------------------------------------------------------------------------
 * The first version of this script read `.leadgen-data/app-data.json` and
 * nothing else, while its own comment said, correctly:
 *
 *   "A checker that looks at a different file from the one the seeder writes is
 *    worse than no checker: it reports confidently about the wrong data."
 *
 * It then did exactly that one level up. `.env` sets
 * `PERSISTENCE_PROVIDER=prisma`, so the product serves screens out of Postgres —
 * and this checker kept reporting on the JSON file. Measured on 2026-08-24, at
 * the same minute: the JSON copy said "OK — Demo is demonstrable, 23h 58m left",
 * and Postgres said 163.8 hours old, zero open windows, not demonstrable. A
 * green pre-demo check, for the wrong database, about a demo that would have
 * shown the template-only path in front of a customer.
 *
 * So: resolve the provider the same way the app does, read from THAT, and print
 * which substrate the answer came from. An answer that does not name what it
 * measured is how the first version stayed wrong for four days.
 *
 * Exits 0 when the dataset is demonstrable, 1 when it is not, and prints the
 * refresh command FOR THAT SUBSTRATE. Read `src/lib/demo-freshness.ts` for why a
 * static demo quietly changes what it demonstrates after 24 hours.
 *
 * Run: npm run demo:check
 */
import fs from "node:fs";
import path from "node:path";
import {
  DEMO_REFRESH_COMMAND,
  DEMO_REFRESH_COMMAND_PRISMA,
  demoFreshness,
  demoFreshnessReport,
  type DemoLeadLike,
} from "../src/lib/demo-freshness";
import { getPersistenceProvider } from "../src/repositories";

async function readLeads(): Promise<{ leads: DemoLeadLike[]; source: string; refreshCommand: string }> {
  const provider = getPersistenceProvider();

  if (provider === "prisma") {
    // Imported lazily: loading the Prisma client in JSON mode would open a
    // database connection this run has no reason to need.
    const { prisma } = await import("../src/lib/prisma");
    const rows = await prisma.lead.findMany({
      select: { id: true, companyName: true, lastInboundAt: true },
    });
    await prisma.$disconnect();
    return {
      leads: rows.map((row) => ({
        id: row.id,
        companyName: row.companyName ?? undefined,
        lastInboundAt: row.lastInboundAt ? row.lastInboundAt.toISOString() : undefined,
      })),
      // Deliberately no connection string: it carries a password.
      source: "PostgreSQL (PERSISTENCE_PROVIDER=prisma) — the substrate this ships on",
      refreshCommand: DEMO_REFRESH_COMMAND_PRISMA,
    };
  }

  // Resolve exactly the way seed-demo.ts and src/lib/db.ts do.
  const dataDir = process.env.LEADGEN_DATA_DIR
    ? path.resolve(process.env.LEADGEN_DATA_DIR)
    : path.join(process.cwd(), ".leadgen-data");
  const dataFile = path.join(dataDir, "app-data.json");

  if (!fs.existsSync(dataFile)) {
    console.error(`[demo freshness] STALE — no demo dataset at ${dataFile}.`);
    console.error(`  Seed it: ${DEMO_REFRESH_COMMAND}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(dataFile, "utf8")) as { leads?: DemoLeadLike[] };
  return {
    leads: data.leads ?? [],
    source: `${dataFile} (PERSISTENCE_PROVIDER=json)`,
    refreshCommand: DEMO_REFRESH_COMMAND,
  };
}

async function main() {
  const { leads, source, refreshCommand } = await readLeads();
  const state = demoFreshness(leads, Date.now(), refreshCommand);
  console.log(demoFreshnessReport(state));
  console.log(`  measured: ${source}`);
  console.log(`  leads read: ${leads.length}`);
  if (!state.demonstrable) {
    console.log("  (nothing is broken — the product is correctly refusing an out-of-window free-text send.)");
  }
  process.exit(state.demonstrable ? 0 : 1);
}

main().catch((error) => {
  console.error("[demo freshness] could not be determined:", error instanceof Error ? error.message : error);
  // Exit 1, not 0. A checker that cannot read its data must not report "fine".
  process.exit(1);
});
