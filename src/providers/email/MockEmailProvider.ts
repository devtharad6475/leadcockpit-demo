/**
 * Stage 5 / WP2 (2026-07-28) — Mock email provider (default fallback).
 *
 * No RESEND_API_KEY needed. Records every email to an in-memory outbox +
 * returns a deterministic mock id, AND reports provider="mock" honestly
 * (never claims real success). The outbox lets tests + the JSON demo assert
 * "the email would have been sent with these contents" without a network
 * call or a paid key.
 *
 * Same honest-status discipline as the LLM Mock fallback: mock output is
 * never shown as real success. Pinned by golden:email-send CASE C.
 *
 * Per docs/LOGIC.md 2026-07-28 (operator-initiated password reset).
 */
import type { EmailSendInput, EmailSendProvider, EmailSendResult } from "./EmailSendProvider";

export type MockOutboxEntry = {
  id: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  purpose: EmailSendInput["purpose"];
  recordedAt: string;
};

const outbox: MockOutboxEntry[] = [];

export class MockEmailProvider implements EmailSendProvider {
  isConfigured(): boolean {
    // "Configured" in the sense that it CAN send (it records to the outbox).
    // getActiveEmailProvider() returns "mock" when no real key is set, so
    // callers know this is the fallback, not a real send.
    return true;
  }

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const id = `mock_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    outbox.push({
      id,
      from: input.from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      purpose: input.purpose,
      recordedAt: new Date().toISOString(),
    });
    return {
      ok: true,
      provider: "mock",
      providerMessageId: id,
    };
  }
}

/**
 * Test/demo helper: read the in-memory outbox.
 *
 * Stage 5 re-audit F-P3-5 (2026-07-28 — documented limitation): the outbox is
 * a PROCESS-GLOBAL singleton (module-level `const outbox` above). Today the
 * codebase runs each golden as a separate `tsx` invocation, so cross-test
 * pollution does NOT trigger. BUT if a future test runner (jest/vitest) loads
 * multiple goldens in ONE process, the outbox WILL leak between tests.
 *
 * CONTRACT: every test that reads the outbox MUST call `clearMockOutbox()`
 * (or `resetMockEmailProvider()`) FIRST, so it starts from a known-empty
 * state. `golden:email-send` CASE C already does this. Do NOT rely on the
 * outbox being empty when your test starts.
 */
export function getMockOutbox(): readonly MockOutboxEntry[] {
  return outbox;
}

/** Test/demo helper: clear the outbox (used by golden:email-send for isolation). */
export function clearMockOutbox(): void {
  outbox.length = 0;
}

/**
 * Stage 5 re-audit F-P3-5 (2026-07-28): alias for `clearMockOutbox()` with a
 * more discoverable name. Reset the mock email provider's outbox to empty.
 * Call this at the START of any test that reads the outbox (Ironclad Gate #8 —
 * each test gets a clean slate).
 */
export function resetMockEmailProvider(): void {
  clearMockOutbox();
}
