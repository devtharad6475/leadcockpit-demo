/**
 * Golden test — Voice-of-Customer analysis (the demand/confusion report).
 *
 * Phase 1.5 / skill v2 / build-right Phase 3 — written BEFORE the service code.
 * This test DEFINES the contract that VoiceOfCustomerService must satisfy.
 *
 * What this proves (the rules in docs/LOGIC.md CP-12):
 *
 *   CASE A — Deterministic topic counts are hand-computed and exact (the Golden
 *     Thread). Given a known set of customer messages + leads + orders, the
 *     aggregation MUST produce these hand-computed numbers:
 *       5 messages mention "gold border" → topic "gold border" count = 5
 *       3 messages mention "red zari"   → topic "red zari"   count = 3
 *       Topics are sorted DESC by count (highest demand first).
 *     The AI layer sits ON TOP of these counts (mocked here); the COUNTS are
 *     pure + deterministic, so this is the proof the math is right.
 *
 *   CASE B — The "what are people asking for?" report renders a ranked list
 *     (highest-demand topic first), with the count next to each. The owner sees
 *     the signal, not raw messages.
 *
 *   CASE C — No-hallucination (CP-12d): with FEWER THAN 3 customer messages,
 *     the analysis refuses to draw a conclusion ("not enough data to tell yet")
 *     instead of inventing a trend. It never fabricates demand.
 *
 *   CASE D — "Demand for something we don't make": the analysis flags a topic
 *     that appears in customer messages but is NOT in the owner's
 *     ProductSettings — surfaced as an "emerging demand" signal.
 *
 *   CASE E — Workspace isolation (CP-12e): the analysis only reads ONE
 *     workspace's data. A message in workspace B must NOT appear in workspace
 *     A's report. (Cross-tenant leak = P0.)
 *
 *   CASE F — Lead + order signal included: the report's data source is the FULL
 *     picture (messages + leads + orders), not messages-only (CP-12a). An order
 *     for a product counts toward that product's demand; a lead's industry
 *     counts toward the "who's asking" breakdown.
 *
 * Test isolation (Gate #8): each case uses its OWN unique workspace ID
 * (ws_voc_*). The golden preload pins each run to a process-unique
 * LEADGEN_DATA_DIR, so cases never share state.
 *
 * Run: npm run golden:copilot-voice-of-customer
 *      npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-copilot-voice-of-customer.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { analyzeVoiceOfCustomer } from "@/services/VoiceOfCustomerService";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function seedWorkspace(repos: RepositoryBundle, workspaceId: string) {
  await repos.workspace.create({ id: workspaceId, name: `Test WS ${workspaceId}`, status: "active" });
}

/** Seed a customer reply message on a lead. */
async function seedMessage(repos: RepositoryBundle, ws: string, leadId: string, text: string, classification?: string) {
  await repos.reply.create({ workspaceId: ws, leadId, channel: "whatsapp", rawText: text, classification });
}

