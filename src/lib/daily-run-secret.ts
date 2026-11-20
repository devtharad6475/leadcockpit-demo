/**
 * 2026-09-27 — the shared secret that lets an outside schedule start the daily
 * routine (POST /api/internal/daily-run). "off" when no usable secret is
 * configured (the endpoint then does not exist); compared in constant time.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const MIN_DAILY_RUN_SECRET_LENGTH = 32;

export function dailyRunSecretMatches(sent: string | null | undefined, configured: string | undefined): "off" | "wrong" | "ok" {
  const expected = (configured || "").trim();
  if (expected.length < MIN_DAILY_RUN_SECRET_LENGTH) return "off";
  const given = (sent || "").trim();
  if (!given) return "wrong";
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) ? "ok" : "wrong";
}
