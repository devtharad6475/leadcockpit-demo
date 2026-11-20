import { readFileSync } from "node:fs";
import { defaultWorkspaceId, mutateData, timestamp, uid } from "@/lib/db";
import type { AppData, Campaign, ICP, Lead, MessageTemplate } from "@/lib/types";
import { createRepositories } from "@/repositories";
import { approveLead } from "@/services/LeadReviewDecisionService";
import { enrichLead } from "@/services/LeadEnrichmentService";
import { getDashboardIntelligence, getFollowupRadar, getLeadActivityTimeline, getOutreachQueue } from "@/services/OutreachQueueService";

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
  const campaignId = uid("campaign_phase5");
  const icpId = uid("icp_phase5");
  const queueLeadId = uid("lead_phase5_queue");
  const followupLeadId = uid("lead_phase5_followup");
  const messageId = uid("message_phase5_queue");

  try {
    await mutateData((data) => {
      const profile = data.businessProfiles[0];
      assert(profile, "Smoke requires a demo business profile.");
      const icp: ICP = {
        id: icpId,
        workspaceId: defaultWorkspaceId,
        businessProfileId: profile.id,
        name: "Phase 5 B2B buyers",
        description: "Generic buyers for outreach queue smoke.",
        buyerType: "Wholesale buyer",
        industries: ["Textile retail"],
        geography: ["Surat"],
        companySizeBucket: "small company",
        likelyNeeds: ["catalogue"],
        buyingTriggers: ["supplier review"],
        painPoints: ["reliable supply"],
        preferredChannels: ["WhatsApp"],
        messagingAngles: ["reviewed supplier"],
        qualificationRules: ["review before sending"],
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
        name: "Phase 5 Queue Smoke",
        goal: "review and send draft outreach manually",
        targetRegion: ["Surat"],
        productFocus: ["catalogue supply"],
        offer: "reviewed supplier introduction",
        selectedChannels: ["WhatsApp"],
        dailyOutreachLimit: 10,
        leadGoal: 5,
        status: "active",
        approvalStatus: "approved",
        plan: {
          icpSummary: "Generic B2B buyers",
          prospectSources: ["Manual smoke"],
          searchQueries: ["wholesale buyers Surat"],
          messageStrategy: "Human-reviewed draft only.",
          outreachSequence: ["Manual WhatsApp"],
          qualificationCriteria: ["approved lead"],
          expectedLeadStatuses: ["approved", "contacted"],
          manualExecutionSteps: ["Review", "Draft", "Copy", "Mark sent"],
        },
        createdAt: now,
        updatedAt: now,
      };
      data.icps.push(icp);
      data.campaigns.push(campaign);
      data.leads.push(
        // 2026-09-29: starts un-reviewed. It was seeded already approved, and
        // since 2026-09-26 approving an approved lead is (correctly) a no-op
        // with no audit row, so the timeline check below could never pass.
        makeLead(queueLeadId, campaignId, icpId, "Phase 5 Queue Lead", "needs_review"),
        {
          ...makeLead(followupLeadId, campaignId, icpId, "Phase 5 Followup Lead", "contacted"),
          reviewStatus: "approved",
          lastContactedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
        },
      );
      const message: MessageTemplate = {
        id: messageId,
        workspaceId: defaultWorkspaceId,
        campaignId,
        leadId: queueLeadId,
        channel: "WhatsApp",
        body: "Hi, this is a human-reviewed draft for Phase 5 smoke.",
        tone: "professional",
        language: "English",
        status: "draft",
        personalizationUsed: {
          generationMeta: {
            reviewState: "pending_review",
            humanReviewRequired: true,
            provider: "mock",
            modelName: "mock-balanced",
            mode: "mock",
          },
        },
        createdAt: now,
        updatedAt: now,
      };
      data.messageTemplates.push(message);
    });

    await approveLead(defaultWorkspaceId, queueLeadId, repos);
    await enrichLead(defaultWorkspaceId, queueLeadId, {
      candidates: [{
        companyName: "Phase 5 Queue Lead",
        city: "Surat",
        industry: "Textile retail",
        websiteUrl: "https://phase5-queue.example",
        sourceUrl: "https://phase5-queue.example/contact",
        email: "hello@phase5-queue.example",
      }],
    }, repos);

    const queue = await getOutreachQueue(defaultWorkspaceId, repos);
    assert(queue.count >= 1, "Outreach queue did not return the pending draft.");
    const queueItem = queue.items.find((item) => item.message.id === messageId);
    assert(queueItem?.lead.companyName === "Phase 5 Queue Lead", "Outreach queue did not join the lead.");
    assert(Boolean(queueItem.message.body), "Outreach queue message body is missing.");

    const timeline = await getLeadActivityTimeline(defaultWorkspaceId, queueLeadId, repos);
    assert(timeline.events.some((event) => event.label.toLowerCase().includes("approved")), "Activity timeline is missing lead approval.");
    const sorted = timeline.events.every((event, index, events) => index === 0 || events[index - 1].happenedAt <= event.happenedAt);
    assert(sorted, "Activity timeline is not sorted ascending.");

    const radar = await getFollowupRadar(defaultWorkspaceId, repos);
    const overdue = radar.leads.find((lead) => lead.id === followupLeadId);
    assert(overdue && overdue.daysSinceContact >= 3, "Follow-up radar did not include the overdue contacted lead.");

    const intelligence = await getDashboardIntelligence(defaultWorkspaceId, repos);
    for (const key of ["pendingReviewLeads", "draftsPendingReview", "followupsDue", "enrichmentGaps", "approvedLeads", "ambiguousEnrichments", "repliesUnread"] as const) {
      assert(typeof intelligence[key] === "number" && intelligence[key] >= 0, `Dashboard intelligence key ${key} is invalid.`);
    }

    const routeSource = readFileSync("src/app/api/[[...path]]/route.ts", "utf8");
    assert(routeSource.includes("outreach-queue") && routeSource.includes("dashboard") && routeSource.includes("intelligence"), "Phase 5 GET routes are not wired.");

    console.log(`PASS phase5-queue: ${queue.count} draft(s), ${timeline.events.length} timeline event(s), ${radar.count} follow-up(s).`);
  } finally {
    if (before) {
      await mutateData((data) => {
        const restored = structuredClone(before) as AppData;
        Object.keys(data).forEach((key) => delete (data as unknown as Record<string, unknown>)[key]);
        Object.assign(data, restored);
      });
    }
  }
}

function makeLead(id: string, campaignId: string, icpId: string, companyName: string, status: Lead["status"]): Lead {
  return {
    id,
    workspaceId: defaultWorkspaceId,
    campaignId,
    icpId,
    companyName,
    websiteUrl: `https://${companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.example`,
    source: "phase5_smoke",
    sourceUrl: "https://example.com",
    city: "Surat",
    state: "Gujarat",
    country: "India",
    buyerType: "Wholesale buyer",
    industry: "Textile retail",
    fitReason: "Generic smoke lead for Phase 5.",
    discoveredInfo: "Created for Phase 5 smoke verification.",
    leadScore: 14,
    fitScore: 4,
    needScore: 4,
    reachabilityScore: 3,
    timingScore: 3,
    confidenceScore: 0.7,
    qualificationStatus: "good_prospect",
    scoreReason: {},
    status,
    enrichmentStatus: "not_started",
    reviewStatus: status === "approved" || status === "contacted" ? "approved" : "pending",
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
