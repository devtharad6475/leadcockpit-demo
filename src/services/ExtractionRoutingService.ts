import { createRepositories } from "@/repositories";
import type { KnowledgeQuestionAnswer, SettingsConflict } from "@/lib/types";
import { timestamp, uid } from "@/lib/db";
import { coerceSettingValue } from "@/lib/settings-field-shapes";
import { NeedsActionError } from "@/lib/user-errors";

type SettingTarget = {
  area: "sales" | "product" | "policy" | "communication";
  fieldKey: string;
  label: string;
};

/**
 * Phase 2.1 audit fix: these setting areas/fields are "sensitive" — they
 * involve payment, credit, delivery, returns, pricing, or commitments that
 * must NEVER be auto-written from extraction. Even when the field is empty,
 * the extracted value goes into a review card (SettingsConflict) for the owner
 * to explicitly approve. This prevents the AI from silently setting business
 * commitments that affect money, legal obligations, or customer expectations.
 */
const SENSITIVE_FIELD_KEYS = new Set([
  "standardCreditPeriod", "advancePaymentRule", "defaultMOQ", "priceDiscussionRule",
  "discountNegotiationRules", "shippingDeliveryPolicy", "returnReplacementPolicy",
  "paymentPolicy", "creditPolicy", "customizationPolicy", "priceReplyRule",
  "creditPaymentReplyRule", "bulkOrderRule", "quotationValidity",
]);

function isSensitiveField(fieldKey: string): boolean {
  return SENSITIVE_FIELD_KEYS.has(fieldKey);
}

const questionToSettingMappings: Array<{ domainKey: string; questionKey: string; target: SettingTarget }> = [
  { domainKey: "product_varieties", questionKey: "minimum_quantities_by_variety", target: { area: "sales", fieldKey: "defaultMOQ", label: "Default MOQ" } },
  { domainKey: "payment_credit_terms", questionKey: "credit_period", target: { area: "sales", fieldKey: "standardCreditPeriod", label: "Credit period" } },
  { domainKey: "payment_credit_terms", questionKey: "gst_quotation_validity", target: { area: "sales", fieldKey: "quotationValidity", label: "Quotation validity" } },
  { domainKey: "payment_credit_terms", questionKey: "advance_payment_rule", target: { area: "sales", fieldKey: "advancePaymentRule", label: "Advance payment rule" } },
  { domainKey: "samples_catalogue_quotation_rules", questionKey: "sample_available", target: { area: "sales", fieldKey: "sampleAvailability", label: "Sample availability" } },
  { domainKey: "samples_catalogue_quotation_rules", questionKey: "bulk_order_rule", target: { area: "sales", fieldKey: "bulkOrderRule", label: "Bulk order rule" } },
  { domainKey: "lead_qualification", questionKey: "mql_rules", target: { area: "sales", fieldKey: "leadQualificationThresholds", label: "Lead qualification thresholds" } },
  { domainKey: "lead_qualification", questionKey: "hot_lead_signals", target: { area: "sales", fieldKey: "humanReviewTriggers", label: "Human review triggers" } },
  { domainKey: "pricing_policy", questionKey: "pricing_structure", target: { area: "sales", fieldKey: "priceDiscussionRule", label: "Price discussion rule" } },
  { domainKey: "pricing_policy", questionKey: "discount_policy", target: { area: "sales", fieldKey: "discountNegotiationRules", label: "Discount/negotiation rules" } },
  { domainKey: "shipping_delivery", questionKey: "delivery_timelines", target: { area: "policy", fieldKey: "shippingDeliveryPolicy", label: "Shipping/delivery policy" } },
  { domainKey: "returns_replacement", questionKey: "return_allowed", target: { area: "policy", fieldKey: "returnReplacementPolicy", label: "Return/replacement policy" } },
  { domainKey: "payment_credit_terms", questionKey: "payment_methods", target: { area: "policy", fieldKey: "paymentPolicy", label: "Payment policy" } },
  { domainKey: "payment_credit_terms", questionKey: "credit_allowed", target: { area: "policy", fieldKey: "creditPolicy", label: "Credit policy" } },
  { domainKey: "customization", questionKey: "customization_available", target: { area: "policy", fieldKey: "customizationPolicy", label: "Customization policy" } },
  { domainKey: "samples_catalogue_quotation_rules", questionKey: "catalogue_available", target: { area: "policy", fieldKey: "samplePolicy", label: "Sample/catalogue policy" } },
  { domainKey: "whatsapp_communication", questionKey: "preferred_tone", target: { area: "communication", fieldKey: "tone", label: "Communication tone" } },
  { domainKey: "whatsapp_communication", questionKey: "unknown_answer_reply", target: { area: "communication", fieldKey: "defaultFallbackReply", label: "Default fallback reply" } },
  { domainKey: "whatsapp_communication", questionKey: "auto_reply_boundaries", target: { area: "communication", fieldKey: "allowedAutoReplyTopics", label: "Allowed auto-reply topics" } },
  { domainKey: "whatsapp_communication", questionKey: "abusive_customer_handling", target: { area: "communication", fieldKey: "abusiveMessageRule", label: "Abusive message rule" } },
  { domainKey: "pricing_policy", questionKey: "price_faq", target: { area: "communication", fieldKey: "priceReplyRule", label: "Price reply rule" } },
  { domainKey: "payment_credit_terms", questionKey: "credit_eligibility", target: { area: "communication", fieldKey: "creditPaymentReplyRule", label: "Credit/payment reply rule" } },
  { domainKey: "returns_replacement", questionKey: "complaint_escalation", target: { area: "communication", fieldKey: "complaintReplyRule", label: "Complaint reply rule" } },
  { domainKey: "whatsapp_communication", questionKey: "language_preferences", target: { area: "communication", fieldKey: "unknownAnswerBehavior", label: "Unknown-answer behavior" } },
];

