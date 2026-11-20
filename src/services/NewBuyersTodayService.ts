/**
 * 2026-09-28 — "Today's new buyers" (feature book #10).
 *
 * A short morning list of ONLY the new prospects worth the owner's time:
 *   - found since yesterday (created on yesterday's or today's IST date);
 *   - scored GOOD by the AI (AI-only scoring is a standing CEO decision — a
 *     lead the AI has not scored is never listed, whatever its stored numbers);
 *   - reachable: a WhatsApp number or an email, not do-not-contact (flag,
 *     status or the permanent register), not a duplicate / invalid, not rejected;
 *   - not contacted yet, and not already talking to us.
 * Best first (score, then fit, then newest), at most NEW_BUYERS_CAP.
 *
 * The owner's morning summary counts "New buyers found" with THIS function, so
 * the phone and the screen always show the same number (docs/LOGIC.md
 * TODAY'S-NEW-BUYERS).
 *
 * Reads only. Nothing here sends anything to a buyer.
 */
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { Lead, LeadStatus } from "@/lib/types";
import { startOfIstDay, todayIstIsoDate } from "@/lib/time";
import { isAiScored } from "@/lib/lead-rules";
import { isContactBlocked } from "@/lib/dnc-registry";
import { LEAD_SCORE_MAX } from "@/lib/display-labels";

/** At most this many on the list. */
export const NEW_BUYERS_CAP = 10;
/**
 * "Good" = the AI's total is in the good-prospect band or better (11+ of 20;
 * the same bands as calculateFNRTScore: 11–14 good prospect, 15–17 MQL, 18+ SQL).
 */
export const NEW_BUYER_MIN_SCORE = 11;

/** A found prospect nobody has spoken to yet. Anything later in the pipeline is not "new". */
const NEW_PROSPECT_STATUSES = new Set<LeadStatus>([
  "prospected", "discovered", "needs_review", "approved", "enriching", "enriched", "message_ready",
]);

export type NewBuyer = {
  leadId: string;
  name: string;
  score: number;
  scoreMax: number;
  /** One plain line: "Scored 16/20 — makes zari borders for sarees; has WhatsApp". */
  reason: string;
  reachBy: Array<"WhatsApp" | "email">;
  city?: string;
  foundAt: string;
  /** Still waiting for approve / not a fit (false = already approved). */
  awaitingReview: boolean;
};

export type NewBuyersToday = {
  /** Best first, at most NEW_BUYERS_CAP. */
  items: NewBuyer[];
  /** Every buyer that qualified (can be more than items.length). The morning summary shows THIS. */
  count: number;
  /** IST dates covered: yesterday and today. */
  since: string;
  day: string;
  generatedAt: string;
};

function shortReason(text?: string): string {
  const clean = (text || "").replace(/\s+/g, " ").trim().replace(/[.。]+$/, "");
  if (!clean) return "";
  if (clean.length <= 90) return lowerFirst(clean);
  const cut = clean.slice(0, 90);
  return `${lowerFirst(cut.slice(0, Math.max(cut.lastIndexOf(" "), 60)))}…`;
}

function lowerFirst(s: string): string {
  // Keep proper nouns / acronyms ("GST", "Surat") — lower only a plain capitalised word.
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

function reachChannels(lead: Lead): Array<"WhatsApp" | "email"> {
  const out: Array<"WhatsApp" | "email"> = [];
  if ((lead.whatsappNumber || "").replace(/\D/g, "").length >= 8) out.push("WhatsApp");
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((lead.email || "").trim())) out.push("email");
  return out;
}

/** The pure rules (everything except the permanent do-not-contact register). */
export function isNewBuyerCandidate(lead: Lead, since: string): boolean {
  if (!lead.createdAt || todayIstIsoDate(new Date(lead.createdAt)) < since) return false;
  if (!isAiScored(lead) || !((lead.leadScore || 0) >= NEW_BUYER_MIN_SCORE)) return false;
  if (lead.doNotContact || lead.reviewStatus === "rejected") return false;
  if (!NEW_PROSPECT_STATUSES.has(lead.status)) return false;
  if (lead.lastContactedAt || lead.lastInboundAt) return false;
  return reachChannels(lead).length > 0;
}

export async function listNewBuyersToday(
  workspaceId: string,
  repos: RepositoryBundle,
  options: { now?: Date; cap?: number } = {},
): Promise<NewBuyersToday> {
  const now = options.now || new Date();
  const cap = options.cap ?? NEW_BUYERS_CAP;
  const day = todayIstIsoDate(now);
  const since = todayIstIsoDate(new Date(startOfIstDay(now).getTime() - 12 * 60 * 60 * 1000));
  // Company-scoped by the repository (every lead query carries the workspace).
  const leads = await repos.lead.listLeads(workspaceId);

  const qualified: Lead[] = [];
  for (const lead of leads) {
    if (!isNewBuyerCandidate(lead, since)) continue;
    // The complete identity (both numbers, email and website) must be checked.
    // A registry failure must surface, never advertise an unchecked contact.
    const contact = await isContactBlocked(workspaceId, lead, repos);
    if (contact.blocked) continue;
    qualified.push(lead);
  }

  qualified.sort((a, b) =>
    (b.leadScore || 0) - (a.leadScore || 0)
    || (b.fitScore || 0) - (a.fitScore || 0)
    || String(b.createdAt).localeCompare(String(a.createdAt)));

  const items = qualified.slice(0, cap).map<NewBuyer>((lead) => {
    const reachBy = reachChannels(lead);
    const why = shortReason(lead.fitReason || lead.relevancyReason);
    const reach = `has ${reachBy.join(" and ")}`;
    return {
      leadId: lead.id,
      name: lead.companyName || lead.contactName || "Unnamed buyer",
      score: lead.leadScore,
      scoreMax: LEAD_SCORE_MAX,
      reason: [`Scored ${lead.leadScore}/${LEAD_SCORE_MAX}`, why].filter(Boolean).join(" — ") + `; ${reach}`,
      reachBy,
      city: lead.city || undefined,
      foundAt: lead.createdAt,
      awaitingReview: lead.reviewStatus !== "approved",
    };
  });

  return { items, count: qualified.length, since, day, generatedAt: now.toISOString() };
}
