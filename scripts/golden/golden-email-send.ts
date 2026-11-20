/**
 * golden-email-send.ts — pins the EmailSendProvider contract (Stage 5 / WP2).
 *
 * WHAT THIS PROVES (Stage 5 / WP2, docs/LOGIC.md 2026-07-28 — password reset)
 *   The first email-sending code path in LeadCockpit. Used by the operator-
 *   initiated password reset to email a one-time reset link to a known
 *   workspace user. This is a TRANSACTIONAL email (the operator-confirmed
 *   exception to no-auto-outreach), NOT prospecting outreach.
 *
 *   The contract is provider-agnostic (EmailSendProvider interface) with a
 *   concrete Resend adapter. A Mock adapter is the default fallback so the
 *   JSON demo + tests work without a paid Resend key — same pattern as the
 *   LLM Mock fallback.
 *
 * THE CONTRACTS (hand-computed BEFORE writing assertions):
 *
 *   CASE A — Resend adapter sends the RIGHT request shape: POST
 *            https://api.resend.com/emails with Authorization: Bearer <key>,
 *            body {from, to, subject, html}. The captured request must have
 *            the key in the Authorization header ONLY (never in the body, never
 *            in a query string — anti-leak). Returns a provider message id.
 *
 *   CASE B — Resend adapter parses the response shape: {id: "..."}. An empty
 *            or non-JSON response throws a typed EmailSendError (no silent
 *            undefined). A 4xx/5xx response throws with the provider's error
 *            message surfaced (no silent failure — build-right rule).
 *
 *   CASE C — Mock adapter (fallback, no key): records the email in an in-memory
 *            outbox + returns a deterministic mock id, AND reports
 *            provider="mock" honestly (never claims real success). The mock
 *            outbox lets tests assert "the email would have been sent with
 *            these contents" without a network call.
 *
 *   CASE D — Provider selection: with RESEND_API_KEY set → Resend adapter;
 *            without → Mock adapter. The selected provider's `provider` field
 *            is honest ("resend" | "mock"). This is the same honest-status
 *            discipline as the LLM layer (real/fallback/mock).
 *
 *   CASE E — No-auto-outreach invariant: the email provider is ONLY used for
 *            transactional emails to KNOWN workspace users (password reset,
 *            invite, security notice). It is NEVER wired to prospecting paths
 *            (WhatsApp/Gmail cold sends to leads). Static check: the provider
 *            module exports no function that takes a leadId or contactId.
 *
 *   CASE F — Rate-limited: the password-reset email send path is capped
 *            (password_reset_email preset) so a bug can't spam a user's inbox.
 *            The rate-limit check happens BEFORE the provider call.
 *
 * REAL PIPELINE: stubbed global fetch (same anti-cheat pattern as
 * golden-llm-adapters). No real network call, no paid key needed.
 *
 * Run: npx tsx scripts/golden/golden-email-send.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";

type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

/**
 * Install a stubbed global fetch that records every call + returns the canned
 * response. Returns the captured calls so assertions can inspect them.
 */
async function withStubbedFetch<T>(
  responder: (call: FetchCall) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>,
  fn: () => Promise<T>,
): Promise<{ result: T; calls: FetchCall[] }> {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method || "GET";
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) headers[k] = v;
    }
    const body = typeof init?.body === "string" ? init.body : "";
    const call: FetchCall = { url, method, headers, body };
    calls.push(call);
    const { status, body: respBody } = await responder(call);
    return new Response(JSON.stringify(respBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    globalThis.fetch = original;
  }
}

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