/**
 * N-BUG (2026-09-07) — the business-profile routing that did not exist.
 *
 * The question framework tags each of its 424 questions with the areas its
 * answer feeds, and eight of them say `business_profile`. Nothing read that
 * tag. routeExtractedFactsToSettings covers sales/product/policy/communication
 * only, and the unified onboarding bundle has no other profile writer — so a
 * workspace onboarded from documents alone ended with BusinessProfile null
 * forever. That is not cosmetic: the Ideal Customers button is
 * `disabled={!profile}`, Campaign and Discovery sit behind it, and Sync
 * Knowledge reports "Business profile not found". The Profile screen renders
 * "No profile yet." with no form and no button, so there was no way out of it
 * from the UI at all. Measured on the live deployment: a real extraction pulled
 * the company name, industry, website, email, phone and address correctly out
 * of the document, and every one of them was dropped on the floor.
 *
 * The profile is created in `draft` status, which is the product's existing
 * review gate (`POST /api/business-profile/:id/approve`). Only answers the
 * model marked `answered` are used — `needs_review`, `partial` and `conflict`
 * stay out of the profile and remain the operator's decision. An existing
 * profile is never overwritten: an empty field is filled, an identical value is
 * a no-op, and a differing value becomes a SettingsConflict card, the same
 * pattern the settings routing above uses.
 */
const questionToProfileMappings: Array<{ domainKey: string; questionKey: string; fieldKey: ProfileFieldKey; label: string }> = [
  { domainKey: "factual_company_profile", questionKey: "legal_company_name", fieldKey: "companyName", label: "Company name" },
  { domainKey: "factual_company_profile", questionKey: "industry", fieldKey: "industry", label: "Industry" },
  { domainKey: "factual_company_profile", questionKey: "website", fieldKey: "websiteUrl", label: "Website" },
  { domainKey: "factual_company_profile", questionKey: "email", fieldKey: "contactEmail", label: "Contact email" },
  { domainKey: "factual_company_profile", questionKey: "phone_whatsapp", fieldKey: "contactPhone", label: "Contact phone" },
  { domainKey: "factual_company_profile", questionKey: "address_location", fieldKey: "address", label: "Address" },
  { domainKey: "company_knowledge", questionKey: "business_type", fieldKey: "businessType", label: "Business type" },
  { domainKey: "company_knowledge", questionKey: "company_overview", fieldKey: "description", label: "Description" },
];

