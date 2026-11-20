/**
 * Sensitive-field detection chokepoint (S-10 fix, batch 3, 2026-07-27).
 *
 * BEFORE: the allowlist only matched `apikey | api_key | secret | token |
 * password`. Real-world credential fields escaped redaction:
 *   - `authorization` (HTTP Authorization header — MetaWhatsAppCloudProvider
 *     sends `authorization: Bearer ${token}` on every WhatsApp API call)
 *   - `bearer`        (Bearer token fields)
 *   - `key`           (Google Maps `key=...`, Stripe-style `key`, AWS access
 *                      key id fields literally named `key`)
 *   - `credential`    (LLMProviderCredentialRepository, `clientCredential`)
 *
 * These were reconnaissance gold — an attacker reading GET /integrations or
 * an audit-log payload could lift live tokens. Now they're masked.
 *
 * MATCHING DISCIPLINE (don't over-redact legitimate data):
 *   The compound matches (`apikey`, `secret`, `token`, `password`, `bearer`,
 *   `credential`) use plain substring includes() — safe because no real
 *   business field contains those letter runs.
 *   The bare `key` match uses a WORD-BOUNDARY regex so we don't nuke
 *   `keyboardLayout`, `monkeyCount`, `turkeyOrigin`, `primaryKey`, etc.
 *   (`key` as a standalone word, or `key` at start/end of a camelCase token).
 */
const SECRET_SUBSTRING_PATTERNS = [
  "apikey",
  "api_key",
  "secret",
  "token",
  "password",
  "authorization",
  "bearer",
  "credential",
];
// `key` as a standalone word OR a camelCase token boundary (start/end).
// Matches: `key`, `apiKey` → `api key` boundary, `accessKey`, `keyId`.
// Does NOT match: `keyboard`, `monkey`, `turkey`, `primaryKey` (compound words).
const SECRET_KEY_WORD_PATTERN = /(^|[^a-z])key([^a-z]|$)/i;

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SECRET_SUBSTRING_PATTERNS.some((p) => lower.includes(p))) return true;
  return SECRET_KEY_WORD_PATTERN.test(key);
}

export function maskSecret(value: string | undefined | null) {
  if (!value) return undefined;
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function redactSecretsFromObject<T>(obj: T): T {
  if (Array.isArray(obj)) return obj.map((item) => redactSecretsFromObject(item)) as T;
  if (!obj || typeof obj !== "object") return obj;
  const record = obj as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).map(([key, value]) => {
    // Session 55 (2026-09-09): a NUMBER is not a credential.
    //
    // The comment above says "no real business field contains those letter
    // runs". This product's AI-usage model counts TOKENS, so `dailyTokenLimit`,
    // `monthlyTokenLimit`, `currentDailyTokens` and `currentMonthlyTokens` all
    // matched "token" and every one of them left the product as "****". Found
    // by restoring a backup: the load failed with
    //   Argument `dailyTokenLimit`: Invalid value provided. Expected Int or
    //   Null, provided String.
    // and an operator reading their own export saw "****" where their usage
    // limits should be.
    //
    // Numbers and booleans cannot carry a key, a token or a password — those
    // are strings without exception. Objects and arrays still mask whole,
    // because a secret can hide inside one.
    if (isSensitiveKey(key) && (typeof value === "number" || typeof value === "boolean")) {
      return [key, value];
    }
    if (isSensitiveKey(key)) {
      return [key, typeof value === "string" ? maskSecret(value) : "****"];
    }
    return [key, redactSecretsFromObject(value)];
  })) as T;
}

/**
 * Session 55 (2026-09-09) — drop values an export has already masked.
 *
 * WHY: a backup is a redacted document by design ("saved credentials are
 * stripped from every export"). Loading one back therefore has a choice
 * between leaving a credential field alone and writing the literal string
 * "****" or "ap...ey" into it. The second is worse than the first: it looks
 * like a value, it fails no validation, and the integration it belongs to then
 * fails at call time with a credential nobody can recognise as a placeholder.
 *
 * Only fields the redactor itself considers sensitive are checked, and only
 * against the two shapes it produces, so a real value that happens to contain
 * dots survives.
 */
const MASKED_VALUE_PATTERN = /^(\*{4}|.{4}\.\.\..{4})$/;

export function stripRedactedValues<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (isSensitiveKey(key) && typeof value === "string" && MASKED_VALUE_PATTERN.test(value)) continue;
    out[key] = value;
  }
  return out as T;
}

