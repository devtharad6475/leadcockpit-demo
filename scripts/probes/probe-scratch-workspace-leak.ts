/**
 * probe-scratch-workspace-leak.ts — READ-ONLY measurement of the scratch
 * workspace leak recorded under N-DATA-2.
 *
 * THE CLAIM BEING TESTED. The status doc says the prisma goldens leak one
 * `sp-*-prisma-ws` workspace per run into the SHIP database, that nothing ever
 * reaps them, and that the leads inside them "carry routable phone numbers" —
 * which would breach N-SAFETY-1 (fake data must be unroutable BY CONSTRUCTION:
 * phones `+91 00000 000NN`, domains RFC 2606 `.example`). A claim that serious
 * should be measured, not inherited.
 *
 * THIS SCRIPT WRITES NOTHING. It only counts and classifies. It deliberately
 * runs against the REAL configured substrate (no force-json preload) because
 * the whole question is what is sitting in the ship database right now.
 *
 * ON PRINTING PHONE NUMBERS. A phone number that turns out to be routable may
 * belong to a real person, so this prints a CLASSIFICATION plus a masked sample
 * (last 2 digits only) — enough to prove the point, not enough to dial. The
 * unroutable test is structural, matching how the safe data is constructed.
 *
 * Run: npx tsx scripts/probes/probe-scratch-workspace-leak.ts
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

/** N-SAFETY-1 shape: +91 00000 000NN — any spacing, must be all-zero body. */
function isUnroutableByConstruction(phone: string | null | undefined): boolean {
  if (!phone) return true; // no number cannot dial anyone
  const digits = phone.replace(/\D/g, "");
  // +91 00000 000NN => 91 followed by 00000000 then two free digits.
  if (/^910{8}\d{2}$/.test(digits)) return true;
  // Also treat an all-zero body of any length as unroutable.
  if (/^91?0+$/.test(digits)) return true;
  return false;
}

function mask(phone: string | null | undefined): string {
  if (!phone) return "(empty)";
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 2) return "**";
  return `${"*".repeat(digits.length - 2)}${digits.slice(-2)}`;
}

async function main() {
  const { getPersistenceProvider } = await import("@/repositories");
  const { prisma } = await import("@/lib/prisma");
  const provider = getPersistenceProvider();
  console.log(`persistence provider: ${provider}`);
  console.log(`(this is the SHIP substrate — no golden preload in effect)\n`);

  // Workspaces are not part of the repository bundle, so this reads the ship
  // database directly through Prisma. Read-only: findMany only.
  const workspaces = await prisma.workspace.findMany({ select: { id: true, name: true } });

  const scratch = workspaces.filter((item) => /^sp-/.test(item.id));
  const real = workspaces.filter((item) => !scratch.includes(item));

  console.log(`workspaces total:   ${workspaces.length}`);
  console.log(`  real:             ${real.length}   ${real.map((item) => `${item.id} ("${item.name}")`).join(", ") || "(none)"}`);
  console.log(`  scratch (sp-*):   ${scratch.length}`);

  if (!scratch.length) {
    console.log("\nRESULT: no scratch workspaces present. Nothing to reap.");
    return;
  }

  let leadTotal = 0;
  let routable = 0;
  const routableSamples: string[] = [];

  for (const workspace of scratch) {
    const leads = await prisma.lead.findMany({ where: { workspaceId: workspace.id }, select: { phone: true } });
    leadTotal += leads.length;
    for (const lead of leads) {
      const phone = lead.phone;
      if (!isUnroutableByConstruction(phone)) {
        routable += 1;
        if (routableSamples.length < 5) routableSamples.push(`${workspace.id}: ${mask(phone)}`);
      }
    }
  }

  console.log(`\nleads inside scratch workspaces: ${leadTotal}`);
  console.log(`  NOT unroutable-by-construction: ${routable}`);
  if (routableSamples.length) {
    console.log("  masked samples (last 2 digits only):");
    for (const sample of routableSamples) console.log(`    ${sample}`);
  }

  console.log("\n--- verdict ---");
  if (routable > 0) {
    console.log(`N-SAFETY-1 BREACH CONFIRMED in the ship database: ${routable} lead(s) across ${scratch.length} leaked workspace(s) hold a phone number that is not unroutable by construction.`);
  } else {
    console.log(`Leak confirmed (${scratch.length} scratch workspaces) but every lead phone IS unroutable by construction — this is clutter, not an N-SAFETY-1 breach.`);
  }
}

main().catch((e) => {
  console.error("PROBE FAILED:", e instanceof Error ? e.message : e);
  process.exit(2);
});
