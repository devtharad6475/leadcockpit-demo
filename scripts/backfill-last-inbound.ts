/**
 * backfill-last-inbound.ts — repair `lead.lastInboundAt` on data that already exists (N-DATA-9).
 *
 * WHY THIS EXISTS (2026-08-20)
 * ----------------------------
 * Fixing the seeders fixes the NEXT seed. It does nothing for the data already
 * sitting in .leadgen-data/app-data.json and in Postgres — which is the data the
 * CEO opens. That data holds customer replies against leads whose
 * `lastInboundAt` is unset, so the Replies screen shows a customer's WhatsApp
 * question directly above "Customer hasn't messaged you yet", and the CP-24
 * 24-hour window gate refuses every reply on those leads.
 *
 * This script derives the timestamp from the replies themselves, using the one
 * shared rule in src/lib/last-inbound.ts, and writes it through the repository
 * layer — so it works on whichever substrate PERSISTENCE_PROVIDER selects.
 *
 * It is deliberately conservative:
 *   - it only ever ADDS a missing timestamp, or moves one FORWARD to match a
 *     later reply; it never moves a timestamp backwards and never clears one,
 *     because in a live workspace the engine's value is the authority
 *   - WhatsApp replies only — an email reply does not open Meta's window
 *   - idempotent: a second run reports 0 changes
 *   - dry by default. Pass --force to write.
 *
 * Run: npx tsx scripts/backfill-last-inbound.ts [--force]
 *      PERSISTENCE_PROVIDER=prisma npx tsx scripts/backfill-last-inbound.ts --force
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { lastInboundByLead } from "@/lib/last-inbound";
import type { Reply } from "@/lib/types";

async function main() {
  const force = process.argv.includes("--force");
  const { createRepositories } = await import("@/repositories");
  const repos = createRepositories();
  const provider = process.env.PERSISTENCE_PROVIDER || "json";

  const workspaces = await repos.workspace.listAll(true);
  let scanned = 0;
  let changed = 0;

  for (const ws of workspaces) {
    const leads = await repos.lead.listLeads(ws.id);
    const replies = (await repos.reply.listByWorkspace(ws.id)) as Reply[];
    const inbound = lastInboundByLead(replies);
    scanned += leads.length;

    for (const lead of leads) {
      const derived = inbound.get(lead.id);
      if (!derived) continue;
      // Never move it backwards: the engine's stamp is the authority in a live
      // workspace, and a seeded reply must not undo a real conversation.
      if (lead.lastInboundAt && lead.lastInboundAt >= derived) continue;
      const before = lead.lastInboundAt ?? "(unset)";
      changed += 1;
      console.log(`  ${force ? "+" : "would set"} ${ws.id}/${lead.id} (${lead.companyName || "unnamed"}): ${before} -> ${derived}`);
      if (force) await repos.lead.updateLead(ws.id, lead.id, { lastInboundAt: derived });
    }
  }

  console.log(`\nprovider=${provider} · workspaces=${workspaces.length} · leads scanned=${scanned} · leads ${force ? "updated" : "needing repair"}=${changed}`);
  if (!force && changed > 0) console.log("Dry run. Re-run with --force to write.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
