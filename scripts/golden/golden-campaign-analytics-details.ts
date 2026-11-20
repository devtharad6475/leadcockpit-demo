import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/[[...path]]/route";
import { mutateData, defaultWorkspaceId } from "@/lib/db";
import { createRepositories } from "@/repositories";
import { ensureWorkspace } from "./_helpers/fixtures";
import { buildCampaignAnalytics, buildCampaignAnalyticsDetails, ANALYTICS_METRIC_KEYS } from "@/services/CampaignAnalyticsService";
import type { AppData, Lead, Campaign, MessageTemplate, OutreachActivity, Reply, ICP } from "@/lib/types";

async function main() {
  process.env.AUTH_MODE = "demo";
  const ws = defaultWorkspaceId, foreign = "ws_analytics_foreign", id = "campaign_traceability";
  const now = "2026-10-07T12:00:00.000Z";
  const leads = ["mql", "sql", "hot_lead", "won", "lost", "interested", "new"].map((status, index) => ({ id: `trace_lead_${index}`, workspaceId: ws, campaignId: id, companyName: `Sample ${index}`, status, reviewStatus: index < 4 ? "approved" : index === 4 ? "rejected" : "pending", enrichmentStatus: index < 2 ? "completed" : "not_started", createdAt: now })) as Lead[];
  const data = {
    leads: [...leads, { ...leads[0], id: "foreign_lead", workspaceId: foreign, companyName: "Private foreign name" }],
    campaigns: [{ id, workspaceId: ws, name: "Trial campaign", icpId: "trace_icp" }, { id: "foreign_campaign", workspaceId: foreign, name: "Private campaign" } ] as Campaign[],
    icps: [{ id: "trace_icp", workspaceId: ws, name: "Trial customer type" }] as ICP[],
    messageTemplates: [0, 1].map((index) => ({ id: `trace_template_${index}`, workspaceId: ws, campaignId: id, leadId: leads[0].id, createdAt: now })) as MessageTemplate[],
    outreachActivities: ["sent", "sent_manual", "sent_api", "failed", "drafted"].map((status, index) => ({ id: `trace_send_${index}`, workspaceId: ws, campaignId: id, leadId: leads[0].id, status, createdAt: now })) as OutreachActivity[],
    replies: [{ id: "trace_reply_1", workspaceId: ws, campaignId: id, leadId: leads[0].id, createdAt: now }, { id: "trace_reply_2", workspaceId: ws, campaignId: id, leadId: "foreign_lead", createdAt: now, rawText: "Private legacy message" }] as Reply[],
  } as AppData;
  const report = buildCampaignAnalytics(data, id, ws);
  assert.deepEqual([report.totalProspectsDiscovered, report.leadsApproved, report.leadsRejected, report.leadsEnriched, report.messagesGenerated, report.messagesMarkedSent, report.repliesReceived, report.interestedReplies, report.mqlCount, report.sqlCount, report.hotLeadCount, report.wonLostCount, report.campaignConversionRate], [7, 4, 1, 2, 2, 3, 2, 4, 1, 1, 1, 2, 57]);
  const details = buildCampaignAnalyticsDetails(data, id, ws, { pageSize: 2 });
  assert.equal(details.metrics.length, ANALYTICS_METRIC_KEYS.length);
  for (const metric of details.metrics) {
    if (typeof metric.value === "number" && metric.key !== "campaignConversionRate") assert.equal(metric.total, metric.value, `source count matches ${metric.key}`);
    assert.ok(metric.rows.length <= 2);
  }
  const conversion = details.metrics.find((metric) => metric.key === "campaignConversionRate")!;
  assert.equal(conversion.numerator, 4); assert.equal(conversion.denominator, 7); assert.equal(conversion.denominatorMetric, "totalProspectsDiscovered");
  const first = details.metrics.find((metric) => metric.key === "totalProspectsDiscovered")!;
  assert.equal(first.hasMore, true);
  const second = buildCampaignAnalyticsDetails(data, id, ws, { metric: "totalProspectsDiscovered", page: 2, pageSize: 2 }).metrics[0];
  assert.deepEqual(second.rows.map((row) => row.id), leads.slice(2, 4).map((lead) => lead.id));
  const shuffled = buildCampaignAnalyticsDetails({ ...data, leads: [...data.leads].reverse() }, id, ws, { metric: "totalProspectsDiscovered", page: 2, pageSize: 2 }).metrics[0];
  assert.deepEqual(shuffled.rows, second.rows, "equal-date pagination is stable regardless of repository order");
  const dated = buildCampaignAnalyticsDetails({ ...data, leads: data.leads.map((lead) => lead.id === leads[6].id ? { ...lead, createdAt: "2026-10-08T00:00:00.000Z" } : lead) }, id, ws, { metric: "totalProspectsDiscovered", pageSize: 1 }).metrics[0];
  assert.equal(dated.rows[0].id, leads[6].id, "most recent source record sorts first");
  const last = buildCampaignAnalyticsDetails(data, id, ws, { metric: "totalProspectsDiscovered", page: 4, pageSize: 2 }).metrics[0];
  assert.equal(last.rows.length, 1); assert.equal(last.hasMore, false);
  const replyRows = details.metrics.find((metric) => metric.key === "repliesReceived")!.rows;
  assert.equal(replyRows[1].leadId, undefined); assert.equal(replyRows[1].name, "Customer not linked");
  assert.ok(!JSON.stringify(details).includes("Private"));
  const empty = buildCampaignAnalyticsDetails({ ...data, leads: [], messageTemplates: [], outreachActivities: [], replies: [] }, id, ws);
  assert.equal(empty.report.campaignConversionRate, 0); assert.equal(empty.metrics.find((item) => item.key === "campaignConversionRate")!.denominator, 0);
  assert.throws(() => buildCampaignAnalyticsDetails(data, "foreign_campaign", ws));
  const repos = createRepositories(); await ensureWorkspace(repos, ws); await ensureWorkspace(repos, foreign);
  await mutateData((store) => { store.campaigns.push(...data.campaigns); store.icps.push(...data.icps); store.leads.push(...data.leads); store.messageTemplates.push(...data.messageTemplates); store.outreachActivities.push(...data.outreachActivities); store.replies.push(...data.replies); });
  async function get(campaignId: string, query = "") { return GET(new NextRequest(`http://localhost:3000/api/analytics/campaign/${campaignId}/details${query}`), { params: Promise.resolve({ path: ["analytics", "campaign", campaignId, "details"] }) }); }
  assert.equal((await get("foreign_campaign")).status, 404);
  for (const query of ["?metric=unknown", "?page=0", "?page=-1", "?page=1.5", "?page=100001", "?pageSize=101", "?pageSize=0", "?pageSize=no"]) assert.equal((await get(id, query)).status, 400, query);
  const response = await get(id, "?metric=messagesGenerated&pageSize=1&page=2"); assert.equal(response.status, 200);
  const payload = await response.json(); assert.equal(payload.metrics.length, 1); assert.equal(payload.metrics[0].total, 2); assert.equal(payload.metrics[0].rows[0].id, "trace_template_1"); assert.equal(payload.metrics[0].hasMore, false);
  console.log("Campaign analytics source traceability: counts, conversion, tenant guard, safe linked names, pagination and empty state passed.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
