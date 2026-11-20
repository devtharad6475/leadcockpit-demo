import { defaultWorkspaceId, timestamp, writeData } from "../src/lib/db";
import type { AppData } from "../src/lib/types";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { hashPassword } from "../src/lib/password";
import { TOUR_USER_ID } from "../src/lib/auth-service";

import { lastInboundByLead } from "@/lib/last-inbound";
import { demoFreshness, demoFreshnessReport } from "@/lib/demo-freshness";
import { demoKnowledgeAnswers } from "./seed-demo-knowledge";

const now = timestamp();

// N-UX-11 (2026-08-20): every demo row used to be stamped `now`, which made
// the fulfilment history unreadable — an order confirmed, shipped and delivered
// in the same millisecond — and left the later transition dates NULL entirely,
// so order #3 read "Delivered" with no delivery date on screen. These offsets
// give each seeded document a plausible, ORDERED history, which is also what
// makes the follow-up clocks and "days since" readouts show anything at all.
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.parse(now) - n * DAY_MS).toISOString();

// L-2/L-4 (2026-08-04): exported so a prisma-mode seeder CAN reuse this dataset
// without duplicating ~900 lines.
//
// N-DATA-2 correction (2026-08-17): this comment used to claim the prisma path
// "both call this". It does not. `scripts/seed-demo-prisma.ts` builds its own
// deliberately minimal dataset (3 leads, no business profile, no knowledge) and
// never calls buildDemoData(). So everything below — the company identity, the
// ICPs, the campaign, the leads, the knowledge, the unroutable contact details —
// exists ONLY on the JSON substrate, while `.env` currently runs the app on
// Postgres. Nothing calls this exported function today; it is the hook a real
// prisma seeder would use. Do not trust this line again without checking:
// `grep -rn buildDemoData scripts/`.
export async function buildDemoData(): Promise<AppData> {
  // CP-20 — hash the tour credential password (async, can't run in the literal).
  const tourCred = data.userCredentials?.find((c) => c.id === "cred_tour");
  if (tourCred) {
    tourCred.passwordHash = await hashPassword("tour-only-no-login-7c9e1f4a2b8d");
  }
  // 2026-08-20 N-DATA-9 — a seeded lead with a customer's WhatsApp reply on file
  // must carry the timestamp of that reply. Without it the Replies screen showed
  // the customer's message and "Customer hasn't messaged you yet" at the same
  // time, and the 24-hour window gate refused every send on the demo data.
  // Derived, never hand-typed: a hand-typed copy of a derivable value drifts the
  // moment somebody edits one of the two.
  const inboundByLead = lastInboundByLead(data.replies ?? []);
  for (const lead of data.leads ?? []) {
    const at = inboundByLead.get(lead.id);
    if (at) lead.lastInboundAt = at;
  }
  return data;
}

/**
 * N-AI-2 — slot routing for the demo workspace.
 *
 * Returns real DeepSeek slot rows when a platform key is present, and an empty
 * list otherwise (which leaves every slot on the mock default). See the comment
 * at the `llmModelRoutings:` field below for why this is conditional.
 *
 * `enableMockFallback: true` is intentional: if the key is revoked or DeepSeek is
 * down, the demo degrades to mock output instead of throwing in the user's face.
 */
function demoModelRoutings(): AppData["llmModelRoutings"] {
  if (!process.env.PLATFORM_DEEPSEEK_API_KEY?.trim()) return [];
  const slot = (slotId: string, modelName: string, modelTier: string) => ({
    id: `llm_route_${slotId}`,
    workspaceId: defaultWorkspaceId,
    taskName: slotId,
    provider: "deepseek",
    modelName,
    modelTier,
    isEnabled: true,
    // No credentialId → resolved from PLATFORM_DEEPSEEK_API_KEY at call time.
    fallbackProvider: "mock",
    fallbackModelName: "mock-balanced",
    config: { enableMockFallback: true },
    createdAt: now,
    updatedAt: now,
  });
  // deepseek-chat and deepseek-reasoner are the two models the DeepSeek API
  // actually serves. Other DeepSeek names in the catalog are listed for
  // completeness and would be rejected at call time.
  return [
    slot("fast_customer_reply", "deepseek-chat", "fast"),
    slot("daily_workhorse", "deepseek-chat", "balanced"),
    slot("deep_reasoning", "deepseek-reasoner", "strong"),
  ] as AppData["llmModelRoutings"];
}

