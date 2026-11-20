/**
 * golden-business-profile-routing.ts — N-BUG pin (2026-09-07).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * A workspace onboarded from uploaded documents alone could never get a
 * BusinessProfile, and could therefore never use the product past Knowledge.
 *
 * The question framework tags every one of its 424 questions with the areas
 * its answer feeds, and eight of them say `business_profile`. Nothing read
 * that tag. routeExtractedFactsToSettings covered sales/product/policy/
 * communication only. The other two writers of a BusinessProfile are the
 * website crawl (needs a real, crawlable site) and applyDocumentExtraction on
 * the older /api/documents/process path. The unified onboarding bundle used by
 * the Onboarding screen called neither.
 *
 * Measured on the live deployment: a real DeepSeek extraction pulled the
 * company name, industry, website, email, phone and address correctly out of
 * an uploaded document, and every one of them was dropped on the floor. The
 * consequences are not cosmetic —
 *
 *   - the Ideal Customers button is `disabled={!profile}` (page.tsx),
 *   - Campaign and Discovery sit behind an ICP,
 *   - Sync Knowledge reports `profile: { synced: false, error: "Business
 *     profile not found" }`,
 *   - and the Profile screen renders "No profile yet." with no form and no
 *     button, so there is no way to create one from the UI at all.
 *
 * HAND-COMPUTED CONTRACT (written BEFORE the implementation was run):
 *
 *   CASE A — six `answered` facts across the two mapped domains must produce a
 *   profile that did not exist before, in `draft` status, carrying exactly
 *   those six values. Draft is the product's existing review gate
 *   (POST /api/business-profile/:id/approve); anything auto-approved would be
 *   the AI writing company facts nobody signed off.
 *
 *   CASE B — an answer the model did not settle never reaches the profile.
 *   `needs_review`, `partial`, `conflict` and `unanswered` all stay out. A fix
 *   that simply wrote every non-empty answer would pass CASE A and fail here.
 *
 *   CASE C — an existing profile is never overwritten. Empty field → filled.
 *   Identical value → no-op, no conflict card. Different value → a
 *   SettingsConflict with settingsArea "profile", and the stored value is
 *   still the old one.
 *
 *   CASE D — no mapped answers means no profile is invented. A workspace whose
 *   extraction found nothing about the company must not end up with a row full
 *   of blanks that later reads as "already set up".
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { routeExtractedFactsToBusinessProfile } from "@/services/ExtractionRoutingService";
import { createJsonRepos } from "./_helpers/provider";
import type { KnowledgeQuestionAnswer } from "@/lib/types";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

function caseWorkspace(slug: string): string {
  return `ws_golden_profileroute_${slug}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

let seq = 0;
function answer(
  workspaceId: string,
  domainKey: string,
  questionKey: string,
  text: string,
  answerStatus: KnowledgeQuestionAnswer["answerStatus"] = "answered",
): KnowledgeQuestionAnswer {
  seq++;
  return {
    id: `kqa_golden_${seq}`,
    workspaceId,
    domainKey,
    questionKey,
    question: `${domainKey}/${questionKey}`,
    answer: text,
    answerStatus,
    sourceType: "document",
    confidenceScore: 0.9,
    usedByAgentsJson: {},
    mapsToJson: { values: ["business_profile"] },
    humanReviewRequired: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** The six facts a real extraction pulled out of the live deployment's document. */
function extractedFacts(ws: string): KnowledgeQuestionAnswer[] {
  return [
    answer(ws, "factual_company_profile", "legal_company_name", "TechNova Solutions"),
    answer(ws, "factual_company_profile", "industry", "Enterprise software solutions"),
    answer(ws, "factual_company_profile", "website", "technovasolutions.com"),
    answer(ws, "factual_company_profile", "email", "contact@technovasolutions.com"),
    answer(ws, "factual_company_profile", "address_location", "New York, USA"),
    answer(ws, "company_knowledge", "business_type", "Service provider"),
  ];
}

test("CASE A — a document-only extraction creates the DRAFT profile the rest of the product is gated on", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("A");
  assert.strictEqual(await repos.businessProfile.getByWorkspace(WS), undefined, "precondition: no profile yet");

  const result = await routeExtractedFactsToBusinessProfile(WS, extractedFacts(WS), "golden:A", repos);
  assert.strictEqual(result.created, true, "a workspace with no profile must get one");
  assert.strictEqual(result.filled, 6, `all six mapped facts are written, got ${result.filled}`);

  const profile = await repos.businessProfile.getByWorkspace(WS);
  assert.ok(profile, "the profile must actually be readable back — this is the row ICP generation is gated on");
  assert.strictEqual(profile!.companyName, "TechNova Solutions");
  assert.strictEqual(profile!.industry, "Enterprise software solutions");
  assert.strictEqual(profile!.websiteUrl, "technovasolutions.com");
  assert.strictEqual(profile!.contactEmail, "contact@technovasolutions.com");
  assert.strictEqual(profile!.address, "New York, USA");
  assert.strictEqual(profile!.businessType, "Service provider");
  assert.strictEqual(profile!.status, "draft", "extraction proposes, the owner approves — never auto-approved");
});

