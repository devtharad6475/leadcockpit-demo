/**
 * Golden test — every guided knowledge section is named after the part of the
 * business it asks about.
 *
 * WHY THIS EXISTS (2026-09-09, session 55)
 * ----------------------------------------
 * Found on the live demo, reading the guided view as the owner would.
 *
 * `guidedBlockDefinitions` hand-writes blocks for ten domains. The framework
 * has twenty-six. Every other domain fell back to one shared definition titled
 * "Business Context", with the same prompt and the same example — so the screen
 * listed fifteen different sections of the business, objection handling and
 * legal terms and pricing policy among them, all under that one name. An owner
 * looking at the list could not tell which one to open, and opening one told
 * them nothing either.
 *
 * The domain's own title was on the record the whole time.
 *
 *   CASE A — no block is left with the placeholder name.
 *
 *   CASE B — the titles are distinct, which is the property that actually makes
 *     the list usable. A unique-looking fix that still collides on two domains
 *     would pass CASE A and leave the screen ambiguous.
 *
 *   CASE C — the hand-written blocks keep their own names. The fallback is a
 *     fallback; it must not start overriding the ten titles someone wrote on
 *     purpose.
 *
 * Substrate: pure function. No repository, no network, no AI.
 */
import { buildGuidedKnowledgeBlocks } from "@/services/KnowledgeQuestionPresentationService";
import { KNOWLEDGE_QUESTION_FRAMEWORK } from "@/knowledge/knowledge-question-framework";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function main() {
  console.log("=== GOLDEN: every guided section is named after its part of the business ===\n");

  const blocks = buildGuidedKnowledgeBlocks([]);
  assert(blocks.length > 10, `setup: expected the full framework's blocks, got ${blocks.length}`);

  // ---------------------------------------------------------------- CASE A
  {
    const placeholder = blocks.filter((block) => block.title === "Business Context");
    assert(
      placeholder.length === 0,
      `CASE A: ${placeholder.length} sections are still called "Business Context" ` +
      `(${placeholder.map((block) => block.domainKey).join(", ")}) — the owner cannot tell them apart`,
    );
    console.log("✅ CASE A — no section is left with the placeholder name");
  }

  // ---------------------------------------------------------------- CASE B
  {
    const seen = new Map<string, string[]>();
    for (const block of blocks) {
      seen.set(block.title, [...(seen.get(block.title) || []), block.domainKey]);
    }
    const collisions = [...seen.entries()].filter(([, domains]) => domains.length > 1);
    assert(
      collisions.length === 0,
      `CASE B: these titles are used by more than one section: ` +
      collisions.map(([title, domains]) => `${JSON.stringify(title)} (${domains.join(", ")})`).join("; "),
    );
    console.log(`✅ CASE B — all ${blocks.length} section names are distinct`);
  }

  // ---------------------------------------------------------------- CASE C
  {
    const overview = blocks.find((block) => block.blockKey === "company_knowledge:company_overview");
    assert(overview, "CASE C: the company_knowledge overview block should exist");
    assert(
      overview.title === "Company Overview",
      `CASE C: a hand-written title must survive, got ${JSON.stringify(overview.title)}`,
    );

    const fallbackDomain = KNOWLEDGE_QUESTION_FRAMEWORK.find((domain) => domain.domainKey === "objection_handling");
    if (fallbackDomain) {
      const fallbackBlock = blocks.find((block) => block.domainKey === "objection_handling");
      assert(fallbackBlock, "CASE C: the objection_handling domain should produce a block");
      assert(
        fallbackBlock.title === fallbackDomain.domainTitle,
        `CASE C: a fallback block must take its domain's title, expected ${JSON.stringify(fallbackDomain.domainTitle)}, got ${JSON.stringify(fallbackBlock.title)}`,
      );
    }
    console.log("✅ CASE C — hand-written names stand, and a fallback takes its domain's name");
  }

  console.log("\n=== GOLDEN PASSED (A-C) ===");
}

main();
