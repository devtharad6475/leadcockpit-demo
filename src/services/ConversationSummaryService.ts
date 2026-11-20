/**
 * CP-22 (2026-08-02) — Conversation summary service.
 *
 * Generates a 2-3 sentence natural-language summary of everything discussed
 * with a customer so far, so the owner has instant context before replying.
 *
 * How it works:
 *   1. Gathers the lead's full interaction history (replies, outreach, logs).
 *   2. Formats it as a chronological text feed.
 *   3. Asks the LLM (via message_generation task + overridePrompt) to summarize.
 *   4. If no real AI is connected (mock), returns a heuristic rule-based summary
 *      built from the same data — so the box is NEVER empty.
 *
 * Honesty: the result always reports whether it's a real-AI summary or a
 * heuristic fallback (mode: "real" | "mock" | "fallback").
 */
import type { RepositoryBundle } from "@/repositories/interfaces";
import { safeNotFound } from "@/lib/safe-not-found";
import { hasRecordedCustomerSend, hasRecordedAutomaticSend } from '@/lib/recorded-customer-send';

/** Minimal date formatter (the UI's formatDate lives in page.tsx; this is backend). */
function fmtDate(iso: string): string {
  try { return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }); } catch { return iso.slice(0, 10); }
}

export type ConversationSummaryResult = {
  summary: string;
  mode: "real" | "mock" | "fallback";
  provider?: string;
  modelName?: string;
  eventCount: number;
  contextCoverage?: { includedEvents: number; totalEvents: number; shortenedMessages: number; limited: boolean };
};

export const CONVERSATION_CONTEXT_MAX_CHARS = 24_000;
const MAX_CONTEXT_EVENTS = 80;
const MAX_MESSAGE_CHARS = 8_000;
const SHORTENED = ' [message middle omitted; original remains in customer history] ';

/** Keep both ends of an oversized message, without modifying its saved text. */
function boundedMessage(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  const room = MAX_MESSAGE_CHARS - SHORTENED.length;
  return text.slice(0, Math.ceil(room / 2)) + SHORTENED + text.slice(-Math.floor(room / 2));
}

function recentContext(events: Array<{ label: string; happenedAt: string }>) {
  const lines: string[] = [];
  let length = 0, shortenedMessages = 0;
  // Reserve space for an explicit coverage notice, rather than slicing the
  // finished text and accidentally losing that notice or a recent fact.
  for (const event of events.slice(-MAX_CONTEXT_EVENTS).reverse()) {
    const label = boundedMessage(event.label);
    const line = `[${fmtDate(event.happenedAt)}] ${label}`;
    if (length + line.length + 1 > CONVERSATION_CONTEXT_MAX_CHARS - 200) break;
    lines.unshift(line); length += line.length + 1;
    if (label.includes(SHORTENED)) shortenedMessages++;
  }
  const omitted = events.length - lines.length;
  const notice = omitted ? `[${omitted} earlier events omitted from this AI window; original history remains available.]\n` : '';
  return { text: notice + lines.join('\n'), contextCoverage: { includedEvents: lines.length, totalEvents: events.length, shortenedMessages, limited: omitted > 0 || shortenedMessages > 0 } };
}

/**
 * Gather the chronological interaction history for a lead as readable text.
 * Used both as LLM input AND as the basis for the heuristic fallback.
 */
export async function gatherHistoryText(workspaceId: string, leadId: string, repos: RepositoryBundle) {
  // F-DATA-6 (2026-08-07, real-AI proof-pass): Reply/AutoReplyLog now have a
  // real listByLead (added alongside OutreachActivity's) so this queries one
  // lead's history directly instead of scanning every reply in the workspace
  // on every inbound WhatsApp message — was an O(workspace) cost per message.
  // F-SILENT-1 (2026-08-04 build-right audit): use the Cluster 5 `safeNotFound`
  // chokepoint, NOT `.catch(() => [])`. A real DB error (corrupt JSON, Postgres
  // timeout) must surface to the operator, not silently look like "no history".
  const [replies, activities, leadLogs] = await Promise.all([
    safeNotFound(() => repos.reply.listByLead(workspaceId, leadId), { fallback: [] as Awaited<ReturnType<typeof repos.reply.listByLead>>, context: "ConversationSummary.replies" }),
    safeNotFound(() => repos.outreachActivity.listByLead(workspaceId, leadId), { fallback: [] as Awaited<ReturnType<typeof repos.outreachActivity.listByLead>>, context: "ConversationSummary.outreach" }),
    safeNotFound(() => repos.autoReplyLog.listByLead(workspaceId, leadId), { fallback: [] as Awaited<ReturnType<typeof repos.autoReplyLog.listByLead>>, context: "ConversationSummary.autoReplyLogs" }),
  ]);

  type Ev = { happenedAt: string; label: string };
  const events: Ev[] = [];
  for (const a of activities || []) {
    if (hasRecordedCustomerSend(a)) {
      events.push({ happenedAt: a.activityAt || a.createdAt, label: `You sent (${a.channel}; send recorded, delivery not confirmed here): "${a.body || ''}"` });
    }
  }
  // 2026-09-27 (A1): this history is read by models only — reply drafting, the
  // customer memory, discovery, at-risk, re-engagement, and the summary the
  // owner reads. It used to add `AI suggested: "..."` for every reply with a
  // draft, INCLUDING drafts the owner rejected or never approved, so a rejected
  // "we can deliver in 3 days" came back as something the customer had been
  // told. Now it holds only what the customer said and what actually went out:
  // an approved draft is already an OutreachActivity ("You sent"), and a reply
  // the AI sent on its own is its auto_sent log below. Pending drafts stay on
  // the owner's review screens, which do not read this.
  for (const r of replies || []) {
    events.push({ happenedAt: r.createdAt, label: `Customer replied: "${r.rawText || ''}"` });
  }
  for (const l of leadLogs) {
    if (hasRecordedAutomaticSend(l) && l.generatedReply) {
      events.push({ happenedAt: l.createdAt, label: `Sent automatically (${l.channel}; provider acceptance recorded): "${l.generatedReply}"` });
    }
    if (l.acknowledgementSent) events.push({ happenedAt: l.createdAt, label: `Holding message sent to customer.` });
    events.push({ happenedAt: l.createdAt, label: `Reply review status: ${l.status}` });
  }
  events.sort((a, b) => a.happenedAt.localeCompare(b.happenedAt));

  const context = recentContext(events);
  return { ...context, text: events.length ? context.text : 'No interactions yet.', events };
}

