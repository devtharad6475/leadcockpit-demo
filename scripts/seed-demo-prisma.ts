/**
 * seed-demo-prisma.ts — L-2/L-4 (2026-08-04).
 *
 * Seeds workspace_demo in the ACTIVE Postgres database with a minimal-but-
 * meaningful demo dataset so the prod-prisma e2e spec has real data to render
 * (Dashboard pipeline, CRM rows, Commercial orders/quotes, Replies).
 *
 * WHY THIS EXISTS (not just `npm run seed:demo`):
 *   seed-demo.ts writes via `writeData` (the JSON file path) — it does NOT go
 *   through the repository layer, so in prisma mode it would write to
 *   .leadgen-data/app-data.json while the app reads from Postgres (split-brain).
 *   This script writes through the REAL prisma repositories.
 *
 * IDEMPOTENT: safe to re-run. Each run first deletes prior seed rows (by their
 * fixed `seed_*` ids via deleteByLead / deleteById), then re-creates them.
 * NEVER touches real customer rows.
 *
 * Run: PERSISTENCE_PROVIDER=prisma npx tsx scripts/seed-demo-prisma.ts
 */
// N-BUILD-2 (2026-08-18): this script used to get PERSISTENCE_PROVIDER purely
// from the npm script's `PERSISTENCE_PROVIDER=prisma tsx ...` prefix — POSIX
// shell syntax. npm shells out to cmd.exe on Windows, where that is a parse
// error, so the documented command could not run at all on the platform this
// repo is developed on. Loading `.env` here makes the script self-sufficient and
// the npm script cross-platform. The prisma-mode guard in main() is unchanged,
// so running it with PERSISTENCE_PROVIDER=json still refuses.
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

// `createRepositories` is imported DYNAMICALLY inside main(): @/repositories
// builds a repository singleton at module-evaluation time, and static imports
// are hoisted above the loadEnvConfig() call above. The type-only import below
// is erased at compile time, so it carries no runtime ordering risk.
import type { RepositoryBundle } from "@/repositories/interfaces";
import { findForeignRows } from "./lib/foreign-rows";
import { lastInboundByLead } from "@/lib/last-inbound";

const WS = "workspace_demo";
const LEAD_USER = "user_owner";
const NOW = new Date().toISOString();
// N-UX-11 (2026-08-20): a seeded order stamped entirely with NOW claims it was
// confirmed and delivered in the same millisecond, and seed_order_2 recorded a
// delivery date with no ship date at all -- goods that arrived without ever
// leaving. Ordered offsets instead.
const DAYS_AGO = (n: number) => new Date(Date.parse(NOW) - n * 24 * 60 * 60 * 1000).toISOString();

async function seedLead(repos: RepositoryBundle, id: string, overrides: Record<string, unknown>) {
  // Idempotent: delete first if it exists.
  try { await repos.lead.deleteById(WS, id); } catch { /* not present */ }
  // NOTE: pass ONLY Prisma-native Lead fields. The JSON Lead type has extra
  // fields (ownerUserId, sources[], tags[]) that the Prisma model names
  // differently (assignedTo, source string, no tags) — a JSON/Prisma drift
  // outside this script's scope. Stripping to native fields avoids the
  // validation errors; the demo only needs enough to render the pipeline.
  await repos.lead.createLead({ workspaceId: WS, id, assignedTo: LEAD_USER, consentStatus: "none", leadScore: 10, createdAt: NOW, updatedAt: NOW, ...overrides } as never);
  console.log(`  + lead ${id}`);
}

/**
 * N-SEED-1 (2026-08-17, CEO-loop session 3) — ensure the workspace + owner user
 * EXIST before anything references them.
 *
 * This script always assumed `workspace_demo` and `user_owner` were already in
 * the database, because it was only ever run against a Postgres that had been
 * imported from the JSON file (import-json-to-postgres.ts). Against a FRESH
 * database — i.e. every real first deployment, which is the ship target since
 * decision D3 — the very first write died with:
 *
 *   Foreign key constraint violated on the constraint: `leads_workspace_id_fkey`
 *
 * because Lead.workspaceId references a Workspace row that nothing had created.
 * Both writes below are idempotent (get-then-create), so re-running the seed on
 * an already-seeded database is still a no-op for these two rows.
 */