const data: AppData = {
  workspaces: [{
    id: defaultWorkspaceId,
    // 2026-08-02 (UI polish) — workspace display name. Was the dev placeholder
    // "CampaignWorkspace", which surfaced verbatim in the header user-chip on
    // every page ("Demo OwnerCampaignWorkspace"). Now shows the real business
    // name so the demo looks like a live workspace.
    // 2026-08-17 (N-DATA-1 / gate G8, decision D2) — was "Balaji Zari Udyog",
    // the operator's REAL first customer. The demo now seeds the fiction that
    // matches fixtures/meghdoot-zari/, so the workspace name, the business
    // profile and the loaded knowledge all describe one company.
    name: "Meghdoot Zari",
    ownerUserId: "user_owner",
    businessName: "Meghdoot Zari & Trims Pvt Ltd",
    industry: "Textile trims and zari manufacturing",
    status: "active",
    createdAt: now,
    updatedAt: now,
  }],
  users: [{
    id: "user_owner",
    workspaceId: defaultWorkspaceId,
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
    createdAt: now,
    updatedAt: now,
  },
  // CP-20 (2026-08-02) — the read-only tour viewer. A real user row MUST exist
  // (resolveCurrentUser does findUserById) for the public tour session to
  // resolve. role: "viewer" so the existing RBAC gate auto-blocks every
  // mutation with 403. The matching credential below carries sessionVersion: 1
  // so the tour token (also version 1) passes the version check.
  {
    id: TOUR_USER_ID,
    workspaceId: defaultWorkspaceId,
    name: "Demo Explorer",
    email: "tour@leadcockpit.demo",
    role: "viewer",
    createdAt: now,
    updatedAt: now,
  }],
  // CP-20 — credential for the tour viewer. The password hash is a real scrypt
  // hash of a long random string, but NO ONE ever logs in with it (the tour
  // path mints a session directly via startTourSession). It exists only so the
  // sessionVersion check in resolveCurrentUser passes. sessionVersion: 1.
  // The hash is filled in by main() (hashPassword is async; this literal is
  // module-top-level so we use a sentinel and overwrite it before writing).
  userCredentials: [{
    id: "cred_tour",
    userId: TOUR_USER_ID,
    workspaceId: defaultWorkspaceId,
    email: "tour@leadcockpit.demo",
    passwordHash: "__TOUR_HASH_PLACEHOLDER__",
    sessionVersion: 1,
    createdAt: now,
    updatedAt: now,
  }],
  businessProfiles: [{
    id: "profile_demo",
    workspaceId: defaultWorkspaceId,
    // Identity + contact block kept byte-identical in meaning to the shipped
    // default in src/lib/db.ts — if these two ever disagree, the product
    // introduces itself as one company and answers as another, which is the
    // exact defect N-DATA-1 recorded. Contact details are unroutable BY
    // CONSTRUCTION (N-SAFETY-1): `.example` is an RFC 2606 reserved TLD that
    // can never be registered, and an Indian mobile never starts with 0 after
    // +91, so neither can reach a real person if a live send test runs against
    // the demo data. Do not "make these more realistic".
    companyName: "Meghdoot Zari & Trims Pvt Ltd",
    websiteUrl: "https://meghdootzari.example",
    industry: "Textile trims and zari manufacturing",
    businessType: "Manufacturer",
    description: "Manufacturer of zari thread and supplier of embroidery trims — laces, borders, sequins and cutdana — to the Indian textile trade. Business-to-business only: no retail, no single pieces, no consumer sales.",
    products: ["Zari thread", "Laces", "Borders", "Sequins", "Cutdana"],
    services: ["Bulk supply", "Custom shade matching", "Catalogue sharing"],
    productCategories: ["Textiles", "Ethnic wear material"],
    contactEmail: "sales@meghdootzari.example",
    contactPhone: "+91 00000 00010",
    whatsappNumber: "+910000000010",
    address: "Ring Road, Surat, Gujarat 395002",
    city: "Surat",
    state: "Gujarat",
    country: "India",
    // India only, and no "Export buyers" — the company documents state it does
    // not export. See src/lib/db.ts for the full rationale.
    targetGeographies: ["India"],
    currentCustomerTypes: ["Saree wholesalers", "Embroidery units", "Garment makers"],
    desiredCustomerTypes: ["Saree wholesalers", "Ethnic wear manufacturers", "Trims distributors"],
    strengths: ["Batch-to-batch shade consistency", "60+ shades held in stock", "On-time dispatch"],
    limitations: ["Not the cheapest supplier — competes on consistency, not rate", "Does not export; supplies within India only"],
    certifications: [],
    socialLinks: [],
    catalogueLinks: [],
    proofAssets: [],
    languagePreference: "English",
    tonePreference: "Warm, concise, businesslike",
    status: "approved",
    fields: [],
    createdAt: now,
    updatedAt: now,
  }],
  crawlJobs: [],
  crawlPages: [],
  businessExtractions: [],
  icps: [
    {
      id: "icp_bridal_uae",
      workspaceId: defaultWorkspaceId,
      businessProfileId: "profile_demo",
      // 2026-08-17 (N-DATA-1) — the record `id` stays `icp_bridal_uae` on
      // purpose: campaigns and leads reference it, and renaming an id to match
      // display copy is a migration, not a data fix. Only the customer-visible
      // content moved to India.
      name: "Bridal Boutiques in India",
      description: "Boutiques selling bridal and ethnic wear across Indian metros.",
      buyerType: "Boutique owner / fashion retailer",
      industries: ["Fashion retail", "Bridal wear"],
      geography: ["India"],
      companySizeBucket: "small company",
      likelyNeeds: ["zari thread", "bridal borders", "decorative trims"],
      buyingTriggers: ["festive season", "new bridal collection"],
      painPoints: ["needs fresh catalogue", "bulk sourcing"],
      preferredChannels: ["WhatsApp", "Instagram DM", "Email"],
      messagingAngles: ["Latest bridal and festive zari catalogue"],
      qualificationRules: ["Sells bridal or ethnic wear", "Located in India", "Reachable by WhatsApp, email, or DM"],
      confidenceScore: 0.82,
      status: "selected",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "icp_india_wholesale",
      workspaceId: defaultWorkspaceId,
      businessProfileId: "profile_demo",
      name: "Ethnic Wear Wholesalers in India",
      description: "Wholesalers sourcing trims and lace for garment makers.",
      buyerType: "Wholesaler",
      industries: ["Textiles", "Ethnic wear"],
      geography: ["India"],
      companySizeBucket: "medium company",
      likelyNeeds: ["bulk lace", "zari borders"],
      buyingTriggers: ["seasonal stocking"],
      painPoints: ["price and catalogue comparison"],
      preferredChannels: ["WhatsApp", "Email"],
      messagingAngles: ["Bulk-ready zari catalogue with sample support"],
      qualificationRules: ["Has wholesale textile focus", "Has reachable contact route"],
      confidenceScore: 0.74,
      status: "suggested",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "icp_export_buyers",
      workspaceId: defaultWorkspaceId,
      businessProfileId: "profile_demo",
      // 2026-08-17 (N-DATA-1) — this was an ENTIRE ICP aimed at export buyers
      // in UAE/UK/USA, for a business whose own documents say it does not
      // export. Left unfixed, the AI would have qualified and pitched leads the
      // company can never supply, and the contradiction would have surfaced in
      // front of a customer. Repurposed to a domestic segment rather than
      // deleted, because the id is referenced elsewhere.
      name: "Embroidery and Job-Work Units",
      description: "Embroidery houses and job-work units buying zari thread and trims in bulk.",
      buyerType: "Production owner / sourcing lead",
      industries: ["Embroidery", "Textiles"],
      geography: ["India"],
      companySizeBucket: "unknown",
      likelyNeeds: ["bulk zari thread", "consistent shade matching"],
      buyingTriggers: ["new sourcing season"],
      painPoints: ["supplier validation", "shade variation between lots"],
      preferredChannels: ["Email", "WhatsApp"],
      messagingAngles: ["Batch-to-batch shade consistency with sample support"],
      qualificationRules: ["Buys textile or garment material in bulk", "Has email or website"],
      confidenceScore: 0.66,
      status: "suggested",
      createdAt: now,
      updatedAt: now,
    },
  ],
  campaigns: [{
    id: "campaign_bridal_uae",
    workspaceId: defaultWorkspaceId,
    businessProfileId: "profile_demo",
    icpId: "icp_bridal_uae",
    name: "Bridal Boutiques in India campaign",
    goal: "get catalogue requests",
    targetRegion: ["India"],
    productFocus: ["Zari thread", "Borders"],
    offer: "Latest bridal and festive zari catalogue",
    selectedChannels: ["WhatsApp", "Email", "Instagram DM"],
    dailyOutreachLimit: 20,
    leadGoal: 50,
    status: "active",
    approvalStatus: "approved",
    plan: {
      icpSummary: "Bridal and ethnic wear boutiques across Indian metros.",
      prospectSources: ["Google search", "Instagram", "manual CSV"],
      searchQueries: ["bridal boutique Mumbai", "ethnic wear boutique Jaipur", "lehenga boutique Surat"],
      messageStrategy: "Short permission-based catalogue offer.",
      outreachSequence: ["First message", "Follow-up after 3 days"],
      qualificationCriteria: ["Sells bridal/ethnic wear", "Reachable by WhatsApp/email/DM"],
      expectedLeadStatuses: ["approved", "message_ready", "contacted", "mql", "sql", "hot_lead"],
      manualExecutionSteps: ["Review leads", "Enrich approved only", "Generate message", "Send manually", "Paste replies"],
    },
    createdAt: now,
    updatedAt: now,
  }],
  leads: [
    // 2026-09-04 (N-DEMO-2) — this lead used to have NO company name, so the
    // demo opened Lead Review, Discovery and Compliance with a row reading
    // "Unnamed prospect" / "(no name)" at the top. The fallbacks are correct and
    // stay in the code — a CSV import really can arrive without a name — but a
    // demo should demonstrate the product, not its edge case. The nameless path
    // is covered by tests, which is where it belongs.
    //
    // Distinct email and phone, like lead_dnc: the DNC registry keys on
    // email+phone, and the lead() helper's shared defaults would otherwise make
    // isContactBlocked match this lead against the do-not-contact entry (F-UI-7).
    {
      ...lead("lead_review", "Rukmini Silks", "needs_review", "pending", "not_started", 0, false, { city: "Varanasi" }),
      email: "rukmini@example.com",
      phone: "+910000000005",
      whatsappNumber: "+910000000005",
    },
    // 2026-08-17 (N-DATA-1 + N-SAFETY-1) — this lead set was 13/14 UAE, for a
    // company whose own documents say it does not export. Relocated to Indian
    // textile hubs so the pipeline matches the business that is selling.
    //
    // Every phone is now `+91 00000 000NN`. An Indian mobile number never has
    // 0 as its first subscriber digit, so these are UNASSIGNABLE — no live send
    // test can reach a real person. The previous numbers (`+971 50 111 000X`)
    // were structurally valid Dubai mobiles and some were plausibly in service.
    // Numbers stay distinct per lead: the DNC registry keys on email+phone, so
    // duplicates would make isContactBlocked match every lead (F-UI-7).
    lead("lead_approved", "Aarna Bridal Studio", "approved", "approved", "not_started", 8, false, { email: "aarna@example.com", phone: "+910000000001", city: "Surat" }),
    lead("lead_enriched", "Meera Ethnic Wear", "enriched", "approved", "completed", 12, false, { email: "meera@example.com", phone: "+910000000002", city: "Mumbai" }),
    lead("lead_contacted", "Noor Bridal Boutique", "contacted", "approved", "completed", 14, false, { email: "noor@example.com", phone: "+910000000003", city: "Jaipur" }),
    lead("lead_hot", "Zayna Wedding Couture", "hot_lead", "approved", "completed", 18, false, { email: "zayna@example.com", phone: "+910000000004", city: "Hyderabad" }),
    // F-UI-7 (depth-audit 2026-07-29): give lead_dnc a DISTINCT email/phone
    // so the DNC registry entry (which keys on these) matches ONLY lead_dnc —
    // not lead_hot / lead_approved / etc. The lead() helper hard-codes
    // hello@example.com / +910000000000 for every company lead; without this
    // override, isContactBlocked would falsely match every company lead
    // against the DNC entry, blocking their outreach.
    {
      ...lead("lead_dnc", "Old Supplier Co", "do_not_contact", "rejected", "not_started", 0, true),
      email: "unsubscribe@oldsupplier.example",
      phone: "+910000009999",
      whatsappNumber: "+910000009999",
    },
    // CP-20 (2026-08-02) — richer tour dataset: more leads across every stage
    // so the CRM pipeline + dashboard look realistic to a first-time visitor.
    // Each has DISTINCT contact details (F-UI-7 isolation).
    lead("lead_mql_1", "Fatima Couture House", "mql", "approved", "completed", 15, false, { email: "fatima@example.com", phone: "+910000000005", city: "Lucknow", buyerType: "Couture house" }),
    lead("lead_sql_1", "Kanchipuram Silk House", "sql", "approved", "completed", 19, false, { email: "kanchipuram@example.com", phone: "+910000000006", city: "Chennai", buyerType: "Saree retailer" }),
    lead("lead_replied_1", "Pearl Ethnic Atelier", "replied", "approved", "completed", 16, false, { email: "pearl@example.com", phone: "+910000000007", city: "Kolkata", buyerType: "Atelier" }),
    lead("lead_interested_1", "Royal Trimmings Pvt Ltd", "interested", "approved", "completed", 17, false, { email: "royal@example.com", phone: "+910000000008", city: "Ludhiana", buyerType: "Wholesaler" }),
    lead("lead_won_1", "Luxe Lace Mumbai", "won", "approved", "completed", 20, false, { email: "luxelace@example.com", phone: "+910000000009", city: "Mumbai", buyerType: "Boutique chain" }),
    lead("lead_closed_won_1", "Heritage Trims Varanasi", "closed_won", "approved", "completed", 21, false, { email: "heritage@example.com", phone: "+910000000010", city: "Varanasi", buyerType: "Retailer" }),
    lead("lead_lost_1", "Sahyadri Fashions", "lost", "approved", "completed", 9, false, { email: "sahyadri@example.com", phone: "+910000000011", city: "Pune", buyerType: "Boutique" }),
    lead("lead_not_interested_1", "Gujarat Garments", "not_interested", "approved", "completed", 7, false, { email: "gujarat@example.com", phone: "+910000000012", city: "Ahmedabad", buyerType: "Manufacturer" }),
    lead("lead_message_ready_1", "Velvet Vogue Bridal", "message_ready", "approved", "completed", 13, false, { email: "velvetvogue@example.com", phone: "+910000000013", city: "Bengaluru", buyerType: "Bridal boutique" }),
  ],
  messageTemplates: [{
    id: "message_demo",
    workspaceId: defaultWorkspaceId,
    campaignId: "campaign_bridal_uae",
    leadId: "lead_contacted",
    channel: "WhatsApp",
    body: "Hi there, came across your work with bridal and ethnic fashion — genuinely impressive. We make zari borders and decorative laces for businesses like yours. Mind if I share our latest catalogue?",
    tone: "Warm, concise, businesslike",
    language: "English",
    status: "approved",
    personalizationUsed: { product: "Zari lace", campaignGoal: "get catalogue requests" },
    createdAt: now,
    updatedAt: now,
  }],
  outreachActivities: [{
    id: "activity_demo",
    workspaceId: defaultWorkspaceId,
    campaignId: "campaign_bridal_uae",
    leadId: "lead_contacted",
    channel: "WhatsApp",
    messageTemplateId: "message_demo",
    direction: "outbound",
    status: "sent_manual",
    sentManually: true,
    body: "Demo message sent manually.",
    activityAt: now,
    createdBy: "user_owner",
    createdAt: now,
    updatedAt: now,
  }],
  replies: [{
    id: "reply_demo",
    workspaceId: defaultWorkspaceId,
    campaignId: "campaign_bridal_uae",
    leadId: "lead_hot",
    channel: "WhatsApp",
    rawText: "Please share price and minimum order quantity.",
    classification: "ask_price",
    confidenceScore: 0.88,
    summary: "Lead asked for price and MOQ.",
    suggestedNextAction: "Send catalogue and ask quantity/design type.",
    suggestedResponse: "Happy to share pricing! So I quote you accurately, could you tell me which lace or border type and quantity you're looking for?",
    createdAt: now,
    updatedAt: now,
  },
  // CP-20 (2026-08-02) — richer tour dataset: replies across classifications.
  {
    id: "reply_demo_2",
    workspaceId: defaultWorkspaceId,
    campaignId: "campaign_bridal_uae",
    leadId: "lead_replied_1",
    channel: "WhatsApp",
    rawText: "Yes, please send me your latest catalogue. I run an atelier in Kolkata.",
    classification: "interested",
    confidenceScore: 0.91,
    summary: "Lead wants the catalogue; runs an atelier.",
    suggestedNextAction: "Share catalogue + ask about bridal vs festive designs.",
    suggestedResponse: "Glad to send our catalogue! Are you looking more for bridal borders or festive trims so I focus on the right pages?",
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "reply_demo_3",
    workspaceId: defaultWorkspaceId,
    campaignId: "campaign_bridal_uae",
    leadId: "lead_interested_1",
    channel: "Email",
    rawText: "What is the lead time for 300 metres of mixed embroidery trim?",
    classification: "ask_delivery",
    confidenceScore: 0.84,
    summary: "Lead asked about delivery lead time for a bulk order.",
    suggestedNextAction: "Confirm lead time + check production schedule.",
    suggestedResponse: "Typical lead time is 7-10 days for that volume. Let me confirm with production and I'll get back to you today with the exact date.",
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "reply_demo_4",
    workspaceId: defaultWorkspaceId,
    campaignId: "campaign_bridal_uae",
    leadId: "lead_lost_1",
    channel: "WhatsApp",
    rawText: "Thanks but we already have a supplier. Maybe later.",
    classification: "not_interested",
    confidenceScore: 0.93,
    summary: "Lead declined — already has a supplier.",
    suggestedNextAction: "Acknowledge politely + keep for future nurture.",
    suggestedResponse: "No problem at all — I'll keep your details handy for when you're next sourcing. Wishing you well!",
    createdAt: now,
    updatedAt: now,
  }],
  agentRuns: [{
    id: "agent_demo",
    workspaceId: defaultWorkspaceId,
    agentName: "Campaign Analytics Agent",
    input: { campaignId: "campaign_bridal_uae" },
    output: { demo: true },
    status: "completed",
    startedAt: now,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
  }],
  integrations: [
    "whatsapp_cloud", "gmail", "smtp", "google_maps", "google_search", "instagram",
    "linkedin", "indiamart", "tradeindia", "apollo", "hunter", "clearbit",
    "email_verifier", "crm_hubspot", "crm_zoho", "google_sheets", "zapier_webhook",
  ].map((provider) => ({
    id: `integration_${provider}`,
    workspaceId: defaultWorkspaceId,
    provider,
    status: "not_connected",
    authType: provider === "smtp" ? "password" : "oauth_or_api_key",
    config: { mvpMode: "placeholder", manualFallback: true },
    createdAt: now,
    updatedAt: now,
  })),
  campaignLearnings: [{
    id: "learning_demo",
    workspaceId: defaultWorkspaceId,
    campaignId: "campaign_bridal_uae",
    summary: "Human-approved leads with WhatsApp reachability are the strongest early segment.",
    winningPatterns: ["Clear WhatsApp route", "Bridal boutique relevance"],
    losingPatterns: ["Missing contact route", "Generic fashion pages"],
    recommendedNextSteps: ["Approve a focused India batch", "Generate WhatsApp and email variants"],
    createdAt: now,
  }],
  auditLogs: [{
    id: "audit_demo",
    workspaceId: defaultWorkspaceId,
    eventType: "demo.seeded",
    entityType: "workspace",
    entityId: defaultWorkspaceId,
    payload: { seededAt: now },
    createdAt: now,
    updatedAt: now,
  }],
  providerAccounts: [],
  agentBehaviorPolicies: [{
    id: "policy_global_demo",
    name: "LeadCockpit global behavior policy",
    scope: "global",
    version: "1.0",
    policy: { noHallucination: true, humanReviewForSensitiveTopics: true, respectOptOut: true },
    isActive: true,
    createdAt: now,
    updatedAt: now,
  }],
  companyCommunicationSettings: [{
    id: "comm_settings_demo",
    workspaceId: defaultWorkspaceId,
    language: "English",
    tone: "professional_friendly",
    brandVoice: "Helpful, concise, respectful",
    messageLength: "short",
    greeting: "Hello",
    closing: "Thank you",
    preferredWords: ["catalogue", "confirm", "design"],
    avoidedWords: ["guaranteed", "cheapest"],
    formalityLevel: "balanced",
    emojiUsage: "minimal",
    allowHinglish: false,
    customInstructions: "Keep WhatsApp replies short and never invent pricing.",
    createdAt: now,
    updatedAt: now,
  }],
  conversationPolicies: [],
  whatsAppAgentSettings: [{
    id: "wa_settings_demo",
    workspaceId: defaultWorkspaceId,
    enabled: true,
    mode: "draft_only",
    defaultLanguage: "English",
    maxAutoRepliesPerConversation: 3,
    businessHours: {},
    escalationContactName: "Owner",
    // N-SAFETY-1: escalation is the ONE number the agent actively dials, so it
    // must be unroutable. Kept identical to the business profile's contactPhone
    // above — "Owner" and the company contact are the same person here.
    escalationContactPhone: "+910000000010",
    escalationContactEmail: "sales@example.com",
    unknownAnswerBehavior: "hold_for_review",
    abusiveMessageBehavior: "escalate",
    priceQuestionBehavior: "ask_quantity_or_escalate",
    createdAt: now,
    updatedAt: now,
  }],
  escalationRules: [],
  unknownQuestions: [{
    id: "unknown_demo",
    workspaceId: defaultWorkspaceId,
    leadId: "lead_hot",
    channel: "whatsapp",
    questionText: "Can you confirm exact price for 500 meters?",
    missingTopic: "price_request",
    status: "open",
    suggestedAnswer: "Great question — let me confirm the exact details with our team and get right back to you.",
    createdAt: now,
    updatedAt: now,
  }],
  autoReplyLogs: [{
    id: "auto_reply_demo",
    workspaceId: defaultWorkspaceId,
    leadId: "lead_hot",
    replyId: "reply_demo",
    channel: "whatsapp",
    incomingMessage: "Can you confirm exact price for 500 meters?",
    retrievedContext: { confidenceScore: 0.2, chunks: [] },
    classification: "price_request",
    generatedReply: "Great question — let me confirm the exact details with our team and get right back to you.",
    confidenceScore: 0.9,
    canAutoSend: false,
    needsHumanReview: true,
    reason: "Price question requires verified knowledge or human review.",
    modelProvider: "mock",
    modelName: "deterministic-safety-engine",
    status: "held_for_review",
    createdAt: now,
    updatedAt: now,
  }],
  websiteCrawlConsents: [{
    id: "crawl_consent_demo",
    workspaceId: defaultWorkspaceId,
    websiteUrl: "https://meghdootzari.example",
    consentGiven: true,
    consentGivenAt: now,
    consentTextVersion: "v1",
    userId: "user_owner",
    createdAt: now,
    updatedAt: now,
  }],
  productKnowledges: [{
    id: "product_zari_demo",
    workspaceId: defaultWorkspaceId,
    productName: "Zari lace",
    productCategory: "Ethnic garment material",
    description: "Decorative lace and borders used by wholesalers, manufacturers, boutiques, designers, and embroidery units.",
    source: "demo_seed",
    confidenceScore: 0.82,
    createdAt: now,
    updatedAt: now,
  }],
  productVarieties: [{
    id: "variety_zari_standard_demo",
    workspaceId: defaultWorkspaceId,
    productKnowledgeId: "product_zari_demo",
    name: "Standard zari lace range",
    description: "Fast-moving catalogue designs for resale and manufacturing.",
    useCases: ["resale", "saree/lehenga manufacturing", "boutique customization"],
    buyerTypes: ["wholesaler", "manufacturer", "boutique"],
    confidenceScore: 0.8,
    createdAt: now,
    updatedAt: now,
  }],
  productApplications: [{
    id: "application_zari_manufacturing_demo",
    workspaceId: defaultWorkspaceId,
    productKnowledgeId: "product_zari_demo",
    varietyId: "variety_zari_standard_demo",
    applicationName: "Zari lace in ethnic garment manufacturing",
    industry: "Fashion manufacturing",
    description: "Used in sarees, lehengas, bridal wear, festive garments, and decorative apparel.",
    exampleProducts: ["sarees", "lehengas", "bridal wear", "festive garments"],
    buyerTypes: ["manufacturer", "embroidery unit", "boutique"],
    seasonality: { peak: ["wedding season", "festive season"] },
    confidenceScore: 0.8,
    createdAt: now,
    updatedAt: now,
  }],
  buyerSegments: [{
    id: "segment_wholesaler_demo",
    workspaceId: defaultWorkspaceId,
    name: "Textile wholesalers",
    segmentType: "wholesaler",
    description: "Need variety, margin, ready stock, and fast-moving designs.",
    needs: ["variety", "margin", "bulk rate", "ready stock"],
    buyingCriteria: ["fast-moving designs", "bulk pricing", "reliable dispatch"],
    preferredChannels: ["whatsapp", "email"],
    qualificationSignals: ["sells garment materials", "asks for catalogue/bulk"],
    badFitSignals: ["consumer-only"],
    createdAt: now,
    updatedAt: now,
  }, {
    id: "segment_manufacturer_demo",
    workspaceId: defaultWorkspaceId,
    name: "Ethnic wear manufacturers",
    segmentType: "manufacturer",
    description: "Need consistency, custom size/design, repeat supply, and delivery reliability.",
    needs: ["consistent quality", "repeat supply", "custom size", "delivery time"],
    buyingCriteria: ["sample support", "application fit", "stable supply"],
    preferredChannels: ["whatsapp", "email"],
    qualificationSignals: ["makes finished garments", "asks for MOQ/sample"],
    badFitSignals: ["no production activity"],
    createdAt: now,
    updatedAt: now,
  }],
  productApplicationMarketMaps: [{
    id: "market_map_zari_wholesaler_demo",
    workspaceId: defaultWorkspaceId,
    productKnowledgeId: "product_zari_demo",
    varietyId: "variety_zari_standard_demo",
    applicationId: "application_zari_manufacturing_demo",
    buyerSegmentId: "segment_wholesaler_demo",
    targetingAngle: "Target textile wholesalers who care about variety, margin, bulk rate, and ready stock.",
    messageAngle: "Share fast-moving zari lace catalogue with bulk and margin-friendly supply.",
    searchQueries: ["zari lace wholesaler", "ethnic garment material wholesaler", "lace border supplier"],
    leadSources: ["Google search", "business directories", "Instagram profiles"],
    confidenceScore: 0.82,
    createdAt: now,
    updatedAt: now,
  }],
  leadReviewSettings: [{
    id: "lead_review_settings_demo",
    workspaceId: defaultWorkspaceId,
    mode: "manual_review",
    autoApproveThreshold: 0.85,
    autoRejectThreshold: 0.25,
    maxAutoApprovedPerDay: 25,
    requireHumanForNewCampaigns: true,
    requireHumanForNewIndustries: true,
    allowAutoEnrichment: false,
    allowAutoOutreachPreparation: true,
    allowAutoSend: false,
    auditEveryDecision: true,
    createdAt: now,
    updatedAt: now,
  }],
  leadReviewDecisions: [{
    id: "lead_review_decision_demo",
    workspaceId: defaultWorkspaceId,
    leadId: "lead_approved",
    campaignId: "campaign_bridal_uae",
    decision: "approve",
    confidenceScore: 0.78,
    reason: "Demo recommendation: lead matches bridal/ethnic wear targeting and has reachable contact data.",
    matchedSignals: ["matches ICP", "reachable profile", "relevant buyer type"],
    riskSignals: [],
    suggestedNextStep: "Human should approve, then enrich.",
    modeUsed: "manual_review",
    decidedBy: "agent",
    createdAt: now,
    updatedAt: now,
  }],
  knowledgeBaseDocuments: [{
    id: "kb_doc_demo",
    workspaceId: defaultWorkspaceId,
    title: "Demo company profile knowledge",
    documentType: "company_profile",
    source: "business_profile",
    status: "active",
    contentText: "Company: Meghdoot Zari & Trims Pvt Ltd\nProducts: Zari thread, Laces, Borders, Sequins, Cutdana\nServices: Bulk supply, Catalogue sharing, Custom design support\nPricing: Exact pricing depends on design and quantity and must be confirmed by the team.\nCatalogue: Catalogue can be shared on request.",
    metadata: { seeded: true },
    createdAt: now,
    updatedAt: now,
  }],
  knowledgeBaseChunks: [{
    id: "kb_chunk_demo",
    workspaceId: defaultWorkspaceId,
    documentId: "kb_doc_demo",
    chunkIndex: 0,
    chunkText: "Company: Meghdoot Zari & Trims Pvt Ltd\nProducts: Zari thread, Laces, Borders, Sequins, Cutdana\nPricing: Exact pricing depends on design and quantity and must be confirmed by the team.\nCatalogue: Catalogue can be shared on request.",
    metadata: { seeded: true },
    createdAt: now,
    updatedAt: now,
  }],
  // 2026-09-04 N-DEMO-3 — the demo workspace had an empty AI brain, so the
  // Knowledge Base screen was twenty-six identical "0 of 17 answered · Weak"
  // cards. See scripts/seed-demo-knowledge.ts for what is claimed and why the
  // coverage is deliberately uneven.
  knowledgeQuestionAnswers: demoKnowledgeAnswers(defaultWorkspaceId, now),
  knowledgeBaseQueryLogs: [],
  llmProviderCredentials: [],
  // UA-7 fix: this used to seed a task-level override row (taskName:
  // "whatsapp_reply") that silently pinned WhatsApp replies to mock forever,
  // invisible in the AI Settings UI (which only shows/edits slot-level rows).
  // routeModelSelection() no longer consults task-level rows at all, so this
  // stays empty — slot-level routing (configured via AI Settings) is now the
  // only thing that controls provider selection.
  // N-AI-2 fix (2026-08-17): this used to be a flat `[]`, which meant a freshly
  // seeded demo had NO slot rows at all. With no rows, getModelSlots() falls back
  // to slotDefaults (src/llm/ModelRouter.ts:31) where every slot is `mock` — so
  // the whole product, including the knowledge-extraction pipeline, ran on canned
  // answers while looking like it was running on AI.
  //
  // The fix is deliberately conditional, not unconditional. Seeding a real
  // provider row on a machine with no key would only produce confusing runtime
  // failures; seeding one unconditionally on a machine that HAS a key would mean
  // "npm run seed:demo" silently starts spending the operator's money. So:
  //   key present in the environment → real DeepSeek routing, real AI
  //   key absent                     → [] → mock, which the UI already labels
  // Either way no secret is written into the repo: these rows carry NO
  // credentialId, and LLMService.ts:135 resolves a credential-less route through
  // platformApiKey() → PLATFORM_DEEPSEEK_API_KEY from .env at call time.
  //
  // These are SLOT-level rows (taskName === a slot id), which is what the AI
  // Settings UI shows and edits — not the task-level override rows removed in
  // UA-7, which pinned a provider invisibly. Only the three text slots are set:
  // DeepSeek has no search/image/embedding model, so those three stay on the
  // mock default rather than pretending to a capability the provider lacks.
  llmModelRoutings: demoModelRoutings(),
  aiUsageLimits: [{
    id: "ai_usage_demo",
    workspaceId: defaultWorkspaceId,
    // N-AI-4 (2026-08-17): these were 50,000 daily / 1,000,000 monthly tokens.
    // Measured: ONE full company-knowledge extraction over the 18 onboarding
    // documents costs **63,105 tokens** — so the out-of-the-box daily budget was
    // smaller than the very first thing a new user does, and the second run of
    // the day was refused. Worse, the refusal surfaced as "Configure and test a
    // real Daily Workhorse model", which sends the operator to check their API
    // key when the real cause is the budget (see N-AI-5).
    //
    // The two kinds of limit are now given different jobs, on purpose:
    //   - cost limits are the REAL brake ($5/day ≈ 3.5M DeepSeek tokens at the
    //     $0.088 / 63k tokens rate measured here)
    //   - token limits are a sanity ceiling against a runaway loop, set high
    //     enough that they never fire before the cost limit does
    // Set them the other way round and the system stops for a reason nobody
    // can act on, which is exactly what happened.
    dailyTokenLimit: 2_000_000,
    monthlyTokenLimit: 20_000_000,
    dailyCostLimit: 5,
    monthlyCostLimit: 100,
    currentDailyTokens: 0,
    currentMonthlyTokens: 0,
    currentDailyCost: 0,
    currentMonthlyCost: 0,
    resetAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    createdAt: now,
    updatedAt: now,
  }],
  // Stage A+ / Cluster 11 (P3): demo seed for the previously-empty tabs so the
  // operator sees realistic data when first walking Commercial / Tickets /
  // Media / Knowledge questions / Compliance. Each is one realistic sample.
  orders: [{
    id: "order_demo_1",
    workspaceId: defaultWorkspaceId,
    orderNumber: 1,
    leadId: "lead_approved",
    quoteId: undefined,
    status: "confirmed",
    lineItems: [{
      id: "li_demo_1",
      productName: "Zari lace (gold)",
      sku: "ZL-G-001",
      quantity: 50,
      unit: "metre",
      unitPrice: 120,
      currencyCode: "INR",
      lineTotal: 6000,
    }],
    grandTotal: 6000,
    currencyCode: "INR",
    origin: "direct",
    confirmedAt: daysAgo(3),
    notes: "Sample order — bridal boutique Mumbai",
    createdAt: daysAgo(4),
    updatedAt: daysAgo(3),
  },
  // CP-20 (2026-08-02) — richer tour dataset: orders across the fulfilment
  // lifecycle so the Commercial tab shows a realistic pipeline.
  {
    id: "order_demo_2",
    workspaceId: defaultWorkspaceId,
    orderNumber: 2,
    leadId: "lead_won_1",
    quoteId: "quote_demo_1",
    status: "shipped",
    lineItems: [{
      id: "li_demo_2",
      productName: "Decorative border (silver)",
      sku: "DB-S-014",
      quantity: 200,
      unit: "metre",
      unitPrice: 85,
      currencyCode: "INR",
      lineTotal: 17000,
    }],
    grandTotal: 17000,
    currencyCode: "INR",
    origin: "from_quote",
    confirmedAt: daysAgo(8),
    // A shipped order that never recorded a ship date is the N-UX-11 defect.
    shippedAt: daysAgo(2),
    notes: "Boutique chain reorder — dispatched via Surat courier",
    createdAt: daysAgo(9),
    updatedAt: daysAgo(2),
  },
  {
    id: "order_demo_3",
    workspaceId: defaultWorkspaceId,
    orderNumber: 3,
    leadId: "lead_closed_won_1",
    status: "delivered",
    lineItems: [
      { id: "li_demo_3a", productName: "Embroidery trim (rose gold)", sku: "ET-RG-007", quantity: 120, unit: "metre", unitPrice: 150, currencyCode: "INR", lineTotal: 18000 },
      { id: "li_demo_3b", productName: "Zari lace (gold)", sku: "ZL-G-001", quantity: 80, unit: "metre", unitPrice: 120, currencyCode: "INR", lineTotal: 9600 },
    ],
    grandTotal: 27600,
    currencyCode: "INR",
    origin: "direct",
    confirmedAt: daysAgo(15),
    shippedAt: daysAgo(9),
    deliveredAt: daysAgo(5),
    notes: "Delivered — retailer Varanasi, festive season stock",
    createdAt: daysAgo(16),
    updatedAt: daysAgo(5),
  }],
  quotes: [{
    id: "quote_demo_1",
    workspaceId: defaultWorkspaceId,
    quoteNumber: 1,
    leadId: "lead_contacted",
    status: "sent",
    lineItems: [{
      id: "li_q_demo_1",
      productName: "Decorative border (silver)",
      sku: "DB-S-014",
      quantity: 100,
      unit: "metre",
      unitPrice: 85,
      currencyCode: "INR",
      lineTotal: 8500,
    }],
    grandTotal: 8500,
    currencyCode: "INR",
    validityNote: "7 days",
    sentAt: daysAgo(2),
    notes: "Sample quote — Surat saree manufacturer",
    createdAt: daysAgo(3),
    updatedAt: daysAgo(2),
  },
  // CP-20 (2026-08-02) — richer tour dataset: quotes across statuses.
  {
    id: "quote_demo_2",
    workspaceId: defaultWorkspaceId,
    quoteNumber: 2,
    leadId: "lead_sql_1",
    status: "accepted",
    lineItems: [{
      id: "li_q_demo_2",
      productName: "Zari lace (gold) — premium",
      sku: "ZL-G-001-P",
      quantity: 150,
      unit: "metre",
      unitPrice: 140,
      currencyCode: "INR",
      lineTotal: 21000,
    }],
    grandTotal: 21000,
    currencyCode: "INR",
    validityNote: "10 days",
    sentAt: daysAgo(10),
    // "Accepted" with no accepted date was the other half of N-DATA-11.
    acceptedAt: daysAgo(6),
    notes: "Accepted — bridal retailer Varanasi",
    createdAt: daysAgo(11),
    updatedAt: daysAgo(6),
  },
  {
    id: "quote_demo_3",
    workspaceId: defaultWorkspaceId,
    quoteNumber: 3,
    leadId: "lead_interested_1",
    status: "draft",
    lineItems: [{
      id: "li_q_demo_3",
      productName: "Embroidery trim (mixed)",
      sku: "ET-MIX-022",
      quantity: 300,
      unit: "metre",
      unitPrice: 110,
      currencyCode: "INR",
      lineTotal: 33000,
    }],
    grandTotal: 33000,
    currencyCode: "INR",
    validityNote: "7 days",
    notes: "Draft — pending owner review before sending",
    createdAt: now,
    updatedAt: now,
  }],
  tickets: [{
    id: "ticket_demo_1",
    workspaceId: defaultWorkspaceId,
    ticketNumber: 1,
    leadId: "lead_approved",
    sourceChannel: "whatsapp",
    type: "question",
    priority: "medium",
    status: "open",
    subject: "Bulk order discount query",
    description: "Customer asked if a 20% discount applies for orders above 500 metres. Needs owner response.",
    sourceEntityType: "inbound",
    slaStartedAt: now,
    slaDueAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    slaBreached: false,
    createdAt: now,
    updatedAt: now,
  },
  // CP-20 (2026-08-02) — richer tour dataset: tickets across types/statuses.
  {
    id: "ticket_demo_2",
    workspaceId: defaultWorkspaceId,
    ticketNumber: 2,
    leadId: "lead_won_1",
    sourceChannel: "whatsapp",
    type: "complaint",
    priority: "high",
    status: "in_progress",
    subject: "Delayed shipment — festive stock",
    description: "Boutique chain reports the reorder hasn't arrived 2 days past promised date. Wants ETA + expedite.",
    sourceEntityType: "inbound",
    slaStartedAt: now,
    slaDueAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    slaBreached: false,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "ticket_demo_3",
    workspaceId: defaultWorkspaceId,
    ticketNumber: 3,
    leadId: "lead_closed_won_1",
    sourceChannel: "email",
    type: "question",
    priority: "low",
    status: "resolved",
    subject: "Care instructions for zari trim",
    description: "Customer asked how to store the embroidery trim to avoid tarnish. Answered with care guide.",
    sourceEntityType: "inbound",
    slaStartedAt: now,
    slaDueAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    slaBreached: false,
    resolvedAt: now,
    createdAt: now,
    updatedAt: now,
  }],
  ticketEvents: [{
    id: "te_demo_1",
    workspaceId: defaultWorkspaceId,
    ticketId: "ticket_demo_1",
    eventType: "created",
    actorType: "system",
    note: "Ticket auto-created from inbound WhatsApp message",
    createdAt: now,
  }],
  ticketSlaSettings: [{
    id: "tss_demo",
    workspaceId: defaultWorkspaceId,
    clockMode: "business_hours",
    businessHoursStart: "09:00",
    businessHoursEnd: "18:00",
    businessDays: [1, 2, 3, 4, 5, 6], // Mon-Sat default (matches DEFAULT_BUSINESS_DAYS in src/lib/ticket-sla.ts; seed value, operator can override via UI)
    urgentSlaMinutes: 240,
    highSlaMinutes: 480,
    mediumSlaMinutes: 1440,
    lowSlaMinutes: 10080,
    assignmentMode: "manual",
    assignmentRules: [],
    roundRobinPointer: 0,
    createdAt: now,
    updatedAt: now,
  }],
  mediaCatalogItems: [{
    id: "media_demo_1",
    workspaceId: defaultWorkspaceId,
    title: "Zari lace catalogue 2026",
    category: "catalog",
    fileName: "zari-catalogue-2026.pdf",
    fileType: "application/pdf",
    fileSize: 2_400_000,
    url: "/media/zari-catalogue-2026.pdf",
    storagePath: "media/zari-catalogue-2026.pdf",
    caption: "Full product catalogue with prices and variants",
    status: "active",
    createdAt: now,
    updatedAt: now,
  }],
  doNotContactRegistry: [{
    id: "dnc_demo_1",
    workspaceId: defaultWorkspaceId,
    sourceLeadId: "lead_dnc",
    // F-UI-7 (depth-audit 2026-07-29): a realistic DNC entry carries the
    // normalized contact keys (normalizedPhone/normalizedEmail) so the
    // remove-DNC flow (removeFromDncRegistry, which matches on these) can
    // actually remove it. The old seed omitted them, so the seeded entry was
    // an un-removable ghost. Keys now match lead_dnc's DISTINCT contacts
    // (see leads[] override) — NOT the shared hello@example.com default, so
    // only lead_dnc is blocked (not every company lead).
    // 2026-08-17 (N-SAFETY-1) — kept in lockstep with lead_dnc's phone above.
    // If these two ever drift apart the DNC entry stops matching the lead it
    // exists to block, and the demo silently shows a do-not-contact lead as
    // contactable. Change both or neither.
    normalizedPhone: "+910000009999",
    normalizedEmail: "unsubscribe@oldsupplier.example",
    reason: "Customer replied STOP to opt out",
    createdAt: now,
  }],
  // Depth-audit Batch 3 (2026-07-29): a base policySettings record so the
  // conflict-resolution tests have a known existingValue to resolve against.
  // paymentPolicy = "100% advance" is the EXISTING (operator-set) value; the
  // seeded conflict below proposes an extracted alternative. Each resolution
  // action (keep/use/custom/both/ignore) is exercised in e2e/depth-settings.
  policySettings: [{
    id: "policy_settings_demo",
    workspaceId: defaultWorkspaceId,
    paymentPolicy: "100% advance",
    createdAt: now,
    updatedAt: now,
  }],
  // One OPEN conflict targeting the sensitive paymentPolicy field. The
  // existingValue mirrors policySettings[0].paymentPolicy so the "keep" /
  // "both" actions have a deterministic expected outcome. extractedValue is
  // the crawl-derived alternative. The depth test resolves this same conflict
  // id with each of the 5 actions (restore resets it between tests).
  /**
   * 2026-09-04 (N-DEMO-1) — the catalogue was empty in the demo.
   *
   * The business profile has always listed five products (see `products:`
   * above), but those live on the PROFILE. The Catalogue screen reads
   * `productSettings`, which nothing seeded — so a demo of a system whose whole
   * job is quoting customers opened on "No products yet". The AI cannot quote
   * without prices, so several downstream screens were demonstrating an
   * emptier product than the one that exists.
   *
   * These are the same five products, with the prices and units the Quotes and
   * Orders demo data already implies (order #1 is 6,000 INR, #2 is 17,000, #3
   * is 27,600), so a reader can follow a number from the catalogue through to
   * an order without hitting a contradiction. One product carries variants so
   * the variant UI has something to show; the rest are simple.
   */
  productSettings: [{
    id: "product_settings_demo",
    workspaceId: defaultWorkspaceId,
    products: [
      {
        id: "prod_zari_thread",
        name: "Zari thread",
        category: "Textiles",
        productMode: "variant",
        material: "Polyester-viscose with metallic finish",
        moq: "5 kg",
        priceUnit: "per kg",
        price: 1200,
        inStockDispatchTime: "2-3 days",
        productionDispatchTime: "7-10 days",
        customizationAvailable: true,
        useCaseTags: ["sarees", "lehengas", "bridal wear"],
        variants: [
          { id: "var_zari_gold", name: "Gold", attributes: { colour: "gold" }, price: 1200, priceUnit: "per kg", inStockNote: "Usually in stock" },
          { id: "var_zari_silver", name: "Silver", attributes: { colour: "silver" }, price: 1150, priceUnit: "per kg", inStockNote: "Usually in stock" },
          { id: "var_zari_antique", name: "Antique", attributes: { colour: "antique" }, price: 1340, priceUnit: "per kg", inStockNote: "Made to order" },
        ],
      },
      {
        id: "prod_laces",
        name: "Laces",
        category: "Ethnic wear material",
        productMode: "simple",
        material: "Zari and cotton blend",
        sizeSpec: "Widths from 12 mm to 90 mm",
        moq: "100 metres",
        priceUnit: "per metre",
        price: 34,
        inStockDispatchTime: "2-3 days",
        productionDispatchTime: "7-10 days",
        customizationAvailable: true,
        useCaseTags: ["blouses", "dupattas", "festive garments"],
      },
      {
        id: "prod_borders",
        name: "Borders",
        category: "Ethnic wear material",
        productMode: "simple",
        material: "Zari on cotton base",
        sizeSpec: "Widths from 25 mm to 150 mm",
        moq: "100 metres",
        priceUnit: "per metre",
        price: 58,
        inStockDispatchTime: "3-4 days",
        productionDispatchTime: "10-12 days",
        customizationAvailable: true,
        useCaseTags: ["sarees", "lehengas"],
      },
      {
        id: "prod_sequins",
        name: "Sequins",
        category: "Textiles",
        productMode: "simple",
        packaging: "500 g packs",
        moq: "10 packs",
        priceUnit: "per pack",
        price: 260,
        inStockDispatchTime: "Same day",
        productionDispatchTime: "5-7 days",
        customizationAvailable: false,
        useCaseTags: ["embroidery", "bridal wear"],
      },
      {
        id: "prod_cutdana",
        name: "Cutdana",
        category: "Textiles",
        productMode: "simple",
        packaging: "250 g packs",
        moq: "20 packs",
        priceUnit: "per pack",
        price: 185,
        inStockDispatchTime: "Same day",
        productionDispatchTime: "5-7 days",
        customizationAvailable: false,
        useCaseTags: ["embroidery", "hand work"],
        notes: "Sold by weight, not by piece count.",
      },
    ],
    createdAt: now,
    updatedAt: now,
  }],
  settingsConflicts: [{
    id: "conflict_demo_1",
    workspaceId: defaultWorkspaceId,
    settingsArea: "policy",
    fieldKey: "paymentPolicy",
    existingValue: "100% advance",
    extractedValue: "50% advance, balance before dispatch",
    extractedSource: "website:https://meghdootzari.example",
    status: "open",
    createdAt: now,
    updatedAt: now,
  }],
};

