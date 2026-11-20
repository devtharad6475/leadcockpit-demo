import type { BusinessExtraction, BusinessProfile, Campaign, CampaignLearning, CampaignPlan, ICP, Lead, MessageTemplate, Reply } from "./types";
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { LLMService } from "@/llm/LLMService";

const includesAny = (value: string, words: string[]) => words.some((word) => value.toLowerCase().includes(word.toLowerCase()));
const compact = <T>(items: (T | undefined | null | "")[]) => Array.from(new Set(items.filter(Boolean) as T[]));

export function extractBusinessFromPages(workspaceId: string, crawlJobId: string, pages: { title: string; text: string; emails: string[]; phones: string[]; socials: string[]; catalogues: string[] }[]): Omit<BusinessExtraction, "id" | "createdAt" | "updatedAt"> {
  const allText = pages.map((page) => `${page.title}. ${page.text}`).join(" ").slice(0, 50000);
  const homepageTitle = pages[0]?.title?.replace(/[-|].*$/, "").trim();
  const emails = compact(pages.flatMap((page) => page.emails));
  const phones = compact(pages.flatMap((page) => page.phones));
  const socials = compact(pages.flatMap((page) => page.socials));
  const catalogues = compact(pages.flatMap((page) => page.catalogues));
  // Phase 3.1 audit fix: generic product hints — no textile/zari bias.
  const productHints = [
    "software", "consulting", "manufacturing", "services", "catalogue", "bulk supply", "export",
    "products", "solutions", "platform", "equipment", "materials", "supplies",
  ].filter((hint) => includesAny(allText, [hint]));
  const strengths = [
    includesAny(allText, ["manufacturer", "manufacturing"]) ? "Manufacturing capability" : undefined,
    includesAny(allText, ["export", "international"]) ? "Export or international interest" : undefined,
    includesAny(allText, ["custom", "bespoke"]) ? "Custom work support" : undefined,
    includesAny(allText, ["catalog", "catalogue", "brochure"]) ? "Catalogue available" : undefined,
  ];
  const missingFields = [
    emails.length ? undefined : "contact_email",
    phones.length ? undefined : "contact_phone",
    includesAny(allText, ["moq", "minimum order"]) ? undefined : "minimum_order_quantity",
    includesAny(allText, ["export"]) ? undefined : "export_readiness",
    includesAny(allText, ["whatsapp", "wa.me"]) ? undefined : "whatsapp_number",
    includesAny(allText, ["customer", "client"]) ? undefined : "current_customers",
  ];

  return {
    workspaceId,
    crawlJobId,
    extractedCompanyName: homepageTitle || "Company name not found",
    extractedIndustry: inferIndustry(allText),
    extractedProducts: productHints.length ? productHints : ["Products/services found in website text"],
    extractedServices: includesAny(allText, ["service", "support"]) ? ["Customer support", "Business service"] : [],
    extractedContacts: { emails, phones },
    extractedLocations: inferLocations(allText),
    extractedSocials: socials,
    extractedStrengths: compact(strengths),
    extractedTargetCustomers: inferTargetCustomers(allText),
    extractedCertifications: includesAny(allText, ["iso", "certified"]) ? ["Certification mentioned on website"] : [],
    extractedCatalogueLinks: catalogues,
    confidence: {
      companyName: homepageTitle ? "medium" : "low",
      contacts: emails.length || phones.length ? "high" : "low",
      products: productHints.length ? "medium" : "low",
    },
    missingFields: compact(missingFields),
  };
}