async function ensureWorkspaceAndOwner(repos: RepositoryBundle) {
  const existingWs = await repos.workspace.getById(WS);
  if (!existingWs) {
    await repos.workspace.create({ id: WS, name: "Demo Workspace", createdAt: NOW, updatedAt: NOW } as never);
    console.log(`  + workspace ${WS} (was missing — fresh database)`);
  } else {
    console.log(`  = workspace ${WS} already present`);
  }
  const existingUser = await repos.user.findById(LEAD_USER);
  if (!existingUser) {
    await repos.user.create({
      // N-SAFETY-2: `owner@demo.local` is not deliverable, but it also does not
      // match `owner@example.com` in scripts/seed-demo.ts — the same demo owner
      // with two identities depending on substrate. Aligned to the JSON seeder.
      id: LEAD_USER, workspaceId: WS, email: "owner@example.com", name: "Demo Owner",
      role: "owner", status: "active", createdAt: NOW, updatedAt: NOW,
    } as never);
    console.log(`  + user ${LEAD_USER} (was missing — fresh database)`);
  } else {
    console.log(`  = user ${LEAD_USER} already present`);
  }
}

/**
 * N-SEED-2 (2026-08-19, CEO-loop session 7) — refuse to run on top of migrated data.
 *
 * WHAT WENT WRONG
 * ---------------
 * This seeder writes fixed `seed_*` rows. The JSON->Postgres migration writes
 * the real demo data set as `*_demo_*` rows. Both want order number 1 in
 * `workspace_demo`, and `(workspace_id, order_number)` is UNIQUE, so running
 * this against a migrated database dies mid-transaction with:
 *
 *     Unique constraint failed on the fields: (`workspace_id`,`order_number`)
 *
 * — after some rows have already been written, leaving the database in a state
 * nobody asked for and giving no hint about the cause.
 *
 * WHY THIS REFUSES RATHER THAN MERGES
 * -----------------------------------
 * Renumbering around the collision would make the command "succeed", and the
 * result would be demo rows mixed into the real data set with no marker saying
 * which is which. The seeder exists to fill an EMPTY database for the e2e
 * smoke; on a database that already has the real data it has no job to do. The
 * useful behaviour is to stop and say so in one sentence.
 *
 * The detection is deliberately about ORIGIN, not counts: any row this script
 * did not write is somebody else's data. `--force` is offered because the
 * caller may genuinely want seed rows in a scratch database, and refusing with
 * no way through is its own kind of unhelpful.
 */
async function refuseIfDataIsNotOurs(repos: RepositoryBundle) {
  const [orders, quotes, leads] = await Promise.all([
    repos.order.listByWorkspace(WS),
    repos.quote.listByWorkspace(WS),
    repos.lead.listLeads(WS),
  ]);
  const foreign = findForeignRows({ orders, quotes, leads });
  if (foreign.length === 0) return;

  if (process.argv.includes("--force")) {
    console.log(`WARNING: ${foreign.length} rows in ${WS} were not written by this seeder, and --force was passed.`);
    console.log("         Seeding anyway. Expect a unique-constraint failure if an order number collides.");
    return;
  }

  console.error("");
  console.error(`Refusing to seed: ${WS} already holds ${foreign.length} rows this seeder did not write.`);
  console.error("");
  console.error("  " + foreign.slice(0, 8).join("\n  ") + (foreign.length > 8 ? `\n  ...and ${foreign.length - 8} more` : ""));
  console.error("");
  console.error("This looks like the real demo data set, migrated in from the JSON file.");
  console.error("This seeder writes fixed seed_* rows that collide with it on order number,");
  console.error("so it would fail part-way through and leave the database half-written.");
  console.error("");
  console.error("Nothing has been changed. If you want the demo data, it is already there.");
  console.error("If you really want seed rows in this database as well, re-run with --force.");
  process.exit(1);
}

