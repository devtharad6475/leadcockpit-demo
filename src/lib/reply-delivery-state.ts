/**
 * ONE place that decides what an approved reply's row says to the operator
 * (N-UX-4).
 *
 * THE DEFECT THIS EXISTS TO KILL (found 2026-08-20, S10-3, by the G7 outbound
 * golden; fixed 2026-08-20, S14-1).
 * ---------------------------------------------------------------------------
 * `approveAutoReplyLog` marks the draft `approved` whenever the send did not
 * hard-fail. That is deliberate and correct at the data layer — CASE C of
 * `golden-whatsapp-outbound-send` pins it: the 24-hour WhatsApp window can be
 * closed with no template chosen, and the row is then stored as
 * `status: "approved", sendStatus: "blocked"`, with the outreach row underneath
 * honestly marked as a manual follow-up.
 *
 * The APPROVALS LIST is what an operator actually scans, and there it read
 * "Approved - Manual Send" in success green — the same green as a message that
 * really reached the customer. Nothing was delivered. Nothing had been sent
 * manually either. Four of the six send outcomes (`dry_run`, `blocked`,
 * `not_attempted`, and a missing status) fell through to that green label.
 *
 * The rule, stated once so it cannot drift per-screen:
 *
 *   A reply is DELIVERED only when the provider says `sent`.
 *   Nothing that was not delivered may be shown in the success tone.
 *   A row that was not delivered must SAY it was not delivered, and say why.
 *
 * Pinned by scripts/golden/golden-approved-not-delivered.ts (CASES A–E).
 */

/** The provider outcomes `AutoReplyLog.sendStatus` can hold (types.ts:1494). */
export const REPLY_SEND_STATUSES = [
  "not_attempted",
  "not_configured",
  "sent",
  "failed",
  "blocked",
  "dry_run",
  // 2026-09-29 (owner walk-through R2) — the owner sent it from their own phone
  // and said so. Delivered, but never claimed as a WhatsApp Cloud API send.
  "sent_by_owner",
  "unconfirmed",
] as const;

export type ReplySendStatus = (typeof REPLY_SEND_STATUSES)[number];

/** Visual weight. `success` is reserved for genuinely delivered messages. */
export type ReplyDeliveryTone = "success" | "warning" | "danger" | "info" | "neutral";

export type ReplyDeliveryState = {
  /** True only when the message actually reached the customer. */
  delivered: boolean;
  tone: ReplyDeliveryTone;
  /** Short badge text for the list. */
  label: string;
  /** One sentence the operator can act on, shown on the row. */
  explanation: string;
};

type ReplyLogLike = {
  status: string;
  sendStatus?: string;
  providerError?: string;
  sendAttempted?: boolean;
};

/**
 * What actually happened to this reply, in the operator's words.
 *
 * Read `sendStatus` FIRST and `status` second. `status` records what the owner
 * decided; `sendStatus` records what the network did, and the network is the
 * one the customer experiences.
 */
export function replyDeliveryState(log: ReplyLogLike): ReplyDeliveryState {
  const reason = String(log.providerError || "").trim();
  const because = reason ? ` Reason: ${reason}` : "";

  switch (log.sendStatus) {
    case "unconfirmed":
      return {
        delivered: false, tone: "warning", label: "Approved, delivery unconfirmed",
        explanation: `Delivery has not been confirmed. Check the customer's conversation before sending again.${because}`,
      };
    case "sent":
      return {
        delivered: true,
        tone: "success",
        label: "Sent on WhatsApp",
        explanation: "Delivered to the customer through the WhatsApp Cloud API.",
      };
    case "sent_by_owner":
      return {
        delivered: true,
        tone: "success",
        label: "Sent by you",
        explanation: "You sent this yourself, from your own phone.",
      };
    case "failed":
      return {
        delivered: false,
        tone: "danger",
        label: "Send failed, not delivered",
        explanation: `WhatsApp rejected the message, so the customer received nothing.${because}`,
      };
    case "blocked":
      return {
        delivered: false,
        tone: "danger",
        label: "Approved, blocked, not delivered",
        explanation:
          `Approved, but the send was blocked, so the customer received nothing.${because}` +
          " Send it yourself, or re-send once the block is cleared.",
      };
    case "not_configured":
      return {
        delivered: false,
        tone: "warning",
        label: "Approved, not delivered: WhatsApp not connected",
        explanation: "Approved, but WhatsApp sending is not connected, so nothing left this system. Send it yourself for now.",
      };
    case "dry_run":
      return {
        delivered: false,
        tone: "warning",
        label: "Approved, not delivered: test only",
        explanation: "Dry-run only. No WhatsApp message was sent and the customer received nothing.",
      };
    case "not_attempted":
      if (log.status === "approved" || log.status === "auto_sent") {
        return {
          delivered: false,
          tone: "warning",
          label: log.status === "approved" ? "Approved, not delivered" : "Not delivered: no send attempted",
          explanation: `No send was attempted, so the customer received nothing.${because}`,
        };
      }
      // A pending or dismissed draft has no send attempt either. That fact
      // must not invent owner approval; retain its actual review state below.
      break;
  }

  // No sendStatus at all. Older rows, and drafts that never reached a send.
  if (log.status === "auto_sent") {
    return { delivered: true, tone: "success", label: "Sent automatically", explanation: "Sent automatically to the customer." };
  }
  if (log.status === "approved") {
    // The N-UX-4 case in its purest form: approved, and no record of anything
    // reaching anyone. Never green.
    return {
      delivered: false,
      tone: "warning",
      label: "Approved, not delivered",
      explanation: "Approved, but there is no record of this message reaching the customer. Send it yourself and confirm.",
    };
  }
  if (log.status === "held_for_review") {
    return { delivered: false, tone: "warning", label: "Needs review", explanation: "Waiting for you to approve or dismiss it." };
  }
  if (log.status === "acknowledged") {
    return {
      delivered: false,
      tone: "warning",
      label: "Holding msg sent - Awaiting your answer",
      explanation: "A holding message went out. The real answer still needs you.",
    };
  }
  if (log.status === "drafted") {
    return { delivered: false, tone: "info", label: "Draft Prepared", explanation: "Not sent yet." };
  }
  if (log.status === "blocked") {
    return { delivered: false, tone: "danger", label: "Blocked", explanation: "The safety gate stopped this reply." };
  }
  if (log.status === "failed") {
    return { delivered: false, tone: "danger", label: "Failed", explanation: "This reply could not be produced." };
  }
  if (log.status === "rejected") {
    return { delivered: false, tone: "neutral", label: "Dismissed", explanation: "You dismissed this draft. Nothing was sent." };
  }
  return { delivered: false, tone: "neutral", label: "", explanation: "Not sent yet." };
}