export function profileFromExtraction(workspaceId: string, websiteUrl: string, extraction: BusinessExtraction): Omit<BusinessProfile, "id" | "createdAt" | "updatedAt"> {
  const contacts = extraction.extractedContacts as { emails?: string[]; phones?: string[] };
  return {
    workspaceId,
    companyName: extraction.extractedCompanyName,
    websiteUrl,
    industry: extraction.extractedIndustry,
    businessType: "To confirm",
    description: `Draft profile generated from ${websiteUrl}. Please review before campaign use.`,
    products: extraction.extractedProducts,
    services: extraction.extractedServices,
    productCategories: extraction.extractedProducts,
    contactEmail: contacts.emails?.[0],
    contactPhone: contacts.phones?.[0],
    whatsappNumber: extraction.extractedSocials.find((link) => /wa\.me|whatsapp/i.test(link)),
    address: extraction.extractedLocations.join(", "),
    city: "",
    state: "",
    country: "",
    targetGeographies: [],
    currentCustomerTypes: [],
    desiredCustomerTypes: extraction.extractedTargetCustomers,
    strengths: extraction.extractedStrengths,
    limitations: extraction.missingFields.map((field) => `${field.replaceAll("_", " ")} needs confirmation`),
    certifications: extraction.extractedCertifications,
    socialLinks: extraction.extractedSocials,
    catalogueLinks: extraction.extractedCatalogueLinks,
    proofAssets: [],
    languagePreference: "English",
    tonePreference: "Warm, concise, businesslike",
    status: "reviewed",
    fields: [
      { key: "companyName", label: "Company name", value: extraction.extractedCompanyName || "", source: "crawler", confidence: extraction.extractedCompanyName ? "medium" : "low" },
      { key: "industry", label: "Industry", value: extraction.extractedIndustry || "", source: "agent", confidence: "medium" },
      { key: "products", label: "Products/services", value: extraction.extractedProducts.join(", "), source: "agent", confidence: "medium" },
      { key: "contactEmail", label: "Email", value: contacts.emails?.[0] || "Not found", source: "crawler", confidence: contacts.emails?.[0] ? "high" : "low", missing: !contacts.emails?.[0] },
      { key: "whatsappNumber", label: "WhatsApp", value: "Not found", source: "crawler", confidence: "low", missing: true },
    ],
  };
}

/**
 * Deterministic ICP generation — the safety-net fallback.
 *
 * Phase 1.5 / skill v2 (2026-07-19): the runtime `generateICPs` (below)
 * calls the LLM first; this function is the deterministic fallback used
 * when the LLM is unavailable, in mock mode, or returns <3 ICPs. It always
 * returns exactly 3 ICPs (Direct Buyers / Manufacturers & Producers /
 * Regional Wholesalers) derived generically from the profile.
 *
 * Exported as `generateICPsDeterministicForTest` so the golden test can
 * call it directly with known inputs.
 */
