/**
 * Golden test — the company the Profile screen shows is the company the agent
 * tells customers about.
 *
 * WHY THIS EXISTS (2026-09-09, session 55)
 * ----------------------------------------
 * Found on the live demo, filling in a real company's details. The Profile
 * screen read:
 *
 *   Om Jari & Metallic · omjari.in · sales@omjari.in · Surat, Gujarat
 *
 * and the knowledge answers the agent quotes still read:
 *
 *   factual_company_profile/legal_company_name : "TechNova Solutions"
 *   factual_company_profile/website            : "technovasolutions.com"
 *   factual_company_profile/email              : "contact@technovasolutions.com"
 *
 * — left over from an earlier extraction against a different document. No
 * conflict card was ever raised, because no code path put the two values beside
 * each other.
 *
 * `ExtractionRoutingService.questionToProfileMappings` routes extracted ANSWERS
 * into the PROFILE. Nothing routed the other way. `refreshBusinessProfileKnowledge`,
 * which every profile write goes through, rebuilt the profile knowledge
 * DOCUMENT and left the framework ANSWERS untouched — and the answers are what
 * the agent reads when a customer asks who they are dealing with. The product
 * was ready to introduce itself to a real customer under the wrong company
 * name, from a screen that showed the right one.
 *
 *   CASE A — a profile write updates the question answers, not only the
 *     document.
 *
 *   CASE B — every identity field the extraction router can WRITE INTO the
 *     profile can also be read back OUT of it. A one-way mapping is how the two
 *     drifted apart; a field covered in one direction and not the other would
 *     recreate exactly this defect for that field.
 *
 *   CASE C — an answer the owner separately approved is not silently
 *     overwritten. It becomes a conflict, the same way a structured setting
 *     does, so a disagreement is a decision rather than a race between whichever
 *     code ran last.
 *
 *   CASE D — an empty profile field erases nothing. "Not filled in" is not an
 *     answer, and treating it as one would delete a good answer that came from a
 *     document.
 *
 *   CASE E — a failure in one half is not reported as success of the other, and
 *     neither half can fail the profile save. The owner's edit is already
 *     stored by the time this runs.
 *
 * Substrate: static read of the two services. No repository, no network, no AI.
 */
import "./_helpers/isolate-standalone";
import { readSource } from "./_helpers/read-source";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const MAPPING = "src/services/StructuredSettingsQuestionMappingService.ts";
const KNOWLEDGE = "src/services/KnowledgeBaseService.ts";
const EXTRACTION = "src/services/ExtractionRoutingService.ts";

function main() {
  console.log("=== GOLDEN: the profile and the answers agree ===\n");

  const mapping = readSource(MAPPING);
  const knowledge = readSource(KNOWLEDGE);
  const extraction = readSource(EXTRACTION);

  // ---------------------------------------------------------------- CASE A
  {
    assert(
      /export async function syncBusinessProfileToQuestions/.test(mapping),
      `CASE A: nothing routes the profile into the question answers`,
    );
    const refresh = knowledge.slice(knowledge.indexOf("export async function refreshBusinessProfileKnowledge"));
    const body = refresh.slice(0, refresh.indexOf("\n}"));
    assert(
      /syncBusinessProfileToQuestions/.test(body),
      `CASE A: ${KNOWLEDGE} rebuilds the profile document but never the answers the agent quotes`,
    );
    console.log("✅ CASE A — a profile write reaches the answers, not just the document");
  }

  // ---------------------------------------------------------------- CASE B
  {
    // Derived from the extraction router itself, so a field added there is
    // covered here without editing this golden.
    const tableStart = extraction.indexOf("const questionToProfileMappings");
    assert(tableStart > 0, `CASE B setup: ${EXTRACTION} no longer defines questionToProfileMappings`);
    const table = extraction.slice(tableStart, extraction.indexOf("];", tableStart));
    const intoProfile = Array.from(
      new Set((table.match(/fieldKey: "(\w+)"/g) || []).map((hit) => hit.replace(/.*"(\w+)"$/, "$1"))),
    );
    assert(intoProfile.length >= 8, `CASE B setup: expected the identity mappings in ${EXTRACTION}, found ${intoProfile.length}`);
    const outOfProfile = mapping.slice(mapping.indexOf("const profileToQuestionMappings"));
    const missing = intoProfile.filter((field) => !new RegExp(`field: "${field}"`).test(outOfProfile));
    assert(
      missing.length === 0,
      `CASE B: ${missing.join(", ")} can be written INTO the profile by extraction but never read back OUT — that field would drift exactly as legal_company_name did`,
    );
    console.log(`✅ CASE B — all ${intoProfile.length} identity fields map both ways: ${intoProfile.join(", ")}`);
  }

  // ---------------------------------------------------------------- CASE C
  {
    const fn = mapping.slice(mapping.indexOf("export async function syncBusinessProfileToQuestions"));
    assert(
      /existing\?\.isUserApproved && existing\.answer\?\.trim\(\) && answersConflict/.test(fn),
      `CASE C: an answer the owner approved would be silently overwritten by the profile`,
    );
    assert(
      /answerStatus = "conflict"/.test(fn),
      `CASE C: the disagreement must be raised as a conflict, not resolved by whichever ran last`,
    );
    console.log("✅ CASE C — an approved answer becomes a conflict, never a silent overwrite");
  }

  // ---------------------------------------------------------------- CASE D
  {
    const fn = mapping.slice(mapping.indexOf("export async function syncBusinessProfileToQuestions"));
    assert(
      /if \(!value\) continue;/.test(fn),
      `CASE D: an empty profile field would be written as the answer, erasing one that came from a document`,
    );
    console.log("✅ CASE D — an unfilled profile field erases nothing");
  }

  // ---------------------------------------------------------------- CASE E
  {
    const refresh = knowledge.slice(knowledge.indexOf("export async function refreshBusinessProfileKnowledge"));
    const body = refresh.slice(0, refresh.indexOf("\n}"));
    assert(
      /answersError/.test(body) && /documentError/.test(body),
      `CASE E: the two halves must report separately — a failed answer sync must not read as a successful one`,
    );
    assert(
      (body.match(/try \{/g) || []).length >= 2,
      `CASE E: each half must be caught on its own; the profile is already saved by the time this runs and must not be failed by it`,
    );
    console.log("✅ CASE E — the halves report separately, and neither can fail the save");
  }

  console.log("\n=== GOLDEN PASSED (A-E) ===");
}

main();
