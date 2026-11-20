import type { DashboardIntelligence, Lead, LeadActivityEvent, MessageTemplate, OutreachQueueItem } from "@/lib/types";
import { displayLabel } from "@/lib/display-labels";
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { safeNotFound } from "@/lib/safe-not-found";
import { displayLeadSource } from "@/lib/display-labels";
import { timelineSentence } from "@/services/ActivityLogService";
import { isContactBlocked } from "@/lib/dnc-registry";

export type OutreachQueueResponse = {
  count: number;
  items: OutreachQueueItem[];
};

export type FollowupRadarLead = Lead & { daysSinceContact: number };

export type FollowupRadarResponse = {
  count: number;
  leads: FollowupRadarLead[];
};

export type LeadActivityTimeline = {
  leadId: string;
  events: LeadActivityEvent[];
};

export async function getOutreachQueue(workspaceId: string, repos: RepositoryBundle = createRepositories()): Promise<OutreachQueueResponse> {
  const [messages, leads] = await Promise.all([
    repos.messageTemplate.listByWorkspace(workspaceId),
    repos.lead.listLeads(workspaceId),
  ]);
  const leadById = new Map(leads.map((lead) => [lead.id, lead]));
  const drafts = messages.filter((message) => message.status === "draft" && reviewState(message) === "pending_review");
  const draftLeadIds = new Set(drafts.map((message) => message.leadId));
  const contactSafeLeadIds = new Set<string>();
  for (const lead of leads) {
    if (!draftLeadIds.has(lead.id)) continue;
    if (lead.reviewStatus !== "approved" || ["rejected", "invalid", "duplicate", "not_interested"].includes(lead.status)) continue;
    if (!(await isContactBlocked(workspaceId, lead, repos)).blocked) contactSafeLeadIds.add(lead.id);
  }
  const items = drafts
    // 2026-09-26 (break test): a lead that opted out kept its pending drafts in
    // this "ready to review and send" queue. Opt-out is immediate; its drafts
    // are not offered.
    .filter((message) => message.leadId && contactSafeLeadIds.has(message.leadId))
    .map((message) => {
      const lead = leadById.get(message.leadId || "")!;
      return {
        message,
        lead,
        enrichmentStatus: lead.enrichmentResult?.status || "not_enriched",
        daysOld: daysSince(message.createdAt),
      } satisfies OutreachQueueItem;
    })
    .sort((a, b) => (b.lead.leadScore || 0) - (a.lead.leadScore || 0) || b.message.createdAt.localeCompare(a.message.createdAt))
    .slice(0, 20);
  return { count: items.length, items };
}

export async function getFollowupRadar(workspaceId: string, repos: RepositoryBundle = createRepositories(), staleDays = 3): Promise<FollowupRadarResponse> {
  const blocked = new Set(["interested", "not_interested", "do_not_contact", "won", "closed_won", "lost", "closed_lost"]);
  const leads = await repos.lead.listLeads(workspaceId);
  const stale = leads
    .filter((lead) => ["contacted", "replied"].includes(lead.status) && Boolean(lead.lastContactedAt) && !blocked.has(lead.status))
    .map((lead) => ({ ...lead, daysSinceContact: daysSince(lead.lastContactedAt || "") }))
    .filter((lead) => lead.daysSinceContact >= staleDays)
    .sort((a, b) => String(a.lastContactedAt || "").localeCompare(String(b.lastContactedAt || "")));
  const due: typeof stale = [];
  for (const lead of stale) {
    if (!(await isContactBlocked(workspaceId, lead, repos)).blocked) due.push(lead);
  }
  // 2026-09-27 (sector review M12): the list shows the 10 oldest, but the
  // count is how many are due. It was the length of the shown list, so it
  // could never say more than 10 — 40 leads waiting read as "10".
  return { count: due.length, leads: due.slice(0, 10) };
}

