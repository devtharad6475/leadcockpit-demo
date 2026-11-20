/** Dumps a checklist, one line per question. Run: npx tsx scripts/probes/checklist-dump.ts [kinds,comma] [exports] */
import { checklistQuestions } from "@/knowledge/knowledge-sheets";
import type { BusinessKind } from "@/knowledge/knowledge-question-framework";
const kinds = (process.argv[2] || "").split(",").filter(Boolean) as BusinessKind[];
let domain = "";
for (const q of checklistQuestions({ kinds, exports: process.argv[3] === "exports" })) {
  if (q.domainKey !== domain) { domain = q.domainKey; console.log(`\n## ${q.domainTitle}`); }
  console.log(`${q.isEssential ? "*" : " "}${q.required ? "R" : " "} ${q.questionKey.padEnd(36).slice(0, 36)} ${q.question}`);
}
