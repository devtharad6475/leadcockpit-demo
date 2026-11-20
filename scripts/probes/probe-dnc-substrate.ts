/**
 * probe-dnc-substrate.ts — N-DNC-1 evidence run (2026-08-18, CEO-loop session 6).
 *
 * THE CLAIM UNDER TEST
 * --------------------
 * `src/lib/dnc-registry.ts` — the permanent Do-Not-Contact registry, the store
 * that decides whether the product is allowed to message somebody who said stop
 * — reads and writes with `readData()` / `mutateData()` from `src/lib/db.ts`.
 * Those two functions are plain file operations on `.leadgen-data/app-data.json`
 * with NO awareness of `PERSISTENCE_PROVIDER` (db.ts:209 and db.ts:260). So on
 * the substrate this product ships on (Postgres, decision D3) the compliance
 * registry would live in a local JSON file, while `do_not_contact_entries` sits
 * in Postgres and nothing reads it.
 *
 * This probe does not argue that. It runs it, both directions:
 *
 *   DIRECTION 1 (WRITE) — call registerDoNotContact() with the app bound to
 *     Postgres, then count the Postgres table. If the count does not move, the
 *     opt-out never reached the ship database.
 *
 *   DIRECTION 2 (READ) — the dangerous half. Put an opt-out DIRECTLY into the
 *     Postgres table, then ask the product's own guard,
 *     isPermanentlyDoNotContact(), whether that contact is blocked. If it
 *     answers false, an opt-out recorded in the ship database does not stop an
 *     outbound message.
 *
 * SAFETY. Both numbers are N-SAFETY-1 unroutable by construction
 * (+91 00000 000NN). Everything this probe creates, it removes in `finally`,
 * on both substrates, whether it passes or fails.
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { readData } from "@/lib/db";
import {
  registerDoNotContact,
  isPermanentlyDoNotContact,
  normalizePhone,
} from "@/lib/dnc-registry";

const WORKSPACE = "workspace_demo";
const PHONE_WRITE = "+91 00000 00098";
const PHONE_READ = "+91 00000 00099";
const PROBE_ID = "dnc_probe_n_dnc_1";

async function main() {
  const provider = process.env.PERSISTENCE_PROVIDER;
  console.log(`PERSISTENCE_PROVIDER = ${provider}`);
  if (provider !== "prisma") {
    console.error("This probe only means something with PERSISTENCE_PROVIDER=prisma. Stopping.");
    process.exit(1);
  }

  const { prisma } = await import("@/lib/prisma");

  try {
    // ── DIRECTION 1: does an opt-out reach Postgres? ───────────────────────
    const pgBefore = await prisma.doNotContactEntry.count();
    const jsonBefore = ((await readData()).doNotContactRegistry || []).length;
    console.log("");
    console.log("DIRECTION 1 — write an opt-out through the product's own API");
    console.log(`  before:  postgres rows = ${pgBefore}   json rows = ${jsonBefore}`);

    const entry = await registerDoNotContact(WORKSPACE, {
      phone: PHONE_WRITE,
      reason: "N-DNC-1 substrate probe",
    });
    console.log(`  registerDoNotContact() returned: ${entry ? entry.id : "null"}`);

    const pgAfter = await prisma.doNotContactEntry.count();
    const jsonAfter = ((await readData()).doNotContactRegistry || []).length;
    console.log(`  after:   postgres rows = ${pgAfter}   json rows = ${jsonAfter}`);
    console.log(
      `  VERDICT: postgres ${pgAfter === pgBefore ? "DID NOT CHANGE" : "changed"}, ` +
      `json ${jsonAfter > jsonBefore ? "GREW" : "did not grow"}`,
    );

    // ── DIRECTION 2: can the guard see an opt-out that IS in Postgres? ─────
    console.log("");
    console.log("DIRECTION 2 — put an opt-out directly in Postgres, then ask the guard");
    await prisma.doNotContactEntry.create({
      data: {
        id: PROBE_ID,
        workspaceId: WORKSPACE,
        normalizedPhone: normalizePhone(PHONE_READ),
        reason: "N-DNC-1 substrate probe (postgres side)",
      },
    });
    const inPg = await prisma.doNotContactEntry.findUnique({ where: { id: PROBE_ID } });
    console.log(`  row present in postgres: ${Boolean(inPg)} (phone ${inPg?.normalizedPhone})`);

    const blocked = await isPermanentlyDoNotContact(WORKSPACE, { phone: PHONE_READ });
    console.log(`  isPermanentlyDoNotContact(${PHONE_READ}) = ${blocked}`);
    console.log(
      `  VERDICT: a contact who opted out, recorded in the SHIP database, is ` +
      `${blocked ? "correctly blocked" : "NOT BLOCKED — the product would message them"}`,
    );
  } finally {
    // ── cleanup, both substrates ──────────────────────────────────────────
    console.log("");
    console.log("cleanup:");
    // Delete by id AND by reason. Once the fix landed, DIRECTION 1's opt-out
    // lands in Postgres too — cleaning only PROBE_ID would leave the probe's
    // own row behind in the ship database, which is exactly the kind of debris
    // that made the workspace reaper necessary.
    const removed = await prisma.doNotContactEntry.deleteMany({
      where: { OR: [{ id: PROBE_ID }, { reason: { contains: "N-DNC-1 substrate probe" } }] },
    });
    console.log(`  postgres rows removed: ${removed.count}`);

    const { mutateData } = await import("@/lib/db");
    const jsonRemoved = await mutateData((data) => {
      const before = (data.doNotContactRegistry || []).length;
      data.doNotContactRegistry = (data.doNotContactRegistry || []).filter(
        (e) => !(e.reason || "").startsWith("N-DNC-1 substrate probe"),
      );
      return before - data.doNotContactRegistry.length;
    });
    console.log(`  json rows removed:     ${jsonRemoved}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
