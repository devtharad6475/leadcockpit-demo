/**
 * smoke-prisma-runtime.ts — Phase 4D acceptance test
 *
 * Proves the Prisma repository layer can round-trip data: create records,
 * read them back, and verify persistence. This is the test that was impossible
 * before Phase 4C (the 6 split-brain services bypassed repos entirely).
 *
 * Specifically tests:
 *   1. createRepositories("prisma") returns a working bundle
 *   2. repos.workspace.create + getById round-trip
 *   3. repos.lead.createLead + listLeads round-trip
 *   4. repos.mutateAll! (the new transaction abstraction) round-trips
 *      knowledgeQuestionAnswers + auditLogs atomically
 *   5. repos.readAll! returns the full snapshot including the new collections
 *
 * Requires: PostgreSQL running with DATABASE_URL set, and `prisma db push` run.
 *
 * Run: DATABASE_URL="postgresql://postgres:postgres@localhost:5433/leadcockpit_test" PERSISTENCE_PROVIDER=prisma npx tsx scripts/smoke-prisma-runtime.ts
 */
import { createRepositories } from "../src/repositories";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  assert(Boolean(dbUrl), "DATABASE_URL must be set for this smoke test.");

  console.log("smoke-prisma-runtime: testing Prisma repository round-trip...\n");

  // --- 1. Create a Prisma repository bundle ---
  console.log("  [1] Creating Prisma repository bundle...");
  const repos = createRepositories("prisma");
  assert(typeof repos.mutateAll === "function", "repos.mutateAll must be a function");
  assert(typeof repos.readAll === "function", "repos.readAll must be a function");
  console.log("    OK Prisma bundle created with mutateAll + readAll");

  // --- 2. Workspace round-trip ---
  console.log("  [2] Workspace create + read round-trip...");
  const wsId = `smoke-prisma-ws-${Date.now()}`;
  const workspace = await repos.workspace.create({
    id: wsId,
    name: "Prisma Smoke Test Workspace",
    industry: "Testing",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  assert(workspace.id === wsId, "workspace id should match");
  const fetched = await repos.workspace.getById(wsId);
  assert(fetched?.id === wsId, "workspace should be readable by id");
  console.log("    OK workspace created and read back");

  // --- 3. Lead round-trip ---
  console.log("  [3] Lead create + list round-trip...");
  const leadInput = {
    id: `smoke-prisma-lead-${Date.now()}`,
    workspaceId: wsId,
    campaignId: undefined as string | undefined,
    icpId: undefined as string | undefined,
    companyName: "Prisma Smoke Lead Co",
    source: "smoke_test",
    status: "prospected" as const,
    reviewStatus: "pending" as const,
    enrichmentStatus: "not_started" as const,
    confidenceScore: 0.8,
    qualificationStatus: "mql" as const,
    leadScore: 0,
    fitScore: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const lead = await repos.lead.createLead(leadInput);
  assert(lead.id === leadInput.id, "lead id should match");
  const leads = await repos.lead.listLeads(wsId);
  const found = leads.find((l) => l.id === leadInput.id);
  assert(Boolean(found), "lead should appear in listLeads");
  console.log("    OK lead created and listed");

  // --- 4. mutateAll round-trip (the core Phase 4C transaction abstraction) ---
  console.log("  [4] mutateAll atomic multi-collection write...");
  const kqaId = `smoke-prisma-kqa-${Date.now()}`;
  const auditId = `smoke-prisma-audit-${Date.now()}`;
  const now = new Date().toISOString();
  await repos.mutateAll!((data) => {
    data.knowledgeQuestionAnswers ||= [];
    data.knowledgeQuestionAnswers.push({
      id: kqaId,
      workspaceId: wsId,
      domainKey: "test_domain",
      questionKey: "test_question",
      question: "Is the Prisma mutateAll working?",
      answer: "Yes",
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
    data.auditLogs ||= [];
    data.auditLogs.push({
      id: auditId,
      workspaceId: wsId,
      eventType: "smoke_test_event",
      entityType: "knowledge_question_answer",
      entityId: kqaId,
      payload: { test: true },
      createdAt: now,
      updatedAt: now,
    });
    return { kqaId, auditId };
  });
  console.log("    OK mutateAll wrote knowledgeQuestionAnswers + auditLogs atomically");

  // --- 5. readAll returns the new collections ---
  console.log("  [5] readAll returns full snapshot including new collections...");
  const snapshot = await repos.readAll!();
  const kqaFound = (snapshot.knowledgeQuestionAnswers || []).find((k) => k.id === kqaId);
  assert(Boolean(kqaFound), "knowledgeQuestionAnswer should be in readAll snapshot");
  assert(kqaFound?.answer === "Yes", "KQA answer should match");
  const auditFound = (snapshot.auditLogs || []).find((a) => a.id === auditId);
  assert(Boolean(auditFound), "auditLog should be in readAll snapshot");
  console.log("    OK readAll returns knowledgeQuestionAnswers + auditLogs");

  // --- 6. mutateAll UPDATE (not just create) ---
  console.log("  [6] mutateAll update existing record...");
  await repos.mutateAll!((data) => {
    const existing = (data.knowledgeQuestionAnswers || []).find((k) => k.id === kqaId);
    if (existing) {
      existing.answer = "Updated answer";
      existing.updatedAt = new Date().toISOString();
    }
    return undefined;
  });
  const updatedSnapshot = await repos.readAll!();
  const updatedKqa = (updatedSnapshot.knowledgeQuestionAnswers || []).find((k) => k.id === kqaId);
  assert(updatedKqa?.answer === "Updated answer", "KQA should be updated after mutateAll");
  console.log("    OK mutateAll updated existing record");

  // --- Cleanup (test data stays in the test DB; reset with prisma db push --force-reset) ---
  console.log("  [7] Test data left in leadcockpit_test DB (reset with prisma db push --force-reset)");
  console.log("    OK");

  console.log("\nsmoke-prisma-runtime: ALL CHECKS PASSED");
}

main().catch((error) => {
  console.error("\nsmoke-prisma-runtime FAILED:", error.message);
  console.error(error.stack);
  process.exit(1);
});
