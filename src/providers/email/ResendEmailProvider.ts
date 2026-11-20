/**
 * Stage 5 / WP2 (2026-07-28) — Resend (https://resend.com) email adapter.
 *
 * Real-send adapter for transactional emails to known workspace users
 * (password reset, invite, security notice). India-friendly deliverability,
 * simple HTTP API, generous free tier.
 *
 * Auth: Authorization: Bearer <RESEND_API_KEY> header (never in the body,
 * never in the URL — anti-leak, pinned by golden:email-send CASE A).
 *
 * Error handling: 4xx/5xx + empty/malformed responses throw EmailSendError
 * (no silent failure — build-right rule). Pinned by golden:email-send CASE B.
 *
 * Per docs/LOGIC.md 2026-07-28 (operator-initiated password reset).
 */
import type { EmailSendInput, EmailSendProvider, EmailSendResult } from "./EmailSendProvider";
import { EmailSendError } from "./EmailSendProvider";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export class ResendEmailProvider implements EmailSendProvider {
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, timeoutMs = 15_000) {
    this.apiKey = apiKey;
    this.timeoutMs = Math.max(1, timeoutMs);
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    if (!this.apiKey) {
      throw new EmailSendError("Resend API key is not configured", { provider: "resend" });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: input.from,
          to: input.to,
          subject: input.subject,
          html: input.html,
        }),
      });
    // Non-2xx → surface the provider's error message (no silent failure).
    if (!response.ok) {
      let providerMessage = `Resend returned HTTP ${response.status}`;
      try {
        const body = await response.json() as { message?: string; error?: string };
        if (body?.message) providerMessage = body.message;
        else if (body?.error) providerMessage = body.error;
      } catch {
        // Body wasn't JSON; keep the generic status message.
      }
      throw new EmailSendError(providerMessage, { provider: "resend", statusCode: response.status });
    }

    // Parse the {id} response. Empty/malformed → typed error.
    const text = await response.text();
    if (!text) {
      throw new EmailSendError("Email acceptance could not be confirmed: Resend returned an empty response body. Check before retrying.", { provider: "resend", statusCode: response.status, outcomeUnknown: true });
    }
    let body: { id?: string };
    try {
      body = JSON.parse(text);
    } catch {
      throw new EmailSendError("Email acceptance could not be confirmed: Resend returned a non-JSON response body. Check before retrying.", { provider: "resend", statusCode: response.status, outcomeUnknown: true });
    }
    if (!body?.id) {
      throw new EmailSendError("Email acceptance could not be confirmed: Resend response missing the expected 'id' field. Check before retrying.", { provider: "resend", statusCode: response.status, outcomeUnknown: true });
    }

    return {
      ok: true,
      provider: "resend",
      providerMessageId: String(body.id),
    };
    } catch (e) {
      if (e instanceof EmailSendError) throw e;
      throw new EmailSendError(
        "Email acceptance could not be confirmed. It may already be queued; check the inbox or email provider before trying again.",
        { provider: "resend", outcomeUnknown: true },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
