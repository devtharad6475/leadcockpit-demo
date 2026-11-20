import "./smoke-offline-preload";
import { loadEnvConfig } from "@next/env";
// This smoke proves discovery/dedup with sample candidates, never billable search.
process.env.PLATFORM_SERPAPI_API_KEY = "";
process.env.SERPAPI_API_KEY = "";
loadEnvConfig(process.cwd());

import { defaultWorkspaceId, mutateData, timestamp, uid } from "@/lib/db";
import type { AppData, Campaign, ICP, Lead } from "@/lib/types";
import { createRepositories } from "@/repositories";
import { ProspectingService, scrapeWebsiteContacts } from "@/services/ProspectingService";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  let before: AppData | undefined;
  await mutateData((data) => {
    before = structuredClone(data);
  });

  const campaignId = uid("campaign_phase3");
  const icpId = uid("icp_phase3");

  try {
    await mutateData((data) => {
      const now = timestamp();
      const icp: ICP = {
        id: icpId,
        workspaceId: defaultWorkspaceId,
        businessProfileId: "profile_demo",
        name: "Independent boutique buyers",
        description: "Retail boutiques that need repeat B2B supply.",
        buyerType: "Boutique retailer",
        industries: ["Retail apparel"],
        geography: ["Mumbai"],
        companySizeBucket: "small company",
        likelyNeeds: ["catalogue", "wholesale supplier"],
        buyingTriggers: ["new collection", "seasonal stock"],
        painPoints: ["supplier reliability"],
        preferredChannels: ["WhatsApp"],
        messagingAngles: ["fresh catalogue", "reviewed supplier"],
        qualificationRules: ["Must be a business buyer", "Must have reachable contact details"],
        confidenceScore: 0.8,
        status: "selected",
        createdAt: now,
        updatedAt: now,
      };
      const campaign: Campaign = {
        id: campaignId,
        workspaceId: defaultWorkspaceId,
        businessProfileId: "profile_demo",
        icpId,
        name: "Boutique buyer discovery smoke",
        goal: "find qualified boutique buyers",
        targetRegion: ["Mumbai"],
        productFocus: ["catalogue supply"],
        offer: "reviewed wholesale catalogue",
        selectedChannels: ["WhatsApp"],
        dailyOutreachLimit: 10,
        leadGoal: 20,
        status: "active",
        approvalStatus: "approved",
        plan: {
          icpSummary: "Boutique retailers in Mumbai",
          prospectSources: ["Google Maps"],
          searchQueries: ["boutique retailers Mumbai wholesale"],
          messageStrategy: "Review first, then draft catalogue outreach.",
          outreachSequence: ["Manual first message"],
          qualificationCriteria: ["reachable contact", "retail apparel"],
          expectedLeadStatuses: ["needs_review", "approved"],
          manualExecutionSteps: ["Run discovery", "Review leads", "Approve safe leads"],
        },
        createdAt: now,
        updatedAt: now,
      };
      data.icps.push(icp);
      data.campaigns.push(campaign);
      data.leads = data.leads.filter((lead) => lead.campaignId !== campaignId);
    });

    const service = new ProspectingService(createRepositories("json"));
    const first = await service.prospectForWorkspace({
      workspaceId: defaultWorkspaceId,
      campaignId,
      icpId,
      query: "boutique retailers Mumbai wholesale",
      region: "Mumbai",
      limit: 3,
    });
    assert(first.status === "completed", "Prospecting run did not complete.");
    assert(first.mode === "llm_assisted_demo" || first.mode === "fallback_demo" || first.mode === "live_google_maps", "Prospecting mode was not reported.");
    assert(first.queries.length > 0, "Prospecting queries were not returned.");
    assert(first.leads.length === 3, `Expected 3 leads, found ${first.leads.length}.`);
    assert(first.leads.every((lead) => lead.leadScore === 0 && lead.qualificationStatus === "not_scored"), "Discovery must not invent qualification scores without real AI qualification.");
    assert(first.leads.every((lead) => lead.reviewStatus === "pending"), "Discovered leads should remain pending review.");
    assert(first.leads.every((lead) => lead.source), "Discovered leads are missing source labels.");
    assert(first.leads.some((lead) => lead.email || lead.phone || lead.websiteUrl), "Discovered leads are missing contact signals.");

    const second = await service.prospectForWorkspace({
      workspaceId: defaultWorkspaceId,
      campaignId,
      icpId,
      query: "boutique retailers Mumbai wholesale",
      region: "Mumbai",
      limit: 3,
    });
    assert(second.created === 0, `Second run should not create duplicates; created ${second.created}.`);
    assert(second.updated >= 3, `Second run should update existing leads; updated ${second.updated}.`);

    const storeLeads = (await createRepositories("json").lead.listLeads(defaultWorkspaceId, { campaignId })) as Lead[];
    assert(storeLeads.length === 3, `Expected 3 stored leads after repeat run, found ${storeLeads.length}.`);

    const contactInfo = await scrapeWebsiteContacts("https://example.com");
    assert(Array.isArray(contactInfo.emails), "Website contact scraper did not return email array.");

    console.log(`PASS prospecting: ${first.modeLabel}, ${first.created} created first run, ${second.updated} updated on repeat, ${storeLeads.length} stored leads.`);
  } finally {
    if (before) {
      await mutateData((data) => {
        Object.assign(data, before);
      });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