const PROFILE_FIELD_KEYS = new Set<string>(questionToProfileMappings.map((mapping) => mapping.fieldKey));
const RESOLUTIONS = new Set(["keep_existing", "use_extracted", "custom", "keep_both", "not_applicable"]);

type ProfileFieldKey = "companyName" | "industry" | "websiteUrl" | "contactEmail" | "contactPhone" | "address" | "businessType" | "description";

export type ProfileRoutingResult = {
  created: boolean;
  filled: number;
  conflictsCreated: number;
  skipped: number;
  details: Array<{ fieldKey: string; action: "filled" | "conflict" | "skipped"; value: string }>;
};

export async function routeExtractedFactsToBusinessProfile(
  workspaceId: string,
  answers: KnowledgeQuestionAnswer[],
  extractedSource: string,
  repos = createRepositories()
): Promise<ProfileRoutingResult> {
  const result: ProfileRoutingResult = { created: false, filled: 0, conflictsCreated: 0, skipped: 0, details: [] };

  const patch: Partial<Record<ProfileFieldKey, string>> = {};
  for (const answer of answers) {
    // Only settled answers. A model that told us it is unsure does not get to
    // write the facts the agent repeats to customers.
    if (answer.answerStatus !== "answered") continue;
    const value = answer.answer?.trim();
    if (!value) continue;
    const mapping = questionToProfileMappings.find(
      (m) => m.domainKey === answer.domainKey && m.questionKey === answer.questionKey
    );
    if (!mapping) continue;
    patch[mapping.fieldKey] = value;
  }
  if (!Object.keys(patch).length) return result;

  const existing = await repos.businessProfile.getByWorkspace(workspaceId);
  if (!existing) {
    await repos.businessProfile.create({
      id: uid("profile"),
      workspaceId,
      status: "draft",
      ...patch,
      createdAt: timestamp(),
      updatedAt: timestamp(),
    } as never);
    result.created = true;
    result.filled = Object.keys(patch).length;
    result.details = Object.entries(patch).map(([fieldKey, value]) => ({ fieldKey, action: "filled" as const, value }));
    return result;
  }

  // 2026-09-26 (break test): reading the same documents again raised the same
  // profile conflict card again — the settings routing below already checked
  // for an open card; this path did not.
  const openProfileConflicts = await repos.settingsConflict.listByWorkspace(workspaceId, { status: "open", settingsArea: "profile" });
  const safePatch: Record<string, string> = {};
  for (const [fieldKey, value] of Object.entries(patch) as Array<[ProfileFieldKey, string]>) {
    const currentValue = (existing as unknown as Record<string, unknown>)[fieldKey];
    const currentText = currentValue === undefined || currentValue === null ? "" : String(currentValue);
    if (!currentText.trim()) {
      safePatch[fieldKey] = value;
      result.filled++;
      result.details.push({ fieldKey, action: "filled", value });
    } else if (normalizeSettingValue(currentText) === normalizeSettingValue(value)) {
      result.skipped++;
      result.details.push({ fieldKey, action: "skipped", value });
    } else if (openProfileConflicts.some((c) => c.fieldKey === fieldKey && normalizeSettingValue(String(c.extractedValue || "")) === normalizeSettingValue(value))) {
      result.skipped++;
      result.details.push({ fieldKey, action: "skipped", value });
    } else {
      await repos.settingsConflict.create(workspaceId, {
        settingsArea: "profile",
        fieldKey,
        existingValue: currentText,
        extractedValue: value,
        extractedSource,
        status: "open",
      });
      result.conflictsCreated++;
      result.details.push({ fieldKey, action: "conflict", value });
    }
  }
  if (Object.keys(safePatch).length) {
    await repos.businessProfile.update(workspaceId, existing.id, safePatch as never);
  }
  return result;
}