export function generateICPsDeterministic(profile: BusinessProfile): Omit<ICP, "id" | "createdAt" | "updatedAt">[] {
  // Phase 3.1 audit fix: generic ICP generation — no textile/zari/fashion bias.
  // ICPs are derived from the business profile (products, industry, geography)
  // using generic buyer-type templates that work for any B2B business.
  const geography = profile.targetGeographies.length ? profile.targetGeographies : ["Multiple regions"];
  const product = profile.products[0] || profile.services[0] || "your offer";
  const industry = profile.industry || "Multiple industries";
  return [
    {
      workspaceId: profile.workspaceId,
      businessProfileId: profile.id,
      name: `Direct Buyers — ${geography[0]}`,
      description: `Retailers and end-buyers likely to purchase ${product} directly.`,
      buyerType: "Direct buyer / retailer",
      industries: [industry],
      geography: [geography[0]],
      companySizeBucket: "small company",
      likelyNeeds: [product, "catalogue access", "sample or trial support"],
      buyingTriggers: ["New product interest", "Supplier comparison", "Seasonal demand"],
      painPoints: ["Finding reliable suppliers", "Price clarity", "Minimum order flexibility"],
      preferredChannels: ["WhatsApp", "Email", "Website form"],
      messagingAngles: [`Share a concise catalogue for ${product}`, "Offer sample or trial discussion"],
      qualificationRules: ["Has active website or contact route", "Product category matches", "Reachable by WhatsApp or email"],
      confidenceScore: 0.82,
      status: "suggested",
    },
    {
      workspaceId: profile.workspaceId,
      businessProfileId: profile.id,
      name: `Manufacturers & Producers — ${geography[0]}`,
      description: `Businesses that need ${product} as input for their own production or operations.`,
      buyerType: "Production / sourcing manager",
      industries: [industry],
      geography,
      companySizeBucket: "medium company",
      likelyNeeds: [product, "consistent supply", "MOQ clarity", "quotation"],
      buyingTriggers: ["New production batch", "Supplier comparison", "Operational demand"],
      painPoints: ["Supply reliability", "Price consistency", "Quality assurance"],
      preferredChannels: ["Email", "WhatsApp", "Phone"],
      messagingAngles: ["Reliable supplier with catalogue and bulk supply"],
      qualificationRules: ["Manufactures or produces goods", "Has contact route", "Product category matches"],
      confidenceScore: 0.76,
      status: "suggested",
    },
    {
      workspaceId: profile.workspaceId,
      businessProfileId: profile.id,
      name: `Regional Wholesalers & Distributors`,
      description: "Distributors and wholesalers who resell to retailers and local markets.",
      buyerType: "Wholesaler / distributor",
      industries: ["Wholesale", industry],
      geography,
      companySizeBucket: "small company",
      likelyNeeds: ["bulk pricing", "fast catalogue review", "repeat purchase potential"],
      buyingTriggers: ["Market demand", "New supplier sourcing", "Inventory planning"],
      painPoints: ["Margin pressure", "Stock variety", "Supplier trust"],
      preferredChannels: ["WhatsApp", "Email"],
      messagingAngles: ["Ask permission to share latest wholesale catalogue and MOQ."],
      qualificationRules: ["Clearly sells to retailers", "Has phone or WhatsApp", "Location fits campaign region"],
      confidenceScore: 0.72,
      status: "suggested",
    },
  ];
}

/**
 * Runtime ICP generation — calls the LLM, falls back to deterministic.
 *
 * Phase 1.5 / skill v2 (2026-07-19): replaces the old deterministic-only
 * `generateICPs`. The LLM is asked to return 3-5 ICPs tailored to the
 * business; if the call fails, returns fewer than 3, or runs in mock mode,
 * the deterministic fallback kicks in (which always returns exactly 3).
 *
 * Operator-confirmed rule (docs/LOGIC.md, 2026-07-19):
 *   - 3-5 ICPs, count decided by AI based on business diversity.
 *   - Every required ICP field populated; confidenceScore capped at 0.9.
 *   - status="suggested" on creation.
 *   - Deterministic fallback always returns 3 — it is the floor.
 *
 * Pinned by: scripts/golden/golden-icp-generation.ts
 */
export async function generateICPs(
  profile: BusinessProfile,
  repos: RepositoryBundle = createRepositories(),
  /**
   * Test seam (S24-15), mirroring the `repos` seam on the line above. This
   * function used to build its own LLMService, and LLMService resolves a
   * provider from the workspace's routing table and its encrypted credentials
   * - so from a test there was no way to make the LLM return a specific number
   * of ICPs without real network traffic or a fake route seeded in the
   * database. scripts/golden/golden-icp-generation.ts CASE E passes a stand-in
   * here to drive the fallback rule below, which had never been executed by
   * the suite. Production callers pass nothing and get exactly the LLMService
   * they got before.
   */
  llm: Pick<LLMService, "runTask"> = new LLMService(undefined, repos),
): Promise<Omit<ICP, "id" | "createdAt" | "updatedAt">[]> {
  const deterministic = generateICPsDeterministic(profile);
  try {
    const result = await llm.runTask<{ icps?: unknown[] }>("icp_generation", {
      businessProfile: {
        companyName: profile.companyName,
        industry: profile.industry,
        businessType: profile.businessType,
        description: profile.description,
        products: profile.products,
        services: profile.services,
        targetGeographies: profile.targetGeographies,
        desiredCustomerTypes: profile.desiredCustomerTypes,
        strengths: profile.strengths,
      },
      instructions: "Return 3 to 5 ICPs tailored to this specific business. Each ICP must include name, description, buyerType, industries (array), geography (array), likelyNeeds (array), buyingTriggers (array), painPoints (array), preferredChannels (array), messagingAngles (array), qualificationRules (array), confidenceScore (number in [0,1], max 0.9). Do not invent capabilities the business does not have. If the business is single-product, return 3; if multi-product or cross-industry, up to 5.",
    }, { workspaceId: profile.workspaceId });
    const aiIcps = parseLLMICPs(result.output, profile);
    // Rule: if the LLM returned fewer than 3, the deterministic fallback
    // is the floor. Same when the run was mock mode (the generic mock
    // returns a placeholder object, not real ICPs).
    const isMockRun = result.mode === "mock" || result.provider === "mock";
    if (isMockRun || aiIcps.length < 3) {
      return deterministic;
    }
    return aiIcps;
  } catch {
    return deterministic;
  }
}

