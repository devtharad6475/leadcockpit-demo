/**
 * Golden test — createLead must not silently drop fields (N-DATA-7).
 *
 * WHY THIS EXISTS (2026-08-20)
 * ----------------------------
 * The JSON substrate builds every new lead through `normalizeLead()`, an
 * EXPLICIT field whitelist. The Prisma substrate builds one through
 * `leadData()`, which spreads `...rest` — i.e. it carries whatever it is given.
 * The two therefore drift in one direction only: a field added to the `Lead`
 * type is automatically persisted by Postgres and silently discarded by JSON.
 *
 * That had already happened to three fields:
 *
 *   - `relevancyReason` — the AI's stated reason this lead is worth contacting
 *   - `discoveredInfo`  — what the crawler actually found about the company
 *   - `lastInboundAt`   — the timestamp the 24-hour WhatsApp window is computed from
 *
 * It was not theoretical. `ProspectingService` builds its create payload as
 * `{ ...qualified, … }`, and `qualified` sets `relevancyReason` (line ~368) and
 * carries `discoveredInfo` from the candidate (lines ~466/498/518). So on the
 * JSON substrate every prospected lead was created WITHOUT its evidence, while
 * the identical run on Postgres kept it. Downstream,
 * `LeadAgentActionPlanService` reads `lead.relevancyReason` and
 * `LeadEnrichmentService` appends to `lead.discoveredInfo` — so the operator
 * saw a lead with no reason and an empty enrichment history and had no way to
 * tell that anything had been lost.
 *
 * `golden-substrate-parity` did not catch it because it probes four hand-picked
 * lead fields (companyName, city, confidenceScore, qualificationStatus). Hand-
 * picked lists are exactly what drifts. CASE A below is therefore STATIC and
 * exhaustive: it reads the `Lead` type and the `normalizeLead()` body out of
 * the source and fails if the type has a field the whitelist does not set. A
 * future agent who adds a field to `Lead` and forgets the JSON writer gets a
 * failing golden instead of a silent data loss.
 *
 *   CASE A — every field on the `Lead` type is set by `normalizeLead()`, except
 *     the documented allowlist below. Static source check, no I/O.
 *
 *   CASE B — behavioural round-trip: creating a lead that carries all three
 *     previously-dropped fields returns them AND they survive a reload from
 *     storage (create → getLeadById). Hand-computed expectations, so a writer
 *     that "returns but doesn't persist" also fails.
 *
 *   CASE C — the regression in its production shape: a payload built the way
 *     ProspectingService builds one (`{...qualified}`) keeps its evidence.
 *
 * ALLOWLIST — `billingAddress` and `shippingAddress` are deliberately NOT
 * persisted. They exist on the `Lead` TYPE and nowhere else: no Postgres column
 * in prisma/schema.prisma, no writer, no reader anywhere in src/ or scripts/.
 * Adding them to the JSON whitelist would create the mirror-image bug (a field
 * JSON keeps and Postgres cannot store). They are dead type surface and are
 * tracked for removal rather than papered over here.
 *
 * Test isolation (Gate #8): own workspace id (ws_leadfid_*), JSON substrate.
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts \
 *        scripts/golden/golden-lead-create-field-fidelity.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { readSource } from "./_helpers/read-source";
import { createJsonRepos } from "./_helpers/provider";
import type { Lead } from "@/lib/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

/** Fields on the Lead type that JSON must NOT persist — see ALLOWLIST above. */
const DEAD_TYPE_FIELDS = new Set(["billingAddress", "shippingAddress"]);

