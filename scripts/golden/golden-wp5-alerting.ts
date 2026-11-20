/**
 * Golden test — Stage 5 / WP5 (2026-07-29) — Operator alerting.
 *
 * Skill build-right Phase 3: pins the CONTRACT of src/services/AlertService.ts.
 *
 * Per docs/LOGIC.md §WP5.3 + docs/DECISIONS.md D-2026-07-29-g + D-2026-07-29-i:
 *   - Channel: existing EmailSendProvider (Resend/Mock). NO new dependency.
 *   - Recipient: OPERATOR_ALERT_EMAIL env var. Unset → routed:false,
 *     reason:"no_recipient" (NO silent send to a guessed address).
 *   - SEV1 → immediate send. SEV2/SEV3 → queued (not sent now).
 *   - Honest: every result reports routed (bool) + reason (string) + sentAt
 *     (ISO when actually sent).
 *   - No-auto-outreach: alerts go to the OPERATOR (transactional exception).
 *     Never to a customer, lead, or contact. No WhatsApp, no SMS.
 *
 * Anti-cheat: the test stubs the EmailSendProvider via injectEmailProvider
 * so we can assert the EXACT calls (recipient, subject prefix, severity in
 * the body) without depending on Resend or a real key. The stub records
 * every call; the assertion reads the recorded calls.
 *
 * Ironclad Gate #8 (Test Isolation): resetAlertService() before each case
 * so no stub or queue state leaks across cases.
 *
 * Run: npx tsx scripts/golden/golden-wp5-alerting.ts
 */
export {};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

let passed = 0;
function pass(name: string) {
  console.log(`  ✓ ${name}`);
  passed += 1;
}

const RUN_ID = `wp5alert_${Date.now()}`;