/** Parse and validate the LLM's ICP output. Drops any entry missing required fields. */
function parseLLMICPs(output: { icps?: unknown } | undefined, profile: BusinessProfile): Omit<ICP, "id" | "createdAt" | "updatedAt">[] {
  const rawIcps = Array.isArray(output?.icps) ? (output?.icps as Array<Record<string, unknown>>) : [];
  return rawIcps
    .map((raw) => normalizeLLMICP(raw, profile))
    .filter((icp): icp is Omit<ICP, "id" | "createdAt" | "updatedAt"> => icp !== null);
}

function normalizeLLMICP(raw: Record<string, unknown>, profile: BusinessProfile): Omit<ICP, "id" | "createdAt" | "updatedAt"> | null {
  const name = String(raw.name || "").trim();
  const description = String(raw.description || "").trim();
  const buyerType = String(raw.buyerType || "").trim();
  if (!name || !description || !buyerType) return null;
  const stringArray = (value: unknown): string[] => Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean) : [];
  const rawConfidence = typeof raw.confidenceScore === "number" ? raw.confidenceScore : 0.6;
  return {
    workspaceId: profile.workspaceId,
    businessProfileId: profile.id,
    name,
    description,
    buyerType,
    industries: stringArray(raw.industries).length ? stringArray(raw.industries) : [profile.industry || "Multiple industries"],
    geography: stringArray(raw.geography).length ? stringArray(raw.geography) : (profile.targetGeographies.length ? profile.targetGeographies : ["Multiple regions"]),
    companySizeBucket: normalizeCompanySize(raw.companySizeBucket),
    likelyNeeds: stringArray(raw.likelyNeeds),
    buyingTriggers: stringArray(raw.buyingTriggers),
    painPoints: stringArray(raw.painPoints),
    preferredChannels: stringArray(raw.preferredChannels).length ? stringArray(raw.preferredChannels) : ["WhatsApp", "Email"],
    messagingAngles: stringArray(raw.messagingAngles),
    qualificationRules: stringArray(raw.qualificationRules),
    confidenceScore: Math.max(0, Math.min(0.9, rawConfidence)),
    status: "suggested",
  };
}

function normalizeCompanySize(value: unknown): ICP["companySizeBucket"] {
  const v = String(value || "").toLowerCase();
  if (v.includes("solo")) return "solo/small business";
  if (v.includes("medium")) return "medium company";
  if (v.includes("large")) return "large company";
  if (v.includes("small")) return "small company";
  return "unknown";
}

// Test-only export.
export const generateICPsDeterministicForTest = generateICPsDeterministic;

/**
 * Deterministic campaign planning — the safety-net fallback.
 *
 * Phase 1.5 / skill v2 (2026-07-19): the runtime `planCampaign` (below)
 * calls the LLM first; this function is the deterministic fallback used
 * when the LLM is unavailable or in mock mode.
 *
 * Exported as `planCampaignDeterministicForTest` for the golden test.
 */