function lead(
  id: string,
  companyName: string | undefined,
  status: AppData["leads"][number]["status"],
  reviewStatus: AppData["leads"][number]["reviewStatus"],
  enrichmentStatus: AppData["leads"][number]["enrichmentStatus"],
  score: number,
  doNotContact = false,
  // CP-20 (2026-08-02) — optional distinct contact details. The tour dataset
  // adds many leads; if they all shared the lead() default email/phone the DNC
  // registry would false-match them all (the F-UI-7 bug). Each enriched tour
  // lead passes its OWN email/phone so DNC matching stays isolated.
  contacts?: { email?: string; phone?: string; city?: string; buyerType?: string },
): AppData["leads"][number] {
  // F-N-R-T components are the source of truth; leadScore is their sum so the
  // pipeline score column always matches the relevancy drill-down breakdown
  // (Golden Thread at the UI layer — build-right Phase 3b).
  // 2026-08-17 (UX-2 + N-SAFETY-1) — every seeded lead used to carry the literal
  // placeholder `https://example.com`, which is what UX-2 flags as "looks like
  // onboarding was never finished". Derive a per-company domain instead, on the
  // RFC 2606 reserved `.example` TLD: it can never be registered by anyone, so
  // nothing here can point at a real business, while the UI shows a distinct,
  // plausible site per lead.
  const slug = (companyName ?? "prospect").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const leadSite = `https://${slug}.example`;
  const fitScore = Math.min(5, Math.ceil(score / 4));
  const needScore = 3;
  const reachabilityScore = companyName ? 4 : 1;
  const timingScore = status === "hot_lead" ? 5 : 2;
  const leadScore = fitScore + needScore + reachabilityScore + timingScore;
  return {
    id,
    workspaceId: defaultWorkspaceId,
    campaignId: "campaign_bridal_uae",
    icpId: "icp_bridal_uae",
    companyName,
    websiteUrl: companyName ? leadSite : "",
    source: "demo_seed",
    sourceUrl: companyName ? leadSite : "",
    email: companyName ? (contacts?.email ?? "hello@example.com") : undefined,
    // N-SAFETY-1: unassignable by construction (no Indian mobile starts with 0
    // after +91), so a live send test against demo data cannot reach a person.
    phone: companyName ? (contacts?.phone ?? "+910000000000") : undefined,
    country: "India",
    city: contacts?.city ?? "Surat",
    buyerType: contacts?.buyerType ?? "Bridal boutique",
    industry: "Fashion retail",
    companySizeBucket: "small company",
    fitReason: "Matches bridal/ethnic wear ICP and has a plausible contact route.",
    personalizationNote: "Relevant for bridal/festive zari catalogue outreach.",
    leadScore,
    fitScore,
    needScore,
    reachabilityScore,
    timingScore,
    confidenceScore: 0.72,
    qualificationStatus: leadScore >= 18 ? "sql" : leadScore >= 15 ? "mql" : leadScore >= 11 ? "good_prospect" : leadScore >= 6 ? "possible" : "unqualified",
    scoreReason: { reason: "Demo score for UI and workflow verification." },
    status,
    enrichmentStatus,
    reviewStatus,
    doNotContact,
    // S6 D-5: was "unknown" — the production create-lead path never writes
    // "unknown" (D1 fix sets "none" for fresh prospects per LOGIC.md Q11).
    // The seed script was missed, so re-running `seed:demo --force` regen'd
    // leads in a state the running system can't produce. Aligned to "none".
    consentStatus: doNotContact ? "none" : "none",
    assignedTo: "user_owner",
    lastContactedAt: status === "contacted" || status === "hot_lead" || status === "replied" || status === "interested" ? now : undefined,
    createdAt: now,
    updatedAt: now,
  };
}