export type ExtractionRoutingResult = {
  filled: number;
  conflictsCreated: number;
  skipped: number;
  details: Array<{ settingArea: string; fieldKey: string; action: "filled" | "conflict" | "skipped"; value: string }>;
};

export async function routeExtractedFactsToSettings(
  workspaceId: string,
  answers: KnowledgeQuestionAnswer[],
  extractedSource: string,
  repos = createRepositories(),
  /**
   * N-BUG (2026-09-08). `autoFillEmpty: false` cards every field instead of
   * writing the empty ones.
   *
   * Filling an empty non-sensitive field is right when the owner just asked for
   * a website crawl or ran onboarding: they requested the extraction, and the
   * facts come from their own site. It is NOT right for Sync Knowledge, whose
   * answers come from Information Needed — text the owner typed to teach the
   * agent, not to configure the business. The rule those answers live under is
   * that they become settings only through the draft-and-save review, and
   * smoke-group-answer-concurrency asserts exactly that:
   *
   *   "Information Needed answers should not silently become Sales settings
   *    before owner review"
   *
   * Sync Knowledge began re-applying stored answers to settings to repair a
   * paymentPolicy that had been approved and lost. That repair is correct and
   * still happens — as a review card, which is what it always produced for
   * sensitive fields. This flag stops the non-sensitive half writing silently.
   */
  options: { autoFillEmpty?: boolean } = {},
): Promise<ExtractionRoutingResult> {
  const autoFillEmpty = options.autoFillEmpty !== false;
  const result: ExtractionRoutingResult = { filled: 0, conflictsCreated: 0, skipped: 0, details: [] };

  const salesSettings = (await repos.salesSettings.getByWorkspace(workspaceId)) || undefined;
  const policySettings = (await repos.policySettings.getByWorkspace(workspaceId)) || undefined;
  const communicationSettings = (await repos.communicationSettings.getByWorkspace(workspaceId)) || undefined;

  // N-BUG (2026-09-08): every create below was unconditional, so running this
  // twice over the same answers left the operator two identical review cards
  // for the same field — and sensitive fields ALWAYS card, so they duplicated
  // on every single run. Harmless when routing only ever ran once per
  // extraction; not harmless now that Sync Knowledge re-applies stored answers
  // to repair a lost setting.
  const openConflicts = await repos.settingsConflict.listByWorkspace(workspaceId, { status: "open" });
  const alreadyOpen = (area: string, fieldKey: string, extractedValue: string) =>
    openConflicts.some((c) => c.settingsArea === area && c.fieldKey === fieldKey
      && normalizeSettingValue(String(c.extractedValue || "")) === normalizeSettingValue(extractedValue));

  for (const answer of answers) {
    if (!answer.answer?.trim()) continue;
    const mapping = questionToSettingMappings.find(
      (m) => m.domainKey === answer.domainKey && m.questionKey === answer.questionKey
    );
    if (!mapping) continue;

    const { area, fieldKey } = mapping.target;
    const newValue = answer.answer.trim();

    const currentValue = getSettingValue(area, fieldKey, { salesSettings, policySettings, communicationSettings });

    // Phase 2.1: sensitive fields (payment, credit, delivery, returns, pricing)
    // NEVER auto-write — always create a review card, even when empty.
    if (isSensitiveField(fieldKey)) {
      if (alreadyOpen(area, fieldKey, newValue)) {
        result.skipped++;
        result.details.push({ settingArea: area, fieldKey, action: "skipped", value: newValue });
      } else if (!currentValue || !String(currentValue).trim() || normalizeSettingValue(String(currentValue)) !== normalizeSettingValue(newValue)) {
        await repos.settingsConflict.create(workspaceId, {
          settingsArea: area,
          fieldKey,
          existingValue: currentValue ? String(currentValue) : "",
          extractedValue: newValue,
          extractedSource,
          status: "open",
        });
        result.conflictsCreated++;
        result.details.push({ settingArea: area, fieldKey, action: "conflict", value: newValue });
      } else {
        result.skipped++;
        result.details.push({ settingArea: area, fieldKey, action: "skipped", value: newValue });
      }
    } else if (!currentValue || !String(currentValue).trim()) {
      if (!autoFillEmpty) {
        // Card it instead of writing it — see `options.autoFillEmpty` above.
        if (alreadyOpen(area, fieldKey, newValue)) {
          result.skipped++;
          result.details.push({ settingArea: area, fieldKey, action: "skipped", value: newValue });
        } else {
          await repos.settingsConflict.create(workspaceId, {
            settingsArea: area,
            fieldKey,
            existingValue: "",
            extractedValue: newValue,
            extractedSource,
            status: "open",
          });
          result.conflictsCreated++;
          result.details.push({ settingArea: area, fieldKey, action: "conflict", value: newValue });
        }
        continue;
      }
      // Non-sensitive field is empty — fill it safely
      await setSettingValue(workspaceId, area, fieldKey, newValue, repos);
      result.filled++;
      result.details.push({ settingArea: area, fieldKey, action: "filled", value: newValue });
    } else if (normalizeSettingValue(String(currentValue)) !== normalizeSettingValue(newValue)) {
      if (alreadyOpen(area, fieldKey, newValue)) {
        result.skipped++;
        result.details.push({ settingArea: area, fieldKey, action: "skipped", value: newValue });
        continue;
      }
      // Different from existing — create conflict
      await repos.settingsConflict.create(workspaceId, {
        settingsArea: area,
        fieldKey,
        existingValue: String(currentValue),
        extractedValue: newValue,
        extractedSource,
        status: "open",
      });
      result.conflictsCreated++;
      result.details.push({ settingArea: area, fieldKey, action: "conflict", value: newValue });
    } else {
      result.skipped++;
      result.details.push({ settingArea: area, fieldKey, action: "skipped", value: newValue });
    }
  }

  return result;
}