export async function getLeadActivityTimeline(workspaceId: string, leadId: string, repos: RepositoryBundle = createRepositories()): Promise<LeadActivityTimeline> {
  const lead = await repos.lead.getLeadById(workspaceId, leadId);
  if (!lead) throw new Error("Lead not found");
  const [auditLogs, outreach, replies, autoReplyLogs] = await Promise.all([
    repos.auditLog.listByWorkspace(workspaceId),
    repos.outreachActivity.listByLead(workspaceId, leadId),
    repos.reply.listByWorkspace(workspaceId),
    repos.autoReplyLog.listByWorkspace(workspaceId),
  ]);

  const events: LeadActivityEvent[] = [
    {
      type: "audit",
      label: `Lead discovered: ${lead.companyName || "Unnamed prospect"}`,
      // 2026-09-01 (N-UX-11) — third and last place `lead.source` reached the
      // operator raw. The lead drawer's activity timeline read
      // "Source: demo_seed". Same translation as the chip row and the Source
      // line above it, so all three now agree.
      detail: lead.source ? `Source: ${displayLeadSource(lead.source)}` : undefined,
      happenedAt: lead.createdAt,
    },
    ...auditLogs
      .filter((item) => item.entityId === leadId || (item.entityType === "lead" && item.entityId === leadId))
      .map((item) => ({
        type: "audit" as const,
        label: auditLabel(item.eventType, item.payload),
        detail: auditDetail(item.payload),
        happenedAt: item.createdAt,
      })),
    ...outreach.map((item) => ({
      type: "outreach" as const,
      label: `${channelLabel(item.channel)} ${item.status === "sent_manual" ? "marked sent" : item.status.replace(/_/g, " ")}`,
      detail: excerpt(item.body || item.subject || ""),
      happenedAt: item.activityAt || item.createdAt,
    })),
    ...replies
      .filter((item) => item.leadId === leadId)
      .map((item) => ({
        type: "reply" as const,
        label: "Reply received",
        detail: item.summary || excerpt(item.rawText),
        happenedAt: item.createdAt,
      })),
    ...autoReplyLogs
      .filter((log) => log.leadId === leadId)
      .map((log) => {
        let label = "WhatsApp reply log";
        let type: "audit" | "outreach" = "outreach";
        if (log.status === "auto_sent") label = "Auto reply sent";
        if (log.status === "held_for_review") label = "WhatsApp reply held for review";
        if (log.status === "blocked") label = "Auto outreach blocked";
        if (log.status === "approved") label = "WhatsApp reply approved";
        if (log.status === "rejected") label = "WhatsApp reply dismissed";
        if (log.status === "drafted") label = "WhatsApp reply drafted";
        if (log.status.startsWith("test_only_")) {
          label = "WhatsApp agent dry-run";
          type = "audit";
        }
        const incomingExcerpt = log.incomingMessage ? (log.incomingMessage.length > 60 ? log.incomingMessage.slice(0, 60) + "..." : log.incomingMessage) : "";
        const draftExcerpt = log.generatedReply ? (log.generatedReply.length > 60 ? log.generatedReply.slice(0, 60) + "..." : log.generatedReply) : "";
        const detail = `[${log.classification || "unclassified"}] ${incomingExcerpt} -> Draft: ${draftExcerpt} (Reason: ${log.reason || "none"})`;
        return {
          type,
          label,
          detail: detail.replace("â†’", "->"),
          happenedAt: log.updatedAt || log.createdAt,
        };
      }),
  ];

  return { leadId, events: events.sort((a, b) => a.happenedAt.localeCompare(b.happenedAt)) };
}

