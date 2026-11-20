/**
 * Safe JSON body handling.
 *
 * Two responsibilities:
 *  1. Parse the request body as JSON without throwing on malformed input
 *     (returns {} so handlers can validate and reject cleanly).
 *  2. Strip prototype-polluting keys (`__proto__`, `constructor`, `prototype`)
 *     from any parsed object or nested object/array. This is the defense that
 *     closes the Object.assign prototype-pollution hole in the JSON repository
 *     layer.
 *
 * Why strip at the boundary instead of replacing Object.assign everywhere?
 * Defense in depth: we strip here AND we will add strict zod validation on
 * every PUT. But the sanitizer guarantees that even routes we forget to add a
 * schema to are still safe, because the dangerous keys never reach the repo.
 */
import type { NextRequest } from "next/server";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export class SafeJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeJsonError";
  }
}

/**
 * Recursively remove prototype-polluting keys from any value. Mutates and
 * returns the same value for convenience.
 */
export function sanitizePrototypeKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) sanitizePrototypeKeys(item);
    return value;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (FORBIDDEN_KEYS.has(key)) {
        delete obj[key];
      } else {
        sanitizePrototypeKeys(obj[key]);
      }
    }
  }
  return value;
}

/**
 * Outcome of a safe body parse.
 * - `ok: true`  -> body was empty, or parsed cleanly to a plain object.
 * - `ok: false` -> body was present but malformed (caller should return 400).
 *
 * Returning an explicit result type lets the catch-all route distinguish "no
 * body supplied" (a legitimate state some endpoints allow) from "the client
 * sent bytes that were not valid JSON" (a client error worth a 400). The old
 * behavior collapsed both into `{}`, which hid malformed clients behind a
 * generic zod validation error and made the API harder to debug.
 */
export type SafeBodyResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: "malformed"; message: string };

/**
 * Parse a request body as JSON safely.
 * - Empty body            -> { ok: true, value: {} }
 * - Valid JSON object     -> { ok: true, value: <sanitized object> }
 * - Present but invalid   -> { ok: false, reason: "malformed", ... }
 * - JSON that is not a
 *   plain object (array,
 *   number, string, null) -> { ok: false, reason: "malformed", ... }
 *
 * Prototype-polluting keys (`__proto__`, `constructor`, `prototype`) are
 * stripped recursively from any accepted object, regardless of caller.
 */
export async function parseBodySafely(request: NextRequest): Promise<SafeBodyResult> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    // Body stream could not be read at all (client disconnect, transport error).
    // Treat as empty so handlers that accept no body still work.
    return { ok: true, value: {} };
  }
  if (!text || text.trim().length === 0) return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      reason: "malformed",
      message: err instanceof Error ? `Request body is not valid JSON: ${err.message}` : "Request body is not valid JSON.",
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: "malformed",
      message: "Request body must be a JSON object.",
    };
  }
  return { ok: true, value: sanitizePrototypeKeys(parsed as Record<string, unknown>) };
}