async function main() {
  console.log(`\n=== golden:wp5-alerting (RUN_ID=${RUN_ID}) ===\n`);

  // Type-only import (erased at runtime). Pulls the Severity union type
  // directly so the `as Severity` casts below are honest.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Severity = "SEV1" | "SEV2" | "SEV3";
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("../../src/services/AlertService");
  const {
    routeAlert,
    flushDigest,
    resetAlertService,
    injectEmailProviderForTesting,
  } = mod;

  // A stub EmailSendProvider that records every call. Mirrors the real
  // interface so AlertService can't tell the difference.
  type RecordedSend = {
    to: string;
    subject: string;
    html: string;
    purpose: string;
  };
  function makeStub() {
    // Use a stable object holding the array so the closure mutations are
    // visible to TS as widening (not narrowing to length 0).
    const state: { sent: RecordedSend[] } = { sent: [] };
    return {
      provider: {
        isConfigured: () => true,
        send: async (input: { to: string; subject: string; html: string; purpose: string }) => {
          state.sent.push({ to: input.to, subject: input.subject, html: input.html, purpose: input.purpose });
          return { ok: true, provider: "mock" as const, providerMessageId: `stub_${state.sent.length}` };
        },
      },
      get sent(): RecordedSend[] { return state.sent; },
    };
  }

  // ===========================================================================
  // CASE 1 — SEV1 fires an immediate email. OPERATOR_ALERT_EMAIL is set, so
  // the recipient is exactly that address. routed=true, sentAt is an ISO
  // string. Subject contains [SEV1] so the operator's inbox filter can triage.
  // ===========================================================================
  {
    resetAlertService();
    process.env.OPERATOR_ALERT_EMAIL = `op_${RUN_ID}@example.test`;
    const stub = makeStub();
    injectEmailProviderForTesting(stub.provider);

    const result = await routeAlert({
      severity: "SEV1" as Severity,
      event: "database_unreachable",
      summary: "Postgres connection refused on /api/leads",
    });

    assert(result.routed === true, "SEV1 must be routed when OPERATOR_ALERT_EMAIL is set");
    assert(result.reason === undefined || result.reason === "sent", "successful route has no error reason");
    assert(typeof result.sentAt === "string", "routed=true must carry an ISO sentAt");
    assert(stub.sent.length === 1, `exactly one email must be sent for SEV1 (sent ${stub.sent.length})`);
    assert(stub.sent[0].to === process.env.OPERATOR_ALERT_EMAIL, "email recipient must be OPERATOR_ALERT_EMAIL");
    assert(stub.sent[0].subject.includes("SEV1"), "subject must include the severity for inbox filtering");
    assert(stub.sent[0].html.includes("database_unreachable"), "body must include the event name");
    pass("CASE 1 — SEV1 fires immediate email to OPERATOR_ALERT_EMAIL");
  }

  // ===========================================================================
  // CASE 2 — SEV2 and SEV3 do NOT fire immediately. They are queued for the
  // digest. The stub outbox stays empty. routed=false, reason="queued".
  // ===========================================================================
  {
    resetAlertService();
    process.env.OPERATOR_ALERT_EMAIL = `op_${RUN_ID}@example.test`;
    const stub = makeStub();
    injectEmailProviderForTesting(stub.provider);

    for (const sev of ["SEV2", "SEV3"] as Severity[]) {
      const result = await routeAlert({
        severity: sev,
        event: "scheduler_late",
        summary: "Daily digest 4h overdue",
      });
      assert(result.routed === false, `${sev} must NOT route immediately`);
      assert(result.reason === "queued", `${sev} must report reason="queued" (got ${result.reason})`);
      assert(result.sentAt === undefined, `${sev} must not carry a sentAt (nothing was sent)`);
    }
    assert(stub.sent.length === 0, "no email must be sent for SEV2/SEV3 (digest-deferred)");
    pass("CASE 2 — SEV2 + SEV3 are queued, NOT sent immediately");
  }

  // ===========================================================================
  // CASE 3 — If OPERATOR_ALERT_EMAIL is unset, even a SEV1 returns routed:false
  // with reason="no_recipient". NEVER a silent send to a guessed address.
  // ===========================================================================
  {
    resetAlertService();
    delete process.env.OPERATOR_ALERT_EMAIL;
    const stub = makeStub();
    injectEmailProviderForTesting(stub.provider);

    const result = await routeAlert({
      severity: "SEV1",
      event: "database_unreachable",
      summary: "should NOT send — no recipient configured",
    });
    assert(result.routed === false, "SEV1 must NOT route when OPERATOR_ALERT_EMAIL is unset");
    assert(result.reason === "no_recipient", `reason must be "no_recipient" (got ${result.reason})`);
    assert(stub.sent.length === 0, "no email must be sent when recipient is unset");
    pass("CASE 3 — missing OPERATOR_ALERT_EMAIL → routed:false, reason:'no_recipient', no send");
  }

  // ===========================================================================
  // CASE 4 — flushDigest sends ONE consolidated email with all queued alerts.
  // Proves the digest path: queue N SEV2/SEV3 events, flush, get 1 email
  // whose body contains every event. If queue is empty, flushDigest is a
  // no-op (no empty email).
  // ===========================================================================
  {
    resetAlertService();
    process.env.OPERATOR_ALERT_EMAIL = `op_${RUN_ID}@example.test`;
    const stub = makeStub();
    injectEmailProviderForTesting(stub.provider);

    // Queue 3 SEV2/SEV3 events.
    await routeAlert({ severity: "SEV2", event: "scheduler_late", summary: "digest 4h late" });
    await routeAlert({ severity: "SEV3", event: "label_bug", summary: "wrong text on /leads" });
    await routeAlert({ severity: "SEV2", event: "llm_slot_down", summary: "anthropic 5xx rate" });
    assert(stub.sent.length === 0, "queued alerts must NOT send yet");

    const flush1 = await flushDigest();
    assert(flush1.routed === true, "flushDigest must route when there are queued events");
    assert(flush1.eventCount === 3, `digest must consolidate 3 events (got ${flush1.eventCount})`);
    const sentCount: number = stub.sent.length;
    assert(sentCount === 1, `flushDigest must send exactly ONE email (sent ${sentCount})`);
    const sent0 = stub.sent[0];
    assert(sent0.html.includes("scheduler_late"), "digest body must include event 1");
    assert(sent0.html.includes("label_bug"), "digest body must include event 2");
    assert(sent0.html.includes("llm_slot_down"), "digest body must include event 3");

    // Second flush on an empty queue is a no-op.
    const flush2 = await flushDigest();
    assert(flush2.routed === false, "flushDigest on empty queue must NOT route");
    assert(flush2.eventCount === 0, "empty flush reports 0 events");
    const finalCount: number = stub.sent.length;
    assert(finalCount === 1, `no extra email on empty flush (sent ${finalCount})`);
    pass("CASE 4 — flushDigest consolidates queued alerts into ONE email; no-op when empty");
  }

  // ===========================================================================
  // CASE 5 — No-auto-outreach invariant: AlertService imports NO WhatsApp,
  // Gmail, or prospecting-outreach sender. It may only import the
  // EmailSendProvider (transactional-to-operator path). A grep of the source
  // file proves this statically.
  // ===========================================================================
  {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "src", "services", "AlertService.ts"),
      "utf8",
    );
    const forbidden = [
      "MetaWhatsAppCloudProvider",
      "WhatsAppSendProvider",
      "from \"@/providers/whatsapp\"",
      "generateMessage",
      "sendOutreach",
      "OutreachActivity",
    ];
    const found = forbidden.filter((token) => src.includes(token));
    assert(found.length === 0, `AlertService must NOT import outreach/WhatsApp paths (found: ${found.join(", ")})`);
    // It MUST import the email provider (the allowed channel).
    assert(src.includes("@/providers/email"), "AlertService must import the EmailSendProvider (the allowed channel)");
    pass("CASE 5 — No-auto-outreach: AlertService uses email-only, no outreach/WhatsApp paths");
  }

  // Cleanup: leave env clean for the next golden.
  delete process.env.OPERATOR_ALERT_EMAIL;

  console.log(`\n✅ ${passed} passed, 0 failed — ALL GREEN ✅\n`);
}

main().catch((err) => {
  console.error(`\n❌ FAILED after ${passed} passed: ${err instanceof Error ? err.message : err}`);
  console.error(err instanceof Error ? err.stack : "");
  process.exit(1);
});
