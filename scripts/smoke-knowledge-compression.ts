import "./smoke-offline-preload";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { defaultWorkspaceId, mutateData } from "@/lib/db";
import { getAllKnowledgeQuestions, getEssentialKnowledgeQuestions, KNOWLEDGE_CORE_DOMAINS, KNOWLEDGE_QUESTION_FRAMEWORK } from "@/knowledge/knowledge-question-framework";
import type { HumanFallbackTask, KnowledgeEntry } from "@/lib/types";
import { getEssentialQuestionGroups } from "@/services/KnowledgeQuestionPresentationService";
import { upsertKnowledgeEntry } from "@/services/KnowledgeSyncService";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const allQuestions = getAllKnowledgeQuestions();
  const essentialQuestions = getEssentialKnowledgeQuestions();
  const essentialGroups = getEssentialQuestionGroups();
  const coreKeys = new Set(KNOWLEDGE_CORE_DOMAINS.map((domain) => domain.coreDomainKey));

  // N13 replaces padded templates with a canonical question pool. Keep full domain coverage.
  assert(allQuestions.length > 0, "Canonical question pool must not be empty");
  assert(allQuestions.length === KNOWLEDGE_QUESTION_FRAMEWORK.reduce((n, domain) => n + domain.questions.length, 0), "Canonical questions were truncated");
  const domainsWithQuestions = new Set(allQuestions.map((question) => question.domainKey));
  assert(KNOWLEDGE_QUESTION_FRAMEWORK.every(domain => domainsWithQuestions.has(domain.domainKey)), `Expected every knowledge domain to contribute questions, found ${domainsWithQuestions.size}.`);
  assert(KNOWLEDGE_CORE_DOMAINS.length === 12, `Expected 12 owner-facing core domains, found ${KNOWLEDGE_CORE_DOMAINS.length}.`);
  assert(essentialQuestions.length > 0 && essentialQuestions.every(q => allQuestions.some(item => item.domainKey === q.domainKey && item.questionKey === q.questionKey && item.isEssential)), "Every essential must belong to the canonical question pool");
  const groupedIds = essentialGroups.flatMap(group => group.questions.map(q => q.id));
  assert(groupedIds.length === essentialQuestions.length && new Set(groupedIds).size === essentialQuestions.length && essentialQuestions.every(q => groupedIds.includes(`${q.domainKey}/${q.questionKey}`)), "Every essential question must appear exactly once in owner-facing groups");
  assert(essentialGroups.length === new Set(essentialQuestions.map(q => q.coreDomainKey)).size, "Every core domain with essentials must have an owner-facing group");

  for (const question of allQuestions) {
    assert(typeof question.isEssential === "boolean", `Question ${question.domainKey}/${question.questionKey} is missing isEssential.`);
    assert(coreKeys.has(question.coreDomainKey), `Question ${question.domainKey}/${question.questionKey} has invalid core domain ${question.coreDomainKey}.`);
    assert(Boolean(question.coreDomainTitle), `Question ${question.domainKey}/${question.questionKey} is missing coreDomainTitle.`);
  }

  const root = process.cwd();
  const pageSource = await readFile(path.join(root, "src/app/page.tsx"), "utf8");
  const routeSource = await readFile(path.join(root, "src/app/api/[[...path]]/route.ts"), "utf8");
  assert(pageSource.includes("Essential setup questions"), "Onboarding does not render the owner-facing essential questions panel.");
  assert(pageSource.includes("/api/knowledge/essential-questions"), "Onboarding does not load the essential questions API.");
  assert(routeSource.includes('["knowledge", "essential-questions"]'), "Essential questions API route is missing.");
  assert(routeSource.includes('["fallback", "resolve"]'), "Fallback resolve API route is missing.");

  let beforeEntries: KnowledgeEntry[] = [];
  let beforeTasks: HumanFallbackTask[] = [];
  await mutateData((data) => {
    beforeEntries = structuredClone(data.knowledgeEntries || []);
    beforeTasks = structuredClone(data.humanFallbackTasks || []);
  });

  try {
    const created = await upsertKnowledgeEntry({
      workspaceId: defaultWorkspaceId,
      questionKey: "company_knowledge/company_overview",
      answer: "Smoke test answer for the generic SaaS company setup.",
    });
    assert(created.success, "KnowledgeEntry upsert did not report success.");
    assert(created.entry.questionId === "company_knowledge/company_overview", "KnowledgeEntry was saved with the wrong question id.");
    assert(created.entry.domain === "company_knowledge", "KnowledgeEntry was saved with the wrong domain.");

    const updated = await upsertKnowledgeEntry({
      workspaceId: defaultWorkspaceId,
      domainKey: "company_knowledge",
      questionKey: "company_overview",
      answer: "Updated smoke test answer.",
    });
    assert(updated.mode === "updated", "Second KnowledgeEntry upsert should update the existing row.");
    assert(updated.entry.answer === "Updated smoke test answer.", "KnowledgeEntry update did not persist the latest answer.");
  } finally {
    await mutateData((data) => {
      data.knowledgeEntries = beforeEntries;
      data.humanFallbackTasks = beforeTasks;
    });
  }

  console.log(`PASS knowledge compression: ${allQuestions.length} internal questions, ${essentialQuestions.length} visible essentials, ${essentialGroups.length} owner-facing domains.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
