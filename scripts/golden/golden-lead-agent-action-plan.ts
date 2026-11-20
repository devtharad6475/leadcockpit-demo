/**
 * golden-lead-agent-action-plan.ts — pins the LeadAgentActionPlanService (DARK).
 *
 * WHAT THIS PROVES
 *   `createLeadAgentActionPlan` is the LLM-assisted action-plan builder for a
 *   single lead. The SACRED contract (AGENTS.md "No automatic customer-facing
 *   outreach" + "No hallucination"): every plan has `humanReviewRequired: true`
 *   and `safetyNote` explaining a human must review before outreach. DNC /
 *   rejected leads get a "Do not contact" recommendation with NO draft message.
 *   This golden pins those contracts so a future change can't silently flip
 *   the plan to auto-send or auto-approve.
 *
 * THE CONTRACT (hand-computed BEFORE writing assertions):
 *   CASE A — a normal lead: plan has humanReviewRequired === true ALWAYS,
 *            safetyNote is the documented "Draft only..." string, and
 *            draftMessage is present (the deterministic fallback mentions the
 *            companyName). modelStatus.mode is honest about mock/fallback.
 *   CASE B — DNC lead (doNotContact=true): recommendation === "Do not contact
 *            this lead.", draftMessage === "" (empty — never draft for DNC),
 *            nextSteps warn to keep the lead out of outreach.
 *   CASE C — rejected lead (reviewStatus="rejected"): SAME as CASE B — blocked.
 *   CASE D — do_not_contact STATUS lead: SAME as CASE B — blocked.
 *   CASE E — non-existent lead throws (no silent empty plan).
 *   CASE F — the audit event is recorded (lead.agent_action_plan_created).
 *
 * REAL PIPELINE: imports the real LeadAgentActionPlanService + real JSON repos.
 * The LLM call falls through to the deterministic fallback (mock mode default),
 * so the assertions are deterministic. Each case uses an isolated workspace.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { createJsonRepos } from "./_helpers/provider";
import { createLeadAgentActionPlan } from "@/services/LeadAgentActionPlanService";
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { Lead } from "@/lib/types";
import assert from "node:assert";

function caseWs(caseId: string) { return `ws_action_plan_${caseId}`; }

async function seedLead(ws: string, repos: RepositoryBundle, overrides: Partial<Lead> = {}): Promise<Lead> {
  return repos.lead.createLead({
    workspaceId: ws,
    companyName: overrides.companyName || "Test Co",
    contactName: overrides.contactName,
    whatsappNumber: overrides.whatsappNumber,
    source: overrides.source || "manual",
    fitReason: "seed for golden",
    status: overrides.status || "needs_review",
    reviewStatus: overrides.reviewStatus || "pending",
    enrichmentStatus: overrides.enrichmentStatus || "not_started",
    doNotContact: overrides.doNotContact || false,
    consentStatus: overrides.consentStatus || "none",
    ...overrides,
  });
}

async function clearWorkspaceLeads(ws: string, repos: RepositoryBundle) {
  for (const lead of await repos.lead.listLeads(ws)) {
    try { await repos.lead.deleteById(ws, lead.id); } catch { /* best-effort */ }
  }
}

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

// --- CASE A: normal lead — humanReviewRequired ALWAYS true + safety note ---------
test("CASE A — normal lead: humanReviewRequired === true ALWAYS + draft present + honest modelStatus", async () => {
  const ws = caseWs("A");
  const repos = createJsonRepos();
  await clearWorkspaceLeads(ws, repos);
  const lead = await seedLead(ws, repos, { companyName: "Acme Textiles" });

  const plan = await createLeadAgentActionPlan(ws, lead.id, repos, "user_owner");

  // SACRED contract (AGENTS.md): every plan requires human review.
  assert.strictEqual(plan.humanReviewRequired, true, "humanReviewRequired === true ALWAYS (sacred no-auto-outreach)");
  // The safety note must say it's draft-only + never auto-sends.
  assert.ok(/draft only/i.test(plan.safetyNote), `safetyNote mentions 'draft only', got: '${plan.safetyNote}'`);
  assert.ok(/never sends/i.test(plan.safetyNote) || /no.*auto/i.test(plan.safetyNote), `safetyNote warns against auto-send, got: '${plan.safetyNote}'`);
  // The deterministic fallback draft mentions the company name (proves the
  // fallback path populated the draft, not an empty stub).
  assert.ok(plan.draftMessage.length > 0, "draftMessage is populated (deterministic fallback)");
  assert.ok(/Acme Textiles/i.test(plan.draftMessage), `draft mentions companyName, got: '${plan.draftMessage.slice(0, 80)}...'`);
  // Honest model status — mock mode is reported as mock, never as 'real'.
  assert.notStrictEqual(plan.modelStatus.mode, "real", "modelStatus.mode is never 'real' under mock fallback");
  assert.ok(["mock", "fallback", "demo", "deterministic", "rule-based"].includes(plan.modelStatus.mode || ""), `mode is honest: '${plan.modelStatus.mode}'`);
  // plan is scoped to this lead.
  assert.strictEqual(plan.leadId, lead.id);
});