function getSettingValue(
  area: string,
  fieldKey: string,
  settings: {
    salesSettings?: { [key: string]: unknown };
    policySettings?: { [key: string]: unknown };
    communicationSettings?: { [key: string]: unknown };
  }
): unknown {
  if (area === "sales") return settings.salesSettings?.[fieldKey];
  if (area === "policy") return settings.policySettings?.[fieldKey];
  if (area === "communication") return settings.communicationSettings?.[fieldKey];
  return undefined;
}

async function setSettingValue(
  workspaceId: string,
  area: string,
  fieldKey: string,
  rawValue: string,
  repos: ReturnType<typeof createRepositories>
) {
  // 2026-09-01 (N-DATA-22) — this function takes a string and assigns it to
  // `[fieldKey]` whatever that field's declared shape is. Two communication
  // fields are `string[]`, and their Prisma columns are `Json?`, so a routed
  // sentence was stored as a sentence, accepted by Postgres, accepted by the
  // type checker, and only noticed when the Settings screen called `.join` on
  // it and crashed the whole panel into the route error boundary.
  //
  // Coercing HERE rather than at each of the three call sites is deliberate:
  // this is the single chokepoint every settings write passes through
  // (extraction routing AND conflict resolution), so a new list-typed field
  // needs one entry in LIST_SETTING_FIELDS and nothing else.
  const value = coerceSettingValue(area, fieldKey, rawValue);
  // Stage A+ / Cluster 10d (P2-14): spread only KNOWN fields, not the entire
  // existing record. The previous `{...existing, [fieldKey]: value}` would
  // silently persist stale/unknown fields from older data shapes or schema
  // drift. Now we destructure the known fields explicitly and pass only those
  // — a new field added to the type is a compile error here until wired.
  //
  // 2026-07-26 Session 4 audit fix (P2-P2-14-NOTDONE): the original comment
  // claimed an "explicit destructure" but the code still spread `{...existing}`.
  // Now we ACTUALLY destructure per type so adding a new field to SalesSettings
  // / PolicySettings / CommunicationSettings makes this a compile error until
  // the field is wired here. Compile-time guarantee > runtime hope.
  if (area === "sales") {
    const existing = await repos.salesSettings.getByWorkspace(workspaceId);
    // Destructure EVERY known SalesSettings field (matches src/lib/types.ts).
    // A new field added to the type but not listed here = TS2339 (or TS2741
    // missing-property) at the upsertForWorkspace call below.
    const {
      id, workspaceId: _ws, createdAt: _ca, updatedAt: _ua,
      defaultMOQ, productWiseMOQ, standardCreditPeriod, maxCreditPeriod,
      advancePaymentRule, sampleAvailability, quotationValidity, bulkOrderRule,
      leadQualificationThresholds, humanReviewTriggers, priceDiscussionRule,
      discountNegotiationRules,
    } = (existing || {}) as Record<string, unknown>;
    await repos.salesSettings.upsertForWorkspace(workspaceId, {
      id, workspaceId, createdAt: _ca as string | undefined, updatedAt: new Date().toISOString(),
      defaultMOQ, productWiseMOQ, standardCreditPeriod, maxCreditPeriod,
      advancePaymentRule, sampleAvailability, quotationValidity, bulkOrderRule,
      leadQualificationThresholds, humanReviewTriggers, priceDiscussionRule,
      discountNegotiationRules,
      // The override — the one fresh field for this write.
      [fieldKey]: value,
    } as Record<string, unknown> as Parameters<typeof repos.salesSettings.upsertForWorkspace>[1]);
  } else if (area === "policy") {
    const existing = await repos.policySettings.getByWorkspace(workspaceId);
    const {
      id, workspaceId: _ws, createdAt: _ca, updatedAt: _ua,
      paymentPolicy, creditPolicy, shippingDeliveryPolicy, returnReplacementPolicy,
      cancellationPolicy, customizationPolicy, samplePolicy,
    } = (existing || {}) as Record<string, unknown>;
    await repos.policySettings.upsertForWorkspace(workspaceId, {
      id, workspaceId, createdAt: _ca as string | undefined, updatedAt: new Date().toISOString(),
      paymentPolicy, creditPolicy, shippingDeliveryPolicy, returnReplacementPolicy,
      cancellationPolicy, customizationPolicy, samplePolicy,
      [fieldKey]: value,
    } as Record<string, unknown> as Parameters<typeof repos.policySettings.upsertForWorkspace>[1]);
  } else if (area === "communication") {
    const existing = await repos.communicationSettings.getByWorkspace(workspaceId);
    const {
      id, workspaceId: _ws, createdAt: _ca, updatedAt: _ua,
      tone, defaultFallbackReply, allowedAutoReplyTopics, humanReviewRequiredTopics,
      priceReplyRule, creditPaymentReplyRule, complaintReplyRule, abusiveMessageRule,
      stopUnsubscribeBehavior, unknownAnswerBehavior,
    } = (existing || {}) as Record<string, unknown>;
    await repos.communicationSettings.upsertForWorkspace(workspaceId, {
      id, workspaceId, createdAt: _ca as string | undefined, updatedAt: new Date().toISOString(),
      tone, defaultFallbackReply, allowedAutoReplyTopics, humanReviewRequiredTopics,
      priceReplyRule, creditPaymentReplyRule, complaintReplyRule, abusiveMessageRule,
      stopUnsubscribeBehavior, unknownAnswerBehavior,
      // The two topic fields are LISTS; a text answer used to be stored as
      // one string, and the settings screen then could not be saved
      // (break test, 2026-09-26). Text becomes one item per line.
      [fieldKey]: (fieldKey === "allowedAutoReplyTopics" || fieldKey === "humanReviewRequiredTopics") && typeof value === "string"
        ? value.split(/\n|;/).map((item) => item.trim()).filter(Boolean)
        : value,
    } as Record<string, unknown> as Parameters<typeof repos.communicationSettings.upsertForWorkspace>[1]);
  }
}

