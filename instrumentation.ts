/**
 * Next.js instrumentation hook (Stage C.3).
 *
 * Next.js automatically calls `register()` once on boot of the Node.js
 * server (and once per Edge runtime if used). This is the official place
 * to initialize Sentry, OpenTelemetry, or any other observability SDK.
 *
 * Contract:
 *   - If SENTRY_DSN is unset, this is a NO-OP (no @sentry import, no
 *     init call). Demo mode + tests are unaffected.
 *   - If SENTRY_DSN is set, initSentry() runs once. The wrapper is
 *     idempotent so calling it again from elsewhere (worker-entrypoint,
 *     explicit code) is safe.
 *
 * Docs: https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 *
 * 2026-07-27 Stage C.3.
 */
export async function register() {
  // Lazy import so this file doesn't pull monitoring.ts (and its lazy
  // @sentry/nextjs import) at module-eval time when SENTRY_DSN is unset.
  // When DSN is unset, initSentry returns immediately without ever
  // touching @sentry.
  if (process.env.SENTRY_DSN) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { initSentry } = require("./src/lib/monitoring");
    await initSentry();
    // eslint-disable-next-line no-console
    console.log("[instrumentation] Sentry initialized (Stage C.3).");
  } else {
    // Don't even log here — keep boot quiet when monitoring is off.
  }
}
