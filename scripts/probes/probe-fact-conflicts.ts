/**
 * probe-fact-conflicts.ts — N-AI-3 verification against the REAL knowledge base.
 *
 * The golden proves the logic on constructed answers. This proves it on the
 * 523 answers a real DeepSeek extraction actually produced from the 18 fixture
 * documents — the exact data in which the 5 kg vs 10 kg MOQ contradiction was
 * measured surviving both earlier fixes.
 *
 * READ-ONLY: the answers are deep-copied before the pass runs, so this reports
 * what production WOULD flag without writing anything.
 *
 * Run: npx tsx scripts/probes/probe-fact-conflicts.ts
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

async function main() {
  const { getFactGroups } = await import("@/knowledge/knowledge-fact-groups");
  const { detectFactGroupConflicts } = await import("@/services/KnowledgeFactConflictService");
  const { readData } = await import("@/lib/db");

  const store = await readData();
  const answers = (store.knowledgeQuestionAnswers || []);
  const workspaceIds = Array.from(new Set(answers.map((a) => a.workspaceId)));

  console.log(`knowledge answers in the JSON store: ${answers.length}`);
  console.log(`workspaces holding answers: ${workspaceIds.length}`);
  console.log(`fact groups in play (2+ members): ${getFactGroups().length}\n`);

  let total = 0;
  for (const workspaceId of workspaceIds) {
    // Deep copy so the probe cannot write anything back.
    const data = {
      knowledgeQuestionAnswers: JSON.parse(JSON.stringify(answers)),
      unknownQuestions: [],
    } as never;

    const summary = detectFactGroupConflicts({ workspaceId, data });
    if (!summary.factConflictsFound) continue;
    total += summary.factConflictsFound;

    console.log(`workspace ${workspaceId}: ${summary.factConflictsFound} fact conflict(s)`);
    for (const detail of summary.details) console.log(`  - ${detail}`);
    for (const item of (data as { unknownQuestions: Array<{ questionText: string; suggestedAnswer?: string }> }).unknownQuestions) {
      console.log(`\n  REVIEW ITEM: ${item.questionText}`);
      for (const line of (item.suggestedAnswer || "").split("\n")) console.log(`    ${line}`);
    }
    console.log("");
  }

  console.log(`=== ${total} fact conflict(s) found across the live knowledge base ===`);
}

main().catch((e) => {
  console.error("PROBE FAILED:", e instanceof Error ? e.message : e);
  process.exit(2);
});