// --- CASE B: DNC lead (doNotContact=true) — blocked, no draft -------------------
test("CASE B — DNC lead (doNotContact=true): recommendation='Do not contact', draftMessage=''", async () => {
  const ws = caseWs("B");
  const repos = createJsonRepos();
  await clearWorkspaceLeads(ws, repos);
  const lead = await seedLead(ws, repos, { companyName: "Blocked Co", doNotContact: true });

  const plan = await createLeadAgentActionPlan(ws, lead.id, repos);

  assert.strictEqual(plan.humanReviewRequired, true, "still requires human review (even blocked leads)");
  assert.strictEqual(plan.recommendation, "Do not contact this lead.", "DNC recommendation");
  assert.strictEqual(plan.draftMessage, "", "draftMessage is EMPTY for DNC (never draft outreach for blocked)");
  assert.ok(plan.nextSteps.length >= 1, "nextSteps populated");
  assert.ok(/out of outreach/i.test(plan.nextSteps.join(" ")), "nextSteps warn to keep out of outreach");
});

// --- CASE C: rejected lead (reviewStatus=rejected) — blocked --------------------
test("CASE C — rejected lead (reviewStatus='rejected'): blocked, no draft", async () => {
  const ws = caseWs("C");
  const repos = createJsonRepos();
  await clearWorkspaceLeads(ws, repos);
  const lead = await seedLead(ws, repos, { companyName: "Rejected Co", reviewStatus: "rejected" });

  const plan = await createLeadAgentActionPlan(ws, lead.id, repos);

  assert.strictEqual(plan.recommendation, "Do not contact this lead.", "rejected recommendation");
  assert.strictEqual(plan.draftMessage, "", "no draft for rejected lead");
});

// --- CASE D: do_not_contact STATUS lead — blocked -------------------------------
test("CASE D — do_not_contact status lead: blocked, no draft", async () => {
  const ws = caseWs("D");
  const repos = createJsonRepos();
  await clearWorkspaceLeads(ws, repos);
  const lead = await seedLead(ws, repos, { companyName: "DNC Status Co", status: "do_not_contact" });

  const plan = await createLeadAgentActionPlan(ws, lead.id, repos);

  assert.strictEqual(plan.recommendation, "Do not contact this lead.", "status-based DNC recommendation");
  assert.strictEqual(plan.draftMessage, "", "no draft for do_not_contact status lead");
});

// --- CASE E: non-existent lead throws -------------------------------------------
test("CASE E — non-existent lead throws (no silent empty plan)", async () => {
  const ws = caseWs("E");
  const repos = createJsonRepos();
  await assert.rejects(
    () => createLeadAgentActionPlan(ws, "nonexistent_lead_id", repos),
    /not found/i,
    "non-existent lead must throw (not silently return an empty plan)",
  );
});

// --- CASE F: audit event recorded -----------------------------------------------
test("CASE F — audit event lead.agent_action_plan_created is recorded", async () => {
  const ws = caseWs("F");
  const repos = createJsonRepos();
  await clearWorkspaceLeads(ws, repos);
  const lead = await seedLead(ws, repos, { companyName: "Audit Co" });
  // Clear pre-existing audit logs for this workspace to isolate the assertion.
  const data = await (await import("@/lib/db")).readData();
  const before = (data.auditLogs || []).filter((l) => l.workspaceId === ws && l.eventType === "lead.agent_action_plan_created").length;

  await createLeadAgentActionPlan(ws, lead.id, repos, "user_owner");

  const dataAfter = await (await import("@/lib/db")).readData();
  const after = (dataAfter.auditLogs || []).filter((l) => l.workspaceId === ws && l.eventType === "lead.agent_action_plan_created").length;
  assert.ok(after > before, `audit event recorded (before=${before}, after=${after})`);
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
  console.log(`lead-agent-action-plan: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