export function planCampaignDeterministic(profile: BusinessProfile, icp: ICP, input: Partial<Campaign>): CampaignPlan {
  const region = input.targetRegion?.join(", ") || icp.geography.join(", ");
  return {
    icpSummary: `${icp.name}: ${icp.description}`,
    prospectSources: ["Manual lead entry", "CSV upload", "Google-style search review", "Website/social profile review"],
    searchQueries: [
      `${icp.name} ${region}`,
      `${icp.buyerType} ${region}`,
      `${icp.industries[0]} companies ${region}`,
      `${profile.products[0] || "supplier"} buyer ${region}`,
      `${icp.name} contact WhatsApp email`,
    ],
    messageStrategy: `Short, permission-based outreach focused on ${input.offer || profile.products[0] || "the catalogue"}.`,
    outreachSequence: ["First message", "Follow-up after 3 days", "Helpful reminder after 7 days", "Breakup message"],
    qualificationCriteria: icp.qualificationRules,
    expectedLeadStatuses: ["needs_review", "approved", "enriched", "message_ready", "contacted", "replied", "mql", "sql", "hot_lead"],
    manualExecutionSteps: ["Review prospects", "Approve only relevant leads", "Enrich approved leads", "Generate messages", "Open channel manually", "Mark sent", "Paste replies"],
  };
}

/**
 * Runtime campaign planning — calls the LLM, falls back to deterministic.
 *
 * Phase 1.5 / skill v2 (2026-07-19): replaces the old deterministic-only
 * `planCampaign`. The LLM produces a plan specific to the ICP + region;
 * if the call fails or runs in mock mode, the deterministic fallback
 * (which produces a generic 5-query plan) kicks in.
 *
 * Operator-confirmed rule (docs/LOGIC.md, 2026-07-19):
 *   - Plan includes searchQueries, messageStrategy, outreachSequence,
 *     qualificationCriteria, expectedLeadStatuses, manualExecutionSteps.
 *   - Goals are practical (find buyers, get catalogue requests, qualify).
 *     Catalogue/price/quote/sample requests are intent signals, not goals.
 *
 * Pinned by: scripts/golden/golden-campaign-planning.ts
 */
export async function planCampaign(
  profile: BusinessProfile,
  icp: ICP,
  input: Partial<Campaign>,
  repos: RepositoryBundle = createRepositories(),
): Promise<CampaignPlan> {
  const deterministic = planCampaignDeterministic(profile, icp, input);
  try {
    const result = await new LLMService(undefined, repos).runTask<CampaignPlan>("campaign_planning", {
      businessProfile: {
        companyName: profile.companyName,
        industry: profile.industry,
        products: profile.products,
        targetGeographies: profile.targetGeographies,
      },
      icp: {
        name: icp.name,
        description: icp.description,
        buyerType: icp.buyerType,
        industries: icp.industries,
        geography: icp.geography,
        likelyNeeds: icp.likelyNeeds,
        preferredChannels: icp.preferredChannels,
        messagingAngles: icp.messagingAngles,
        qualificationRules: icp.qualificationRules,
      },
      campaignInput: {
        targetRegion: input.targetRegion || icp.geography,
        offer: input.offer,
        productFocus: input.productFocus,
      },
      instructions: "Return a practical, manual-first lead generation plan specific to this ICP. Goals are practical (find buyers, get catalogue requests, qualify leads) — NOT abstract (maximize ROI, scale revenue). Catalogue/price/quote/sample requests are intent signals, not goals. Return JSON with: icpSummary, prospectSources (array), searchQueries (array of 5+), messageStrategy (string), outreachSequence (array of 4+ steps), qualificationCriteria (array), expectedLeadStatuses (array), manualExecutionSteps (array).",
    }, { workspaceId: profile.workspaceId });
    const plan = result.output;
    const isMockRun = result.mode === "mock" || result.provider === "mock";
    if (isMockRun || !plan || typeof plan !== "object" || !Array.isArray(plan.searchQueries) || plan.searchQueries.length < 3) {
      return deterministic;
    }
    // Sanity-fill any missing required field from the deterministic plan.
    return {
      icpSummary: typeof plan.icpSummary === "string" && plan.icpSummary.trim() ? plan.icpSummary : deterministic.icpSummary,
      prospectSources: Array.isArray(plan.prospectSources) && plan.prospectSources.length ? plan.prospectSources.map(String) : deterministic.prospectSources,
      searchQueries: plan.searchQueries.map(String).filter((q) => q.trim()),
      messageStrategy: typeof plan.messageStrategy === "string" && plan.messageStrategy.trim() ? plan.messageStrategy : deterministic.messageStrategy,
      outreachSequence: Array.isArray(plan.outreachSequence) && plan.outreachSequence.length ? plan.outreachSequence.map(String) : deterministic.outreachSequence,
      qualificationCriteria: Array.isArray(plan.qualificationCriteria) && plan.qualificationCriteria.length ? plan.qualificationCriteria.map(String) : deterministic.qualificationCriteria,
      expectedLeadStatuses: Array.isArray(plan.expectedLeadStatuses) && plan.expectedLeadStatuses.length ? plan.expectedLeadStatuses.map(String) : deterministic.expectedLeadStatuses,
      manualExecutionSteps: Array.isArray(plan.manualExecutionSteps) && plan.manualExecutionSteps.length ? plan.manualExecutionSteps.map(String) : deterministic.manualExecutionSteps,
    };
  } catch {
    return deterministic;
  }
}