function normalizeSettingValue(value: string) {
  let stripped = value.trim();
  for (let index = 0; index < 3; index += 1) {
    const next = stripped.replace(/^[a-z0-9/&() -]{2,60}:\s*/i, "").trim();
    if (next === stripped) break;
    stripped = next;
  }
  return stripped
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

export async function resolveSettingsConflict(
  workspaceId: string,
  conflictId: string,
  resolution: SettingsConflict["resolution"],
  customValue?: string,
  reason?: string,
  repos = createRepositories()
) {
  // N-BUG (2026-09-08) — this used to mark the conflict resolved FIRST and
  // apply the value afterwards. When the write threw, the card was already
  // gone from the operator's queue and the setting had never been written:
  // the product reported "resolved" for a policy that did not exist. Measured
  // live — a Date-serialization fault made paymentPolicy's write 500 three
  // times, and the conflict still ended up `resolved` with the policy column
  // empty. Nothing would ever show it again.
  //
  // Write the setting first, then record the decision. A failed write now
  // leaves the conflict open, which is the state that tells the truth.
  const pending = await repos.settingsConflict.getById(workspaceId, conflictId);
  if (!pending) throw new Error("Settings conflict not found.");
  // 2026-09-26 (break test): a card already decided could be decided again —
  // a second click with the other button flipped the setting back — and any
  // made-up choice, or a blank custom value, closed the card with nothing
  // written. All three are refused in plain words now.
  if (pending.status !== "open") throw new NeedsActionError("This difference has already been decided.", 409);
  if (!RESOLUTIONS.has(String(resolution))) throw new NeedsActionError("Choose which value to keep.", 400);
  if (resolution === "custom" && !(typeof customValue === "string" && customValue.trim())) throw new NeedsActionError("Write the value you want to keep.", 400);

  let valueToApply: string | undefined;
  if (resolution === "keep_existing") {
    valueToApply = pending.existingValue || undefined;
  } else if (resolution === "use_extracted") {
    valueToApply = pending.extractedValue || undefined;
  } else if (resolution === "custom") {
    valueToApply = customValue || undefined;
  } else if (resolution === "keep_both") {
    valueToApply = `${pending.existingValue || ""} | Also: ${pending.extractedValue || ""}`;
  }

  if (valueToApply !== undefined && pending.settingsArea === "profile" && pending.fieldKey) {
    // 2026-09-26 (break test): profile cards (company name, address…) were
    // marked resolved while setSettingValue, which knows only the four
    // settings areas, wrote nothing — "use the document's value" changed
    // nothing. The profile is written through its own repository.
    const profile = await repos.businessProfile.getByWorkspace(workspaceId);
    if (profile?.id && PROFILE_FIELD_KEYS.has(pending.fieldKey)) {
      await repos.businessProfile.update(workspaceId, profile.id, { [pending.fieldKey]: valueToApply.trim() } as never);
    }
  } else if (valueToApply !== undefined && pending.settingsArea && pending.fieldKey) {
    await setSettingValue(workspaceId, pending.settingsArea, pending.fieldKey, valueToApply, repos);
  }

  return repos.settingsConflict.resolve(workspaceId, conflictId, resolution, customValue, reason);
}
