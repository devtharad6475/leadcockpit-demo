/**
 * golden-lead-enrichment.ts — LeadEnrichmentService.copyIfMissing pin (NEW, 2026-07-27).
 *
 * WHY THIS TEST EXISTS:
 *   LeadEnrichmentService had NO golden test. The load-bearing rule is the
 *   AGENTS.md "higher-priority never silently overwritten" rule, implemented
 *   by the private copyIfMissing helper: enrichment may FILL a missing field,
 *   but it must NEVER overwrite a value the owner already stamped. A silent
 *   overwrite here means a public-scraped phone/email replaces the owner's
 *   verified contact detail → the operator dials a wrong number a customer
 *   never gave. copyIfMissing is private, so we pin it through the public
 *   enrichLead entrypoint by passing explicit candidates.
 *
 * HAND-COMPUTED CONTRACT (the anti-cheat — these are the rules, not the code):
 *
 *   CASE A — owner-stamped fields are NOT overwritten by enrichment.
 *     Lead has email="owner@example.com" (stamped by the owner). Candidate
 *     offers email=" scraped@example.com". Hand-computed: after enrichLead,
 *     lead.email === "owner@example.com" (PRESERVED), and "email" is NOT in
 *     fieldsAdded. This is the load-bearing copyIfMissing rule. If the helper
 *     ever copies unconditionally, the scraped value wins → silent overwrite.
 *
 *   CASE B — missing fields ARE filled from the candidate (the happy path).
 *     Lead has no email / phone / whatsappNumber. Candidate offers all three.
 *     Hand-computed: after enrichLead, all three are populated from the
 *     candidate, and fieldsAdded contains "email", "phone", "whatsappNumber".
 *     This proves copyIfMissing isn't over-conservative (it does fill gaps).
 *
 *   CASE C — a candidate field that is an EMPTY string does NOT clobber an
 *     existing value (and is not counted as added). copyIfMissing's guard is
 *     `typeof value === "string" && value.trim()` — empty/whitespace fails.
 *     Lead has email="owner@example.com". Candidate offers email="   ".
 *     Hand-computed: lead.email === "owner@example.com" (PRESERVED).
 *
 *   CASE D — ambiguous enrichment (multiple candidates, no clear winner) does
 *     NOT modify contact details at all. decideBestCandidate returns
 *     status="ambiguous" when there are 2+ close matches; the patch then only
 *     sets enrichmentResult, leaving email/phone/etc untouched. Hand-computed:
 *     a lead with email="owner@example.com" + 2 candidates → status="ambiguous",
 *     fieldsAdded=[], lead.email unchanged.
 *
 *   CASE E — a no-results enrichment (no candidates) sets status="no_results"
 *     and leaves contact details unchanged. Hand-computed: fieldsAdded=[],
 *     enrichmentStatus="completed", enrichmentResult.status="no_results".
 *
 * REAL PIPELINE: imports the real enrichLead + the real JSON repo. Each case
 * passes explicit candidates so the service does NOT call findCandidates
 * (which would hit the network). Each case uses a unique timestamped workspace.
 *
 * Run: `npm run golden:lead-enrichment`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { enrichLead, type LeadEnrichmentCandidate } from "@/services/LeadEnrichmentService";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { Lead } from "@/lib/types";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

function caseWorkspace(slug: string): string {
  return `ws_golden_enrich_${slug}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

// A candidate that matches the lead strongly enough to be "matched" (not
// ambiguous). scoreCandidate gives +50 when website domains overlap, so we
// reuse the lead's own website on the candidate to guarantee a high score.
async function seedEnrichableLead(repos: RepositoryBundle, ws: string, overrides: Partial<Lead> = {}): Promise<Lead> {
  return repos.lead.createLead({
    workspaceId: ws,
    companyName: "Bharat Textiles",
    websiteUrl: "https://bharat-textiles.example.com",
    city: "Surat",
    industry: "textiles",
    buyerType: "wholesaler",
    status: "approved",
    reviewStatus: "approved",
    enrichmentStatus: "not_started",
    confidenceScore: 0.7,
    leadScore: 60,
    fitScore: 4,
    needScore: 4,
    reachabilityScore: 4,
    timingScore: 3,
    doNotContact: false,
    ...overrides,
  } as Partial<Lead>);
}

function matchingCandidate(ws: string, overrides: Partial<LeadEnrichmentCandidate> = {}): LeadEnrichmentCandidate {
  return {
    companyName: "Bharat Textiles",
    websiteUrl: "https://bharat-textiles.example.com",
    sourceUrl: "https://bharat-textiles.example.com",
    source: "serpapi_google_maps",
    city: "Surat",
    industry: "textiles",
    buyerType: "wholesaler",
    ...overrides,
  };
}

// --- CASE A: owner-stamped fields NOT overwritten ------------------------------
test("CASE A — owner-stamped email/phone are NOT overwritten by enrichment (copyIfMissing rule)", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("A");
  const lead = await seedEnrichableLead(repos, WS, {
    email: "owner@example.com",
    phone: "+919999900000",
    whatsappNumber: "+919999900000",
  });

  // Candidate offers CONFLICTING values for the owner-stamped fields.
  const result = await enrichLead(WS, lead.id, {
    candidates: [matchingCandidate(WS, {
      email: "scraped@example.com",
      phone: "+918888800000",
      whatsappNumber: "+918888800000",
    })],
  }, repos);

  assert.strictEqual(result.status, "matched", "single strong candidate → matched");
  // THE load-bearing assertion: owner-stamped values preserved.
  assert.strictEqual(result.lead.email, "owner@example.com", "owner email PRESERVED (not overwritten by scraped)");
  assert.strictEqual(result.lead.phone, "+919999900000", "owner phone PRESERVED (not overwritten by scraped)");
  assert.strictEqual(result.lead.whatsappNumber, "+919999900000", "owner whatsappNumber PRESERVED");
  // And fieldsAdded must NOT include the owner-stamped fields.
  assert.ok(!result.fieldsAdded.includes("email"), "email not in fieldsAdded (was already set)");
  assert.ok(!result.fieldsAdded.includes("phone"), "phone not in fieldsAdded (was already set)");
  assert.ok(!result.fieldsAdded.includes("whatsappNumber"), "whatsappNumber not in fieldsAdded");
});

// --- CASE B: missing fields ARE filled -----------------------------------------
test("CASE B — missing fields ARE filled from the candidate (the copyIfMissing happy path)", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("B");
  // Lead has NO email/phone/whatsappNumber — all missing.
  const lead = await seedEnrichableLead(repos, WS, {
    email: undefined, phone: undefined, whatsappNumber: undefined,
  });

  const result = await enrichLead(WS, lead.id, {
    candidates: [matchingCandidate(WS, {
      email: "info@bharat-textiles.example.com",
      phone: "+917777770001",
      whatsappNumber: "+917777770001",
      linkedinUrl: "https://linkedin.com/bharat",
    })],
  }, repos);

  assert.strictEqual(result.status, "matched", "single strong candidate → matched");
  // Hand-computed: all missing fields populated from the candidate.
  assert.strictEqual(result.lead.email, "info@bharat-textiles.example.com", "missing email FILLED");
  assert.strictEqual(result.lead.phone, "+917777770001", "missing phone FILLED");
  assert.strictEqual(result.lead.whatsappNumber, "+917777770001", "missing whatsappNumber FILLED");
  assert.strictEqual(result.lead.linkedinUrl, "https://linkedin.com/bharat", "missing linkedinUrl FILLED");
  // And fieldsAdded lists every filled field.
  for (const field of ["email", "phone", "whatsappNumber", "linkedinUrl"]) {
    assert.ok(result.fieldsAdded.includes(field), `${field} listed in fieldsAdded`);
  }
});

// --- CASE C: empty-string candidate value does NOT clobber ---------------------
test("CASE C — an empty/whitespace candidate value does NOT clobber an existing field", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("C");
  const lead = await seedEnrichableLead(repos, WS, { email: "owner@example.com" });

  const result = await enrichLead(WS, lead.id, {
    candidates: [matchingCandidate(WS, { email: "   " })],
  }, repos);

  assert.strictEqual(result.status, "matched", "still matched (website overlap)");
  // copyIfMissing guard: `typeof value === "string" && value.trim()` → empty fails.
  assert.strictEqual(result.lead.email, "owner@example.com", "empty candidate email does NOT clobber owner value");
  assert.ok(!result.fieldsAdded.includes("email"), "empty email not counted as added");
});

// --- CASE D: ambiguous enrichment leaves contact details untouched -------------
test("CASE D — ambiguous enrichment (2+ close candidates) does NOT modify contact details", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("D");
  const lead = await seedEnrichableLead(repos, WS, { email: "owner@example.com", phone: "+919999900000" });

  // Two candidates with the SAME website domain → both score high → ambiguous
  // (closeMatches.length > 1). decideBestCandidate returns status="ambiguous".
  const result = await enrichLead(WS, lead.id, {
    candidates: [
      matchingCandidate(WS, { companyName: "Bharat Textiles", email: "first@example.com", phone: "+911111110001" }),
      matchingCandidate(WS, { companyName: "Bharat Textiles", email: "second@example.com", phone: "+912222220002" }),
    ],
  }, repos);

  assert.strictEqual(result.status, "ambiguous", "2 close matches → status ambiguous");
  // Hand-computed: contact details UNCHANGED (no overwrite on ambiguity).
  assert.strictEqual(result.lead.email, "owner@example.com", "email unchanged on ambiguous");
  assert.strictEqual(result.lead.phone, "+919999900000", "phone unchanged on ambiguous");
  assert.strictEqual(result.fieldsAdded.length, 0, "no fields added on ambiguous");
});

// --- CASE E: no-results enrichment leaves contact details untouched ------------
test("CASE E — no-results enrichment (no candidates) sets status no_results + leaves contact untouched", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("E");
  const lead = await seedEnrichableLead(repos, WS, { email: "owner@example.com" });

  const result = await enrichLead(WS, lead.id, { candidates: [] }, repos);

  assert.strictEqual(result.status, "no_results", "no candidates → status no_results");
  assert.strictEqual(result.lead.email, "owner@example.com", "email unchanged on no_results");
  assert.strictEqual(result.fieldsAdded.length, 0, "no fields added on no_results");
  // enrichmentStatus moves to completed (the run finished, just with no match).
  assert.strictEqual(result.lead.enrichmentStatus, "completed", "enrichmentStatus === completed");
});

// --- RUNNER ---------------------------------------------------------------------
(async () => {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log("");
  console.log(`lead-enrichment: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
