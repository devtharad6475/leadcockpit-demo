/**
 * golden-secret-redaction.ts — pins the secret-redaction chokepoint (S-10 fix).
 *
 * WHAT THIS PROVES
 *   `redactSecretsFromObject` is the ONE function that scrubs API keys /
 *   tokens / passwords from any object before it leaves the server (it's used
 *   by AuditLogService, the data-export path, GET /integrations, etc.). A key
 *   that escapes it = a secret returned to the UI = P0.
 *
 * THE BUG (audit finding S-10, batch 3):
 *   The allowlist only matched `apikey | api_key | secret | token | password`.
 *   Real-world secret fields that escaped:
 *     - `authorization` (HTTP Authorization header — used by the WhatsApp
 *       provider, see MetaWhatsAppCloudProvider.ts:33,131)
 *     - `bearer`        (Bearer tokens in headers)
 *     - `key`           (many APIs name the field literally `key`, e.g. Google
 *                        Maps `key=...`, Stripe-style `key`)
 *   These are reconnaissance gold for an attacker and were NOT being masked.
 *
 * THE FIX (root cause):
 *   Widen the allowlist regex to also match `authorization`, `bearer`, `key`,
 *   `credential`. Keep it as ONE chokepoint so future secret-bearing field
 *   names are added here, not in 12 places.
 *
 * CASE MAP (each case hand-computed BEFORE looking at the impl):
 *   CASE A — `apikey` still masked (regression guard on the existing allowlist).
 *   CASE B — `api_key` still masked (snake_case variant).
 *   CASE C — `secret` still masked.
 *   CASE D — `token` still masked.
 *   CASE E — `password` still masked.
 *   CASE F — `authorization` now masked (was LEAKING — the S-10 bug).
 *   CASE G — `bearer` now masked (was LEAKING — the S-10 bug).
 *   CASE H — `apiKey` (camelCase) still masked.
 *   CASE I — `accessToken` still masked (substring `token`).
 *   CASE J — NON-secret fields preserved (companyName, whatsappNumber, etc.)
 *            so the redactor doesn't nuke legitimate data.
 *   CASE K — short values (≤8 chars) collapse to "****" (no partial leak).
 *   CASE L — nested objects + arrays recursed (audit payload shape).
 *   CASE M — a legitimate field NAMED like a key but not a secret
 *            (`keyboardLayout`) is NOT over-redacted (the allowlist matches on
 *            word boundaries, not bare substrings — future-proofing).
 *
 * REAL PIPELINE: imports the real `redactSecretsFromObject` + `maskSecret`.
 * No mocks. The function is pure.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { redactSecretsFromObject, maskSecret, stripRedactedValues } from "@/lib/secret-redaction";
import assert from "node:assert";

type Case = { name: string; fn: () => void | Promise<void> };
const cases: Case[] = [];

function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

// --- Existing allowlist regression guards (CASE A–E, H, I) ----------------------

test("CASE A — 'apikey' is masked (existing allowlist regression guard)", () => {
  const out = redactSecretsFromObject({ apikey: "sk_live_1234567890abcdef" }) as { apikey: string };
  assert.notStrictEqual(out.apikey, "sk_live_1234567890abcdef", "apikey must NOT pass through raw");
  assert.ok(out.apikey.includes("****") || out.apikey.includes("..."), `apikey masked form: ${out.apikey}`);
});

test("CASE B — 'api_key' (snake_case) is masked", () => {
  const out = redactSecretsFromObject({ api_key: "sk_test_abcdef1234567890" }) as { api_key: string };
  assert.notStrictEqual(out.api_key, "sk_test_abcdef1234567890");
});

test("CASE C — 'secret' is masked", () => {
  const out = redactSecretsFromObject({ client_secret: "shpss_abcdef1234567890" }) as { client_secret: string };
  assert.notStrictEqual(out.client_secret, "shpss_abcdef1234567890");
});

test("CASE D — 'token' is masked", () => {
  const out = redactSecretsFromObject({ token: "ya29.abcdef1234567890xyz" }) as { token: string };
  assert.notStrictEqual(out.token, "ya29.abcdef1234567890xyz");
});

test("CASE E — 'password' is masked", () => {
  // maskSecret contract: values >8 chars show first4 + ... + last4 (NOT '****').
  // 'supersecret123' (14 chars) → 'supe...t123'. Only values ≤8 chars collapse
  // to '****' (pinned in CASE K). This case just asserts masking happened.
  const out = redactSecretsFromObject({ password: "supersecret123" }) as { password: string };
  assert.notStrictEqual(out.password, "supersecret123", "password must NOT pass through raw");
  assert.ok(out.password.includes("..."), `password (14 chars) → masked with '...' ellipsis, got '${out.password}'`);
});

test("CASE H — 'apiKey' (camelCase) is masked", () => {
  const out = redactSecretsFromObject({ apiKey: "pk_live_1234567890abcdef" }) as { apiKey: string };
  assert.notStrictEqual(out.apiKey, "pk_live_1234567890abcdef");
});

test("CASE I — 'accessToken' (substring token) is masked", () => {
  const out = redactSecretsFromObject({ accessToken: "ya29.abcdef1234567890" }) as { accessToken: string };
  assert.notStrictEqual(out.accessToken, "ya29.abcdef1234567890");
});

// --- The S-10 bug (CASE F, G — were LEAKING before the fix) --------------------

test("CASE F — 'authorization' header is masked (was LEAKING — S-10 bug)", () => {
  // Hand-computed truth: `authorization: "Bearer abc123..."` is a credential.
  // It MUST be masked. Before the S-10 fix, the allowlist did not include
  // 'authorization' so the raw "Bearer ..." string passed through to the UI.
  const out = redactSecretsFromObject({ authorization: "Bearer ya29.abcdef1234567890" }) as { authorization: string };
  assert.notStrictEqual(
    out.authorization, "Bearer ya29.abcdef1234567890",
    "S-10 REGRESSION: 'authorization' header is leaking raw to the response — the allowlist must include 'authorization'",
  );
});

test("CASE G — 'bearer' token field is masked (was LEAKING — S-10 bug)", () => {
  const out = redactSecretsFromObject({ bearer: "abcdef1234567890" }) as { bearer: string };
  assert.notStrictEqual(
    out.bearer, "abcdef1234567890",
    "S-10 REGRESSION: 'bearer' field is leaking raw — the allowlist must include 'bearer'",
  );
});

// --- Non-secret preservation (CASE J) — don't nuke legitimate data ------------

test("CASE J — NON-secret fields are preserved verbatim", () => {
  const out = redactSecretsFromObject({
    companyName: "Balaji Zari Udyog",
    whatsappNumber: "+919876543210",
    city: "Surat",
    productCount: 42,
    isActive: true,
  }) as Record<string, unknown>;
  assert.strictEqual(out.companyName, "Balaji Zari Udyog", "companyName preserved");
  assert.strictEqual(out.whatsappNumber, "+919876543210", "whatsappNumber preserved");
  assert.strictEqual(out.city, "Surat", "city preserved");
  assert.strictEqual(out.productCount, 42, "numeric productCount preserved");
  assert.strictEqual(out.isActive, true, "boolean isActive preserved");
});

// --- maskSecret short-value collapse (CASE K) ---------------------------------

test("CASE K — short secret values (≤8 chars) collapse to '****' (no partial leak)", () => {
  // Hand-computed: an 8-char secret must NOT show any of its real chars.
  assert.strictEqual(maskSecret("12345678"), "****", `8-char secret → '****', got '${maskSecret("12345678")}'`);
  assert.strictEqual(maskSecret("short"), "****", `5-char secret → '****', got '${maskSecret("short")}'`);
  assert.strictEqual(maskSecret(undefined), undefined, "undefined stays undefined");
  assert.strictEqual(maskSecret(null as unknown as undefined), undefined, "null → undefined");
  assert.strictEqual(maskSecret(""), undefined, "empty → undefined");
  // Long secrets show first 4 + last 4 with ellipsis (enough to identify which
  // key it was without exposing the middle).
  const long = maskSecret("sk_live_1234567890abcdef");
  assert.ok(long!.startsWith("sk_l") && long!.endsWith("cdef"), `long secret shows first+last 4: '${long}'`);
});

// --- Recursion (CASE L) -------------------------------------------------------

test("CASE L — nested objects + arrays are recursed (audit payload shape)", () => {
  const payload = {
    workspaceId: "ws_1",
    integrations: [
      { name: "whatsapp", apiKey: "sk_live_1234567890abcdef", configured: true },
      { name: "gmail", token: "ya29.abcdef1234567890", configured: false },
    ],
    owner: { email: "owner@example.com", password: "supersecret123" },
  };
  const out = redactSecretsFromObject(payload) as {
    workspaceId: string;
    integrations: Array<Record<string, unknown>>;
    owner: { email: string; password: string };
  };
  // Non-secret preserved.
  assert.strictEqual(out.workspaceId, "ws_1");
  assert.strictEqual(out.integrations[0].name, "whatsapp");
  assert.strictEqual(out.integrations[0].configured, true);
  assert.strictEqual(out.owner.email, "owner@example.com");
  // Secrets in nested array + nested object BOTH masked.
  assert.notStrictEqual(out.integrations[0].apiKey, "sk_live_1234567890abcdef", "nested array apiKey masked");
  assert.notStrictEqual(out.integrations[1].token, "ya29.abcdef1234567890", "nested array token masked");
  assert.notStrictEqual(out.owner.password, "supersecret123", "nested object password masked");
  assert.ok((out.owner.password as string).includes("..."), `nested password masked with ellipsis, got '${out.owner.password}'`);
});

// --- Future-proofing (CASE M) — word-boundary matching so we don't over-redact -

test("CASE M — a field that merely CONTAINS 'key' as a substring but is NOT a secret is preserved", () => {
  // Hand-computed truth: `keyboardLayout` is not a secret. The allowlist must
  // match on the WORD 'key' as a token boundary, not as a bare substring, so
  // we don't nuke every field containing the letters 'k-e-y'.
  // (If the impl uses bare substring matching, this case will over-redact and
  //  fail — proving the impl is too aggressive.)
  const out = redactSecretsFromObject({
    keyboardLayout: "QWERTY",
    monkeyCount: 5,
   turkeyOrigin: "USA",
  }) as Record<string, string | number>;
  assert.strictEqual(out.keyboardLayout, "QWERTY", "'keyboardLayout' is not a secret — preserve it (word-boundary match)");
  assert.strictEqual(out.monkeyCount, 5, "'monkeyCount' is not a secret — preserve it");
  assert.strictEqual(out.turkeyOrigin, "USA", "'turkeyOrigin' is not a secret — preserve it");
});

test("CASE N — a NUMBER under a sensitive key is not a secret and is kept", () => {
  // Found live in session 55 (2026-09-09) by loading a backup back in:
  //   Argument `dailyTokenLimit`: Invalid value provided. Expected Int or Null,
  //   provided String.
  // This product's AI-usage model counts TOKENS, so `dailyTokenLimit`,
  // `monthlyTokenLimit`, `currentDailyTokens` and `currentMonthlyTokens` all
  // matched the "token" substring and every one of them left the product as
  // "****" — in the operator's own export of their own usage numbers.
  //
  // A number cannot be an API key, a bearer token or a password: those are
  // strings without exception.
  const out = redactSecretsFromObject({
    dailyTokenLimit: 100000,
    monthlyTokenLimit: 3000000,
    currentDailyTokens: 4271,
    currentMonthlyTokens: 88123,
    tokenBudgetExceeded: false,
  }) as Record<string, unknown>;
  assert.strictEqual(out.dailyTokenLimit, 100000, "a numeric token LIMIT is a usage number, not a credential");
  assert.strictEqual(out.monthlyTokenLimit, 3000000, "a numeric token LIMIT is a usage number, not a credential");
  assert.strictEqual(out.currentDailyTokens, 4271, "a token COUNT is a usage number, not a credential");
  assert.strictEqual(out.currentMonthlyTokens, 88123, "a token COUNT is a usage number, not a credential");
  assert.strictEqual(out.tokenBudgetExceeded, false, "a boolean cannot carry a secret");
});

test("CASE O — a STRING under the same key is still masked", () => {
  // The narrowing above must not weaken anything. Same key names, string
  // values, still redacted.
  const out = redactSecretsFromObject({
    accessToken: "abcdefghijklmnop",
    apiKey: "sk-livesecretvalue",
    password: "hunter2",
    credentials: { nested: "x" },
  }) as Record<string, unknown>;
  assert.notStrictEqual(out.accessToken, "abcdefghijklmnop", "a string token must still be masked");
  assert.notStrictEqual(out.apiKey, "sk-livesecretvalue", "a string key must still be masked");
  assert.notStrictEqual(out.password, "hunter2", "a password must still be masked");
  assert.strictEqual(out.credentials, "****", "an object under a sensitive key is still masked whole");
});

test("CASE P — a value the redactor already masked is dropped, not written back", () => {
  // A backup is a redacted document by design. Loading one back must leave a
  // credential field ALONE rather than writing the literal "****" into it: a
  // placeholder that looks like a value fails no validation and then fails at
  // call time as a credential nobody recognises as fake.
  const stripped = stripRedactedValues({
    id: "integration_1",
    provider: "meta",
    encryptedCredentials: "****",
    accessToken: "abcd...mnop",
    dailyTokenLimit: 100000,
    companyName: "Real Value",
  }) as Record<string, unknown>;
  assert.ok(!("encryptedCredentials" in stripped), "a fully-masked value must be dropped, not restored as '****'");
  assert.ok(!("accessToken" in stripped), "a partially-masked value must be dropped too");
  assert.strictEqual(stripped.dailyTokenLimit, 100000, "a number under a sensitive key was never masked and must survive");
  assert.strictEqual(stripped.companyName, "Real Value", "an ordinary field must survive untouched");
  assert.strictEqual(stripped.id, "integration_1", "the row must keep its identity");
});

// --- RUNNER ---------------------------------------------------------------------
(async () => {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log("");
  console.log(`secret-redaction: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