/**
 * Build a heuristic (no-AI) summary from the raw events. This is the fallback
 * when no real AI is connected — so the summary box is never empty.
 */
function heuristicSummary(events: Array<{ label: string; happenedAt: string }>, leadName: string): string {
  if (events.length === 0) {
    return `No conversations with ${leadName} yet. When they reply on WhatsApp or email, the history will appear here.`;
  }
  const customerMsgs = events.filter((e) => e.label.startsWith("Customer replied"));
  const youSent = events.filter((e) => e.label.startsWith("You sent"));
  const holding = events.filter((e) => e.label.includes("Holding message sent"));
  const parts: string[] = [];
  if (youSent.length > 0) parts.push(`You've sent ${youSent.length} message${youSent.length === 1 ? "" : "s"} to ${leadName}`);
  if (customerMsgs.length > 0) parts.push(`they've replied ${customerMsgs.length} time${customerMsgs.length === 1 ? "" : "s"}`);
  if (holding.length > 0) parts.push(`a holding message was sent while awaiting your input`);
  if (parts.length === 0) return `${events.length} interaction${events.length === 1 ? "" : "s"} recorded with ${leadName}.`;
  // The event label already wraps the message in quotes, so quoting it again
  // printed ""like this"" (2026-09-28). And a summary that starts with
  // "they've replied" needs a capital letter.
  const lastText = customerMsgs.length > 0 ? customerMsgs[customerMsgs.length - 1].label.replace("Customer replied: ", "").replace(/^"|"$/g, "").slice(0, 80) : "";
  const lastPart = lastText ? ` Last message from the customer: "${lastText}"` : "";
  const sentence = parts.join(", ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + "." + lastPart;
}

export async function generateConversationSummary(
  workspaceId: string,
  leadId: string,
  repos: RepositoryBundle,
): Promise<ConversationSummaryResult> {
  const lead = await repos.lead.getLeadById(workspaceId, leadId);
  const leadName = lead?.companyName || "this customer";
  const { text, events, contextCoverage } = await gatherHistoryText(workspaceId, leadId, repos);
  const { formatLeadMemoryForPrompt } = await import('./LeadMemoryService');
  const savedContext = formatLeadMemoryForPrompt(lead);

  if (events.length === 0) {
    return { summary: `No conversations with ${leadName} yet. When they reply on WhatsApp or email, the history will appear here.`, mode: "mock", eventCount: 0 };
  }

  // Try the real LLM (message_generation slot = Daily Workhorse, good for summaries).
  try {
    const { LLMService } = await import("@/llm/LLMService");
    const { conversationSummaryPrompt } = await import("@/llm/prompts/conversationSummaryPrompt");
    const llm = new LLMService();
    const result = await llm.runTask<{ summary?: string }>(
      "message_generation",
      { leadId, history: text, savedCustomerContext: savedContext },
      { workspaceId, overridePrompt: `${conversationSummaryPrompt}\n\nSaved customer context (selective notes, not a transcript):\n${savedContext || 'Nothing saved.'}\n\nRecent conversation history:\n${text}\n\nWrite the 2-3 sentence summary now:` },
    );
    // If the LLM returned a real result (not mock), use it.
    if (result.mode === "real" && !result.fallbackUsed) {
      const summaryText = typeof result.output === "string"
        ? result.output
        : (result.output as { summary?: string })?.summary
          || (result.output as { body?: string })?.body
          || String(result.output || "").slice(0, 300);
      if (summaryText && summaryText.trim().length > 10) {
        return { summary: summaryText.trim(), mode: "real", provider: result.provider, modelName: result.modelName, eventCount: events.length, contextCoverage };
      }
    }
    // Mock/fallback LLM → use heuristic.
    return { summary: heuristicSummary(events, leadName), mode: "mock", provider: result.provider, modelName: result.modelName, eventCount: events.length, contextCoverage };
  } catch {
    // LLM totally unavailable → heuristic.
    return { summary: heuristicSummary(events, leadName), mode: "fallback", eventCount: events.length, contextCoverage };
  }
}