test("CASE B — an answer the model did not settle never reaches the profile", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("B");
  const unsettled: KnowledgeQuestionAnswer[] = [
    answer(WS, "factual_company_profile", "legal_company_name", "TechNova Solutions"),
    answer(WS, "factual_company_profile", "phone_whatsapp", "+1-555-0198", "needs_review"),
    answer(WS, "factual_company_profile", "industry", "Maybe software", "partial"),
    answer(WS, "factual_company_profile", "website", "wrong.example", "conflict"),
    answer(WS, "factual_company_profile", "email", "", "unanswered"),
  ];
  const result = await routeExtractedFactsToBusinessProfile(WS, unsettled, "golden:B", repos);
  assert.strictEqual(result.filled, 1, `only the one settled answer is written, got ${result.filled}`);

  const profile = await repos.businessProfile.getByWorkspace(WS);
  assert.strictEqual(profile!.companyName, "TechNova Solutions");
  assert.ok(!profile!.contactPhone, `a needs_review phone must not become a company fact, got ${profile!.contactPhone}`);
  assert.ok(!profile!.industry, `a partial answer must not become a company fact, got ${profile!.industry}`);
  assert.ok(!profile!.websiteUrl, `a conflicted answer must not become a company fact, got ${profile!.websiteUrl}`);
  assert.ok(!profile!.contactEmail, `an unanswered question must not become a company fact, got ${profile!.contactEmail}`);
});

test("CASE C — an existing profile is filled where empty, left alone where equal, and conflict-carded where different", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("C");
  // An owner-entered profile: one field already correct, one field they set to
  // something the document disagrees with, one field left blank.
  await repos.businessProfile.create({
    id: "profile_golden_C",
    workspaceId: WS,
    companyName: "TechNova Solutions",       // same as extraction → no-op
    industry: "Industrial fasteners",        // differs from extraction → conflict
    status: "approved",
  } as never);

  const facts = [
    answer(WS, "factual_company_profile", "legal_company_name", "TechNova Solutions"),
    answer(WS, "factual_company_profile", "industry", "Enterprise software solutions"),
    answer(WS, "factual_company_profile", "email", "contact@technovasolutions.com"),
  ];
  const result = await routeExtractedFactsToBusinessProfile(WS, facts, "golden:C", repos);

  assert.strictEqual(result.created, false, "an existing profile is updated, never re-created");
  assert.strictEqual(result.skipped, 1, `the identical value is a no-op, got ${result.skipped} skipped`);
  assert.strictEqual(result.filled, 1, `only the empty field is filled, got ${result.filled} filled`);
  assert.strictEqual(result.conflictsCreated, 1, `the disagreement is carded, got ${result.conflictsCreated} conflicts`);

  const profile = await repos.businessProfile.getByWorkspace(WS);
  assert.strictEqual(profile!.industry, "Industrial fasteners", "the owner's value must survive — extraction does not overwrite it");
  assert.strictEqual(profile!.contactEmail, "contact@technovasolutions.com", "the empty field is safe to fill");

  const conflicts = await repos.settingsConflict.listByWorkspace(WS);
  const card = conflicts.find((c) => c.fieldKey === "industry");
  assert.ok(card, "a differing value must leave the owner a review card, not vanish");
  assert.strictEqual(card!.settingsArea, "profile");
  assert.strictEqual(card!.existingValue, "Industrial fasteners");
  assert.strictEqual(card!.extractedValue, "Enterprise software solutions");
  assert.strictEqual(card!.status, "open");
});

test("CASE D — an extraction that found nothing about the company invents no profile", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("D");
  const irrelevant = [
    answer(WS, "shipping_delivery", "delivery_timelines", "Digital delivery within 24 hours"),
    answer(WS, "faqs", "free_trial", "14-day free trial"),
  ];
  const result = await routeExtractedFactsToBusinessProfile(WS, irrelevant, "golden:D", repos);
  assert.strictEqual(result.created, false);
  assert.strictEqual(result.filled, 0);
  assert.strictEqual(
    await repos.businessProfile.getByWorkspace(WS),
    undefined,
    "a blank profile row would read as 'already set up' and hide the fact that nothing is known",
  );
});

// --- RUNNER ---------------------------------------------------------------------
(async () => {
  console.log("golden-business-profile-routing — N-BUG (a document-only onboarding must produce the profile the product is gated on)\n");
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log("");
  console.log(`business-profile-routing: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
