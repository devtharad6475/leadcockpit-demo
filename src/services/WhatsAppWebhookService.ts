import type { JsonRecord, Lead } from "@/lib/types";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { AuditLogService } from "@/services/AuditLogService";
import { handleIncomingWhatsAppMessage } from "@/services/WhatsAppConversationEngine";
import { autoRepliesSwitchedOn } from "@/services/AutoReplyTrialService";
import { isPermanentlyDoNotContact } from "@/lib/dnc-registry";
import { hasProcessedMessageId, recordProcessedMessageId } from "@/services/WebhookDedupService";

export type WhatsAppWebhookVerification =
  | { ok: true; challenge: string }
  | { ok: false; reason: string };

export type WhatsAppWebhookProcessResult = {
  ok: true;
  provider: "meta_cloud";
  messagesReceived: number;
  statusesReceived: number;
  processedMessages: Array<{
    from: string;
    providerMessageId?: string;
    autoReplyLogId?: string;
    replyId?: string;
    status: "processed" | "ignored" | "blocked" | "batched";
    reason?: string;
  }>;
};

type MetaWebhookPayload = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        messages?: Array<{
          from?: string;
          id?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          // CP-13 (2026-08-01) — Meta's Cloud API also delivers image/audio/
          // video/document/etc. message types (see docs/LOGIC.md CP-13b for the
          // exact contract). These are intentionally loose; InboundMediaService
          // validates the nested payload at runtime.
          image?: { id?: string; mime_type?: string; caption?: string; sha256?: string; url?: string };
          audio?: { id?: string; mime_type?: string; voice?: boolean; sha256?: string; url?: string };
          [key: string]: unknown;
        }>;
        statuses?: Array<{
          id?: string;
          status?: string;
          recipient_id?: string;
          timestamp?: string;
        }>;
      };
    }>;
  }>;
};

/**
 * @param workspaceToken the verify token this workspace saved through the
 *   Integrations screen, if any. It takes precedence over the environment
 *   variable: the operator who set it is the one Meta is talking to. Before
 *   this parameter existed the token was env-only, so a customer could paste
 *   their own send credentials in the UI and still had no way to be replied
 *   to without shell access to the server.
 */
export function verifyWhatsAppWebhook(searchParams: URLSearchParams, workspaceToken?: string): WhatsAppWebhookVerification {
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");
  // Session 1 audit fix: NEVER fall back to a hardcoded default token. If the
  // verify token is not configured, the subscription handshake fails closed.
  // (A publicly-known default token would let anyone complete the webhook
  // subscription step.) The signature verification on the POST path is a
  // separate concern tracked for the WhatsApp integration session.
  const expectedToken = workspaceToken?.trim() || process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (!expectedToken) {
    return { ok: false, reason: "WhatsApp webhook verification token is not configured." };
  }
  if (mode === "subscribe" && token === expectedToken && challenge) {
    return { ok: true, challenge };
  }
  return { ok: false, reason: "Invalid WhatsApp webhook verification token." };
}

/**
 * 2026-09-27 (review S1, critical): which company each incoming message
 * belongs to. Every message used to be filed under the default company,
 * whichever company's number received it — company B never saw its own
 * customers and the default company read them. Now each change is routed by
 * Meta's phone_number_id to the ONE company that saved that number. The
 * deployment's own number (WHATSAPP_CLOUD_PHONE_NUMBER_ID) belongs to the
 * default company. A number nobody (or more than one company) claims is
 * dropped and counted, never guessed — except in demo mode, where the sample
 * company receives it so the demo keeps working.
 */
export async function routeWhatsAppWebhook(
  payload: JsonRecord,
  repos: RepositoryBundle,
  options: { defaultWorkspaceId: string; deploymentPhoneNumberId?: string; demoFallback: boolean },
): Promise<{ routed: Array<{ workspaceId: string; payload: JsonRecord }>; unrouted: number }> {
  const parsed = payload as MetaWebhookPayload;
  const byWorkspace = new Map<string, NonNullable<MetaWebhookPayload["entry"]>>();
  const cache = new Map<string, string | undefined>();
  let unrouted = 0;
  for (const entry of parsed.entry || []) {
    for (const change of entry.changes || []) {
      const numberId = String(change.value?.metadata?.phone_number_id || "").trim();
      if (!cache.has(numberId)) {
        let owner: string | undefined;
        const claimed = numberId ? await repos.llmProviderCredential.listWorkspaceIdsForWhatsAppNumber(numberId) : [];
        if (claimed.length === 1) owner = claimed[0];
        else if (claimed.length === 0 && numberId && numberId === (options.deploymentPhoneNumberId || "").trim()) owner = options.defaultWorkspaceId;
        else if (claimed.length === 0 && options.demoFallback) owner = options.defaultWorkspaceId;
        cache.set(numberId, owner);
      }
      const owner = cache.get(numberId);
      if (!owner) {
        unrouted += (change.value?.messages?.length || 0) + (change.value?.statuses?.length || 0) || 1;
        console.warn(`[whatsapp-webhook] message for number ${numberId || "(none)"} not filed: no single company has saved this WhatsApp number.`);
        continue;
      }
      const entries = byWorkspace.get(owner) || [];
      entries.push({ ...entry, changes: [change] });
      byWorkspace.set(owner, entries);
    }
  }
  return {
    routed: [...byWorkspace.entries()].map(([workspaceId, entry]) => ({ workspaceId, payload: { ...payload, entry } as JsonRecord })),
    unrouted,
  };
}

