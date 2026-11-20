/**
 * Stage 5 / WP2 (2026-07-28) — Email send provider contract.
 *
 * The FIRST email-sending code path in LeadCockpit. Used by the operator-
 * initiated password reset to email a one-time reset link to a KNOWN
 * workspace user. This is a TRANSACTIONAL email — the operator-confirmed
 * exception to the no-auto-outreach rule (which covers PROSPECTING outreach
 * to leads/customers, NOT operational emails to known users).
 *
 * Provider-agnostic interface with concrete adapters:
 *   - ResendEmailProvider (https://resend.com) — real send when
 *     RESEND_API_KEY is set.
 *   - MockEmailProvider — default fallback (no key needed); records to an
 *     in-memory outbox + reports provider="mock" honestly. Same honest-
 *     status discipline as the LLM Mock fallback.
 *
 * Honest status: every result reports `provider` as "resend" | "mock" so the
 * UI never shows mock output as real success. Pinned by golden:email-send.
 *
 * Per docs/LOGIC.md 2026-07-28 (operator-initiated password reset).
 */
export type EmailPurpose =
  | "password_reset"
  | "invite"
  | "security_notice"
  // Stage 5 re-audit F-P3-4 (2026-07-28): distinct from "invite" — this is the
  // signup email-verification flow. Collapsing the two defeated the per-purpose
  // chokepoint (audit logs / mock outbox / future per-purpose rate limits
  // recorded signup-verifications as invites). Pinned by
  // golden:stage5-batch4-chokepoints CASE 13.
  | "verify_email"
  // GAP-2 (2026-07-31): an OUTBOUND email to a LEAD/CUSTOMER — sent only when
  // the owner explicitly approves a draft reply (human-gated, no-auto-outreach
  // preserved). Distinct from the transactional purposes above so per-purpose
  // rate limits + audit can treat customer-facing email with extra care.
  // Provisional per CP-14 (docs/LOGIC.md).
  | "outbound_lead";

export type EmailSendInput = {
  from: string;
  to: string;
  subject: string;
  html: string;
  /** Why this email is being sent (drives any per-purpose rate limit + audit). */
  purpose: EmailPurpose;
};

export type EmailSendResult = {
  /** Did the provider accept the email? (Mock = true, recorded to outbox.) */
  ok: boolean;
  /** Honest provider name — "resend" (real) or "mock" (fallback). */
  provider: "resend" | "mock";
  /** Provider's message id (Mock returns a deterministic mock_-prefixed id). */
  providerMessageId?: string;
  errorMessage?: string;
};

export interface EmailSendProvider {
  /** Is a real (non-mock) provider configured? */
  isConfigured(): boolean;
  /** Send a transactional email to a known workspace user. */
  send(input: EmailSendInput): Promise<EmailSendResult>;
}

/**
 * Typed error for email-send failures. Thrown on 4xx/5xx from the provider,
 * on empty/malformed responses, and on network errors. Never swallowed —
 * the operator must see every send failure (build-right "no silent failures").
 */
export class EmailSendError extends Error {
  readonly provider: string;
  readonly statusCode?: number;
  /** A request may have been accepted before a connection/response failure. Never auto-retry. */
  readonly outcomeUnknown: boolean;
  constructor(message: string, opts: { provider: string; statusCode?: number; outcomeUnknown?: boolean } = { provider: "unknown" }) {
    super(message);
    this.name = "EmailSendError";
    this.provider = opts.provider;
    this.statusCode = opts.statusCode;
    this.outcomeUnknown = opts.outcomeUnknown ?? false;
  }
}
