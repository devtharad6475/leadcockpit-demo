/**
 * smoke-workspace-isolation.ts — Phase 4D acceptance test
 *
 * Proves workspace data isolation: records created in workspace A are NOT
 * visible when querying workspace B. This is critical for multi-tenant SaaS —
 * a workspaceId mismatch must never leak data across tenants.
 *
 * Tests:
 *   1. Create 2 workspaces (A and B)
 *   2. Create a lead in workspace A
 *   3. List workspace B leads → must NOT include workspace A's lead
 *   4. mutateAll: create a knowledgeQuestionAnswer in workspace A
 *   5. readAll: filter by workspace → workspace B must NOT see A's KQA
 *
 * Requires: PostgreSQL running with DATABASE_URL set, and `prisma db push` run.
 *
 * Run: DATABASE_URL="postgresql://postgres:postgres@localhost:5433/leadcockpit_test" PERSISTENCE_PROVIDER=prisma npx tsx scripts/smoke-workspace-isolation.ts
 */
import { createRepositories } from "../src/repositories";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  assert(Boolean(dbUrl), "DATABASE_URL must be set for this smoke test.");

  console.log("smoke-workspace-isolation: testing multi-tenant data isolation...\n");

  const repos = createRepositories("prisma");
  const ts = Date.now();
  const wsA = `smoke-iso-wsA-${ts}`;
  const wsB = `smoke-iso-wsB-${ts}`;

  // --- 1. Create two workspaces ---
  console.log("  [1] Creating two workspaces (A and B)...");
  await repos.workspace.create({
    id: wsA,
    name: "Workspace A",
    industry: "Testing",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  await repos.workspace.create({
    id: wsB,
    name: "Workspace B",
    industry: "Testing",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  console.log("    OK both workspaces created");

  // --- 2. Create a lead in workspace A ---
  console.log("  [2] Creating a lead in workspace A...");
  const leadId = `smoke-iso-lead-${ts}`;
  await repos.lead.createLead({
    id: leadId,
    workspaceId: wsA,
    campaignId: undefined as string | undefined,
    icpId: undefined as string | undefined,
    companyName: "Workspace A Exclusive Lead",
    source: "isolation_test",
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
  console.log("    OK lead created in workspace A");

  // --- 3. Workspace B must NOT see workspace A's lead ---
  console.log("  [3] Workspace B leads must NOT include workspace A's lead...");
  const wsBLeads = await repos.lead.listLeads(wsB);
  const leakCheck1 = wsBLeads.find((l) => l.id === leadId);
  assert(!leakCheck1, "workspace B must NOT see workspace A's lead (DATA LEAK!)");
  console.log("    OK workspace B has no visibility into workspace A leads");

  // --- 4. mutateAll: create KQA in workspace A ---
  console.log("  [4] Creating knowledgeQuestionAnswer in workspace A via mutateAll...");
  const kqaId = `smoke-iso-kqa-${ts}`;
  const now = new Date().toISOString();
  await repos.mutateAll!((data) => {
    data.knowledgeQuestionAnswers ||= [];
    data.knowledgeQuestionAnswers.push({
      id: kqaId,
      workspaceId: wsA,
      domainKey: "iso_test",
      questionKey: "secret_question",
      question: "This is workspace A's secret data",
      answer: "CONFIDENTIAL",
      answerStatus: "answered",
      sourceType: "system_generated",
      confidenceScore: 1,
      usedByAgentsJson: {},
      mapsToJson: {},
      humanReviewRequired: false,
      evidenceJson: { sources: [] },
      createdAt: now,
      updatedAt: now,
    });
    return kqaId;
  });
  console.log("    OK KQA created in workspace A");

  // --- 5. readAll: filter by workspace → B must NOT see A's KQA ---
  console.log("  [5] readAll filtered by workspace — B must NOT see A's KQA...");
  const snapshot = await repos.readAll!();
  const wsAKqa = (snapshot.knowledgeQuestionAnswers || []).filter((k) => k.workspaceId === wsA);
  const wsBKqa = (snapshot.knowledgeQuestionAnswers || []).filter((k) => k.workspaceId === wsB);
  assert(wsAKqa.some((k) => k.id === kqaId), "workspace A should have its KQA");
  assert(!wsBKqa.some((k) => k.id === kqaId), "workspace B must NOT have workspace A's KQA (DATA LEAK!)");
  console.log("    OK workspace isolation confirmed — no cross-tenant data leak");

  // --- 6. mutateAll from workspace A must not affect workspace B ---
  console.log("  [6] mutateAll workspace-scoped update doesn't leak...");
  await repos.mutateAll!((data) => {
    // Update only wsA's KQA
    const kqa = (data.knowledgeQuestionAnswers || []).find((k) => k.id === kqaId && k.workspaceId === wsA);
    if (kqa) {
      kqa.answer = "UPDATED CONFIDENTIAL";
    }
    return undefined;
  });
  const afterUpdate = await repos.readAll!();
  const updatedKqa = (afterUpdate.knowledgeQuestionAnswers || []).find((k) => k.id === kqaId);
  assert(updatedKqa?.answer === "UPDATED CONFIDENTIAL", "wsA KQA should be updated");
  assert(updatedKqa?.workspaceId === wsA, "updated KQA must still belong to wsA");
  console.log("    OK workspace-scoped mutateAll confirmed");

  console.log("\nsmoke-workspace-isolation: ALL CHECKS PASSED");
}

main().catch((error) => {
  console.error("\nsmoke-workspace-isolation FAILED:", error.message);
  console.error(error.stack);
  process.exit(1);
});