export async function processWhatsAppCloudWebhook(
  workspaceId: string,
  payload: JsonRecord,
  repos: RepositoryBundle,
): Promise<WhatsAppWebhookProcessResult> {
  const parsed = payload as MetaWebhookPayload;
  const processedMessages: WhatsAppWebhookProcessResult["processedMessages"] = [];
  let statusesReceived = 0;

  for (const entry of parsed.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contacts = value.contacts || [];
      const phoneNumberId = value.metadata?.phone_number_id;

      if (value.statuses?.length) {
        statusesReceived += value.statuses.length;
        await new AuditLogService(repos).logAuditEvent({
          workspaceId,
          userId: "system",
          action: "whatsapp.status_received",
          entityType: "whatsapp_webhook",
          newValuesJson: {
            statuses: value.statuses.map((status) => ({
              id: status.id,
              status: status.status,
              recipientId: status.recipient_id,
              timestamp: status.timestamp,
            })),
          },
          metadataJson: { provider: "meta_cloud", phoneNumberId },
        });
      }

      for (const message of value.messages || []) {
        const textBody = message.text?.body?.trim();
        const from = message.from || "";
        const contactName = contacts.find((contact) => contact.wa_id === from)?.profile?.name || contacts[0]?.profile?.name;

        // Session 6 I-3 fix: Meta's webhook contract says "expect duplicate
        // deliveries; dedup on message.id." Before ANY heavy work, check if we
        // have already processed this message.id for this workspace. If yes,
        // skip silently (return a duplicate_skipped marker so the caller knows
        // the message was seen but intentionally not re-processed). This
        // prevents duplicate replies, tickets, and — critically — duplicate
        // DNC registrations (a customer who re-consented could be silently
        // re-blocked if a stale webhook replayed after remove-dnc).
        if (message.id && await hasProcessedMessageId(workspaceId, message.id, repos)) {
          processedMessages.push({
            from,
            providerMessageId: message.id,
            status: "ignored",
            reason: "Duplicate webhook delivery (same message.id already processed). Skipped per Meta's dedup contract.",
          });
          continue;
        }

        // 2026-08-02 audit P2-3 fix (TOCTOU race tightening): record the
        // message.id IMMEDIATELY after the dedup check passes — before the
        // media-routing branch + before ANY heavy work. Pre-fix the record was
        // ~50 lines later (after the media branch), so two CONCURRENT deliveries
        // of the same message.id could both pass the check at line ~125 before
        // either reached the record, then both ran the heavy work (duplicate
        // LLM call / ticket / DNC). Recording here shrinks the race window to a
        // single await. recordProcessedMessageId is itself idempotent (defensive
        // in-array check + Prisma unique index on (workspaceId, providerMessageId)),
        // so the worst case for a true concurrent tie is one duplicate ROW
        // collapsed by the index — but the heavy side-effects now run once.
        // Sequential replay (Meta's normal 2-3 retries) was already correct.
        // 2026-09-26 (break test): the record is also the claim. Two copies
        // arriving together both passed the check above; only the one that
        // records first goes on, so the heavy work cannot run twice.
        if (message.id && !(await recordProcessedMessageId(workspaceId, message.id, "processed", from, repos))) {
          processedMessages.push({
            from,
            providerMessageId: message.id,
            status: "ignored",
            reason: "Duplicate webhook delivery (same message.id already processed). Skipped per Meta's dedup contract.",
          });
          continue;
        }

        if (!from || message.type !== "text" || !textBody) {
          // CP-13a (2026-08-01) — media is NEVER dropped. Previously every non-
          // text message (image/audio/video/document/...) was silently ignored.
          // Now image/audio/other types route to InboundMediaService: a photo is
          // downloaded + AI-described + ALWAYS flagged for owner review; a voice
          // note is transcribed into the conversation + flagged; other types get
          // a review card. NO auto-reply (CP-13c/d/f). A missing `from` (no
          // sender) is still ignored — we cannot attribute it to a lead.
          if (!from) {
            if (message.id) await recordProcessedMessageId(workspaceId, message.id, "ignored", from, repos);
            processedMessages.push({
              from,
              providerMessageId: message.id,
              status: "ignored",
              reason: "Inbound message has no sender (from). Cannot attribute to a lead.",
            });
            continue;
          }
          // Route to the media-understanding service. It owns dedup + lead
          // resolution + DNC + the review card (CP-13). The text path below is
          // untouched.
          const { processInboundMediaMessage } = await import("@/services/InboundMediaService");
          const mediaResult = await processInboundMediaMessage(
            // alreadyClaimed: the id was recorded above as this delivery's claim
            // (2026-09-26 break test — without it every media message was
            // dropped as a duplicate of itself).
            { workspaceId, message: message as never, alreadyClaimed: Boolean(message.id) },
            repos,
          );
          processedMessages.push({
            from,
            providerMessageId: message.id,
            status: mediaResult.status === "processed" ? "processed" : mediaResult.status === "duplicate" ? "ignored" : "ignored",
            reason: mediaResult.reason,
          });
          continue;
        }

        // (The message.id was already recorded above, immediately after the
        // dedup check passed — see the 2026-08-02 P2-3 fix. It is NOT re-recorded
        // here to avoid implying the dedup fence is later than it actually is.)
        const lead = await getOrCreateInboundWhatsAppLead(workspaceId, from, contactName, repos);

        // Session 3 audit fix: if the inbound number is on the permanent DNC
        // registry, getOrCreateInboundWhatsAppLead returns null. We must NOT
        // create a reply, draft, or auto-response. Record the skip and move on.
        if (!lead) {
          processedMessages.push({
            from,
            providerMessageId: message.id,
            status: "blocked",
            reason: "Sender is on the do-not-contact registry. No lead created, no reply sent.",
          });
          continue;
        }

        // CP-23 (2026-08-02) — message batching. If enabled, the message enters
        // a per-phone buffer instead of being processed immediately. When the
        // quiet window (60s) elapses with no new message from this number, all
        // buffered messages are merged into ONE and processed together — so the
        // AI sees the full context ("price for 500m gold zari urgent") instead
        // of fragments. If batching is disabled (default), process immediately.
        const { getBatcher } = await import("@/services/MessageBatcher");
        // 2026-09-27 (review W10): batching is each company's own setting. It
        // was one in-memory switch for every company, forgotten on restart.
        const waSettings = await repos.whatsAppAgentSettings.getByWorkspace(workspaceId);
        const batcher = getBatcher(Boolean(waSettings?.messageBatchingEnabled));
        const conversationInput = {
          workspaceId,
          leadId: lead.id,
          phone: from,
          rawText: textBody,
          providerMessageId: message.id,
          metadata: {
            provider: "meta_cloud",
            contactName,
            phoneNumberId,
            timestamp: message.timestamp,
          },
        };

        // D-2026-09-27-b (CEO) — a customer who messages first may get an
        // automatic reply, but only when the owner switched automatic replies
        // on and ticked at least one proven kind of question. Until then this
        // is false, exactly as before (Phase 1.3). decideAutoReply still judges
        // every message; this only allows a send to happen at all.
        const allowRealSend = autoRepliesSwitchedOn(waSettings);
        if (batcher) {
          // Batched: add to the buffer. Processing happens after the window.
          batcher.addMessage(conversationInput, repos, allowRealSend);
          processedMessages.push({
            from,
            providerMessageId: message.id,
            status: "batched",
            reason: "Message buffered for conversation-window batching. Will be merged + processed after 60s quiet period.",
          });
        } else {
          // Not batched: process immediately (the original behavior).
          const result = await handleIncomingWhatsAppMessage(
            conversationInput,
            repos,
            { allowRealSend },
          );

          processedMessages.push({
            from,
            providerMessageId: message.id,
            autoReplyLogId: result.autoReplyLogId,
            replyId: result.replyId,
            status: "processed",
            reason: result.reason,
          });
        }
      }
    }
  }

  return {
    ok: true,
    provider: "meta_cloud",
    messagesReceived: processedMessages.filter((message) => message.status === "processed").length,
    statusesReceived,
    processedMessages,
  };
}

