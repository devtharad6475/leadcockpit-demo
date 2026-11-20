/**
 * Stage 5 / WP2 (2026-07-28) — Email provider barrel.
 *
 * Selects the active provider based on env:
 *   - RESEND_API_KEY set → ResendEmailProvider (real send).
 *   - otherwise → MockEmailProvider (records to outbox, honest "mock" status).
 *
 * Same honest-status discipline as the LLM layer (real/fallback/mock): the
 * active provider's name is reported in every EmailSendResult so the UI +
 * audit log never show mock output as real success.
 *
 * NO-AUTO-OUTREACH: this module sends transactional emails to KNOWN workspace
 * users (password reset, invite, security notice, verify_email) AND — since
 * GAP-2 (2026-07-31) — an OUTBOUND email to a LEAD/CUSTOMER, but ONLY through
 * the human-gated approve-draft path (purpose "outbound_lead"). It exports NO
 * auto/prospecting sender: nothing here fires without an explicit owner action.
 * Pinned by golden:email-send CASE E (no auto path) + golden:email-outbound
 * (the human-gated lead path). The sacred no-auto-outreach rule is preserved.
 *
 * Per docs/LOGIC.md 2026-07-28 (operator-initiated password reset).
 */
export type {
  EmailPurpose,
  EmailSendInput,
  EmailSendResult,
  EmailSendProvider,
} from "./EmailSendProvider";
export { EmailSendError } from "./EmailSendProvider";
export { ResendEmailProvider } from "./ResendEmailProvider";
export {
  MockEmailProvider,
  getMockOutbox,
  clearMockOutbox,
  resetMockEmailProvider,
  type MockOutboxEntry,
} from "./MockEmailProvider";

import { ResendEmailProvider } from "./ResendEmailProvider";
import { MockEmailProvider } from "./MockEmailProvider";
import type { EmailSendInput, EmailSendProvider, EmailSendResult } from "./EmailSendProvider";

// Cache the PROVIDER INSTANCE, but re-check the env key on each call so a
// rotation (or a test flipping the env var) is picked up. The key itself is
// cached on the instance at construction; if the env key changes, we build a
// new instance. This avoids both (a) re-reading env on every send when the key
// is stable, and (b) a stale provider surviving a key rotation.
let cachedKey: string | undefined;
let cachedProvider: EmailSendProvider | null = null;

function getProvider(): EmailSendProvider {
  const key = process.env.RESEND_API_KEY;
  if (cachedProvider && key === cachedKey) return cachedProvider;
  cachedKey = key;
  cachedProvider = key ? new ResendEmailProvider(key) : new MockEmailProvider();
  return cachedProvider;
}

/**
 * The active email provider's honest name. Used by the production-readiness
 * check + admin health screen. "resend" = real send; "mock" = fallback.
 */
export function getActiveEmailProvider(): "resend" | "mock" {
  return process.env.RESEND_API_KEY ? "resend" : "mock";
}

/**
 * Send a transactional email to a known workspace user. Routes to the active
 * provider. The result's `provider` field is honest ("resend" | "mock").
 */
export async function sendEmail(input: EmailSendInput): Promise<EmailSendResult> {
  return getProvider().send(input);
}

/**
 * CP-18c (2026-08-02) — send with an OPTIONAL per-workspace Resend key. When
 * provided, it takes precedence over env (a customer's own Resend key). When
 * undefined, falls back to env (unchanged). Used by the lead-outbound approve
 * path so each workspace's own email credentials take effect.
 */
export async function sendEmailForWorkspace(input: EmailSendInput, workspaceKey?: string): Promise<EmailSendResult> {
  if (workspaceKey && workspaceKey.trim()) {
    return new ResendEmailProvider(workspaceKey.trim()).send(input);
  }
  return getProvider().send(input);
}
