import { assertSafeFetchUrl } from "@/lib/ssrf-guard";
import { NeedsActionError } from "@/lib/user-errors";

/**
 * 2026-09-28 — what the owner is told when the operator has paused WhatsApp
 * sending for the whole platform (the whatsapp_send_enabled switch). It used
 * to be "kill-switch whatsapp_send_enabled is OFF", thrown as a plain Error, so
 * the approve screen answered "Something went wrong on our side". Thrown as a
 * NeedsActionError it is shown as written, and the draft is not marked
 * approved — the owner can approve it again once sending resumes.
 */
export const WHATSAPP_PAUSED_MESSAGE =
  "Sending is paused by the platform, so nothing was sent. Your reply is kept — approve it again later, or send it from your WhatsApp phone.";
import type { WhatsAppSendInput, WhatsAppSendProvider, WhatsAppSendResult, WhatsAppTemplateSendInput, WhatsAppTestResult } from "./WhatsAppSendProvider";

/**
 * Optional injected per-workspace credentials (D-2026-08-02 / CP-17). When
 * provided, they take PRECEDENCE over the env vars — so a customer's
 * workspace-level creds (saved via the UI, encrypted) override the operator's
 * env config. When undefined, the provider falls back to env (the original
 * behaviour, unchanged).
 */
export type MetaWhatsAppCreds = { accessToken: string; phoneNumberId: string; businessAccountId?: string };

export class MetaWhatsAppCloudProvider implements WhatsAppSendProvider {
  private readonly accessToken: string | undefined;
  private readonly phoneNumberId: string | undefined;

  constructor(creds?: MetaWhatsAppCreds) {
    // CP-17c — per-workspace creds override env; env is the fallback.
    this.accessToken = creds?.accessToken || process.env.WHATSAPP_CLOUD_ACCESS_TOKEN;
    this.phoneNumberId = creds?.phoneNumberId || process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID;
  }

  isConfigured() {
    return Boolean(this.accessToken && this.phoneNumberId);
  }

