/** Prints the size of every N13 checklist. Run: npx tsx scripts/probes/checklist-sizes.ts */
import { checklistQuestions } from "@/knowledge/knowledge-sheets";
import type { BusinessKind } from "@/knowledge/knowledge-question-framework";
const cases: Array<[string, BusinessKind[], boolean]> = [
  ["nothing known", [], false], ["manufacturer", ["manufacturer"], false], ["trader", ["trader"], false],
  ["retailer", ["retailer"], false], ["service", ["service"], false], ["maker + trader", ["manufacturer", "trader"], false],
  ["maker + trader + export", ["manufacturer", "trader"], true], ["service + export", ["service"], true],
];
for (const [name, kinds, exports] of cases) {
  const list = checklistQuestions({ kinds, exports });
  console.log(`${name.padEnd(24)} ${String(list.length).padStart(4)} questions · ${list.filter((q) => q.isEssential).length} essential · ${list.filter((q) => q.countsAsMissing).length} can be missing`);
}