export async function getOrCreateInboundWhatsAppLead(workspaceId: string, phone: string, contactName: string | undefined, repos: RepositoryBundle): Promise<Lead | null> {
  // P-1 fix (Session 7, 2026-07-28): use the workspace-scoped findLeadByPhone
  // repo method instead of listLeads(...).find(...). The old path loaded EVERY
  // lead in the workspace into Node memory on every inbound message just to
  // find one by phone. Pinned by `golden:find-lead-by-phone` CASE F (asserts
  // listLeads is never called here).
  const existing = await repos.lead.findLeadByPhone(workspaceId, phone);
  if (existing) return existing;

  // Session 3 audit fix: before creating a brand-new lead from an inbound
  // WhatsApp message, check the permanent DNC registry. If this phone number
  // previously unsubscribed (even via a now-deleted lead), do NOT create a
  // fresh contactable record. Return null so the caller treats the message as
  // blocked and does not auto-reply.
  const permanentlyBlocked = await isPermanentlyDoNotContact(workspaceId, { phone }, repos);
  if (permanentlyBlocked) {
    return null;
  }

  return repos.lead.createLead({
    workspaceId,
    companyName: contactName ? `${contactName} via WhatsApp` : `WhatsApp contact ${phone}`,
    contactName,
    whatsappNumber: phone,
    source: "whatsapp",
    fitReason: "Inbound WhatsApp conversation created this CRM lead.",
    personalizationNote: "Reply safely from the Replies Inbox before making commitments.",
    status: "replied",
    reviewStatus: "pending",
    enrichmentStatus: "not_started",
    doNotContact: false,
    consentStatus: "none",
  });
}

function normalizePhone(value: string) {
  return value.replace(/\D/g, "");
}