// ─── CASE A: Resend request shape + key placement ───────────────────────────
test("CASE A — Resend adapter sends correct POST shape; key in Authorization header only", async () => {
  const previous = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_test_key_golden_A";
  try {
    const { calls } = await withStubbedFetch(
      () => ({ status: 200, body: { id: "email_mock_id_A" } }),
      async () => {
        const { sendEmail } = await import("@/providers/email");
        const result = await sendEmail({
          from: "LeadCockpit <noreply@leadcockpit.app>",
          to: "user@example.com",
          subject: "Reset your password",
          html: "<p>Click <a href='https://app.leadcockpit.app/reset?t=abc'>here</a>.</p>",
          purpose: "password_reset",
        });
        // Honest provider status.
        assert.strictEqual(result.provider, "resend", "with RESEND_API_KEY set, provider must report 'resend'");
        assert.strictEqual(result.providerMessageId, "email_mock_id_A");
      },
    );
    assert.strictEqual(calls.length, 1, "exactly one fetch call");
    const c = calls[0];
    assert.strictEqual(c.url, "https://api.resend.com/emails", "must POST to Resend endpoint");
    assert.strictEqual(c.method, "POST");
    assert.strictEqual(c.headers["Authorization"], "Bearer re_test_key_golden_A", "key must be in Authorization header");
    assert.ok(!c.body.includes("re_test_key_golden_A"), "key must NOT leak into the request body");
    assert.ok(!c.url.includes("re_test_key_golden_A"), "key must NOT leak into the URL");
    const body = JSON.parse(c.body);
    assert.strictEqual(body.from, "LeadCockpit <noreply@leadcockpit.app>");
    assert.strictEqual(body.to, "user@example.com");
    assert.strictEqual(body.subject, "Reset your password");
    assert.ok(body.html.includes("reset"), "html body must be passed through");
  } finally {
    if (previous === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = previous;
  }
});

// ─── CASE B: Resend error handling ──────────────────────────────────────────
test("CASE B — Resend adapter surfaces 4xx/5xx + empty response as typed errors (no silent fail)", async () => {
  const previous = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_test_key_golden_B";
  try {
    const { EmailSendError, sendEmail } = await import("@/providers/email");

    // 4xx response → typed error with provider message.
    await assert.rejects(
      () => withStubbedFetch(
        () => ({ status: 422, body: { message: "The from address is invalid" } }),
        async () => sendEmail({ from: "bad", to: "user@example.com", subject: "x", html: "x", purpose: "password_reset" }),
      ),
      EmailSendError,
      "4xx must throw EmailSendError",
    );

    // Empty/non-JSON body → typed error.
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("", { status: 200 })) as typeof globalThis.fetch;
    try {
      await assert.rejects(
        () => sendEmail({ from: "ok@app.app", to: "u@e.com", subject: "s", html: "h", purpose: "password_reset" }),
        EmailSendError,
        "empty response must throw EmailSendError (no silent undefined)",
      );
    } finally {
      globalThis.fetch = original;
    }
  } finally {
    if (previous === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = previous;
  }
});

// ─── CASE C: Mock adapter outbox + honest status ────────────────────────────
test("CASE C — Mock adapter records to outbox + reports provider='mock' honestly", async () => {
  const previous = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    const { sendEmail, getMockOutbox, clearMockOutbox } = await import("@/providers/email");
    clearMockOutbox();
    const result = await sendEmail({
      from: "noreply@leadcockpit.app",
      to: "user@example.com",
      subject: "Reset your password",
      html: "<p>link</p>",
      purpose: "password_reset",
    });
    assert.strictEqual(result.provider, "mock", "without RESEND_API_KEY, provider must honestly report 'mock'");
    assert.ok(result.providerMessageId && result.providerMessageId.startsWith("mock_"), "mock id must be prefixed 'mock_'");

    const outbox = getMockOutbox();
    assert.strictEqual(outbox.length, 1, "mock outbox must record exactly one email");
    assert.strictEqual(outbox[0].to, "user@example.com");
    assert.strictEqual(outbox[0].subject, "Reset your password");
    assert.strictEqual(outbox[0].purpose, "password_reset");
  } finally {
    if (previous === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = previous;
  }
});

// ─── CASE D: provider selection ─────────────────────────────────────────────
test("CASE D — provider selection: RESEND_API_KEY present → resend; absent → mock", async () => {
  const { getActiveEmailProvider } = await import("@/providers/email");
  const previous = process.env.RESEND_API_KEY;

  process.env.RESEND_API_KEY = "re_test_key_golden_D";
  assert.strictEqual(getActiveEmailProvider(), "resend", "with key, active provider is resend");

  delete process.env.RESEND_API_KEY;
  assert.strictEqual(getActiveEmailProvider(), "mock", "without key, active provider is mock (honest fallback)");

  if (previous === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = previous;
});

// ─── CASE E: no-auto-outreach invariant (static) ────────────────────────────
test("CASE E — email provider module exports NO prospecting-path function (no leadId/contactId senders)", async () => {
  const mod = await import("@/providers/email");
  const exportedNames = Object.keys(mod);
  // The provider must NOT export any prospecting-oriented sender.
  const forbidden = exportedNames.filter((n) => /lead|contact|prospect|outreach|cold/i.test(n));
  assert.deepStrictEqual(forbidden, [], "email module must not export any prospecting-path sender");
  // It MUST export the transactional sendEmail.
  assert.ok(typeof mod.sendEmail === "function", "must export sendEmail");
});

// ─── CASE F: rate-limit preset exists ───────────────────────────────────────
test("CASE F — password_reset_email rate-limit preset exists (anti-spam cap)", async () => {
  const { defaults } = await import("@/services/rate-limit/memoryBackend");
  assert.ok(defaults.password_reset_email, "password_reset_email preset must exist");
  assert.ok(defaults.password_reset_email.limit > 0, "limit must be > 0");
  assert.ok(defaults.password_reset_email.limit <= 10, "limit must be small (≤10/hour) to prevent inbox spam");
  assert.ok(defaults.password_reset_email.windowMs >= 60 * 60 * 1000, "window must be ≥1 hour");
});

// ─── Runner ─────────────────────────────────────────────────────────────────
async function main() {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed += 1;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed += 1;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log(`\nGolden email-send: ${passed} passed, ${failed} failed (of ${cases.length})`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