  /**
   * Stage B (2026-07-26) — Validate the credentials without sending a
   * message. Pings `GET /v20.0/{phoneNumberId}` which returns the phone
   * number's display name + quality rating when the token is valid and the
   * phone ID belongs to the token's WABA. Honest about every failure mode.
   *
   * This is the "system will start" proof — the operator clicks "Save & Test"
   * in Integrations, and within 2 seconds sees whether the keys are valid
   * (vs the old "fire a real send and see if it lands" approach).
   */
  async testConnection(): Promise<WhatsAppTestResult> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        status: "not_configured",
        message: "WhatsApp is not connected yet. Paste your access token and phone number ID on the Integrations page (WhatsApp → Set up), then test again.",
      };
    }
    try {
      const response = await fetch(`https://graph.facebook.com/v20.0/${this.phoneNumberId}`, {
        method: "GET",
        headers: { "authorization": `Bearer ${this.accessToken}` },
        signal: AbortSignal.timeout(15000),
      });
      const payload = await response.json().catch(() => ({})) as {
        display_phone_number?: string;
        verified_name?: string;
        quality_rating?: string;
        error?: { message?: string; code?: number; type?: string; fbtrace_id?: string };
      };

      // Meta's error envelope: { error: { message, code, type, fbtrace_id } }
      // Common codes: 190 (invalid OAuth token), 200 (permission), 100 (bad request — usually wrong phone ID).
      if (!response.ok) {
        const errCode = payload.error?.code;
        const errMsg = payload.error?.message || `Meta Graph API returned ${response.status}`;
        // 190 → access token invalid/expired. The most common operator mistake.
        if (errCode === 190 || /access token/i.test(errMsg)) {
          return { ok: false, status: "auth_failed", message: `Access token rejected by Meta (code ${errCode || "?"}): ${errMsg}. Generate a new System User access token in the Meta Business Manager.` };
        }
        // 100 → usually a wrong phone number ID.
        if (errCode === 100 || /does not exist/i.test(errMsg) || /not found/i.test(errMsg)) {
          return { ok: false, status: "wrong_number", message: `Phone number ID not found (code ${errCode || "?"}): ${errMsg}. Check the WHATSAPP_CLOUD_PHONE_NUMBER_ID value in the Meta dashboard → WhatsApp → Phone Numbers.` };
        }
        // 4 / 17 → rate-limited by Meta.
        if (errCode === 4 || errCode === 17 || response.status === 429) {
          return { ok: false, status: "rate_limited", message: `Meta rate-limited the test call (code ${errCode || "?"}): ${errMsg}. Wait a minute and try again.` };
        }
        return { ok: false, status: "unknown_error", message: `Meta rejected the request (code ${errCode || "?"}): ${errMsg}` };
      }
      // Success — Meta returned the phone number's details.
      return {
        ok: true,
        status: "connected",
        message: `Connected. WhatsApp Business number ${payload.display_phone_number || "(unknown)"} (${payload.verified_name || "unverified"}) is reachable.`,
        displayPhoneNumber: payload.display_phone_number,
        qualityRating: payload.quality_rating,
      };
    } catch (error) {
      // Network errors: timeout, DNS, connection refused. Most common is the
      // dev environment having no internet access.
      return {
        ok: false,
        status: "network_error",
        message: `Could not reach Meta's Graph API: ${error instanceof Error ? error.message : "unknown network error"}. Check your internet connection.`,
      };
    }
  }

  async sendTextMessage(input: WhatsAppSendInput): Promise<WhatsAppSendResult> {
    if (input.previewOnly) return { attempted: false, status: "dry_run", provider: "meta_cloud" };
    // Stage 5 re-audit fix (F-P1-3, 2026-07-28) — global kill-switch. The
    // operator can flip whatsapp_send_enabled=false during a Meta provider
    // incident or a cost runaway; this gate throws BEFORE any network call.
    // Pre-fix the flag was write-only (setFeatureFlag wrote the row but no
    // code read it). Pinned by golden:feature-flag-wiring CASE A.
    const { isFeatureEnabled } = await import("@/services/FeatureFlagService");
    if (!(await isFeatureEnabled("whatsapp_send_enabled"))) {
      throw new NeedsActionError(WHATSAPP_PAUSED_MESSAGE, 409);
    }
    if (!this.isConfigured()) return { attempted: false, status: "not_configured", provider: "meta_cloud", errorMessage: "WhatsApp Cloud API env vars are not configured." };
    const recipient = normalizePhone(input.to);
    if (!recipient) return { attempted: false, status: "blocked", provider: "meta_cloud", errorMessage: "Recipient phone number is missing." };
    const mediaUrl = input.mediaAttachmentUrl ? absoluteMediaUrl(input.mediaAttachmentUrl, input.publicOrigin) : "";
    if (input.mediaAttachmentUrl && !mediaUrl) {
      return { attempted: false, status: "blocked", provider: "meta_cloud", errorMessage: "A public app URL is required before WhatsApp can send media attachments." };
    }
    // M3.9 / O10 audit fix: validate the resolved media URL before handing it
    // to Meta. Two checks:
    //   (1) SSRF / private-host check via assertSafeFetchUrl — refuses
    //       localhost, 192.168.*, 10.*, link-local, etc. Prevents leaking
    //       internal URLs to Meta and prevents Meta's fetcher from reaching
    //       internal services.
    //   (2) Origin check against WHATSAPP_PUBLIC_ORIGIN when it is configured —
    //       the URL must point at the app's own public origin. Prevents an
    //       attacker-controlled absolute URL from being sent to customers.
    if (mediaUrl) {
      const safety = await assertSafeFetchUrl(mediaUrl);
      if (!safety.safe) {
        return { attempted: false, status: "blocked", provider: "meta_cloud", errorMessage: `Media attachment URL is not allowed: ${safety.reason}` };
      }
      const configuredOrigin = input.publicOrigin || process.env.WHATSAPP_PUBLIC_ORIGIN;
      if (configuredOrigin) {
        try {
          const configured = configuredOrigin.replace(/\/$/, "").toLowerCase();
          const actual = new URL(mediaUrl).origin.toLowerCase();
          if (actual !== configured) {
            return { attempted: false, status: "blocked", provider: "meta_cloud", errorMessage: `Media attachment URL origin (${actual}) does not match the configured public app origin (${configured}).` };
          }
        } catch {
          return { attempted: false, status: "blocked", provider: "meta_cloud", errorMessage: "Media attachment URL is malformed." };
        }
      }
    }

    try {
      const body = mediaUrl
        ? buildMediaPayload(input, recipient, mediaUrl)
        : {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: recipient,
          type: "text",
          text: { preview_url: false, body: input.body },
        };
      const response = await fetch(`https://graph.facebook.com/v20.0/${this.phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${this.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        // S6 I-1: was NO timeout — a slow/hung Meta Graph API call blocked the
        // approve flow indefinitely (the user stared at a spinner; the local
        // write that follows the send never ran; the operator couldn't tell if
        // the message was sent). Now bounded by WHATSAPP_SEND_TIMEOUT_MS
        // (default 30s, matching testConnection's 15s spirit but roomier for a
        // real send + optional media fetch). On timeout the existing catch
        // returns a clean `failed` result instead of hanging forever.
        signal: AbortSignal.timeout(Number(process.env.WHATSAPP_SEND_TIMEOUT_MS || 30_000)),
      });
      const payload = await response.json().catch(() => ({})) as { messages?: Array<{ id?: string }>; error?: { message?: string; code?: number } };
      if (!response.ok) {
        // S6 I-2: detect Meta rate-limiting (HTTP 429 or error codes 4 / 17)
        // and surface a DISTINCT message naming the Retry-After, so the batch
        // send loop + the operator can tell "Meta rejected" from "Meta is
        // throttling, retry in Ns". Previously every 429 was reported as a
        // generic failure and legitimate recipients never got the message.
        const retryAfter = response.headers.get("retry-after");
        const errorCode = payload.error?.code;
        const isThrottled = response.status === 429 || errorCode === 4 || errorCode === 17;
        if (isThrottled) {
          return {
            attempted: true,
            status: "failed",
            provider: "meta_cloud",
            errorMessage: retryAfter
              ? `WhatsApp Cloud API is rate-limiting this number. Retry after ${retryAfter} seconds.`
              : "WhatsApp Cloud API is rate-limiting this number. Retry shortly.",
          };
        }
        return { attempted: true, status: "failed", provider: "meta_cloud", errorMessage: payload.error?.message || `WhatsApp Cloud API failed with ${response.status}` };
      }
      return { attempted: true, status: "sent", provider: "meta_cloud", providerMessageId: payload.messages?.[0]?.id };
    } catch (error) {
      return { attempted: true, status: "failed", provider: "meta_cloud", errorMessage: error instanceof Error ? error.message : "WhatsApp Cloud API send failed." };
    }
  }

  // CP-25 (2026-08-02) — send a pre-approved Meta template message. Used when
  // the 24-hour customer-service window is closed. Same endpoint as text send,
  // just type: "template" with the template name + language + components.
  async sendTemplateMessage(input: WhatsAppTemplateSendInput): Promise<WhatsAppSendResult> {
    // Same kill-switch check as sendTextMessage. 2026-09-28: it throws the
    // same plain message. It used to RETURN "blocked", which the approve path
    // records as an approved draft with a "sent manually" outreach row — the
    // owner saw "approved" for a template that never left.
    const { isFeatureEnabled } = await import("@/services/FeatureFlagService");
    if (!(await isFeatureEnabled("whatsapp_send_enabled"))) {
      throw new NeedsActionError(WHATSAPP_PAUSED_MESSAGE, 409);
    }
    if (!this.isConfigured()) {
      return { attempted: false, status: "not_configured", provider: "meta_cloud", errorMessage: "WhatsApp Cloud API is not configured." };
    }
    const recipient = normalizePhone(input.to);
    if (!recipient) return { attempted: false, status: "failed", provider: "meta_cloud", errorMessage: "Recipient phone number is required." };
    try {
      const templatePayload = {
        messaging_product: "whatsapp" as const,
        recipient_type: "individual" as const,
        to: recipient,
        type: "template" as const,
        template: {
          name: input.templateName,
          language: { code: input.language || "en_US" },
          ...(input.components ? { components: input.components } : {}),
        },
      };
      const response = await fetch(`https://graph.facebook.com/v20.0/${this.phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(templatePayload),
        signal: AbortSignal.timeout(Number(process.env.WHATSAPP_SEND_TIMEOUT_MS || 30_000)),
      });
      const payload = await response.json().catch(() => ({})) as { messages?: Array<{ id?: string }>; error?: { message?: string } };
      if (!response.ok) {
        return { attempted: true, status: "failed", provider: "meta_cloud", errorMessage: payload.error?.message || `WhatsApp template send failed with ${response.status}` };
      }
      return { attempted: true, status: "sent", provider: "meta_cloud", providerMessageId: payload.messages?.[0]?.id };
    } catch (error) {
      return { attempted: true, status: "failed", provider: "meta_cloud", errorMessage: error instanceof Error ? error.message : "WhatsApp template send failed." };
    }
  }
}