async function main() {
  if (process.env.PERSISTENCE_PROVIDER !== "prisma") {
    console.error("This script only runs in prisma mode. Set PERSISTENCE_PROVIDER=prisma.");
    process.exit(1);
  }
  const { createRepositories } = await import("@/repositories");
  const repos = createRepositories();
  await refuseIfDataIsNotOurs(repos);
  console.log("Seeding workspace_demo in Postgres (minimal demo dataset for e2e)...");

  // MUST be first — every row below has an FK to one or both of these.
  await ensureWorkspaceAndOwner(repos);

  // 3 leads — Dashboard pipeline + CRM. Only Prisma-native fields.
  await seedLead(repos, "seed_lead_hot", {
    contactName: "Priya Sharma", companyName: "Aarna Bridal Studio",
    // N-SAFETY-2 — this seeder writes into POSTGRES, the substrate D3 ships on,
    // and its own header aims it at Neon. It previously carried three
    // structurally valid Indian mobiles (+919876543210 / +919812345678 /
    // +919900112233) and a REGISTRABLE domain (aarnabridal.in — `.in` is a live
    // TLD anyone can buy). Gate G7 exists to prove a real outbound send works,
    // so a send test against this data would have messaged strangers.
    // Unroutable by construction: an Indian mobile's subscriber part never
    // starts with 0, so +91 00000 000NN can never be assigned; `.example` is
    // RFC 2606 reserved and can never be delegated.
    whatsappNumber: "+910000000031", email: "priya@aarnabridal.example", city: "Surat",
    status: "hot_lead", reviewStatus: "approved", leadScore: 19,
    source: "whatsapp", sourceType: "whatsapp",
  });
  await seedLead(repos, "seed_lead_pending", {
    contactName: "Rajesh Kumar", companyName: "Bharat Textiles",
    whatsappNumber: "+910000000032", city: "Mumbai", // N-SAFETY-2
    status: "prospected", reviewStatus: "pending", leadScore: 11,
    source: "serpapi", sourceType: "serpapi",
  });
  await seedLead(repos, "seed_lead_dnc", {
    contactName: "Meena Patel", companyName: "Patel Fabrics",
    whatsappNumber: "+910000000033", city: "Delhi", // N-SAFETY-2
    status: "do_not_contact", reviewStatus: "rejected", doNotContact: true,
    leadScore: 4, source: "manual", sourceType: "manual",
  });

  // Clean any prior seed orders/quotes/replies attached to seed_lead_hot first.
  try { await repos.order.deleteByLead(WS, "seed_lead_hot"); } catch { /* ignore */ }
  try { await repos.reply.deleteByLead?.(WS, "seed_lead_hot"); } catch { /* ignore */ }

  // 2 orders — Commercial. OrderLineItem requires currencyCode.
  const li1 = { id: "seed_li_1", productId: "prod_gold_border_50", productName: "Gold Zari Border 50mm", quantity: 200, unit: "metre", unitPrice: 50, lineTotal: 10000, currencyCode: "INR" };
  await repos.order.create({ workspaceId: WS, id: "seed_order_1", leadId: "seed_lead_hot", status: "confirmed", lineItems: [li1], grandTotal: 10000, currencyCode: "INR", origin: "direct", confirmedAt: DAYS_AGO(3), createdAt: DAYS_AGO(4), updatedAt: DAYS_AGO(3), orderNumber: await repos.order.nextOrderNumber(WS) } as never);
  console.log("  + order seed_order_1 (₹10,000, confirmed)");

  const li2 = { id: "seed_li_2", productId: "prod_gold_border_75", productName: "Gold Zari Border 75mm", quantity: 100, unit: "metre", unitPrice: 52, lineTotal: 5200, currencyCode: "INR" };
  await repos.order.create({ workspaceId: WS, id: "seed_order_2", leadId: "seed_lead_hot", status: "delivered", lineItems: [li2], grandTotal: 5200, currencyCode: "INR", origin: "direct", confirmedAt: DAYS_AGO(15), shippedAt: DAYS_AGO(9), deliveredAt: DAYS_AGO(5), createdAt: DAYS_AGO(16), updatedAt: DAYS_AGO(5), orderNumber: await repos.order.nextOrderNumber(WS) } as never);
  console.log("  + order seed_order_2 (₹5,200, delivered)");

  // 1 quote — Commercial (on the pending lead).
  try { await repos.quote.deleteByLead(WS, "seed_lead_pending"); } catch { /* ignore */ }
  const ql1 = { id: "seed_ql_1", productId: "prod_gold_border_50", productName: "Gold Zari Border 50mm", quantity: 500, unit: "metre", unitPrice: 48, lineTotal: 24000, currencyCode: "INR" };
  await repos.quote.create({ workspaceId: WS, id: "seed_quote_1", leadId: "seed_lead_pending", status: "sent", lineItems: [ql1], grandTotal: 24000, currencyCode: "INR", createdAt: NOW, updatedAt: NOW, quoteNumber: await repos.quote.nextQuoteNumber(WS) } as never);
  console.log("  + quote seed_quote_1 (₹24,000, sent)");

  // 2 replies — Replies inbox. Only Prisma-native Reply fields.
  try { await repos.reply.deleteByLead?.(WS, "seed_lead_hot"); } catch { /* ignore */ }
  await repos.reply.create({ workspaceId: WS, leadId: "seed_lead_hot", channel: "whatsapp", rawText: "Hi, what's the price for 200m of 75mm gold border?", createdAt: NOW } as never);
  console.log("  + reply seed_reply_1 (price question from Priya)");
  await repos.reply.create({ workspaceId: WS, leadId: "seed_lead_pending", channel: "whatsapp", rawText: "Do you export to Dubai? Need 500m for a wedding collection.", createdAt: NOW } as never);
  console.log("  + reply seed_reply_2 (export question from Bharat)");

  // 2026-08-20 N-DATA-9 — a customer who has messaged you must be recorded as
  // having messaged you. In production WhatsAppConversationEngine stamps this on
  // every inbound message; the seeders never did, so the demo showed a customer's
  // WhatsApp question above a banner saying they had never written, and the CP-24
  // window gate refused every reply. Derived from the replies just created, using
  // the same rule as the JSON seeder and the backfill script.
  const seededInbound = lastInboundByLead([
    { leadId: "seed_lead_hot", channel: "whatsapp", createdAt: NOW },
    { leadId: "seed_lead_pending", channel: "whatsapp", createdAt: NOW },
  ]);
  for (const [leadId, at] of seededInbound) {
    await repos.lead.updateLead(WS, leadId, { lastInboundAt: at });
    console.log(`  + lastInboundAt on ${leadId} (${at}) — opens the 24h window the reply implies`);
  }

  // 1 AutoReplyLog — the Replies INBOX shows AI-processed reply logs (not raw
  // replies). Without one, the inbox renders its empty state and the e2e test
  // can't assert the inbox renders real data. Seed a held-for-review log so
  // the inbox has the Priya price question awaiting owner review.
  try { await repos.autoReplyLog.deleteByLead(WS, "seed_lead_hot"); } catch { /* ignore */ }
  await repos.autoReplyLog.create(WS, {
    leadId: "seed_lead_hot",
    channel: "whatsapp",
    incomingMessage: "Hi, what's the price for 200m of 75mm gold border?",
    retrievedContext: {},
    classification: "price_request",
    generatedReply: "Hi Priya! Thanks for the interest. Let me confirm the current pricing for the 75mm gold border and revert shortly.",
    canAutoSend: false,
    needsHumanReview: true,
    reason: "Price is a sensitive topic — held for owner review.",
    modelProvider: "mock",
    modelName: "mock-reply",
    modelMode: "mock",
    status: "held_for_review",
    createdAt: NOW,
    updatedAt: NOW,
  } as never);
  console.log("  + autoReplyLog (price question held for review)");

  // 1 audit log — Dashboard activity feed.
  await repos.auditLog.create({ workspaceId: WS, actorUserId: LEAD_USER, eventType: "lead.approved", entityType: "lead", entityId: "seed_lead_hot", payload: { reason: "Seeded for prod e2e." }, createdAt: NOW } as never);
  console.log("  + audit log (lead.approved)");

  console.log("\n✅ workspace_demo seeded in Postgres. The prod-prisma e2e spec now has real data to render.");
}

main().catch((e) => { console.error("SEED FAILED:", e); process.exit(1); });