async function main() {
  const repos = await createJsonRepos();

  // ─── CASE A: deterministic topic counts are exact (Golden Thread) ──────────
  // Hand-computed BEFORE writing the service:
  //   Messages:  "need gold border" / "gold border price?" / "gold border 50mm?"
  //              / "want gold border bulk" / "gold border urgent"   → 5 × "gold border"
  //              "red zari available?" / "red zari" / "red zari sample"   → 3 × "red zari"
  //   Expected: gold border = 5 (rank 1), red zari = 3 (rank 2). Sorted DESC.
  {
    const WS = "ws_voc_a";
    await seedWorkspace(repos, WS);
    const lead = await repos.lead.createLead({ workspaceId: WS, companyName: "L1", source: "manual", status: "approved", reviewStatus: "approved", enrichmentStatus: "completed" });
    for (const t of ["need gold border", "gold border price?", "gold border 50mm?", "want gold border bulk", "gold border urgent"]) {
      await seedMessage(repos, WS, lead.id, t);
    }
    for (const t of ["red zari available?", "red zari", "red zari sample"]) {
      await seedMessage(repos, WS, lead.id, t);
    }
    const report = await analyzeVoiceOfCustomer(WS, repos);
    const gold = report.topics.find((t) => /gold border/i.test(t.label));
    const red = report.topics.find((t) => /red zari/i.test(t.label));
    assert(gold && gold.count === 5, `CASE A: "gold border" count must be 5, got ${gold?.count}`);
    assert(red && red.count === 3, `CASE A: "red zari" count must be 3, got ${red?.count}`);
    // Sorted DESC: gold border (5) before red zari (3).
    const goldIdx = report.topics.findIndex((t) => /gold border/i.test(t.label));
    const redIdx = report.topics.findIndex((t) => /red zari/i.test(t.label));
    assert(goldIdx < redIdx, `CASE A: topics sorted DESC (gold border rank ${goldIdx} < red zari rank ${redIdx})`);
    console.log(`  OK CASE A — topic counts exact: gold border=5, red zari=3, sorted DESC (Golden Thread)`);
  }

  // ─── CASE B: the report renders a ranked list (highest demand first) ───────
  {
    const WS = "ws_voc_b";
    await seedWorkspace(repos, WS);
    const lead = await repos.lead.createLead({ workspaceId: WS, companyName: "L2", source: "manual", status: "approved", reviewStatus: "approved", enrichmentStatus: "completed" });
    await seedMessage(repos, WS, lead.id, "silk border please");
    await seedMessage(repos, WS, lead.id, "silk border quote");
    await seedMessage(repos, WS, lead.id, "cotton border");
    const report = await analyzeVoiceOfCustomer(WS, repos);
    assert(report.topics.length >= 1, `CASE B: report must have ≥1 topic, got ${report.topics.length}`);
    assert(report.topics[0].count >= report.topics[report.topics.length - 1].count, "CASE B: first topic must have the highest count (ranked)");
    // The summary is a readable string (what the owner sees in chat).
    assert(typeof report.summary === "string" && report.summary.length > 0, "CASE B: report must have a readable summary");
    console.log(`  OK CASE B — report renders ${report.topics.length} ranked topic(s), summary present`);
  }

  // ─── CASE C: no-hallucination — too few messages → "not enough data" ───────
  // CP-12d: with < 3 messages, refuse to conclude instead of inventing a trend.
  {
    const WS = "ws_voc_c";
    await seedWorkspace(repos, WS);
    const lead = await repos.lead.createLead({ workspaceId: WS, companyName: "L3", source: "manual", status: "approved", reviewStatus: "approved", enrichmentStatus: "completed" });
    await seedMessage(repos, WS, lead.id, "hi"); // only 1 message
    const report = await analyzeVoiceOfCustomer(WS, repos);
    assert(report.insufficientData === true, `CASE C: <3 messages must flag insufficientData, got ${report.insufficientData}`);
    assert(/not enough|too few|insufficient/i.test(report.summary), `CASE C: summary must say "not enough data", got: ${report.summary}`);
    console.log("  OK CASE C — <3 messages → honest 'not enough data' (no invented trend, CP-12d)");
  }

  // ─── CASE D: emerging demand — topic NOT in ProductSettings flagged ────────
  {
    const WS = "ws_voc_d";
    await seedWorkspace(repos, WS);
    // Owner sells "gold border" only.
    await repos.productSettings.upsertForWorkspace(WS, {
      products: [{ id: "ps_gb", name: "Gold Border", price: 45, currencyCode: "INR", unit: "metre" }],
    } as never);
    const lead = await repos.lead.createLead({ workspaceId: WS, companyName: "L4", source: "manual", status: "approved", reviewStatus: "approved", enrichmentStatus: "completed" });
    // Customers ask for "sequin border" — NOT in the catalog.
    await seedMessage(repos, WS, lead.id, "do you have sequin border?");
    await seedMessage(repos, WS, lead.id, "sequin border please");
    await seedMessage(repos, WS, lead.id, "sequin border sample");
    const report = await analyzeVoiceOfCustomer(WS, repos);
    const sequin = report.topics.find((t) => /sequin/i.test(t.label));
    assert(sequin, "CASE D: 'sequin border' must appear as a topic");
    assert(sequin?.isEmergingDemand === true, `CASE D: a topic NOT in ProductSettings must be flagged isEmergingDemand, got ${sequin?.isEmergingDemand}`);
    console.log("  OK CASE D — 'sequin border' (not in catalog) flagged as emerging demand");
  }

  // ─── CASE E: workspace isolation — no cross-tenant leak (P0) ───────────────
  {
    const WS_A = "ws_voc_e_a";
    const WS_B = "ws_voc_e_b";
    await seedWorkspace(repos, WS_A);
    await seedWorkspace(repos, WS_B);
    const leadA = await repos.lead.createLead({ workspaceId: WS_A, companyName: "LA", source: "manual", status: "approved", reviewStatus: "approved", enrichmentStatus: "completed" });
    const leadB = await repos.lead.createLead({ workspaceId: WS_B, companyName: "LB", source: "manual", status: "approved", reviewStatus: "approved", enrichmentStatus: "completed" });
    await seedMessage(repos, WS_A, leadA.id, "workspace A secret product AAA");
    await seedMessage(repos, WS_A, leadA.id, "AAA again");
    await seedMessage(repos, WS_A, leadA.id, "AAA third");
    await seedMessage(repos, WS_B, leadB.id, "workspace B secret product BBB");
    await seedMessage(repos, WS_B, leadB.id, "BBB again");
    await seedMessage(repos, WS_B, leadB.id, "BBB third");
    const reportA = await analyzeVoiceOfCustomer(WS_A, repos);
    const reportB = await analyzeVoiceOfCustomer(WS_B, repos);
    assert(!reportA.topics.some((t) => /BBB/i.test(t.label)), "CASE E: workspace A must NOT see workspace B's 'BBB' (P0 isolation)");
    assert(!reportB.topics.some((t) => /AAA/i.test(t.label)), "CASE E: workspace B must NOT see workspace A's 'AAA' (P0 isolation)");
    assert(reportA.topics.some((t) => /AAA/i.test(t.label)), "CASE E: workspace A sees its own 'AAA'");
    console.log("  OK CASE E — workspace isolation: A sees AAA, B sees BBB, no leak (P0)");
  }

  // ─── CASE F: lead + order signal included (full picture, CP-12a) ───────────
  {
    const WS = "ws_voc_f";
    await seedWorkspace(repos, WS);
    const lead = await repos.lead.createLead({ workspaceId: WS, companyName: "L5", source: "manual", status: "approved", reviewStatus: "approved", enrichmentStatus: "completed", industry: "garment", buyerType: "manufacturer" });
    // 2 messages (below the 3-msg rule alone) + 1 order for the same product.
    await seedMessage(repos, WS, lead.id, "velvet border quote");
    await seedMessage(repos, WS, lead.id, "velvet border again");
    await repos.order.create({
      workspaceId: WS, leadId: lead.id, status: "confirmed", origin: "direct",
      lineItems: [{ id: "li1", productName: "Velvet Border", quantity: 100, unit: "metre", unitPrice: 60, currencyCode: "INR", lineTotal: 6000 }],
      grandTotal: 6000, currencyCode: "INR",
    });
    const report = await analyzeVoiceOfCustomer(WS, repos);
    // The order contributes to the velvet-border signal, so the topic appears
    // even though messages alone were below the threshold.
    const velvet = report.topics.find((t) => /velvet/i.test(t.label));
    assert(velvet, `CASE F: order signal must contribute — 'velvet border' topic must appear, got topics: ${report.topics.map((t) => t.label).join(", ")}`);
    // The report includes a "who's asking" breakdown (lead industry/buyerType).
    assert(report.buyerBreakdown !== undefined, "CASE F: report must include a buyer breakdown (lead signal)");
    console.log("  OK CASE F — order + lead signal included in demand (full picture, CP-12a)");
  }

  console.log("\nPASS golden-copilot-voice-of-customer: Voice-of-Customer analysis contract holds.");
  console.log("  Deterministic counts exact (A). Ranked report (B). No-hallucination <3 msgs (C).");
  console.log("  Emerging demand flagged (D). Workspace isolation (E). Lead+order signal (F).");
  process.exit(0);
}

main().catch((e) => {
  console.error("golden-copilot-voice-of-customer FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
