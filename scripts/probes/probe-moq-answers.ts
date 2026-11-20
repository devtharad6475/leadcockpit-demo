/**
 * probe-moq-answers.ts — N-AI-3 diagnosis. READ-ONLY.
 *
 * Dumps every stored knowledge answer that mentions MOQ / minimum, so the
 * fact-conflict pass can be checked against what is really in the store rather
 * than against what I assume is in it.
 *
 * Run: npx tsx scripts/probes/probe-moq-answers.ts
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

async function main() {
  const { readData } = await import("@/lib/db");
  const store = await readData();
  const answers = (store.knowledgeQuestionAnswers || []) as Array<Record<string, unknown>>;
  const hits = answers.filter((a) => /moq|minimum/i.test(`${a.questionKey} ${a.question} ${a.answer}`));
  console.log(`answers mentioning moq/minimum: ${hits.length} (of ${answers.length})\n`);
  for (const a of hits) {
    console.log(`[${a.domainKey}/${a.questionKey}] status=${a.answerStatus} approved=${Boolean(a.isUserApproved)} superseded=${a.supersededByAnswerId || "-"}`);
    console.log(`   Q: ${a.question}`);
    console.log(`   A: ${String(a.answer || "").slice(0, 300)}`);
    console.log("");
  }
}

main().catch((e) => {
  console.error("PROBE FAILED:", e instanceof Error ? e.message : e);
  process.exit(2);
});
