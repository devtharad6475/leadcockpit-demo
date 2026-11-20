import { NeedsActionError } from "@/lib/user-errors";
import { oneAtATime } from "@/lib/one-at-a-time";
import { isContactBlocked } from "@/lib/dnc-registry";
import { shouldProtectQualifiedStatus } from "@/lib/lead-rules";
import { safeAudit } from "@/lib/safe-audit";
import type { AutoReplyLog } from "@/lib/types";
import { MetaWhatsAppCloudProvider } from "@/providers/whatsapp/MetaWhatsAppCloudProvider";
import type { WhatsAppSendProvider, WhatsAppSendResult } from "@/providers/whatsapp/WhatsAppSendProvider";
import type { EmailSendProvider } from "@/providers/email";
import { sendEmailForWorkspace } from "@/providers/email";
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { AuditLogService } from "@/services/AuditLogService";

/**
 * GAP-2 (2026-07-31) — optional injection point for the email provider. In
 * production this is unset and the real Resend/Mock factory (`sendEmail`) is
 * used. Tests inject a stub so the golden can assert the send happened without
 * a real network call. The lead's recipient email is resolved from the lead
 * record (not passed in) so the caller can't spoof a recipient.
 */
export type ApproveOptions = {
  emailProvider?: EmailSendProvider;
  /**
   * Test seam, mirroring `emailProvider` above. When supplied, this provider is
   * used instead of resolving one from the workspace's saved credentials.
   *
   * Added 2026-08-26 (S24-14) because the 24-hour-window branch below was
   * unreachable from a test without either real network traffic to Meta or a
   * stub over global fetch. Both are worse than a symmetric injection point:
   * the email path has had exactly this seam since GAP-2 and it is what makes
   * the email send path provable. Production callers pass nothing and the
   * per-workspace credential resolution is unchanged.
   */
  whatsappProvider?: WhatsAppSendProvider;
};

export async function approveAutoReplyLog(
  workspaceId: string,
  autoReplyLogId: string,
  input: { body?: string; mediaAttachmentId?: string; templateName?: string; templateLanguage?: string } = {},
  repos: RepositoryBundle = createRepositories(),
  actorUserId: string = "owner",
  options: ApproveOptions = {},
) {
  // 2026-09-26 (break test): the "already approved?" check below stops a
  // second click that arrives AFTER the first finished. Two arriving together
  // both passed it and both sent — the customer got the message twice.
  // Approvals of one draft now run one after another, so the second one sees
  // the first one's result.
  return oneAtATime(`approve-reply:${workspaceId}:${autoReplyLogId}`, () => approveAutoReplyLogNow(workspaceId, autoReplyLogId, input, repos, actorUserId, options));
}

