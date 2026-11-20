/**
 * Golden test — Prisma commercial parity (Stage A.1).
 *
 * Skill build-right Phase 3: written BEFORE the Prisma Order/Quote repository
 * implementations. The Prisma repos currently throw "not implemented" for
 * Order and Quote (src/repositories/prisma/index.ts:1929 + :1948). This test
 * will FAIL on first run; the failures ARE the work list. Fix the repo code
 * until green. After green, this is the permanent regression gate — a future
 * change that breaks the Prisma Order/Quote round-trip trips it instantly.
 *
 * Golden Thread rule (skill Phase 3): the SAME hand-computed numbers appear
 * here as in the JSON-layer golden:order-cancel + the math-layer OrderService
 * pure functions. Specifically:
 *
 *   Order with 10 × ₹450 line item → grandTotal = 4500
 *   Order #1 then Order #2          → atomic counter (no duplicates)
 *   Quote with same shape           → grandTotal = 4500, quoteNumber 1→2
 *   deleteByLead cascade            → returns exact count
 *   cancelledQuantityByLine         → persists + reads back (the schema drift
 *                                     fix; JSON runtime had it, Prisma didn't)
 *
 * TicketEvent + TicketSlaSettings parity (the other 2 stubs in this area):
 *
 *   TicketEvent.create               → actually persists (was returning a
 *                                       fake in-memory object with id="")
 *   TicketEvent.listByTicket         → actually reads (was returning [])
 *   TicketSlaSettings.upsert         → actually persists (was returning a
 *                                       hard-coded default with id="")
 *   TicketSlaSettings.getByWorkspace → actually reads (was returning undefined)
 *
 * WorkspaceMember parity (the missing model):
 *
 *   WorkspacePrismaRepository.listActiveStaffForWorkspace
 *                                    → actually queries the new table (was
 *                                       returning [] because no table existed)
 *
 * Hand-computed expected values:
 *
 *   ORDER 1: lineItems = [{ quantity: 10, unitPrice: 450, lineTotal: 4500 }]
 *            → grandTotal = 4500, orderNumber = 1 (first in workspace)
 *   ORDER 2: same shape
 *            → grandTotal = 4500, orderNumber = 2 (atomic increment)
 *   PARTIAL CANCEL on ORDER 1: cancel 4 of the 10 → cancelledQuantityByLine
 *            = { <lineItemId>: 4 }, persisted + readable (schema drift fix)
 *   QUOTE 1: same shape → grandTotal = 4500, quoteNumber = 1
 *   QUOTE 2: same shape → grandTotal = 4500, quoteNumber = 2
 *   DELETE-BY-LEAD (ORDER): after creating 2 orders for a lead, deleteByLead
 *            returns 2; listByLead returns []
 *   DELETE-BY-LEAD (QUOTE): same shape
 *
 * Requires: a real Postgres DATABASE_URL in .env (uses Neon). This test does
 * NOT run against JSON — JSON-side parity is already pinned by
 * golden:order-cancel + golden:repositories. The whole point of THIS test is
 * to pin the Prisma side specifically.
 *
 * Run: DATABASE_URL=<from .env> npx tsx scripts/golden/golden-prisma-commercial-parity.ts
 *
 * // PRISMA_GOLDEN — opt-in marker read by scripts/run-all-goldens.ts: this is a
 * PERSISTENCE golden that needs `.env`'s DATABASE_URL (real Postgres). The suite
 * runner does NOT force JSON for it (unlike logic goldens).
 *
 * Cleanup: uses unique IDs per run with a "gc-" prefix so old runs can be
 * swept periodically. The test cleans up its own data on success.
 */
import { createRepositories } from "../../src/repositories";
import type { RepositoryBundle } from "../../src/repositories/interfaces";
import type { Order, Ticket } from "../../src/lib/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const RUN_ID = `gc-${Date.now()}`;
const WS_ID = `${RUN_ID}-ws`;
const LEAD_ID = `${RUN_ID}-lead`;
const LEAD_ID_2 = `${RUN_ID}-lead2`;
const OTHER_LEAD_ID = `${RUN_ID}-other`;

