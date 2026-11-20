/**
 * knowledge-fact-groups.ts — N-AI-3 (2026-08-18).
 *
 * THE PROBLEM THIS EXISTS TO SOLVE
 * --------------------------------
 * Contradiction detection in KnowledgeAnswerMergeService is keyed on QUESTION
 * IDENTITY: it compares an incoming answer against the canonical answer filed
 * under the same `(domainKey, questionKey)`. That catches "two documents answer
 * the same question differently". It cannot catch "two documents state the same
 * real-world FACT differently under two different questions".
 *
 * Measured, on a real DeepSeek extraction over the 18 fixture documents:
 *   product_varieties/minimum_quantities_by_variety
 *     -> "Zari thread (all grades) has a minimum of 5 kg per shade..."   (official policy doc)
 *   pricing_policy/moq_policy
 *     -> "Zari thread has a minimum order of 10 kg per shade..."         (informal sales note)
 * Both live, both unflagged, both retrievable. A customer is quoted 5 kg or
 * 10 kg depending on which question the retriever happens to match.
 *
 * A fact group names the set of question keys that describe ONE real-world
 * fact, so answers filed under different questions can finally be compared.
 *
 * WHERE THE GROUPS COME FROM (and why it is derived, not hand-written twice)
 * -------------------------------------------------------------------------
 * `StructuredSettingsQuestionMappingService.mappings` ALREADY encodes exactly
 * this idea: it lists, per settings field, the question keys that mean the same
 * thing (`sales.defaultMOQ` <- ["minimum_quantities_by_variety",
 * "deep_06_variant_specific_moq_or_pack_size_rules"]). Copying that table into a
 * second hand-maintained list guarantees drift, so the groups are DERIVED from
 * it. Adding a new settings field therefore extends conflict coverage for free.
 *
 * WHY THERE IS ALSO AN EXTRAS TABLE
 * ---------------------------------
 * The settings mapping is a WRITE path: `syncStructuredSettingsToQuestions`
 * overwrites the answer of every question key it lists. So it is deliberately
 * NARROW — you do not want editing `sales.defaultMOQ` to also overwrite the
 * `pricing_policy/moq_policy` answer that came from a source document.
 * Conflict detection is a READ path and wants to be WIDE. Those are different
 * requirements, so widening the write table to fix N-AI-3 would have been the
 * wrong fix: it would have traded a wrong-answer bug for a silent-overwrite bug.
 * The extras below are cross-domain siblings that belong in the comparison but
 * must stay out of the write path.
 */
import { mappings as settingsFieldMappings } from "@/services/StructuredSettingsQuestionMappingService";

export type FactGroupMember = { domainKey: string; questionKey: string };

export type FactGroup = {
  /** Stable id, e.g. "sales.defaultMOQ". Used in review-item text and goldens. */
  factKey: string;
  /** Human label shown to the owner, e.g. "Default MOQ". */
  label: string;
  members: FactGroupMember[];
};

/**
 * Cross-domain siblings the settings write-path deliberately excludes.
 *
 * Each entry is a REAL same-fact pair, verified against
 * knowledge-question-framework.ts, not a hook for one test:
 *
 *  - sales.defaultMOQ <- pricing_policy/moq_policy
 *      "What minimum order quantity rules apply?" is the same fact as
 *      "Are MOQ rules different by variety or product line?". This is the
 *      N-AI-3 pair itself.
 *
 *  - sales.quotationValidity <- samples_catalogue_quotation_rules/quotation_validity
 *      Found while fixing N-AI-3: the settings mapping already groups
 *      `gst_quotation_validity` with `deep_08_quotation_validity_period`, but
 *      the framework defines a THIRD question, "How long is a quotation valid?",
 *      in the samples/quotation domain. Same bug class, same shape, so it is
 *      fixed at the same time rather than waiting to be re-discovered.
 */
const EXTRA_FACT_GROUP_MEMBERS: Record<string, FactGroupMember[]> = {
  "sales.defaultMOQ": [{ domainKey: "pricing_policy", questionKey: "moq_policy" }],
  "sales.quotationValidity": [
    { domainKey: "samples_catalogue_quotation_rules", questionKey: "quotation_validity" },
  ],
};

function memberKey(member: FactGroupMember) {
  return `${member.domainKey}/${member.questionKey}`;
}

/**
 * Build the fact groups. Only groups with 2+ DISTINCT members are returned —
 * a group of one can never contain a disagreement, and returning it would just
 * make callers loop over nothing.
 */
export function getFactGroups(): FactGroup[] {
  const groups: FactGroup[] = [];

  for (const mapping of settingsFieldMappings) {
    const factKey = `${mapping.area}.${mapping.field}`;
    const seen = new Set<string>();
    const members: FactGroupMember[] = [];

    for (const questionKey of mapping.questionKeys) {
      const member = { domainKey: mapping.domainKey, questionKey };
      if (seen.has(memberKey(member))) continue;
      seen.add(memberKey(member));
      members.push(member);
    }
    for (const member of EXTRA_FACT_GROUP_MEMBERS[factKey] || []) {
      if (seen.has(memberKey(member))) continue;
      seen.add(memberKey(member));
      members.push(member);
    }

    if (members.length < 2) continue;
    groups.push({ factKey, label: mapping.label, members });
  }

  return groups;
}