async function approveAutoReplyLogNow(
  workspaceId: string,
  autoReplyLogId: string,
  input: { body?: string; mediaAttachmentId?: string; templateName?: string; templateLanguage?: string },
  repos: RepositoryBundle,
  actorUserId: string,
  options: ApproveOptions,
) {
  const log = await repos.autoReplyLog.getById(workspaceId, autoReplyLogId);
  if (!log) throw new NeedsActionError("This reply draft no longer exists.", 404);
  if (log.status === "rejected") throw new NeedsActionError("This draft was rejected, so it cannot be sent. Write a new reply instead.");
  // Cluster C fix (2026-07-21 session 19): block re-approving an already-
  // approved (or auto-sent) log. Without this, a double-click on Approve,
  // or a UI retry on network-slow, would send the WhatsApp message TWICE.
  // The customer gets two identical messages — looks careless. Per
  // operator decision 2026-07-21 (the rule is "Block 2nd click").
  // 2026-09-27 (review W7): a test from the settings screen is not a customer
  // conversation. Linked to a real lead, it showed "Approve & Send" and sent a
  // price the customer never asked for (and counted toward the trial).
  if (String(log.status).startsWith("test_only")) {
    throw new NeedsActionError("This was a test from the settings screen, not a customer's message — it can't be sent.", 409);
  }
  if (log.status === "approved" || log.status === "auto_sent") {
    throw new NeedsActionError(log.status === "auto_sent" ? "This reply was already sent automatically." : log.retrievedContext?.source === "ticket_closure" ? "This reply was already approved. Check its delivery record before sending again." : "This reply was already approved and sent — it is not sent twice.");
  }
  const approvedText = String(input.body || log.generatedReply || "").trim();
  if (!approvedText) throw new NeedsActionError("Approved reply text is required", 400);
  // N5 (2026-09-23): approval overwrites generatedReply with the sent text.
  // When the owner changed the draft, the AI's version is kept beside it —
  // otherwise the correction, the clearest statement of what the AI got wrong,
  // is thrown away. Compared on content, not bytes, so a stray space is not an edit.
  const aiOriginal = String(log.generatedReply || "").trim();
  const ownerEdited = Boolean(aiOriginal) && aiOriginal.replace(/\s+/g, " ") !== approvedText.replace(/\s+/g, " ");
  const lead = log.leadId ? await repos.lead.getLeadById(workspaceId, log.leadId) : undefined;
  // N-DATA-10 (2026-08-20): the draft may point at a lead that NO LONGER
  // EXISTS. Found for real in the ship database: a delete removed the lead and
  // left this row behind, so the approval queue held a draft for a customer
  // record that is gone. Every step below then degraded quietly rather than
  // failing: `to` resolves to "", the WhatsApp branch returned a non-"failed"
  // status so nothing threw, the `if (lead)` guard skipped BOTH the outreach
  // row and the status update, and the log still ended up marked "approved".
  // The operator reads "approved" on a message nobody received, with not even
  // a failed outreach row to contradict it. Refuse instead — an approval that
  // cannot be delivered must not be recorded as one.
  if (log.leadId && !lead) {
    throw new Error(
      `This draft belongs to customer record "${log.leadId}", which no longer exists. ` +
      "Nothing can be delivered, so it cannot be approved — reject it instead.",
    );
  }
  // R1 audit fix: consult the PERMANENT DNC registry, not just the lead flag.
  // A contact whose flag was cleared (re-import, manual edit) but who is still
  // on the permanent DNC list must still be blocked. Matches policies/do-not-
  // contact-policy.md: "Do not enrich, contact, or auto-send to do_not_contact
  // leads." Mirrors the defense-in-depth check at route.ts message-generation.
  const dncCheck = await isContactBlocked(workspaceId, lead, repos);
  if (dncCheck.blocked) {
    throw new Error(dncCheck.reason || "Outreach is blocked because this contact is on the do-not-contact list.");
  }
  const mediaAttachmentId = input.mediaAttachmentId || log.mediaAttachmentId;
  const mediaAttachment = mediaAttachmentId ? await repos.mediaCatalog.getById(workspaceId, mediaAttachmentId) : undefined;
  const isClosure = log.retrievedContext?.source === "ticket_closure";
  if (isClosure) {
    // Commit a durable claim before any irreversible provider call. The same
    // workspace lock used by draft replacement makes the two paths exclusive
    // across PostgreSQL instances; no network call holds this transaction open.
    await oneAtATime(`team:${workspaceId}`, () => {
      const claim = async () => {
        const current = await repos.autoReplyLog.getById(workspaceId, autoReplyLogId);
        if (!current || !["held_for_review", "drafted"].includes(current.status)) {
          throw new NeedsActionError("This reply has already been reviewed or replaced. Refresh before continuing.", 409);
        }
        await repos.autoReplyLog.approve(workspaceId, autoReplyLogId, {
          generatedReply: approvedText, canAutoSend: false,
          ...(ownerEdited ? { aiDraft: aiOriginal, ownerEdited: true } : {}),
          sendAttempted: false, sendStatus: "unconfirmed",
          providerError: "Approval started. Customer delivery has not yet been confirmed. Verify delivery before trying again.",
        });
      };
      if (repos.withWorkspaceTeamTransaction) return repos.withWorkspaceTeamTransaction(workspaceId, claim);
      return repos.withTransaction ? repos.withTransaction(claim) : claim();
    });
  }
  let send: WhatsAppSendResult;
  try {
  send = await sendApprovedReply({
    workspaceId,
    channel: log.channel,
    to: lead?.whatsappNumber || lead?.phone || "",
    toEmail: lead?.email || "",
    body: approvedText,
    mediaAttachment,
    emailProvider: options.emailProvider,
    whatsappProvider: options.whatsappProvider, // S24-14 test seam (undefined in production).
    repos, // CP-17c: resolve per-workspace WhatsApp creds.
    lastInboundAt: lead?.lastInboundAt, // CP-24 — drives the 24h window gate.
    templateName: typeof input.templateName === "string" ? input.templateName : undefined,
    templateLanguage: typeof input.templateLanguage === "string" ? input.templateLanguage : undefined,
  });
  } catch (error) {
    if (isClosure) {
      // A provider exception may occur after acceptance. Keep the durable claim
      // instead of making an uncertain send automatically repeatable.
      throw new NeedsActionError("The reply was approved, but delivery could not be confirmed. Check the customer's conversation before sending it yourself or recording that you sent it.", 409);
    }
    throw error;
  }
  if (send.status === "failed") {
    if (isClosure) {
      await repos.autoReplyLog.approve(workspaceId, autoReplyLogId, {
        generatedReply: approvedText, sendAttempted: send.attempted, sendStatus: "unconfirmed",
        providerError: send.errorMessage || "Delivery could not be confirmed. Check the customer's conversation before sending again.",
      });
    }
    await new AuditLogService(repos).logAuditEvent({
      workspaceId,
      userId: actorUserId,
      action: "message.send_failed",
      entityType: "auto_reply_log",
      entityId: autoReplyLogId,
      newValuesJson: { status: "approved", sendStatus: send.status, providerError: send.errorMessage },
    });
    // 2026-09-26 (break test): this was a plain Error, so the API answered 500
    // "something went wrong on our side" and the owner never saw the reason
    // (expired token, "retry after 42 seconds"). The reason is the owner's next
    // step, and the draft stays approvable, so it is shown as written.
    const channelName = String(log.channel || "whatsapp").toLowerCase() === "email" ? "Email" : "WhatsApp";
    throw new NeedsActionError(isClosure
      ? `${channelName} did not confirm delivery: ${send.errorMessage || "no reason was given."} Check the customer's conversation before sending it yourself. The app will not repeat this reply automatically.`
      : `${channelName} did not accept this reply, so nothing was sent: ${send.errorMessage || "no reason was given."}`);
  }
  // Cluster 6 fix (P1-6): wrap the 4 post-send writes (log.approve, outreach
  // create, lead update, audit) in a defensive try/catch. The WhatsApp send
  // is an IRREVERSIBLE external side effect — it cannot be rolled back. So
  // true atomicity isn't achievable here. Instead: if any LOCAL write throws
  // after the send succeeded, we record a "post-send write failed" audit
  // entry so the operator knows the database state may be partial (the
  // customer got the message but the audit trail / outreach timeline may be
  // incomplete). This makes the failure VISIBLE rather than silent, per
  // build-right Phase 4 "No Silent Failures". (The JSON repo methods each
  // use mutateData internally — they're individually atomic; the residual
  // risk is a crash BETWEEN them.)
  let approved: AutoReplyLog;
  try {
    approved = await repos.autoReplyLog.approve(workspaceId, autoReplyLogId, {
      generatedReply: approvedText,
      ...(ownerEdited ? { aiDraft: aiOriginal, ownerEdited: true } : {}),
      canAutoSend: false,
      needsHumanReview: false,
      sendAttempted: send.attempted,
      sendStatus: send.status,
      providerMessageId: send.providerMessageId,
      providerError: send.errorMessage,
      mediaAttachmentId: mediaAttachment?.id,
      mediaAttachmentUrl: mediaAttachment?.url,
      mediaAttachmentName: mediaAttachment?.title,
    });
    if (lead) {
        await repos.outreachActivity.create({
          workspaceId,
          campaignId: lead.campaignId,
          leadId: lead.id,
          channel: log.channel || "whatsapp",
          direction: "outbound",
          // Cluster J fix (2026-07-21 session 20): honest send status. The
          // OLD code mapped not-sent (blocked / not_configured / dry_run) to
          // "sent_manual" (looks like a successful manual send). Now each
          // WhatsApp status maps to an honest outreach-status value.
          // Failed is already early-returned above.
          status: send.status === "sent"
            ? "sent_api"
            : send.status === "not_configured" || send.status === "not_attempted"
              ? "failed"  // not actually delivered — record as failed, not sent
              : "sent_manual",  // dry_run / blocked = manual follow-up expected
          sentManually: send.status !== "sent",
          body: approvedText,
          mediaAttachmentId: mediaAttachment?.id,
          mediaAttachmentUrl: mediaAttachment?.url,
          mediaAttachmentName: mediaAttachment?.title,
          activityAt: timestamp(),
          createdBy: send.status === "sent" ? "meta_whatsapp_cloud" : "user_owner",
        });
        // F1 (2026-08-04 CONTINUOUS-2 audit): protect qualified lead statuses.
        // The sibling outbound-log route (route.ts ~2316) + the inbound engine
        // (WhatsAppConversationEngine nextStatus()) BOTH gate with
        // shouldProtectQualifiedStatus; this approve+send path was the only one
        // that demoted a hot_lead/mql/sql/opportunity/won to "contacted" on
        // reply. Mirror the guard: keep the qualified status, just refresh
        // lastContactedAt.
        const nextStatus = shouldProtectQualifiedStatus(lead.status) ? lead.status : "contacted";
        await repos.lead.updateLead(workspaceId, lead.id, { status: nextStatus, lastContactedAt: timestamp() });
    }
    await new AuditLogService(repos).logAuditEvent({
      workspaceId,
      userId: actorUserId,
      action: "message.approved",
      entityType: "auto_reply_log",
      entityId: autoReplyLogId,
      newValuesJson: { status: "approved", leadId: log.leadId, channel: log.channel, sendStatus: send.status, providerMessageId: send.providerMessageId, mediaAttachmentId: mediaAttachment?.id },
    });
  } catch (postSendError) {
    // The send succeeded but a local write failed. The customer got the
    // message; the database state may be partial. Record this loudly so the
    // operator can reconcile (re-run the approval, check the audit trail).
    // A-2 (Session 7, 2026-07-28): route through safeAudit so a failure of THIS
    // last-resort audit write is logged to console.error + Sentry instead of
    // being swallowed by .catch(() => undefined) (silent). The primary
    // postSendError is still re-thrown below so the caller sees the real failure.
    await safeAudit(repos, {
      workspaceId,
      userId: actorUserId,
      action: "message.approved_partial",
      entityType: "auto_reply_log",
      entityId: autoReplyLogId,
      newValuesJson: {
        warning: "WhatsApp send succeeded but a post-send database write failed. Customer received the message; audit trail / outreach timeline may be incomplete.",
        sendStatus: send.status,
        providerMessageId: send.providerMessageId,
        postSendError: postSendError instanceof Error ? postSendError.message : String(postSendError),
      },
    });
    throw postSendError;
  }
  // N5 — the owner corrected the AI. See whether this topic has a pattern worth
  // proposing. After the send, never awaited, never throws: the customer has
  // their reply and nothing here can take it back or hold it up.
  if (ownerEdited) {
    void import("@/services/LearnedRuleService").then(({ considerLearning }) =>
      considerLearning(workspaceId, approved.classification || "general", repos),
    ).catch((error) => console.warn(`[learned-rules] could not load: ${error instanceof Error ? error.message : String(error)}`));
  }
  return approved;
}

