/**
 * probe-pg-contacts.ts — N-SAFETY-2 verification.
 *
 * Fixing `scripts/seed-demo-prisma.ts` fixes what FUTURE seeds write. It does
 * nothing to the rows already sitting in the database — and those rows are the
 * ones a G7 send test would actually dial. This prints every phone and email
 * currently stored in Postgres, across ALL workspaces (not just workspace_demo),
 * because N-DATA-2 found 11 leftover `sp-*-prisma-ws` scratch workspaces whose
 * leads are just as dialable as the demo ones.
 *
 * READ-ONLY.
 *
 * Run: npx tsx scripts/probes/probe-pg-contacts.ts
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

const UNROUTABLE_PHONE = /^9100000\d{5}$/;

function reservedEmail(email: string): boolean {
  const host = (email.split("@")[1] || "").toLowerCase();
  return (
    host === "example.com" || host === "example.net" || host === "example.org" ||
    host.endsWith(".example.com") || host.endsWith(".example") || host === "localhost"
  );
}

async function main() {
  const { prisma } = await import("@/lib/prisma");

  const leads = await prisma.lead.findMany({
    select: { id: true, workspaceId: true, companyName: true, whatsappNumber: true, phone: true, email: true },
  });

  console.log(`leads in Postgres (all workspaces): ${leads.length}\n`);

  const badPhones: string[] = [];
  const badEmails: string[] = [];

  for (const l of leads) {
    for (const p of [l.whatsappNumber, l.phone]) {
      if (!p) continue;
      const digits = String(p).replace(/\D/g, "");
      if (!UNROUTABLE_PHONE.test(digits)) badPhones.push(`${l.workspaceId}/${l.id} (${l.companyName || "?"}) → ${p}`);
    }
    if (l.email && !reservedEmail(l.email)) badEmails.push(`${l.workspaceId}/${l.id} → ${l.email}`);
  }

  console.log(`ROUTABLE PHONES: ${badPhones.length}`);
  for (const b of badPhones) console.log("  " + b);
  console.log(`\nDELIVERABLE EMAILS: ${badEmails.length}`);
  for (const b of badEmails) console.log("  " + b);

  // Escalation contacts are the numbers the WhatsApp agent actively dials.
  const wa = await prisma.whatsAppAgentSettings.findMany({
    select: { workspaceId: true, escalationContactPhone: true, escalationContactEmail: true },
  }).catch(() => []);
  console.log(`\nescalation contacts stored: ${wa.length}`);
  for (const w of wa) {
    const digits = String(w.escalationContactPhone || "").replace(/\D/g, "");
    const ok = !w.escalationContactPhone || UNROUTABLE_PHONE.test(digits);
    console.log(`  ${w.workspaceId} → ${w.escalationContactPhone || "(none)"} ${ok ? "" : "  <-- ROUTABLE"}`);
  }

  await prisma.$disconnect();

  const total = badPhones.length + badEmails.length;
  console.log(`\n=== ${total === 0 ? "CLEAN ✅ nothing in Postgres can reach a real person" : `${total} reachable contact(s) live in Postgres ❌`} ===`);
  process.exit(total === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("PROBE FAILED:", e instanceof Error ? e.message : e);
  process.exit(2);
});
