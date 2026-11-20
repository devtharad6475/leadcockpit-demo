import { defaultWorkspaceId, mutateData, timestamp, uid } from "@/lib/db";
import type { AppData, Campaign, ICP, Lead } from "@/lib/types";
import { createRepositories } from "@/repositories";
import { approveLead, rejectLead } from "@/services/LeadReviewDecisionService";
import { enrichLead } from "@/services/LeadEnrichmentService";
import { createReviewedOutreachDraft } from "@/services/MessageGenerationService";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  let before: AppData | undefined;
  await mutateData((data) => {
    before = structuredClone(data);
  });

  const repos = createRepositories("json");
  const now = timestamp();
  const campaignId = uid("campaign_phase4");
  const icpId = uid("icp_phase4");
  const approveLeadId = uid("lead_phase4_approve");
  const rejectLeadId = uid("lead_phase4_reject");
  const ambiguousLeadId = uid("lead_phase4_ambiguous");
  const matchLeadId = uid("lead_phase4_match");

  try {
    await mutateData((data) => {
      const profile = data.businessProfiles[0];
      assert(profile, "Smoke requires a demo business profile.");
      const icp: ICP = {
        id: icpId,
        workspaceId: defaultWorkspaceId,
        businessProfileId: profile.id,
        name: "Reviewed B2B buyers",
        description: "Generic buyers for CRM workflow smoke.",
        buyerType: "Wholesale buyer",
        industries: ["Textile retail"],
        geography: ["Surat"],
        companySizeBucket: "small company",
        likelyNeeds: ["catalogue"],
        buyingTriggers: ["supplier review"],
        painPoints: ["reliable supply"],
        preferredChannels: ["WhatsApp"],
        messagingAngles: ["reviewed supplier"],
        qualificationRules: ["Approved before outreach"],
        confidenceScore: 0.8,
        status: "selected",
        createdAt: now,
        updatedAt: now,
      };
      const campaign: Campaign = {
        id: campaignId,
        workspaceId: defaultWorkspaceId,
        businessProfileId: profile.id,
        icpId,
        name: "Phase 4 CRM workflow smoke",
        goal: "review, enrich, and draft safe outreach",
        targetRegion: ["Surat"],
        productFocus: ["catalogue supply"],
        offer: "reviewed supplier conversation",
        selectedChannels: ["WhatsApp"],
        dailyOutreachLimit: 10,
        leadGoal: 5,
        status: "active",
        approvalStatus: "approved",
        plan: {
          icpSummary: "Reviewed wholesale buyers",
          prospectSources: ["Manual smoke data"],
          searchQueries: ["textile wholesale buyers Surat"],
          messageStrategy: "Keep draft human-reviewed.",
          outreachSequence: ["Manual WhatsApp draft"],
          qualificationCriteria: ["approved lead", "safe contact"],
          expectedLeadStatuses: ["approved", "message_ready"],
          manualExecutionSteps: ["Review", "Enrich", "Draft", "Approve manually"],
        },
        createdAt: now,
        updatedAt: now,
      };
      data.icps.push(icp);
      data.campaigns.push(campaign);
      data.leads.push(
        makeLead(approveLeadId, campaignId, icpId, "Approve Transition Co", "Surat"),
        makeLead(rejectLeadId, campaignId, icpId, "Reject Transition Co", "Mumbai"),
        makeLead(ambiguousLeadId, campaignId, icpId, "Generic Corp", "Mumbai"),
        makeLead(matchLeadId, campaignId, icpId, "Test Textiles", "Surat", "https://test-textiles.in"),
      );
    });

    const approved = await approveLead(defaultWorkspaceId, approveLeadId, repos);
    assert(approved.reviewStatus === "approved", "Approve did not set reviewStatus.");
    assert(approved.status === "approved", "Approve did not set status.");
    assert(approved.enrichmentStatus === "not_started", "Approve did not prepare lead for enrichment.");

    const rejected = await rejectLead(defaultWorkspaceId, rejectLeadId, repos);
    assert(rejected.reviewStatus === "rejected", "Reject did not set reviewStatus.");
    assert(rejected.status === "rejected", "Reject did not set status.");

    const ambiguousReady = await approveLead(defaultWorkspaceId, ambiguousLeadId, repos);
    const ambiguous = await enrichLead(defaultWorkspaceId, ambiguousReady.id, {
      candidates: [
        { companyName: "Generic Corp", city: "Delhi", industry: "Trading", email: "sales@generic-delhi.example", sourceUrl: "https://generic-delhi.example" },
        { companyName: "Generic Corp", city: "Pune", industry: "Retail", email: "sales@generic-pune.example", sourceUrl: "https://generic-pune.example" },
      ],
    }, repos);
    assert(ambiguous.status === "ambiguous", "Same-name enrichment should be ambiguous.");
    assert(!ambiguous.lead.email, "Ambiguous enrichment must not change contact fields.");
    assert(Boolean(ambiguous.validationNote), "Ambiguous enrichment needs an owner-facing note.");

    const matchReady = await approveLead(defaultWorkspaceId, matchLeadId, repos);
    const matched = await enrichLead(defaultWorkspaceId, matchReady.id, {
      candidates: [{
        companyName: "Test Textiles",
        city: "Surat",
        industry: "Textile retail",
        websiteUrl: "https://test-textiles.in",
        sourceUrl: "https://test-textiles.in/contact",
        email: "info@test-textiles.in",
        phone: "+91 261 555 0101",
      }],
    }, repos);
    assert(matched.status === "matched", "Expected matched enrichment.");
    assert(matched.lead.email === "info@test-textiles.in", "Matched enrichment did not add email.");
    assert((matched.lead.discoveredInfo || "").includes("Enriched from:"), "Matched enrichment did not record source note.");

    const profile = await repos.businessProfile.getByWorkspace(defaultWorkspaceId);
    const campaign = await repos.campaign.getById(defaultWorkspaceId, campaignId);
    assert(profile && campaign, "Profile and campaign are required for message generation.");
    const message = await createReviewedOutreachDraft({
      workspaceId: defaultWorkspaceId,
      lead: matched.lead,
      campaign,
      profile,
      channel: "WhatsApp",
      repos,
    });
    const meta = message.personalizationUsed.generationMeta as Record<string, unknown> | undefined;
    assert(message.status === "draft", "Generated message must remain a draft.");
    assert(Boolean(message.body.trim()), "Generated message body was empty.");
    assert(meta?.humanReviewRequired === true, "Generated message must require human review.");

    await mutateData((data) => {
      const events = data.auditLogs || [];
      assert(events.some((event) => event.eventType === "lead.approved" && event.entityId === approveLeadId), "Approve audit log was not created.");
      assert(events.some((event) => event.eventType === "lead.rejected" && event.entityId === rejectLeadId), "Reject audit log was not created.");
    });

    console.log("PASS crm-workflow: approve/reject audited, enrichment matched/ambiguous safely, reviewed draft generated.");
  } finally {
    if (before) {
      await mutateData((data) => {
        Object.assign(data, before);
      });
    }
  }
}

function makeLead(id: string, campaignId: string, icpId: string, companyName: string, city: string, websiteUrl?: string): Lead {
  return {
    id,
    workspaceId: defaultWorkspaceId,
    campaignId,
    icpId,
    companyName,
    websiteUrl,
    source: "phase4_smoke",
    sourceUrl: websiteUrl,
    city,
    state: city === "Surat" ? "Gujarat" : "Maharashtra",
    country: "India",
    buyerType: "Wholesale buyer",
    industry: "Textile retail",
    fitReason: "Generic smoke lead for review workflow.",
    discoveredInfo: "Created for Phase 4 smoke verification.",
    leadScore: 11,
    fitScore: 3,
    needScore: 3,
    reachabilityScore: websiteUrl ? 3 : 1,
    timingScore: 2,
    confidenceScore: 0.65,
    qualificationStatus: "good_prospect",
    scoreReason: {},
    status: "needs_review",
    enrichmentStatus: "not_started",
    reviewStatus: "pending",
    doNotContact: false,
    consentStatus: "unknown",
    assignedTo: "user_owner",
    createdAt: timestamp(),
    updatedAt: timestamp(),
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
