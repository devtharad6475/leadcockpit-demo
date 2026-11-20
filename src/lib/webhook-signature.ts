/**
 * WhatsApp webhook signature verification.
 *
 * Phase 1.2 audit fix: Meta signs every webhook POST with an
 * X-Hub-Signature-256 header containing `sha256=<hex-hmac>`. Without verifying
 * this, anyone can POST a forged payload and the system will create leads and
 * trigger the conversation engine. This module implements the verification.
 *
 * Design:
 *   - Reads the RAW request body as bytes (before JSON parsing).
 *   - Computes HMAC-SHA256(rawBody, WHATSAPP_APP_SECRET).
 *   - Compares with timingSafeEqual against the provided signature.
 *   - Fails CLOSED: missing secret → 401; missing/bad signature → 401.
 *   - In demo/local mode: if WHATSAPP_APP_SECRET is not configured, the check
 *     is skipped with a console warning (so the demo still works for testing).
 *     In production: missing secret → 401 (fail closed).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { getAuthMode } from "./auth";

export type SignatureResult =
  | { ok: true; rawBody: string }
  | { ok: false; status: number; reason: string };

/**
 * Read the raw body and verify the X-Hub-Signature-256 header.
 * Returns the raw body string on success so the caller can parse it.
 */
export async function readAndVerifyWebhookBody(request: NextRequest): Promise<SignatureResult> {
  const rawBody = await request.text();

  const appSecret = process.env.WHATSAPP_APP_SECRET;
  const mode = getAuthMode();

  // Fail closed in production if the secret isn't configured.
  if (!appSecret) {
    if (mode === "production") {
      return { ok: false, status: 401, reason: "WHATSAPP_APP_SECRET is not configured. Webhook signature verification cannot be performed." };
    }
    // Demo/local: skip with a warning so testing still works.
    console.warn("WHATSAPP_APP_SECRET is not configured; skipping webhook signature verification in demo/local mode.");
    return { ok: true, rawBody };
  }

  const signatureHeader = request.headers.get("x-hub-signature-256");
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return { ok: false, status: 401, reason: "Missing or malformed X-Hub-Signature-256 header." };
  }

  const expectedSignature = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const providedSignature = signatureHeader.slice("sha256=".length);

  // Constant-time compare to prevent timing attacks.
  const a = Buffer.from(providedSignature);
  const b = Buffer.from(expectedSignature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 401, reason: "Webhook signature verification failed." };
  }

  return { ok: true, rawBody };
}