export async function getDashboardIntelligence(workspaceId: string, repos: RepositoryBundle = createRepositories()): Promise<DashboardIntelligence> {
  const [leads, messages, replies, auditLogs, followups, orders] = await Promise.all([
    repos.lead.listLeads(workspaceId),
    repos.messageTemplate.listByWorkspace(workspaceId),
    repos.reply.listByWorkspace(workspaceId),
    repos.auditLog.listByWorkspace(workspaceId),
    getFollowupRadar(workspaceId, repos),
    // F-SILENT-1 (2026-08-04 build-right audit): use safeNotFound, NOT
    // `.catch(() => [])`. A real order-repo error must surface (the dashboard's
    // recentActivity + orderEvents feed from this), not silently look like "no
    // orders yet". Matches the Cluster 5 chokepoint used across the codebase.
    safeNotFound(() => repos.order.listByWorkspace(workspaceId), { fallback: [] as Awaited<ReturnType<typeof repos.order.listByWorkspace>>, context: "DashboardIntelligence.orders" }),
  ]);
  const draftsPendingReview = messages.filter((message) => message.status === "draft" && reviewState(message) === "pending_review").length;
  // 2026-08-02 (UI polish) — recent activity was ONLY sourced from audit logs,
  // which are empty in a fresh demo (and often sparse in real use until the
  // owner has worked in the system for a while). That made the dashboard look
  // dead ("No recent activity yet") even when there are real leads, replies,
  // and orders in the workspace. Now we ALSO derive activity events from the
  // real records themselves (newest leads, replies, orders by timestamp), then
  // merge with audit logs, dedup, and take the 8 most recent. Every event is
  // backed by a real record — nothing fabricated.
  const auditEvents = auditLogs
    .filter((item) => item.entityType === "lead" || item.eventType.startsWith("lead.") || item.eventType.startsWith("message.") || item.eventType.startsWith("outreach."))
    .map((item) => ({ label: auditLabel(item.eventType, item.payload), entityId: item.entityId || "", happenedAt: item.createdAt }));
  const leadEvents = leads
    .filter((l) => l.reviewStatus === "approved" && l.companyName)
    .map((l) => ({ label: `Approved lead: ${l.companyName}`, entityId: l.id, happenedAt: l.updatedAt || l.createdAt }));
  // Resolve company name for a reply via the matching lead, when available.
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const replyEvents = replies
    .filter((r) => r.rawText)
    .map((r) => {
      // N-DATA-19: no leadId means the sender matched no lead, so the event
      // reads as a bare "Customer reply" with no company attached.
      const company = r.leadId ? leadById.get(r.leadId)?.companyName : undefined;
      return { label: `Customer reply${company ? ` from ${company}` : ""}`, entityId: r.id, happenedAt: r.createdAt };
    });
  const orderEvents = orders
    .filter((o) => o.orderNumber)
    .map((o) => ({ label: `Order #${o.orderNumber} — ${displayLabel(o.status)}`, entityId: o.id, happenedAt: o.updatedAt || o.createdAt }));
  const merged = [...auditEvents, ...leadEvents, ...replyEvents, ...orderEvents]
    .filter((e) => e.happenedAt)
    .sort((a, b) => b.happenedAt.localeCompare(a.happenedAt))
    .slice(0, 8);
  return {
    pendingReviewLeads: leads.filter((lead) => lead.reviewStatus === "pending").length,
    approvedLeads: leads.filter((lead) => lead.reviewStatus === "approved").length,
    enrichmentGaps: leads.filter((lead) => lead.reviewStatus === "approved" && lead.enrichmentStatus === "not_started").length,
    ambiguousEnrichments: leads.filter((lead) => lead.enrichmentResult?.status === "ambiguous").length,
    draftsPendingReview,
    followupsDue: followups.count,
    repliesUnread: replies.filter((reply) => !reply.classification).length,
    recentActivity: merged,
  };
}

function reviewState(message: MessageTemplate) {
  const meta = message.personalizationUsed?.generationMeta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  return String((meta as Record<string, unknown>).reviewState || "");
}

function daysSince(value: string) {
  const date = new Date(value).getTime();
  if (!Number.isFinite(date)) return 0;
  return Math.max(0, Math.floor((Date.now() - date) / (24 * 60 * 60 * 1000)));
}

function auditLabel(eventType: string, payload?: unknown) {
  const labels: Record<string, string> = {
    "lead.created": "Lead created",
    "lead.discovery.completed": "Discovery completed",
    "lead.approved": "Lead approved",
    "lead.rejected": "Lead rejected",
    "lead.enriched": "Lead enriched",
    "lead.scored": "Lead scored",
    "message.generated": "Draft generated",
    "message.approved": "Draft approved",
    "outreach.marked_sent": "Message marked sent",
    "reply.created": "Reply received",
    "reply.classified": "Reply classified",
  };
  // 2026-09-29 (owner walk-through C3): the fallback printed the event's code
  // with the dots taken out ("lead review decision created"). The Activity
  // page's plain sentence is used instead, and nothing is ever the raw code.
  return labels[eventType] || timelineSentence(eventType, (payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}) as Record<string, never>) || "Something changed on this customer";
}

function auditDetail(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const newValues = record.newValuesJson;
  if (newValues && typeof newValues === "object" && !Array.isArray(newValues)) {
    const values = newValues as Record<string, unknown>;
    if (values.reason) return String(values.reason);
    // 2026-09-29 (walk-through C3): the stored status code and a message id
    // were printed as they are ("Status: needs_review", "Message: msg_8f2…").
    if (values.status) return `Status: ${displayLabel(String(values.status))}`;
  }
  return undefined;
}

function channelLabel(channel: string) {
  return channel ? channel.charAt(0).toUpperCase() + channel.slice(1) : "Outreach";
}

function excerpt(value: string) {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > 140 ? `${clean.slice(0, 140)}...` : clean || undefined;
}
