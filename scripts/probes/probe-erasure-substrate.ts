/**
 * probe-erasure-substrate.ts — N-DATA-16 evidence run (2026-08-25, audit A-7).
 *
 * THE CLAIM UNDER TEST
 * --------------------
 * `POST /api/erasure/:leadId` is the product's right-to-erasure endpoint. Before
 * this fix it loaded two of its inputs with `readData()` from `src/lib/db.ts`:
 *
 *   - `humanFallbackTasks` — the questions a customer asked that a human still
 *     has to answer. They carry the customer's own words.
 *   - `doNotContactRegistry` — the one thing an erasure must PRESERVE rather
 *     than delete, so that erasing somebody's record does not also erase the
 *     fact that they said stop.
 *
 * `readData()` is a plain read of `.leadgen-data/app-data.json`. It does not
 * consult PERSISTENCE_PROVIDER and has no Prisma path. So on the substrate this
 * product ships on, both lists came back empty: the erasure deleted no fallback
 * tasks (personal data left behind) and preserved a registry it could not see.
 *
 * This is the same class as N-DNC-1 (session 6). That one was found in
 * `dnc-registry.ts` and fixed there. This is a second instance that survived,
 * which is why the fix ships with `golden-json-substrate-leak.ts` — a check on
 * the whole class rather than on these two lines.
 *
 * This probe does not argue any of that. It measures it, on real Postgres:
 *
 *   MEASUREMENT 1 — seed one fallback task in Postgres, then ask BOTH data
 *     sources for it: the old one (`readData()`) and the new one
 *     (`repos.readAll()`). The old one is expected to report nothing.
 *
 *   MEASUREMENT 2 — the same for the do-not-contact registry, against
 *     `repos.doNotContact.listByWorkspace()`.
 *
 * SAFETY. Every row this probe creates carries the probe id below and is
 * removed in `finally`, pass or fail. The phone number is N-SAFETY-1 unroutable
 * by construction (+91 00000 000NN). `LEADGEN_DATA_DIR` is redirected to a
 * throwaway directory before `@/lib/db` is imported, so calling the OLD code
 * path cannot write to the shared demo file.
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import os from "node:os";
import path from "node:path";

// Before ANY import of @/lib/db: the old path is about to be called on purpose,
// and it must not be able to touch .leadgen-data/app-data.json.
process.env.LEADGEN_DATA_DIR = path.join(os.tmpdir(), "leadgen-erasure-probe", `run-${process.pid}-${Date.now()}`);

const PROBE_ID = "probe_n_data_16";
const PROBE_PHONE = "+910000000097";

async function main() {
  const provider = process.env.PERSISTENCE_PROVIDER;
  console.log(`PERSISTENCE_PROVIDER = ${provider}`);
  if (provider !== "prisma") {
    console.error("This probe only means something with PERSISTENCE_PROVIDER=prisma. Stopping.");
    process.exit(1);
  }

  const { prisma } = await import("@/lib/prisma");
  const { readData } = await import("@/lib/db");
  const { repositories: repos } = await import("@/repositories");

  const lead = await prisma.lead.findFirst({ select: { id: true, workspaceId: true } });
  if (!lead) {
    console.log("SKIP: no lead exists in this database, so there is nothing to hang an erasure on.");
    process.exit(0);
  }
  const workspaceId = lead.workspaceId;
  console.log(`workspace under test = ${workspaceId}`);

  let interactionId: string | undefined;
  let taskId: string | undefined;
  let dncId: string | undefined;
  let exitCode = 1;

  try {
    // ── Seed, directly in Postgres ────────────────────────────────────────
    const interaction = await prisma.interaction.create({
      data: {
        workspaceId,
        leadId: lead.id,
        role: "user",
        channel: "whatsapp",
        content: `${PROBE_ID} what is your return window on damaged pallets?`,
        needsHumanHelp: true,
      },
      select: { id: true },
    });
    interactionId = interaction.id;

    const task = await prisma.humanFallbackTask.create({
      data: {
        workspaceId,
        interactionId: interaction.id,
        prospectQuery: `${PROBE_ID} what is your return window on damaged pallets?`,
        status: "PENDING",
      },
      select: { id: true },
    });
    taskId = task.id;

    const dnc = await prisma.doNotContactEntry.create({
      data: {
        workspaceId,
        normalizedPhone: PROBE_PHONE,
        reason: `${PROBE_ID} seeded opt-out`,
        sourceLeadId: lead.id,
      },
      select: { id: true },
    });
    dncId = dnc.id;

    console.log("seeded in Postgres: 1 interaction, 1 human fallback task, 1 do-not-contact entry");
    console.log("");

    // ── MEASUREMENT 1 — human fallback tasks ──────────────────────────────
    const oldTasks = ((await readData()).humanFallbackTasks || []).filter((t) => t.workspaceId === workspaceId);
    const newTasks = ((await repos.readAll!()).humanFallbackTasks || []).filter((t) => t.workspaceId === workspaceId);
    const oldFound = oldTasks.some((t) => t.id === taskId);
    const newFound = newTasks.some((t) => t.id === taskId);

    console.log("MEASUREMENT 1 — the fallback task the erasure is supposed to delete");
    console.log(`  OLD path  readData().humanFallbackTasks      -> ${oldTasks.length} row(s) for this workspace, seeded task found: ${oldFound}`);
    console.log(`  NEW path  repos.readAll().humanFallbackTasks -> ${newTasks.length} row(s) for this workspace, seeded task found: ${newFound}`);
    console.log(
      oldFound
        ? "  VERDICT: the old path saw it too — the bug does not reproduce here."
        : newFound
          ? "  VERDICT: the OLD path could not see it, the NEW path can. A right-to-erasure request on Postgres left this record behind."
          : "  VERDICT: NEITHER path sees it — the fix is not sufficient. Investigate before closing.",
    );
    console.log("");

    // ── MEASUREMENT 2 — the do-not-contact registry ───────────────────────
    const oldDnc = ((await readData()).doNotContactRegistry || []).filter((d) => d.workspaceId === workspaceId);
    const newDnc = await repos.doNotContact.listByWorkspace(workspaceId);
    const oldDncFound = oldDnc.some((d) => d.id === dncId);
    const newDncFound = newDnc.some((d) => d.id === dncId);

    console.log("MEASUREMENT 2 — the opt-out the erasure is supposed to PRESERVE");
    console.log(`  OLD path  readData().doNotContactRegistry           -> ${oldDnc.length} row(s), seeded entry found: ${oldDncFound}`);
    console.log(`  NEW path  repos.doNotContact.listByWorkspace()      -> ${newDnc.length} row(s), seeded entry found: ${newDncFound}`);
    console.log(
      oldDncFound
        ? "  VERDICT: the old path saw it too — the bug does not reproduce here."
        : newDncFound
          ? "  VERDICT: the OLD path saw an EMPTY registry. An erasure cannot preserve a stop-request it cannot see."
          : "  VERDICT: NEITHER path sees it — the fix is not sufficient. Investigate before closing.",
    );
    console.log("");

    const proved = !oldFound && newFound && !oldDncFound && newDncFound;
    console.log(
      proved
        ? "=== N-DATA-16 REPRODUCED AND FIXED: both inputs were invisible on Postgres before the change, both are visible after it ==="
        : "=== N-DATA-16 NOT CLEANLY DEMONSTRATED — read the verdicts above ===",
    );
    // NOT process.exit() here. Calling it inside the try tears the process down
    // before the awaits in `finally` can run, and the probe's own seed rows are
    // left in the database — which is exactly what the first run of this probe
    // did. The exit code is carried out and applied after cleanup instead.
    exitCode = proved ? 0 : 1;
  } finally {
    // Remove everything this probe created, in dependency order, whatever happened.
    if (dncId) await prisma.doNotContactEntry.delete({ where: { id: dncId } }).catch(() => undefined);
    if (taskId) await prisma.humanFallbackTask.delete({ where: { id: taskId } }).catch(() => undefined);
    if (interactionId) await prisma.interaction.delete({ where: { id: interactionId } }).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
  process.exit(exitCode);
}

main().catch((error) => {
  console.error("PROBE CRASHED:", error);
  process.exit(1);
});