/**
 * The number Meta is sent: digits only, with the country code WhatsApp needs.
 * 2026-09-27 (CEO): "we are searching only for Indian customers, so put the
 * Indian code." A number saved without a country code ("98250 33333",
 * "098250 33333") went out as 9825033333, which Meta reads as a different
 * country. Written with + or 00 it already carries its code and is kept.
 */
export function toWhatsAppRecipient(value: string, defaultCountryCode = "91"): string {
  const raw = (value || "").trim();
  let digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (raw.startsWith("+")) return digits;
  if (digits.startsWith("00")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10) return `${defaultCountryCode}${digits}`;
  return digits;
}

function normalizePhone(value: string) {
  return toWhatsAppRecipient(value);
}

/**
 * Exported for golden coverage (2026-09-10): a stored media URL is relative
 * (/api/media/<id>/file) and Meta FETCHES it, so if this does not produce an
 * absolute URL the photo never arrives and nothing in the app says so.
 */
export function absoluteMediaUrl(url: string, publicOrigin?: string) {
  if (/^https?:\/\//i.test(url)) return url;
  const origin = publicOrigin || process.env.WHATSAPP_PUBLIC_ORIGIN || process.env.NEXT_PUBLIC_APP_URL || "";
  if (!origin) return "";
  return `${origin.replace(/\/$/, "")}/${url.replace(/^\//, "")}`;
}

function buildMediaPayload(input: WhatsAppSendInput, recipient: string, mediaUrl: string) {
  const mimeType = input.mediaAttachmentMimeType || "";
  const fileName = input.mediaAttachmentFilename || "attachment";
  const isImage = mimeType.startsWith("image/");
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    type: isImage ? "image" : "document",
    ...(isImage
      ? { image: { link: mediaUrl, caption: input.body } }
      : { document: { link: mediaUrl, filename: fileName, caption: input.body } }),
  };
}
