import type { AppData, Lead } from "@/lib/types";

const leadPredicates = {
  totalProspectsDiscovered: () => true,
  leadsApproved: (lead: Lead) => lead.reviewStatus === "approved",
  leadsRejected: (lead: Lead) => lead.reviewStatus === "rejected",
  leadsEnriched: (lead: Lead) => lead.enrichmentStatus === "completed",
  interestedReplies: (lead: Lead) => ["interested", "mql", "sql", "hot_lead"].includes(lead.status),
  mqlCount: (lead: Lead) => lead.status === "mql",
  sqlCount: (lead: Lead) => lead.status === "sql",
  hotLeadCount: (lead: Lead) => lead.status === "hot_lead",
  wonLostCount: (lead: Lead) => ["won", "lost"].includes(lead.status),
  campaignConversionRate: (lead: Lead) => ["mql", "sql", "hot_lead", "won"].includes(lead.status),
};
const sentStatuses = ["sent", "sent_manual", "sent_api"];
function collections(data: AppData, campaignId: string, workspaceId?: string) {
  const scope = (item: { workspaceId?: string; campaignId?: string }) => item.campaignId === campaignId && (!workspaceId || item.workspaceId === workspaceId);
  return { leads: data.leads.filter(scope), templates: data.messageTemplates.filter(scope), activities: data.outreachActivities.filter((item) => scope(item) && sentStatuses.includes(item.status)), replies: data.replies.filter(scope) };
}
export function buildCampaignAnalytics(data: AppData, campaignId: string, workspaceId?: string) {
  const records = collections(data, campaignId, workspaceId);
  const count = (key: keyof typeof leadPredicates) => records.leads.filter(leadPredicates[key]).length;
  const campaign = data.campaigns.find((item) => item.id === campaignId && (!workspaceId || item.workspaceId === workspaceId));
  return {
    totalProspectsDiscovered: count("totalProspectsDiscovered"), leadsApproved: count("leadsApproved"), leadsRejected: count("leadsRejected"), leadsEnriched: count("leadsEnriched"),
    messagesGenerated: records.templates.length, messagesMarkedSent: records.activities.length, repliesReceived: records.replies.length,
    interestedReplies: count("interestedReplies"), mqlCount: count("mqlCount"), sqlCount: count("sqlCount"), hotLeadCount: count("hotLeadCount"), wonLostCount: count("wonLostCount"),
    bestSource: "manual/csv until live integrations are connected",
    bestIcp: data.icps.find((item) => item.id === campaign?.icpId && (!workspaceId || item.workspaceId === workspaceId))?.name || "Not enough data",
    bestChannel: "WhatsApp or email after replies are logged",
    campaignConversionRate: records.leads.length ? Math.round(count("campaignConversionRate") / records.leads.length * 100) : 0,
  };
}
export type AnalyticsMetricKey = keyof ReturnType<typeof buildCampaignAnalytics>;
export const ANALYTICS_METRIC_KEYS: AnalyticsMetricKey[] = ["totalProspectsDiscovered", "leadsApproved", "leadsRejected", "leadsEnriched", "messagesGenerated", "messagesMarkedSent", "repliesReceived", "interestedReplies", "mqlCount", "sqlCount", "hotLeadCount", "wonLostCount", "bestSource", "bestIcp", "bestChannel", "campaignConversionRate"];
export type AnalyticsSourceRow = { id: string; leadId?: string; name: string; status?: string; createdAt?: string; description?: string; channel?: string };
export type AnalyticsMetricDetails = { key: AnalyticsMetricKey; value: string | number; explanation: string; source: string; formula: string; nextAction: string; total: number; rows: AnalyticsSourceRow[]; hasMore: boolean; page: number; pageSize: number; numerator?: number; denominator?: number; denominatorMetric?: AnalyticsMetricKey };
export type CampaignAnalyticsDetails = { campaign: { id: string; name: string; customerType: string }; report: ReturnType<typeof buildCampaignAnalytics>; metrics: AnalyticsMetricDetails[] };
const descriptions: Record<AnalyticsMetricKey, [string, string, string, string]> = {
  totalProspectsDiscovered: ["All prospects currently linked to this campaign, including manually added prospects.", "Campaign prospects", "Count of campaign prospects", "Review prospects"],
  leadsApproved: ["Prospects approved for this campaign.", "Prospect review status", "Review status = approved", "Review approved prospects"],
  leadsRejected: ["Prospects rejected during review.", "Prospect review status", "Review status = rejected", "Review rejection decisions"],
  leadsEnriched: ["Prospects whose research is marked completed. This does not guarantee that their phone number or email is valid.", "Prospect research progress", "Research marked completed", "Check prospect details"],
  messagesGenerated: ["Saved message drafts/templates, not unique customers or sent messages.", "Campaign message templates", "Count of message template records", "Review message drafts"],
  messagesMarkedSent: ["Saved sending records, not unique customers. Repeated sends are separate records.", "Campaign outreach log", "Count of records marked sent manually or through a connected service", "Review sending history"],
  repliesReceived: ["Saved reply records, not unique customers. Several replies from one customer each count.", "Campaign reply log", "Count of reply records", "Read customer replies"],
  interestedReplies: ["Prospects currently marked Interested, Warm leads, Ready to talk or Hot leads. This is a prospect count, not a count of reply messages.", "Current prospect status", "Interested + Warm leads + Ready to talk + Hot leads", "Follow up interested prospects"],
  mqlCount: ["Warm leads who appear to fit the target customer.", "Current prospect status", "Marked Warm leads", "Review warm leads"],
  sqlCount: ["Prospects marked Ready to talk.", "Current prospect status", "Marked Ready to talk", "Review prospects ready to talk"],
  hotLeadCount: ["Prospects currently marked as high interest.", "Current prospect status", "Marked Hot leads", "Prioritise hot prospects"],
  wonLostCount: ["Prospects marked won or lost, combined. This is not a win rate.", "Current prospect status", "Marked Won or Lost", "Review outcomes"],
  campaignConversionRate: ["Share of all campaign prospects currently marked Warm leads, Ready to talk, Hot leads or Won. This is not the percentage of completed sales.", "Current campaign prospect statuses", "(Warm leads + Ready to talk + Hot leads + Won) ÷ all campaign prospects × 100, rounded to a whole percent; empty campaign = 0%", "Review qualified prospects"],
  bestSource: ["Source comparison is not calculated yet. No winning source has been established.", "No source comparison available", "Unavailable", "Review campaign prospects"],
  bestIcp: ["The customer type selected for this campaign, not a proven best-performing customer type.", "Campaign target customer profile", "Campaign's selected customer profile", "Review campaign targeting"],
  bestChannel: ["Channel comparison is not calculated yet. No winning channel has been established.", "No channel comparison available", "Unavailable", "Review reply history"],
};
export function buildCampaignAnalyticsDetails(data: AppData, campaignId: string, workspaceId: string, options: { metric?: AnalyticsMetricKey; page?: number; pageSize?: number } = {}): CampaignAnalyticsDetails {
  const campaign = data.campaigns.find((item) => item.id === campaignId && item.workspaceId === workspaceId);
  if (!campaign) throw new Error("Campaign not found in this workspace");
  const report = buildCampaignAnalytics(data, campaignId, workspaceId);
  const records = collections(data, campaignId, workspaceId);
  // Linked display names are also scoped; corrupt/legacy links must not leak another company's customer.
  const leadMap = new Map(data.leads.filter((item) => item.workspaceId === workspaceId).map((item) => [item.id, item]));
  const leadRow = (lead: Lead): AnalyticsSourceRow => ({ id: lead.id, leadId: lead.id, name: lead.companyName || lead.contactName || "Unnamed prospect", status: lead.status, createdAt: lead.createdAt });
  const eventRow = (item: { id: string; leadId?: string; status?: string; classification?: string; createdAt: string; channel?: string }): AnalyticsSourceRow => {
    const lead = item.leadId ? leadMap.get(item.leadId) : undefined;
    return { id: item.id, leadId: lead?.id, name: lead?.companyName || lead?.contactName || "Customer not linked", status: item.status || item.classification, createdAt: item.createdAt, channel: item.channel };
  };
  const page = options.page ?? 1, pageSize = options.pageSize ?? 25;
  const metrics = (options.metric ? [options.metric] : ANALYTICS_METRIC_KEYS).map((key): AnalyticsMetricDetails => {
    let rows: AnalyticsSourceRow[] = [];
    if (key in leadPredicates) rows = records.leads.filter(leadPredicates[key as keyof typeof leadPredicates]).map(leadRow);
    else if (key === "messagesGenerated") rows = records.templates.map(eventRow);
    else if (key === "messagesMarkedSent") rows = records.activities.map(eventRow);
    else if (key === "repliesReceived") rows = records.replies.map(eventRow);
    else if (key === "bestIcp") { const profile = data.icps.find((item) => item.workspaceId === workspaceId && item.id === campaign.icpId); if (profile) rows = [{ id: profile.id, name: profile.name }]; }
    rows.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "") || a.id.localeCompare(b.id));
    const [explanation, source, formula, nextAction] = descriptions[key];
    const start = (page - 1) * pageSize;
    return { key, value: report[key], explanation, source, formula, nextAction, total: rows.length, rows: rows.slice(start, start + pageSize), hasMore: start + pageSize < rows.length, page, pageSize, ...(key === "campaignConversionRate" ? { numerator: rows.length, denominator: records.leads.length, denominatorMetric: "totalProspectsDiscovered" as const } : {}) };
  });
  return { campaign: { id: campaign.id, name: campaign.name, customerType: report.bestIcp }, report, metrics };
}