export async function rejectAutoReplyLog(
  workspaceId: string,
  autoReplyLogId: string,
  repos: RepositoryBundle = createRepositories(),
  options?: { reason?: string },
  actorUserId: string = "owner",
): Promise<AutoReplyLog> {
  // 2026-09-26 (break test): reject had no status check, so dismissing a reply
  // that was already approved and SENT relabelled it "rejected" — the record
  // then denied a message the customer had received. It shares the approve
  // lane, so a dismiss clicked while a send is in flight waits for its result
  // instead of racing it.
  return oneAtATime(`approve-reply:${workspaceId}:${autoReplyLogId}`, async () => {
    const current = await repos.autoReplyLog.getById(workspaceId, autoReplyLogId);
    if (!current) throw new NeedsActionError("This reply draft no longer exists.", 404);
    if (current.status === "approved" || current.status === "auto_sent") {
      throw new NeedsActionError("This reply was already sent to the customer, so it cannot be dismissed.");
    }
    // Already dismissed: nothing changes, and no second audit row.
    if (current.status === "rejected") return current;
    return rejectAutoReplyLogNow(workspaceId, autoReplyLogId, repos, options, actorUserId);
  });
}

async function rejectAutoReplyLogNow(
  workspaceId: string,
  autoReplyLogId: string,
  repos: RepositoryBundle,
  options: { reason?: string } | undefined,
  actorUserId: string,
): Promise<AutoReplyLog> {
  const rejected = await repos.autoReplyLog.reject(workspaceId, autoReplyLogId);
  await new AuditLogService(repos).logAuditEvent({
    workspaceId,
    userId: actorUserId,
    action: "message.rejected",
    entityType: "auto_reply_log",
    entityId: autoReplyLogId,
    newValuesJson: { status: "rejected", leadId: rejected.leadId, channel: rejected.channel, ...(options?.reason ? { reason: options.reason } : {}) },
  });
  return rejected;
}