// Test-only export.
export const planCampaignDeterministicForTest = planCampaignDeterministic;

export function generateMessage(profile: BusinessProfile, campaign: Campaign, lead: Lead, channel: string): Omit<MessageTemplate, "id" | "createdAt" | "updatedAt"> {
  // CP-27 (2026-08-02): personalized-compliment outreach style (operator-approved).
  // Replaces the generic "We help businesses with X. Would you like a catalogue?"
  // spam-shape with Saleshandy's reciprocity pattern: genuine specific praise
  // first, then a zero-pressure soft ask. The product + lead name MUST stay in
  // the body (golden:message-generation asserts both are present).
  const product = campaign.productFocus[0] || profile.products[0] || "our products";
  const company = profile.companyName || "our team";
  const leadName = lead.contactName || "there";
  const leadCompany = lead.companyName || "your business";
  const intro = lead.personalizationNote || `I came across ${leadCompany}'s work — genuinely impressive.`;
  const isEmail = channel.toLowerCase() === "email";
  const body = isEmail
    ? `Hi ${leadName},\n\n${intro} We supply ${product} to businesses like yours, and I thought our range might be a fit.\n\nWould it be alright if I shared a quick overview of what we make? No pressure at all.\n\nWarm regards,\n${company}`
    : `Hi ${leadName}, ${intro} We make ${product} for businesses like yours. Mind if I share a quick overview?`;
  return {
    workspaceId: profile.workspaceId,
    campaignId: campaign.id,
    leadId: lead.id,
    channel,
    subject: isEmail ? `${product} — a quick thought for ${leadCompany}` : undefined,
    body,
    tone: profile.tonePreference,
    language: profile.languagePreference,
    status: "draft",
    personalizationUsed: { intro, product, campaignGoal: campaign.goal },
  };
}

