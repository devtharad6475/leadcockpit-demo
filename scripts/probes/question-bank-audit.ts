/**
 * AUDIT — is the setup question bank worth asking?
 *
 * The CEO's question, 2026-08-24: "I have just written down 523 questions. I
 * don't know whether it is correct one or not." Company to company and
 * industry to industry, not all of them can apply.
 *
 * This prints the bank as data so the judgement is made against what is
 * actually there, not against what anyone remembers putting there.
 */
import { KNOWLEDGE_QUESTION_FRAMEWORK, getAllKnowledgeQuestions, getEssentialKnowledgeQuestions } from "../../src/knowledge/knowledge-question-framework";

const all = getAllKnowledgeQuestions();
const essential = getEssentialKnowledgeQuestions();

console.log(`\nTOTAL questions: ${all.length}`);
console.log(`ESSENTIAL:       ${essential.length}`);
console.log(`REQUIRED:        ${all.filter((q) => q.required).length}`);
console.log(`SENSITIVE:       ${all.filter((q) => q.sensitive).length}`);
console.log(`HUMAN REVIEW:    ${all.filter((q) => q.humanReviewRequired).length}\n`);

console.log("PER DOMAIN");
for (const d of KNOWLEDGE_QUESTION_FRAMEWORK) {
  const ess = d.questions.filter((q) => q.isEssential).length;
  console.log(`  ${String(d.questions.length).padStart(4)}  (${String(ess).padStart(3)} essential)  ${d.domainKey}`);
}

// Duplicate detection: same question text, or same key, in more than one place.
const byText = new Map<string, string[]>();
const byKey = new Map<string, string[]>();
for (const q of all) {
  const t = q.question.trim().toLowerCase().replace(/\s+/g, " ");
  byText.set(t, [...(byText.get(t) ?? []), `${q.domainKey}/${q.questionKey}`]);
  byKey.set(q.questionKey, [...(byKey.get(q.questionKey) ?? []), q.domainKey]);
}
const dupText = [...byText.entries()].filter(([, v]) => v.length > 1);
const dupKey = [...byKey.entries()].filter(([, v]) => v.length > 1);
console.log(`\nDUPLICATE question text: ${dupText.length}`);
for (const [t, where] of dupText.slice(0, 15)) console.log(`   "${t.slice(0, 80)}"  ->  ${where.join(", ")}`);
console.log(`\nDUPLICATE question keys: ${dupKey.length}`);
for (const [k, where] of dupKey.slice(0, 15)) console.log(`   ${k}  ->  ${where.join(", ")}`);

// Quality smells.
const noExample = all.filter((q) => !q.exampleAnswer || !q.exampleAnswer.trim());
const noWhy = all.filter((q) => !q.whyItMatters || !q.whyItMatters.trim());
const longQ = all.filter((q) => q.question.length > 140);
const choiceNoOptions = all.filter((q) => (q.answerType === "single_choice" || q.answerType === "multi_choice") && !(q.options?.length));
console.log(`\nSMELLS`);
console.log(`  no example answer:        ${noExample.length}`);
console.log(`  no "why it matters":      ${noWhy.length}`);
console.log(`  question over 140 chars:  ${longQ.length}`);
console.log(`  choice type, no options:  ${choiceNoOptions.length}`);

console.log(`\nANSWER TYPES`);
const types = new Map<string, number>();
for (const q of all) types.set(q.answerType, (types.get(q.answerType) ?? 0) + 1);
for (const [t, n] of [...types.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${t}`);

if (process.argv.includes("--dump")) {
  console.log("\n\nFULL BANK\n");
  for (const d of KNOWLEDGE_QUESTION_FRAMEWORK) {
    console.log(`\n### ${d.domainKey} — ${d.domainTitle} (${d.questions.length})`);
    for (const q of d.questions) {
      console.log(`  [${q.isEssential ? "E" : " "}${q.required ? "R" : " "}] ${q.questionKey}: ${q.question}`);
    }
  }
}

// --- What the CUSTOMER actually faces, after the grouping layer -------------
// AGENTS.md:134 says the backend keeps the full framework and the frontend
// groups it into business-friendly cards. That defence only holds if the
// grouping actually collapses the count. Measure it.
import { getQuestionPresentationSummary, getEssentialQuestionGroups, groupMissingBusinessDetails } from "../../src/services/KnowledgeQuestionPresentationService";

console.log("\n\nWHAT THE CUSTOMER FACES");
console.log("  presentation summary:", JSON.stringify(getQuestionPresentationSummary()));
const groups = getEssentialQuestionGroups();
console.log(`  essential question groups: ${groups.length}`);
for (const g of groups) console.log(`     ${g.coreDomainKey}`);

// Simulate a fresh tenant: every framework question open, as seeded at signup.
const fresh = all.map((q, i) => ({
  id: `uq-${i}`, workspaceId: "ws", channel: "knowledge", questionText: q.question,
  status: "open", generatedBy: "framework", relatedDomain: q.domainKey,
  relatedQuestionKey: q.questionKey, priority: q.priority,
  createdAt: "", updatedAt: "",
})) as never[];
const cards = groupMissingBusinessDetails(fresh);
console.log(`\n  a fresh tenant's 523 open questions collapse into ${cards.length} cards`);
const sizes = cards.map((c) => c.questionsCount).sort((a, b) => b - a);
console.log(`  biggest card: ${sizes[0]} questions · smallest: ${sizes[sizes.length - 1]} · median: ${sizes[Math.floor(sizes.length / 2)]}`);
console.log(`  cards holding exactly ONE question: ${sizes.filter((n) => n === 1).length}`);