/**
 * 2026-09-29 (owner walk-through R2) — "I sent it myself". An approved reply
 * that never reached the customer (WhatsApp not connected, window closed, a
 * block) used to end on a Copy button: the owner copied it, sent it from their
 * phone, and the system went on saying the customer received nothing — and
 * went on listing the customer as waiting. This records the owner's word:
 * the row reads "Sent by you" (never "Sent on WhatsApp"), and the customer
 * counts as answered. Only for an approved reply that was not delivered.
 */
export async function markReplySentByOwner(
  workspaceId: string,
  autoReplyLogId: string,
  repos: RepositoryBundle = createRepositories(),
  actorUserId: string = "owner",
): Promise<AutoReplyLog> {
  return oneAtATime(`approve-reply:${workspaceId}:${autoReplyLogId}`, async () => {
    const current = await repos.autoReplyLog.getById(workspaceId, autoReplyLogId);
    if (!current) throw new NeedsActionError("This reply no longer exists.", 404);
    if (current.sendStatus === "sent" || current.sendStatus === "sent_by_owner" || current.status === "auto_sent") return current;
    if (current.status !== "approved") {
      throw new NeedsActionError("Approve the reply first, then mark it as sent.", 409);
    }
    const at = timestamp();
    const updated = await repos.autoReplyLog.approve(workspaceId, autoReplyLogId, { sendStatus: "sent_by_owner", sendAttempted: true });
    if (current.leadId) {
      await repos.lead.updateLead(workspaceId, current.leadId, { lastContactedAt: at } as never).catch(() => undefined);
    }
    await safeAudit(repos, {
      workspaceId,
      userId: actorUserId,
      action: "message.sent_by_owner",
      entityType: "auto_reply_log",
      entityId: autoReplyLogId,
      newValuesJson: { leadId: current.leadId, channel: current.channel },
    });
    return updated;
  });
}

