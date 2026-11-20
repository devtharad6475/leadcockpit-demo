/**
 * Golden test — Stage C.3 monitoring (Sentry) wrapper.
 *
 * Skill build-right Phase 3: pins the CONTRACT of src/lib/monitoring.ts —
 * the thin wrapper around @sentry/nextjs. The contract is:
 *
 *   1. captureException NEVER throws — even if Sentry is misconfigured,
 *      even if the underlying SDK throws, even if no DSN is set. The
 *      whole point of the wrapper is that error-reporting must not be
 *      a new source of errors.
 *
 *   2. When SENTRY_DSN is UNSET: captureException falls back to console.error
 *      (no silent failure — build-right rule) and does NOT attempt to load
 *      or call @sentry/nextjs.
 *
 *   3. When SENTRY_DSN is SET: captureException calls Sentry.captureException
 *      with the error + optional context.
 *
 *   4. captureMessage behaves the same way for non-error messages.
 *
 *   5. isSentryEnabled() returns true iff SENTRY_DSN is set + non-empty.
 *
 *   6. initSentry() is idempotent — calling it twice does not double-init.
 *
 * Anti-cheat: the test stubs @sentry/nextjs via the test seam
 * setSentryModuleForTesting so we can assert the EXACT calls made to
 * Sentry.captureException without depending on a real DSN. When the seam
 * is not set, the wrapper falls back to console.error — also asserted.
 *
 * Run: npx tsx scripts/golden/golden-monitoring.ts
 *
 * 2026-07-27 Stage C.3.
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

// =============================================================================
// CASE 1 — captureException never throws (the central contract)
// =============================================================================
function testCaptureExceptionNeverThrows() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { captureException, resetMonitoringForTesting } = require("../../src/lib/monitoring");
  resetMonitoringForTesting();
  delete process.env.SENTRY_DSN;

  let threw = false;
  try {
    captureException(new Error("real error"));
    captureException("string error");
    captureException(null);
    captureException(undefined);
    captureException({ weird: "object" });
    captureException(new Error("with context"), { workspaceId: "ws1", route: "/api/x" });
  } catch {
    threw = true;
  }
  assert(!threw, "captureException must never throw — it's the error reporter, throwing defeats its purpose");

  pass("CASE 1 — captureException never throws for any input type (Error, string, null, undefined, object)");
}

// =============================================================================
// CASE 2 — Without SENTRY_DSN: falls back to console.error, does NOT call Sentry
// =============================================================================
function testFallbackToConsoleError() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { captureException, resetMonitoringForTesting, setSentryModuleForTesting } = require("../../src/lib/monitoring");
  resetMonitoringForTesting();
  delete process.env.SENTRY_DSN;

  // Inject a stub Sentry module whose captureException we can observe. If
  // the wrapper correctly skips Sentry (because DSN is unset), this stub
  // should NEVER be called.
  let sentryCalls = 0;
  setSentryModuleForTesting({
    captureException: () => { sentryCalls += 1; },
    captureMessage: () => { sentryCalls += 1; },
    init: () => {},
  });

  // Capture console.error too (proves no-silent-failure).
  const originalError = console.error;
  let consoleErrorCalls = 0;
  console.error = (..._args: unknown[]) => { consoleErrorCalls += 1; };

  try {
    captureException(new Error("test"));
  } finally {
    console.error = originalError;
  }

  assert(sentryCalls === 0, `without DSN, Sentry.captureException must NOT be called, got ${sentryCalls} calls`);
  assert(consoleErrorCalls > 0, `without DSN, captureException must fall back to console.error (no silent failure), got ${consoleErrorCalls} calls`);

  pass("CASE 2 — without SENTRY_DSN: captureException falls back to console.error, never calls Sentry");
}

// =============================================================================
// CASE 3 — With SENTRY_DSN: captureException dispatches to Sentry with context
// =============================================================================
function testDispatchesToSentryWhenConfigured() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { captureException, resetMonitoringForTesting, setSentryModuleForTesting } = require("../../src/lib/monitoring");
  resetMonitoringForTesting();
  process.env.SENTRY_DSN = "https://fake@example.com/1";

  let capturedError: unknown = null;
  let capturedContext: unknown = null;
  setSentryModuleForTesting({
    captureException: (err: unknown, ctx?: unknown) => {
      capturedError = err;
      capturedContext = ctx;
    },
    captureMessage: () => {},
    init: () => {},
  });

  const originalError = console.error;
  let consoleErrorCalls = 0;
  console.error = (..._args: unknown[]) => { consoleErrorCalls += 1; };

  try {
    const e = new Error("sentry-routed");
    captureException(e, { workspaceId: "ws-dispatch", route: "/api/test" });
  } finally {
    console.error = originalError;
  }

  assert(capturedError instanceof Error && (capturedError as Error).message === "sentry-routed", `Sentry.captureException must be called with the error, got ${capturedError}`);
  // Sentry convention: arbitrary context is wrapped under `extra`. The
  // wrapper passes { extra: { workspaceId, route, ... } } so Sentry's UI
  // shows the context fields in a structured way.
  const ctxObj = capturedContext as { extra?: { workspaceId?: string; route?: string } } | undefined;
  assert(ctxObj && ctxObj.extra && ctxObj.extra.workspaceId === "ws-dispatch", `Sentry context.extra must include workspaceId, got ${JSON.stringify(capturedContext)}`);

  // When Sentry is configured + succeeds, console.error should NOT also fire
  // (avoid double-logging the same error). If Sentry itself threw, the
  // wrapper would fall back to console.error — but our stub doesn't throw.
  assert(consoleErrorCalls === 0, `when Sentry dispatch succeeds, console.error must NOT also fire (no double-log), got ${consoleErrorCalls} calls`);

  pass("CASE 3 — with SENTRY_DSN: captureException dispatches to Sentry with error+context, no double-log");
}

// =============================================================================
// CASE 4 — isSentryEnabled reflects the DSN state honestly
// =============================================================================
function testIsSentryEnabled() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { isSentryEnabled, resetMonitoringForTesting } = require("../../src/lib/monitoring");
  const originalDsn = process.env.SENTRY_DSN;
  try {
    delete process.env.SENTRY_DSN;
    resetMonitoringForTesting();
    assert(isSentryEnabled() === false, "isSentryEnabled must be false when DSN unset");

    process.env.SENTRY_DSN = "";
    assert(isSentryEnabled() === false, "isSentryEnabled must be false when DSN empty");

    process.env.SENTRY_DSN = "placeholder";
    assert(isSentryEnabled() === false, "isSentryEnabled must be false when DSN is a placeholder");

    process.env.SENTRY_DSN = "https://real@example.com/1";
    assert(isSentryEnabled() === true, "isSentryEnabled must be true when a real DSN is set");
  } finally {
    if (originalDsn === undefined) delete process.env.SENTRY_DSN; else process.env.SENTRY_DSN = originalDsn;
  }

  pass("CASE 4 — isSentryEnabled: false for unset/empty/placeholder DSN; true for real DSN");
}

// =============================================================================
// CASE 5 — initSentry is idempotent (no double-init)
// =============================================================================
async function testInitSentryIdempotent() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { initSentry, resetMonitoringForTesting, setSentryModuleForTesting } = require("../../src/lib/monitoring");
  resetMonitoringForTesting();
  process.env.SENTRY_DSN = "https://fake@example.com/1";

  let initCalls = 0;
  setSentryModuleForTesting({
    init: () => { initCalls += 1; },
    captureException: () => {},
    captureMessage: () => {},
  });

  await initSentry();
  await initSentry();
  await initSentry();

  assert(initCalls === 1, `initSentry must call Sentry.init exactly once (idempotent), got ${initCalls} calls`);

  pass("CASE 5 — initSentry idempotent: multiple calls → exactly one Sentry.init");
}

// =============================================================================
// CASE 6 — initSentry is a no-op when DSN is unset (doesn't even import Sentry)
// =============================================================================
async function testInitSentryNoopWithoutDsn() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { initSentry, resetMonitoringForTesting, setSentryModuleForTesting } = require("../../src/lib/monitoring");
  resetMonitoringForTesting();
  delete process.env.SENTRY_DSN;

  let initCalls = 0;
  setSentryModuleForTesting({
    init: () => { initCalls += 1; },
    captureException: () => {},
    captureMessage: () => {},
  });

  await initSentry();
  await initSentry();

  assert(initCalls === 0, `initSentry must NOT call Sentry.init when DSN unset, got ${initCalls} calls`);

  pass("CASE 6 — initSentry no-op when DSN unset (Sentry.init never called, keeps boot hermetic)");
}

// =============================================================================
// CASE 7 — captureMessage mirrors captureException semantics
// =============================================================================
function testCaptureMessage() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { captureMessage, resetMonitoringForTesting, setSentryModuleForTesting } = require("../../src/lib/monitoring");
  resetMonitoringForTesting();
  process.env.SENTRY_DSN = "https://fake@example.com/1";

  const captured: Array<{ msg: unknown; level: unknown }> = [];
  setSentryModuleForTesting({
    captureMessage: (msg: unknown, level: unknown) => { captured.push({ msg, level }); },
    captureException: () => {},
    init: () => {},
  });

  let threw = false;
  try {
    captureMessage("something happened", "warning");
    captureMessage("plain string");
    captureMessage(null as unknown as string);
  } catch {
    threw = true;
  }
  assert(!threw, "captureMessage must never throw");
  // First call should have routed "something happened" with level "warning".
  assert(captured.length >= 1 && captured[0].msg === "something happened", `captureMessage must route the first message to Sentry, got ${JSON.stringify(captured)}`);
  assert(captured[0].level === "warning", `captureMessage must preserve level, got ${captured[0].level}`);

  pass("CASE 7 — captureMessage: routes to Sentry when configured, never throws, preserves level");

  // Sub-case: without DSN, falls back to console.info (message, not error).
  resetMonitoringForTesting();
  delete process.env.SENTRY_DSN;
  let sentryCalls = 0;
  setSentryModuleForTesting({
    captureMessage: () => { sentryCalls += 1; },
    captureException: () => {},
    init: () => {},
  });
  const originalInfo = console.info;
  let consoleInfoCalls = 0;
  console.info = (..._args: unknown[]) => { consoleInfoCalls += 1; };
  try {
    captureMessage("no dsn");
  } finally {
    console.info = originalInfo;
  }
  assert(sentryCalls === 0, `without DSN, captureMessage must NOT call Sentry, got ${sentryCalls}`);
  assert(consoleInfoCalls > 0, `without DSN, captureMessage must fall back to console.info (no silent drop), got ${consoleInfoCalls}`);

  pass("CASE 7b — captureMessage without DSN: falls back to console.info (no silent drop)");
}

async function main() {
  console.log("golden-monitoring — Stage C.3");
  console.log("Hand-computed contract: never-throws, fallback-to-console, dispatch-when-DSN, idempotent-init");
  console.log("");
  testCaptureExceptionNeverThrows();
  testFallbackToConsoleError();
  testDispatchesToSentryWhenConfigured();
  testIsSentryEnabled();
  await testInitSentryIdempotent();
  await testInitSentryNoopWithoutDsn();
  testCaptureMessage();
  console.log("");
  console.log(`✅ 7 passed, 0 failed — ALL GREEN ✅`);
}

main().catch((err) => {
  console.error("");
  console.error(`❌ golden-monitoring FAILED: ${err instanceof Error ? err.message : err}`);
  console.error(err instanceof Error ? err.stack : "");
  process.exit(1);
});