function leadTypeFields(): string[] {
  const src = readSource("src/lib/types.ts");
  const match = src.match(/export type Lead = \{([\s\S]*?)\n\};/) || src.match(/export interface Lead \{([\s\S]*?)\n\}/);
  assert(match, "could not locate the Lead type in src/lib/types.ts — this golden's source parse needs updating");
  return [...match[1].matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
}

function normalizeLeadFields(): string[] {
  const src = readSource("src/repositories/json/index.ts");
  const match = src.match(/function normalizeLead\(input: Partial<Lead>\): Lead \{\n {2}return \{([\s\S]*?)\n {2}\};/);
  assert(match, "could not locate normalizeLead() in src/repositories/json/index.ts — this golden's source parse needs updating");
  return [...match[1].matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]);
}

async function main() {
  // ─── CASE A: no Lead field may be missing from the JSON whitelist ──────────
  {
    const typeFields = leadTypeFields();
    const writerFields = new Set(normalizeLeadFields());
    assert(typeFields.length > 20, `CASE A: parsed only ${typeFields.length} Lead fields — the source parse is broken, not the code`);

    const dropped = typeFields.filter((f) => !writerFields.has(f) && !DEAD_TYPE_FIELDS.has(f));
    assert(
      dropped.length === 0,
      `CASE A: normalizeLead() silently drops ${dropped.length} field(s) that exist on the Lead type: [${dropped.join(", ")}]. ` +
      `Prisma keeps them (leadData spreads ...rest), so a lead created on JSON loses data a lead created on Postgres keeps. ` +
      `Add each field to normalizeLead(), or — if it must never be persisted — add it to DEAD_TYPE_FIELDS in this golden WITH a reason.`,
    );
    // The allowlist must stay honest: an entry that IS handled is stale.
    for (const dead of DEAD_TYPE_FIELDS) {
      assert(!writerFields.has(dead), `CASE A: "${dead}" is on the dead-field allowlist but normalizeLead() now sets it — remove it from DEAD_TYPE_FIELDS`);
    }
    console.log(`✅ CASE A — all ${typeFields.length} Lead fields are written by normalizeLead (allowlisted as dead: ${[...DEAD_TYPE_FIELDS].join(", ")})`);
  }

  const repos = createJsonRepos();

  // ─── CASE B: the three previously-dropped fields survive a round-trip ──────
  {
    const WS = "ws_leadfid_b";
    await repos.workspace.create({ id: WS, name: "Lead fidelity", status: "active" });
    const lastInboundAt = "2026-08-19T10:00:00.000Z";
    const created = await repos.lead.createLead({
      workspaceId: WS,
      companyName: "Meridian Cold Storage",
      contactName: "Ops Head",
      source: "serpapi_google_maps",
      discoveredInfo: "Cold storage operator | Rating: 4.3 | 2 warehouses listed",
      relevancyReason: "Runs refrigerated warehousing, which is the exact buyer profile for the compressor line.",
      lastInboundAt,
    });

    assert(created.discoveredInfo?.startsWith("Cold storage operator"), `CASE B: createLead RETURNS discoveredInfo, got ${JSON.stringify(created.discoveredInfo)}`);
    assert(created.relevancyReason?.startsWith("Runs refrigerated"), `CASE B: createLead RETURNS relevancyReason, got ${JSON.stringify(created.relevancyReason)}`);
    assert(created.lastInboundAt === lastInboundAt, `CASE B: createLead RETURNS lastInboundAt, got ${JSON.stringify(created.lastInboundAt)}`);

    // Returning is not persisting. Read it back out of storage.
    const reloaded = await repos.lead.getLeadById(WS, created.id);
    assert(reloaded, "CASE B: the lead must be readable back");
    assert(reloaded.discoveredInfo === created.discoveredInfo, `CASE B: discoveredInfo must SURVIVE storage, got ${JSON.stringify(reloaded.discoveredInfo)}`);
    assert(reloaded.relevancyReason === created.relevancyReason, `CASE B: relevancyReason must SURVIVE storage, got ${JSON.stringify(reloaded.relevancyReason)}`);
    assert(reloaded.lastInboundAt === lastInboundAt, `CASE B: lastInboundAt must SURVIVE storage, got ${JSON.stringify(reloaded.lastInboundAt)}`);
    console.log("✅ CASE B — discoveredInfo, relevancyReason and lastInboundAt survive create → reload on the JSON substrate");
  }

  // ─── CASE C: the exact production shape that lost the data ────────────────
  {
    const WS = "ws_leadfid_c";
    await repos.workspace.create({ id: WS, name: "Lead fidelity C", status: "active" });

    // This mirrors ProspectingService: a `qualified` candidate object is spread
    // into the create payload. The evidence fields ride in on the spread — they
    // are never named at the call site, which is why their loss was invisible.
    const qualified: Partial<Lead> = {
      companyName: "Harbour Foods Pvt Ltd",
      contactName: "Purchase Manager",
      buyerType: "distributor",
      discoveredInfo: "Food distributor | Rating: 4.1 | Cold chain mentioned on site",
      relevancyReason: "Distributes chilled foods and lists cold-chain handling, matching the ICP's likely need.",
      fitReason: "Distributes chilled foods and lists cold-chain handling, matching the ICP's likely need.",
      confidenceScore: 0.61,
    };
    const lead = await repos.lead.createLead({
      ...qualified,
      workspaceId: WS,
      status: "needs_review",
      reviewStatus: "pending",
      enrichmentStatus: "not_started",
      consentStatus: "none",
    });

    const reloaded = await repos.lead.getLeadById(WS, lead.id);
    assert(reloaded?.relevancyReason === qualified.relevancyReason,
      `CASE C: a prospected lead must keep the AI's stated reason, got ${JSON.stringify(reloaded?.relevancyReason)}`);
    assert(reloaded?.discoveredInfo === qualified.discoveredInfo,
      `CASE C: a prospected lead must keep what the crawler found, got ${JSON.stringify(reloaded?.discoveredInfo)}`);
    console.log("✅ CASE C — a ProspectingService-shaped payload keeps its evidence through create → reload");
  }

  console.log("\n✅✅✅ All lead create-field-fidelity golden cases PASSED (A–C). ✅✅✅");
}

main().catch((err) => {
  console.error("\n❌ GOLDEN FAILED:", err);
  process.exit(1);
});