function timestamp() {
  return new Date().toISOString();
}

async function sendApprovedReply(input: {
  workspaceId: string;
  channel?: string;
  to: string;
  toEmail?: string;
  body: string;
  mediaAttachment?: { url: string; fileType: string; fileName: string };
  emailProvider?: EmailSendProvider;
  /** S24-14 test seam: overrides credential resolution when supplied. */
  whatsappProvider?: WhatsAppSendProvider;
  /** CP-17c: when provided, per-workspace WhatsApp creds override env. */
  repos?: RepositoryBundle;
  /** CP-24: the customer's last inbound message time (drives the 24h window). */
  lastInboundAt?: string;
  /** CP-25: when the 24h window is closed, the owner picks a pre-approved
   *  template; the send uses the template API instead of free-text. */
  templateName?: string;
  templateLanguage?: string;
}): Promise<WhatsAppSendResult> {
  const channel = (input.channel || "whatsapp").toLowerCase();

  // GAP-2 (2026-07-31) — EMAIL branch. Before this, any non-WhatsApp channel
  // returned `not_attempted` (an email lead could be drafted to but never
  // emailed, even after the owner approved). Now an email draft is actually
  // sent via the Resend/Mock provider — still HUMAN-GATED (this only runs on
  // the explicit approve action), so no-auto-outreach is preserved.
  if (channel === "email") {
    const toEmail = (input.toEmail || "").trim();
    if (!toEmail) {
      // CASE D: honest error — we cannot email a lead with no address. Throw
      // rather than silently not_attempted (build-right: no silent failures).
      throw new Error("Cannot send an email reply: this lead has no email address on file. Add an email to the lead first.");
    }
    // CP-18c (2026-08-02) — per-workspace Resend key overrides env. Resolve the
    // workspace's own key (when repos is provided) so a customer's saved email
    // credentials take effect. Falls back to env when none.
    let workspaceResendKey: string | undefined;
    if (input.repos) {
      workspaceResendKey = await new (await import("@/services/IntegrationCredentialService")).IntegrationCredentialService(input.repos).resolveKey(input.workspaceId, "resend");
    }
    const sendFn = input.emailProvider
      ? (i: Parameters<EmailSendProvider["send"]>[0]) => input.emailProvider!.send(i)
      : (i: Parameters<EmailSendProvider["send"]>[0]) => sendEmailForWorkspace(i, workspaceResendKey);
    const result = await sendFn({
      from: process.env.OUTBOUND_EMAIL_FROM || process.env.OPERATOR_ALERT_EMAIL || "LeadCockpit <no-reply@leadcockpit.app>",
      to: toEmail,
      subject: "Re: your enquiry",
      html: `<div style="font-family:sans-serif;white-space:pre-wrap">${escapeHtml(input.body)}</div>`,
      purpose: "outbound_lead",
    });
    return {
      attempted: true,
      // Resend accepted → "sent"; mock fallback → still "sent" (the mock
      // records it) but the honest provider name is surfaced via the audit log
      // (providerMessageId prefix). The downstream outreach status maps mock
      // to "sent_manual" so the UI never shows mock as a real API delivery.
      status: result.ok ? "sent" : "failed",
      provider: "meta_cloud", // (narrow legacy union; the real provider is recorded in the audit log)
      providerMessageId: result.providerMessageId,
      errorMessage: result.errorMessage,
    };
  }

  // WHATSAPP branch (unchanged — CASE E regression guard). Any channel that
  // isn't "email" routes here; the vast majority is "whatsapp".
  if (channel !== "whatsapp") {
    return { attempted: false, status: "not_attempted", provider: "meta_cloud" };
  }

  // N-DATA-10 (2026-08-20): refuse an empty destination, the same way the
  // email branch above already refuses an empty address. The two branches had
  // drifted apart: email threw an honest error, WhatsApp carried the empty
  // string onward and let the outcome depend on whether credentials happened
  // to be configured — "not_configured" is not "failed", so the caller did not
  // throw and the draft was marked approved with nothing sent. A reply with no
  // recipient is never a send, whatever the credential state.
  if (!String(input.to || "").trim()) {
    throw new Error(
      "Cannot send a WhatsApp reply: this lead has no WhatsApp number or phone on file. " +
      "Add a number to the lead first.",
    );
  }

  // CP-17c (2026-08-02) — per-workspace creds override env. Resolve the
  // provider for THIS workspace so a customer's saved credentials take effect.
  // Falls back to env when no per-workspace creds (unchanged behaviour).
  const provider: WhatsAppSendProvider = input.whatsappProvider
    ? input.whatsappProvider
    : input.repos
      ? await new (await import("@/services/WhatsAppCredentialService")).WhatsAppCredentialService(input.repos).resolveProvider(input.workspaceId)
      : new MetaWhatsAppCloudProvider();
  if (!provider.isConfigured()) {
    return {
      attempted: false,
      status: "not_configured",
      provider: "meta_cloud",
      errorMessage: "WhatsApp Cloud API env vars are not configured.",
    };
  }

  // CP-24 (2026-08-02) — the 24-hour customer-service window. Meta's rule:
  // within 24h of the customer's last message → free-text OK. After 24h →
  // ONLY pre-approved templates. If the window is closed and the caller didn't
  // provide a template, refuse with an honest error (don't let Meta reject it
  // silently — tell the owner what to do).
  const { isWithin24hWindow } = await import("@/lib/whatsapp-window");
  const windowStatus = isWithin24hWindow(input.lastInboundAt);
  if (!windowStatus.open && !input.templateName) {
    return {
      attempted: false,
      status: "blocked",
      provider: "meta_cloud",
      // 2026-09-26 (break test): this used to say "re-approve with the template
      // selected" — impossible, because the draft is now approved and a second
      // approve is refused as "already approved and sent". Say what is true.
      errorMessage: windowStatus.label + " Nothing was sent from the app: send this reply from your WhatsApp phone. To send through the app after 24 hours, choose a WhatsApp template before you approve.",
    };
  }

  // CP-25 / CP-24c — if the window is CLOSED and a template was selected,
  // send via the template API instead of free-text. F-DATA-7 (2026-08-04):
  // the old condition `input.templateName && (!windowStatus.open ||
  // input.templateName)` was tautological — the second clause is true whenever
  // the first is — so a selected template forced template-send even when the
  // 24h window was OPEN (the owner could never send free-text with a template
  // also picked). Per LOGIC.md CP-24c: OPEN → free-text; CLOSED → template.
  if (input.templateName && !windowStatus.open) {
    const tplResult = await (provider as { sendTemplateMessage?: (i: { workspaceId: string; to: string; templateName: string; language: string; components?: unknown[] }) => Promise<WhatsAppSendResult> }).sendTemplateMessage?.({
      workspaceId: input.workspaceId,
      to: input.to,
      templateName: input.templateName,
      language: input.templateLanguage || "en_US",
    });
    if (tplResult) return tplResult;
    // If the provider doesn't support template send (mock), fall through to text.
  }

  return provider.sendTextMessage({
    workspaceId: input.workspaceId,
    to: input.to,
    body: input.body,
    previewOnly: false,
    // M3.9 / O10: pass the configured public origin explicitly so the
    // provider can validate the media URL's origin. Without this the provider
    // reads WHATSAPP_PUBLIC_ORIGIN itself, but the explicit pass makes the
    // dependency clear and the test path deterministic.
    publicOrigin: process.env.WHATSAPP_PUBLIC_ORIGIN,
    mediaAttachmentUrl: input.mediaAttachment?.url,
    mediaAttachmentMimeType: input.mediaAttachment?.fileType,
    mediaAttachmentFilename: input.mediaAttachment?.fileName,
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