export function classifyReply(reply: Reply) {
  const text = reply.rawText.toLowerCase();
  if (includesAny(text, ["stop", "unsubscribe", "don't contact", "do not contact"])) {
    return replyResult("unsubscribe", "do_not_contact", "Lead asked not to be contacted.", "Mark do not contact and stop outreach.", "Understood — we've noted this and won't contact you again. Thank you.");
  }
  if (includesAny(text, ["price", "rate", "quotation", "quote", "qty", "quantity"])) {
    return replyResult("ask_price", "hot_lead", "Lead asked for price, quotation, or quantity details.", "Ask for requirement details and prepare quotation.", "Happy to share pricing! So I quote you accurately, could you tell me the product type and approximate quantity you need?");
  }
  if (includesAny(text, ["catalog", "catalogue", "brochure", "send details"])) {
    return replyResult("ask_catalogue", "mql", "Lead asked for catalogue or more details.", "Send catalogue and ask what they are sourcing.", "Glad to send our catalogue! Which product category should I focus on for you?");
  }
  if (includesAny(text, ["call", "meeting", "talk"])) {
    return replyResult("asks_for_call", "sql", "Lead asked for a call or meeting.", "Schedule a call and collect requirement.", "Yes, I'd be glad to connect. What day and time works best for you?");
  }
  if (includesAny(text, ["not interested", "no need", "already have"])) {
    return replyResult("not_interested", "not_interested", "Lead is not interested right now.", "Mark not interested and avoid follow-up unless they invite it.", "No problem at all — thank you for letting me know. I'll keep your details handy in case you need us later.");
  }
  if (includesAny(text, ["later", "next month", "after"])) {
    return replyResult("contact_later", "interested", "Lead asked to reconnect later.", "Set a follow-up date.", "Sure, I'll check back with you later. Is there a good time to reconnect?");
  }
  return replyResult("interested", "mql", "Reply appears positive or open-ended.", "Ask a clarifying requirement question.", "Thanks for your reply! What kind of requirement are you exploring right now? I'll tailor my next note accordingly.");
}

export function generateLearning(campaign: Campaign, leads: Lead[]): Omit<CampaignLearning, "id" | "createdAt"> {
  const approved = leads.filter((lead) => lead.reviewStatus === "approved").length;
  const replied = leads.filter((lead) => ["replied", "mql", "sql", "hot_lead"].includes(lead.status)).length;
  return {
    workspaceId: campaign.workspaceId,
    campaignId: campaign.id,
    summary: `${campaign.name} has ${leads.length} prospects, ${approved} approved leads, and ${replied} reply/qualified signals.`,
    winningPatterns: ["Leads with clear contact routes score higher", "Human-approved leads protect enrichment effort"],
    losingPatterns: ["Prospects without website/social/contact route need manual validation", "Generic source results need review before enrichment"],
    recommendedNextSteps: ["Approve a focused batch", "Enrich approved leads only", "Test WhatsApp and email copy separately", "Record replies for better next campaign planning"],
  };
}

function replyResult(classification: string, leadStatus: string, summary: string, suggestedNextAction: string, suggestedResponse: string) {
  return { classification, confidenceScore: 0.88, leadStatus, summary, suggestedNextAction, suggestedResponse };
}

function inferIndustry(text: string) {
  // Phase 3.1: generic industry inference — no textile bias. Each branch
  // detects a broad industry category from keywords; the fallback is generic.
  if (includesAny(text, ["software", "saas", "automation", "technology", "digital"])) return "Software / technology";
  if (includesAny(text, ["manufacturing", "factory", "production", "industrial"])) return "Manufacturing";
  if (includesAny(text, ["wholesale", "distribution", "supply", "trade"])) return "Wholesale / distribution";
  if (includesAny(text, ["retail", "store", "shop", "e-commerce"])) return "Retail / e-commerce";
  if (includesAny(text, ["service", "consulting", "agency", "professional"])) return "Professional services";
  return "B2B products or services";
}

function inferLocations(text: string) {
  // Phase 3.1: generic location extraction — extracts any capitalized place
  // name pattern rather than hardcoding Indian/Gulf cities.
  const locationPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g;
  const candidates = (text.match(locationPattern) || []).filter((place) => place.length > 2 && !["The", "This", "Our", "Your", "About", "Company"].includes(place));
  return compact([...new Set(candidates)].slice(0, 5));
}

function inferTargetCustomers(text: string) {
  return compact([
    // Phase 3.1: generic buyer-type detection — no "boutique/bridal" bias.
    includesAny(text, ["retailer", "retail", "store"]) ? "Retailers" : undefined,
    includesAny(text, ["wholesaler", "wholesale", "distributor"]) ? "Wholesalers / distributors" : undefined,
    includesAny(text, ["manufacturer", "producer", "factory"]) ? "Manufacturers" : undefined,
    includesAny(text, ["exporter", "export", "international"]) ? "Export buyers" : undefined,
  ]);
}