// Hand-computed: 10 units × ₹450 each = ₹4500 line total = ₹4500 grand total.
const LINE_ITEM = {
  id: `${RUN_ID}-line`,
  productName: "Test Zari Thread",
  quantity: 10,
  unit: "kg",
  unitPrice: 450,
  currencyCode: "INR",
  lineTotal: 4500, // 10 × 450
};
const EXPECTED_GRAND_TOTAL = 4500;

async function seedWorkspace(repos: RepositoryBundle) {
  await repos.workspace.create({
    id: WS_ID,
    name: "GC Parity WS",
    industry: "Testing",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  // Two leads in this workspace (one for the main tests, one to test
  // cascade-scoping — orders belonging to OTHER_LEAD_ID must NOT be deleted
  // when we delete LEAD_ID).
  for (const leadId of [LEAD_ID, LEAD_ID_2, OTHER_LEAD_ID]) {
    await repos.lead.createLead({
      id: leadId,
      workspaceId: WS_ID,
      companyName: `Lead ${leadId}`,
      source: "golden_test",
      status: "prospected",
      reviewStatus: "pending",
      enrichmentStatus: "not_started",
      confidenceScore: 0.5,
      qualificationStatus: "mql",
      leadScore: 0,
      fitScore: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
}

async function cleanup(repos: RepositoryBundle) {
  // Best-effort cleanup. LeadRepository has deleteById (cascade drops children
  // via the FK onDelete: Cascade on Order/Quote/Ticket relations).
  for (const leadId of [LEAD_ID, LEAD_ID_2, OTHER_LEAD_ID]) {
    try { await repos.lead.deleteById(WS_ID, leadId); } catch {}
  }
  try {
    // N-TEST-3 (2026-08-18, CEO-loop session 6). This used to RENAME the
    // workspace to "GC-TO-DELETE" and leave it sitting there — the comment
    // said "workspace delete cascades", but no delete was being called,
    // because `WorkspaceRepository` had no delete when this was written. It
    // has one now (added session 6 for exactly this class of debris).
    //
    // The rename was harmless for as long as this golden never ran. On its
    // first real run — 2026-08-18, immediately after the localhost gate above
    // was re-scoped — it left `gc-…-ws | GC-TO-DELETE` and 2 orders behind in
    // the SHIP database. Measured, not hypothetical. Deleting the workspace
    // cascades through all 68 workspace-scoped relations, so anything the lead
    // deletes above missed goes with it.
    await repos.workspace.delete(WS_ID);
  } catch {}
}

async function testOrderRoundTrip(repos: RepositoryBundle) {
  console.log("  [1] Order create → getById → listByWorkspace → listByLead ...");

  // createWithNextOrderNumber is the atomic variant (read+increment+write in
  // ONE transaction). The route prefers it when present (route.ts:1993).
  // We test BOTH paths: the atomic one + the legacy nextOrderNumber+create pair.
  // Cast through unknown: the OrderRepository interface has strict input
  // types (Partial<Order> & {...}); for the test we want a loose callable
  // shape. The runtime contract is identical; this is a test-only widening.
  const orderRepo = repos.order as unknown as {
    createWithNextOrderNumber?: (input: Record<string, unknown>) => Promise<Record<string, unknown> & { id: string; orderNumber: number; grandTotal: number }>;
    nextOrderNumber: (ws: string) => Promise<number>;
    create: (input: Record<string, unknown>) => Promise<Record<string, unknown> & { id: string; orderNumber: number; grandTotal: number }>;
    getById: (ws: string, id: string) => Promise<{ id: string; grandTotal: number; orderNumber: number; cancelledQuantityByLine?: Record<string, number> } | undefined>;
    listByWorkspace: (ws: string, filters?: Record<string, unknown>) => Promise<Array<{ id: string; orderNumber: number }>>;
    listByLead: (ws: string, leadId: string) => Promise<Array<{ id: string; orderNumber: number }>>;
    update: (ws: string, id: string, data: Record<string, unknown>) => Promise<Record<string, unknown> & { id: string; cancelledQuantityByLine?: Record<string, number> }>;
    deleteByLead: (ws: string, leadId: string) => Promise<number>;
  };

  // === ORDER 1 via atomic createWithNextOrderNumber ===
  let order1;
  if (typeof orderRepo.createWithNextOrderNumber === "function") {
    order1 = await orderRepo.createWithNextOrderNumber({
      workspaceId: WS_ID,
      leadId: LEAD_ID,
      status: "draft",
      lineItems: [LINE_ITEM],
      grandTotal: EXPECTED_GRAND_TOTAL,
      currencyCode: "INR",
      origin: "direct",
    });
    console.log("    used atomic createWithNextOrderNumber");
  } else {
    const num = await orderRepo.nextOrderNumber(WS_ID);
    order1 = await orderRepo.create({
      workspaceId: WS_ID,
      leadId: LEAD_ID,
      status: "draft",
      orderNumber: num,
      lineItems: [LINE_ITEM],
      grandTotal: EXPECTED_GRAND_TOTAL,
      currencyCode: "INR",
      origin: "direct",
    });
    console.log("    used legacy nextOrderNumber + create");
  }
  assert(order1.orderNumber === 1, `Order 1 orderNumber should be 1 (first in workspace), got ${order1.orderNumber}.`);
  assert(Number(order1.grandTotal) === EXPECTED_GRAND_TOTAL, `Order 1 grandTotal should be ${EXPECTED_GRAND_TOTAL}, got ${order1.grandTotal}.`);

  // getById
  const fetched1 = await orderRepo.getById(WS_ID, order1.id);
  assert(fetched1?.id === order1.id, "Order 1 should be readable by id.");
  assert(Number(fetched1?.grandTotal) === EXPECTED_GRAND_TOTAL, `Order 1 fetched grandTotal mismatch.`);

  // === ORDER 2 — atomic counter must produce 2, not duplicate 1 ===
  let order2;
  if (typeof orderRepo.createWithNextOrderNumber === "function") {
    order2 = await orderRepo.createWithNextOrderNumber({
      workspaceId: WS_ID,
      leadId: LEAD_ID,
      status: "draft",
      lineItems: [LINE_ITEM],
      grandTotal: EXPECTED_GRAND_TOTAL,
      currencyCode: "INR",
      origin: "direct",
    });
  } else {
    const num2 = await orderRepo.nextOrderNumber(WS_ID);
    order2 = await orderRepo.create({
      workspaceId: WS_ID,
      leadId: LEAD_ID,
      status: "draft",
      orderNumber: num2,
      lineItems: [LINE_ITEM],
      grandTotal: EXPECTED_GRAND_TOTAL,
      currencyCode: "INR",
      origin: "direct",
    });
  }
  assert(order2.orderNumber === 2, `Order 2 orderNumber should be 2 (atomic increment), got ${order2.orderNumber}.`);

  // listByWorkspace — both orders appear
  const allOrders = await orderRepo.listByWorkspace(WS_ID);
  assert(allOrders.length >= 2, `listByWorkspace should return ≥2 orders, got ${allOrders.length}.`);
  assert(allOrders.some((o) => o.id === order1.id) && allOrders.some((o) => o.id === order2.id),
    "Both orders should appear in listByWorkspace.");

  // listByLead — both orders belong to LEAD_ID
  const leadOrders = await orderRepo.listByLead(WS_ID, LEAD_ID);
  assert(leadOrders.length === 2, `listByLead should return exactly 2, got ${leadOrders.length}.`);

  console.log("    OK Order round-trip (create, getById, list) — atomic number allocation works");

  // === [2] cancelledQuantityByLine schema-drift fix ===
  console.log("  [2] Order.update persists cancelledQuantityByLine (schema drift fix) ...");
  const cancelledQty: Record<string, number> = { [LINE_ITEM.id]: 4 };
  const updated = await orderRepo.update(WS_ID, order1.id, {
    status: "partial_cancelled",
    cancelledQuantityByLine: cancelledQty,
  });
  assert(updated.cancelledQuantityByLine?.[LINE_ITEM.id] === 4,
    `cancelledQuantityByLine should round-trip; got ${JSON.stringify(updated.cancelledQuantityByLine)}.`);
  // Re-fetch to prove it PERSISTED (not just returned)
  const refetched = await orderRepo.getById(WS_ID, order1.id);
  assert(refetched?.cancelledQuantityByLine?.[LINE_ITEM.id] === 4,
    `cancelledQuantityByLine should persist across read; got ${JSON.stringify(refetched?.cancelledQuantityByLine)}.`);
  console.log("    OK cancelledQuantityByLine round-trips through Prisma (was missing before Stage A.1)");

  // === [3] deleteByLead cascade + scoping ===
  console.log("  [3] Order.deleteByLead returns exact count + respects scope ...");
  // Seed 1 order on OTHER_LEAD_ID — must NOT be deleted when we delete LEAD_ID.
  if (typeof orderRepo.createWithNextOrderNumber === "function") {
    await orderRepo.createWithNextOrderNumber({
      workspaceId: WS_ID, leadId: OTHER_LEAD_ID, status: "draft",
      lineItems: [LINE_ITEM], grandTotal: EXPECTED_GRAND_TOTAL, currencyCode: "INR", origin: "direct",
    });
  }
  const deletedCount = await orderRepo.deleteByLead(WS_ID, LEAD_ID);
  assert(deletedCount === 2, `deleteByLead should return 2 (orders 1 + 2), got ${deletedCount}.`);
  const remainingForLead = await orderRepo.listByLead(WS_ID, LEAD_ID);
  assert(remainingForLead.length === 0, `listByLead after delete should be empty, got ${remainingForLead.length}.`);
  // OTHER_LEAD_ID order is untouched (cascade scoping)
  const otherStillThere = await orderRepo.listByLead(WS_ID, OTHER_LEAD_ID);
  assert(otherStillThere.length >= 1, `Other lead's order should be untouched by deleteByLead.`);
  console.log("    OK deleteByLead returns exact count + respects scope");

  return { orderRepo };
}

async function testQuoteRoundTrip(repos: RepositoryBundle) {
  console.log("  [4] Quote create → getById → list + atomic numbering ...");
  const quoteRepo = repos.quote as unknown as {
    createWithNextQuoteNumber?: (input: Record<string, unknown>) => Promise<Record<string, unknown> & { id: string; quoteNumber: number; grandTotal: number }>;
    nextQuoteNumber: (ws: string) => Promise<number>;
    create: (input: Record<string, unknown>) => Promise<Record<string, unknown> & { id: string; quoteNumber: number; grandTotal: number }>;
    getById: (ws: string, id: string) => Promise<{ id: string; grandTotal: number; quoteNumber: number } | undefined>;
    listByLead: (ws: string, leadId: string) => Promise<Array<{ id: string; quoteNumber: number }>>;
    deleteByLead: (ws: string, leadId: string) => Promise<number>;
  };

  let q1;
  if (typeof quoteRepo.createWithNextQuoteNumber === "function") {
    q1 = await quoteRepo.createWithNextQuoteNumber({
      workspaceId: WS_ID, leadId: LEAD_ID_2, status: "draft",
      lineItems: [LINE_ITEM], grandTotal: EXPECTED_GRAND_TOTAL, currencyCode: "INR",
    });
  } else {
    const n = await quoteRepo.nextQuoteNumber(WS_ID);
    q1 = await quoteRepo.create({
      workspaceId: WS_ID, leadId: LEAD_ID_2, status: "draft", quoteNumber: n,
      lineItems: [LINE_ITEM], grandTotal: EXPECTED_GRAND_TOTAL, currencyCode: "INR",
    });
  }
  assert(q1.quoteNumber === 1, `Quote 1 quoteNumber should be 1, got ${q1.quoteNumber}.`);
  assert(Number(q1.grandTotal) === EXPECTED_GRAND_TOTAL, `Quote 1 grandTotal should be ${EXPECTED_GRAND_TOTAL}, got ${q1.grandTotal}.`);

  let q2;
  if (typeof quoteRepo.createWithNextQuoteNumber === "function") {
    q2 = await quoteRepo.createWithNextQuoteNumber({
      workspaceId: WS_ID, leadId: LEAD_ID_2, status: "draft",
      lineItems: [LINE_ITEM], grandTotal: EXPECTED_GRAND_TOTAL, currencyCode: "INR",
    });
  } else {
    const n2 = await quoteRepo.nextQuoteNumber(WS_ID);
    q2 = await quoteRepo.create({
      workspaceId: WS_ID, leadId: LEAD_ID_2, status: "draft", quoteNumber: n2,
      lineItems: [LINE_ITEM], grandTotal: EXPECTED_GRAND_TOTAL, currencyCode: "INR",
    });
  }
  assert(q2.quoteNumber === 2, `Quote 2 quoteNumber should be 2, got ${q2.quoteNumber}.`);

  const fetched = await quoteRepo.getById(WS_ID, q1.id);
  assert(fetched?.id === q1.id, "Quote 1 should be readable by id.");

  const leadQuotes = await quoteRepo.listByLead(WS_ID, LEAD_ID_2);
  assert(leadQuotes.length === 2, `listByLead should return 2 quotes, got ${leadQuotes.length}.`);
  console.log("    OK Quote round-trip + atomic numbering");

  // deleteByLead
  const deleted = await quoteRepo.deleteByLead(WS_ID, LEAD_ID_2);
  assert(deleted === 2, `Quote deleteByLead should return 2, got ${deleted}.`);
  console.log("    OK Quote deleteByLead");
}

async function testTicketEventParity(repos: RepositoryBundle) {
  console.log("  [5] TicketEvent.create actually persists + listByTicket reads ...");
  // First create a ticket to attach events to.
  const ticket = await repos.ticket.create({
    workspaceId: WS_ID,
    leadId: LEAD_ID,
    type: "problem",
    priority: "high",
    subject: "GC parity ticket",
    description: "test",
    sourceChannel: "whatsapp",
    slaStartedAt: new Date().toISOString(),
    slaDueAt: new Date().toISOString(),
  });

  // The OLD stub returned a fake object with id="". The fix must persist.
  const evt = await repos.ticketEvent.create({
    workspaceId: WS_ID,
    ticketId: ticket.id,
    eventType: "created",
    actorType: "system",
    note: "created by golden test",
  });
  assert(evt.id && evt.id.length > 0, `TicketEvent.create should return a persisted id, got "${evt.id}".`);

  // The OLD stub returned []. The fix must read.
  const events = await repos.ticketEvent.listByTicket(WS_ID, ticket.id);
  assert(events.length >= 1, `TicketEvent.listByTicket should return ≥1 event, got ${events.length}.`);
  assert(events.some((e) => e.id === evt.id), "Created event should appear in listByTicket.");
  console.log("    OK TicketEvent persists + reads (was no-op stub)");
}

async function testTicketSlaSettingsParity(repos: RepositoryBundle) {
  console.log("  [6] TicketSlaSettings upsert actually persists + getByWorkspace reads ...");
  // The OLD stub returned a fake default with id="" and never persisted.
  const upserted = await repos.ticketSlaSettings.upsertForWorkspace(WS_ID, {
    clockMode: "always_24_7",
    urgentSlaMinutes: 120,
    highSlaMinutes: 240,
  });
  assert(upserted.id && upserted.id.length > 0, `TicketSlaSettings.upsert should return a persisted id, got "${upserted.id}".`);

  // The OLD stub returned undefined. The fix must read what we just wrote.
  const fetched = await repos.ticketSlaSettings.getByWorkspace(WS_ID);
  assert(fetched?.id === upserted.id, "TicketSlaSettings should round-trip id.");
  assert(fetched?.clockMode === "always_24_7", `clockMode should be always_24_7, got ${fetched?.clockMode}.`);
  assert(fetched?.urgentSlaMinutes === 120, `urgentSlaMinutes should be 120, got ${fetched?.urgentSlaMinutes}.`);
  console.log("    OK TicketSlaSettings persists + reads (was no-op stub)");
}

async function testWorkspaceMemberParity(repos: RepositoryBundle) {
  console.log("  [7] WorkspaceMember + listActiveStaffForWorkspace ...");
  // listActiveStaffForWorkspace was returning [] because there was no table.
  // After adding the WorkspaceMember model + implementing the query, it must
  // return real rows.
  const before = await repos.workspace.listActiveStaffForWorkspace(WS_ID);
  assert(Array.isArray(before), "listActiveStaffForWorkspace should return an array.");

  // Seed a user + membership row directly (mirrors what bootstrapOwner does).
  // Using mutateAll keeps this provider-agnostic.
  const userId = `${RUN_ID}-staff-user`;
  const email = `gcstaff-${RUN_ID}@example.com`;
  const now = new Date().toISOString();
  await repos.mutateAll!((data) => {
    data.users ||= [];
    if (!data.users.some((u) => u.id === userId)) {
      data.users.push({
        id: userId, workspaceId: WS_ID, name: "GC Staff", email,
        role: "sales_member", createdAt: now, updatedAt: now,
      });
    }
    data.workspaceMembers ||= [];
    if (!data.workspaceMembers.some((m) => m.userId === userId)) {
      data.workspaceMembers.push({
        id: `${RUN_ID}-member`, workspaceId: WS_ID, userId, email,
        name: "GC Staff", role: "sales_member", status: "active",
        createdAt: now, updatedAt: now,
      });
    }
    return undefined;
  });

  const after = await repos.workspace.listActiveStaffForWorkspace(WS_ID);
  assert(after.some((m) => m.userId === userId),
    `listActiveStaffForWorkspace should include our seeded member; got ${JSON.stringify(after.map((m) => m.userId))}.`);
  console.log(`    OK listActiveStaffForWorkspace returns ${after.length} active member(s) (was [] before Stage A.1)`);
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  // N-TEST-3 (2026-08-18, CEO-loop session 6) — RE-SCOPED, and this is the
  // second half of that finding.
  //
  // WHAT IT USED TO SAY. `if (!dbUrl || dbUrl.includes("localhost") || …)` →
  // print SKIP, exit 0. Written on 2026-07-28 (D-9) when the product ran on a
  // remote Neon database and "localhost" meant somebody's throwaway.
  //
  // WHY THAT IS NOW WRONG. Under decision **D3** the product ships on Postgres,
  // and under **D7** no hosted database is coming — the ship database is the
  // local Docker Postgres at `localhost:55432`. So the one condition this
  // golden used to detect a fake database now detects the REAL one. Result: it
  // has never run since the substrate changed. It refused, exited 0, and the
  // suite runner counted it as a pass in the "on Postgres" column — the exact
  // opposite of what it was written to prove. Measured 2026-08-18: 150/150
  // green with this golden among the five "on Postgres", none of which was
  // actually true of this one.
  //
  // WHAT IT SAYS NOW. Run against any real Postgres. The gate is only about
  // whether a database exists to talk to; which one it is, is the operator's
  // call and `DATABASE_URL` is how they make it. A skip is still exit 0 — the
  // runner now reports declared skips in their own category rather than as
  // passes (N-TEST-3, first half), so an honest opt-out no longer needs to
  // disguise itself as evidence.
  if (!dbUrl || !/^postgres(ql)?:\/\//.test(dbUrl)) {
    console.log("SKIP: golden-prisma-commercial-parity needs a real Postgres in DATABASE_URL and there is none set.");
    console.log("      Start the ship database (`docker start leadgen-pg`) or point DATABASE_URL at a running Postgres.");
    console.log("      JSON-side commercial parity is covered by golden:order-cancel + golden:repositories (both run unconditionally).");
    process.exit(0);
  }

  console.log(`golden-prisma-commercial-parity (run ${RUN_ID})`);
  console.log("Connecting via createRepositories(\"prisma\")...\n");
  const repos = createRepositories("prisma");

  try {
    await seedWorkspace(repos);
    await testOrderRoundTrip(repos);
    await testQuoteRoundTrip(repos);
    await testTicketEventParity(repos);
    await testTicketSlaSettingsParity(repos);
    await testWorkspaceMemberParity(repos);
    await testReadAllCompleteness(repos);
    console.log("\nPASS golden-prisma-commercial-parity: all 8 cases match.");
    console.log("  Order + Quote: round-trip + atomic numbering + deleteByLead + cancelledQuantityByLine");
    console.log("  TicketEvent + TicketSlaSettings: persist + read (was no-op stubs)");
    console.log("  WorkspaceMember: listActiveStaffForWorkspace reads the new table");
    console.log("  readAll completeness: snapshot returns Order + TicketEvent + 11+ other collections (P0-3)");
  } finally {
    await cleanup(repos);
  }
}

/**
 * 2026-07-26 Session 4 audit fix (P0-3) — readAll() snapshot completeness.
 *
 * The audit found that Prisma's readAll() silently dropped 11+ collections:
 * orders, quotes, tickets, ticketEvents, ticketSlaSettings, autoReplyLogs,
 * salesSettings, productSettings, policySettings, communicationSettings,
 * settingsConflicts, pendingSettingsDrafts, escalationRules. The
 * `/api/data/export` endpoint then returned 200 OK with `orders: []` etc.
 * — silently corrupting the operator's backup.
 *
 * This test seeds one Order + one TicketEvent via the per-collection repos,
 * then calls readAll() and asserts both appear in the snapshot. Pre-fix the
 * assertion fails (orders/ticketEvents arrays are missing entirely from the
 * snapshot — the `by` helper in scopeDataForExport returns [] for undefined).
 */
async function testReadAllCompleteness(repos: RepositoryBundle) {
  console.log("  [7] readAll() snapshot includes all collections (P0-3 regression)...");
  // Seed one Order + one TicketEvent via the per-collection repos. Use LEAD_ID
  // (already seeded by seedWorkspace) so the FK constraint passes. Use plain
  // `create` with an explicit orderNumber (the atomic createWithNextOrderNumber
  // exists on both repos but isn't on the interface — keep the test simple).
  const order = await repos.order.create({
    workspaceId: WS_ID,
    leadId: LEAD_ID,
    orderNumber: 999, // arbitrary; this test isn't checking number allocation
    status: "confirmed" as Order["status"],
    lineItems: [{ id: "li_readall", productName: "Test", quantity: 1, unitPrice: 100, lineTotal: 100, currencyCode: "INR" }],
    grandTotal: 100,
    currencyCode: "INR",
    origin: "manual" as Order["origin"],
  } as never);
  const ticket = await repos.ticket.create({
    workspaceId: WS_ID,
    leadId: LEAD_ID,
    ticketNumber: 999, // arbitrary; this test isn't checking number allocation
    sourceChannel: "whatsapp",
    type: "question",
    priority: "medium",
    status: "open",
    subject: "readAll completeness test",
    description: "ticket to attach an event to",
    sourceEntityType: "inbound",
  });
  await repos.ticketEvent.create({
    workspaceId: WS_ID,
    ticketId: ticket.id,
    eventType: "created",
    actorType: "system",
    note: "test event for readAll completeness",
  });

  // Call readAll() — this is the function under test.
  const snapshot = await repos.readAll!();

  // Assertion 1: orders array exists AND includes our seeded order.
  assert(Array.isArray(snapshot.orders), `readAll must return orders as an array; got ${typeof snapshot.orders}`);
  assert(
    (snapshot.orders as Order[]).some((o) => o.id === order.id),
    `readAll().orders must include the seeded order ${order.id}; got ${JSON.stringify((snapshot.orders as Order[]).map((o) => o.id))}`,
  );

  // Assertion 2: ticketEvents array exists AND includes our seeded event.
  assert(Array.isArray(snapshot.ticketEvents), `readAll must return ticketEvents as an array; got ${typeof snapshot.ticketEvents}`);
  assert(
    (snapshot.ticketEvents as Array<{ ticketId: string }>).some((e) => e.ticketId === ticket.id),
    `readAll().ticketEvents must include the seeded event for ticket ${ticket.id}`,
  );

  // Assertion 3: tickets array exists AND includes our seeded ticket.
  assert(Array.isArray(snapshot.tickets), `readAll must return tickets as an array; got ${typeof snapshot.tickets}`);
  assert(
    (snapshot.tickets as Ticket[]).some((t) => t.id === ticket.id),
    `readAll().tickets must include the seeded ticket ${ticket.id}`,
  );

  // Assertion 4: the 11+ collections the audit identified as missing must
  // all be PRESENT in the snapshot (even if empty for this test workspace).
  // Pre-fix these were `undefined`; the silent `(arr || [])` in
  // scopeDataForExport returned []. Post-fix they must all be arrays.
  const requiredCollections = [
    "orders", "quotes", "tickets", "ticketEvents", "ticketSlaSettings",
    "autoReplyLogs", "salesSettings", "productSettings", "policySettings",
    "communicationSettings", "settingsConflicts", "pendingSettingsDrafts",
    "escalationRules",
  ] as const;
  for (const key of requiredCollections) {
    assert(
      Array.isArray((snapshot as Record<string, unknown>)[key]),
      `readAll().${key} must be an array (P0-3); got ${typeof (snapshot as Record<string, unknown>)[key]}`,
    );
  }
  console.log(`    OK readAll returns all 13 required collections including the seeded order + ticket + event`);
}

main().catch((error) => {
  console.error("\ngolden-prisma-commercial-parity FAILED:", error instanceof Error ? error.message : error);
  console.error(error instanceof Error ? error.stack : "");
  process.exit(1);
});