async function main() {
  if (!process.argv.includes("--force")) {
    console.log("Dry run. Use npm run seed:demo -- --force to replace local demo data.");
    return;
  }
  const seeded = await buildDemoData();
  // 2026-08-19: resolve the same way src/lib/db.ts does. writeData() has always
  // honoured LEADGEN_DATA_DIR; these two lines did not, so a redirected seed run
  // backed up the file in the DEFAULT directory (a file it was not about to
  // touch) and left the redirected one unbacked. Harmless by luck, wrong by
  // construction, and the e2e suite now redirects on every run.
  const seedDataDir = process.env.LEADGEN_DATA_DIR
    ? path.resolve(process.env.LEADGEN_DATA_DIR)
    : path.join(process.cwd(), ".leadgen-data");
  const dataFile = path.join(seedDataDir, "app-data.json");
  const backupDir = path.join(seedDataDir, "backups");
  await mkdir(backupDir, { recursive: true });
  await copyFile(dataFile, path.join(backupDir, `app-data.${Date.now()}.backup.json`)).catch(() => undefined);
  await writeData(seeded);
  console.log("Demo seed data replaced with a coherent workspace. Previous data was backed up when available.");
  // N-OBS-1 (2026-08-24): say out loud what was produced. A seeded dataset
  // decays — the WhatsApp 24-hour window closes a day later — so the run that
  // creates it is the right place to state that it is currently demonstrable.
  console.log(demoFreshnessReport(demoFreshness(seeded.leads ?? [], Date.now())));
}

// 2026-08-20: run only when this file IS the command being run. It exports
// buildDemoData(), and golden-demo-data-coherence imports that — which used to
// execute main() as an import side effect. It printed the dry-run notice and
// stopped, so nothing was harmed, but a script that can rewrite the operator's
// demo data must not be reachable by importing a pure function from it.
const invokedDirectly = process.argv[1] ? path.resolve(process.argv[1]).endsWith(path.normalize("scripts/seed-demo.ts")) : false;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
