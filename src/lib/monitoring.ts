/**
 * Monitoring wrapper (Stage C.3).
 *
 * Thin facade over @sentry/nextjs. Two non-negotiable contracts:
 *
 *   1. NEVER throws. captureException is the error reporter; if it throws,
 *      it becomes a new source of errors. Every public function here is
 *      wrapped so any underlying failure is swallowed + logged.
 *
 *   2. When SENTRY_DSN is unset (the default for demo mode + most CI), the
 *      wrapper does NOT call into Sentry at all — it falls back to
 *      console.error/console.info so the message is still visible (no
 *      silent failure — build-right rule).
 *
 * Init is idempotent: initSentry can be called from instrumentation.ts at
 * boot AND from anywhere else; the underlying Sentry.init runs once.
 *
 * Honesty: when Sentry is NOT configured, captureException returns silently
 * after logging. When it IS configured, errors flow to Sentry with stack +
 * workspace context for triage. Self-hosted GlitchTip speaks the same DSN
 * protocol, so the operator can pick SaaS Sentry OR GlitchTip by setting
 * one env var — no vendor lock-in.
 *
 * 2026-07-27 Stage C.3.
 */

// The structural shape we depend on from @sentry/nextjs. Keeping it
// structural lets the golden test inject a stub.
type SentryModule = {
  init: (opts: Record<string, unknown>) => void;
  captureException: (err: unknown, ctx?: Record<string, unknown>) => void;
  captureMessage: (msg: string, level?: string) => void;
};

let injectedModule: SentryModule | null = null;
let realModulePromise: Promise<SentryModule | null> | null = null;
let realModule: SentryModule | null = null;
let initHasRun = false;

/** Test seam: inject a stub Sentry module. */
export function setSentryModuleForTesting(mod: SentryModule) {
  injectedModule = mod;
  realModule = null;
  realModulePromise = null;
  initHasRun = false;
}

/** Test seam: clear all module-level state between cases. */
export function resetMonitoringForTesting() {
  injectedModule = null;
  realModule = null;
  realModulePromise = null;
  initHasRun = false;
}

/**
 * Whether Sentry monitoring is enabled. Honest: only true when a real DSN
 * is set (non-empty, not a placeholder). Used by the production-readiness
 * check + golden tests.
 */
export function isSentryEnabled(): boolean {
  const dsn = process.env.SENTRY_DSN;
  return Boolean(dsn && dsn.trim() && !dsn.includes("placeholder") && !dsn.includes("changeme"));
}

/** Internal: get the Sentry module (injected stub, or lazy-loaded real one). */
async function getSentryModule(): Promise<SentryModule | null> {
  if (injectedModule) return injectedModule;
  if (realModule) return realModule;
  if (realModulePromise) return realModulePromise;
  if (!isSentryEnabled()) return null;
  realModulePromise = (async () => {
    try {
      // Lazy require so the wrapper module loads cleanly even when
      // @sentry/nextjs isn't installed (e.g. stripped CI).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("@sentry/nextjs");
      realModule = mod as SentryModule;
      return realModule;
    } catch (err) {
      console.error(`[monitoring] failed to load @sentry/nextjs: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  })();
  return realModulePromise;
}

/**
 * Initialize Sentry. Idempotent — calling multiple times runs Sentry.init
 * exactly once. No-op when SENTRY_DSN is unset (doesn't even import Sentry,
 * keeps boot hermetic for demo mode + tests).
 *
 * Called from instrumentation.ts at boot of the Next.js server. Also safe
 * to call from the worker entrypoint.
 */
export async function initSentry(): Promise<void> {
  if (initHasRun) return;
  initHasRun = true;
  if (!isSentryEnabled()) return; // no-op
  const mod = await getSentryModule();
  if (!mod) return;
  try {
    mod.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || "development",
      // 10% trace sample rate — enough to see slow endpoints without
      // flooding Sentry. Operator can raise if they want full coverage.
      tracesSampleRate: 0.1,
      // Don't send release unless we have an explicit version (avoids
      // "unknown release" noise).
      release: process.env.npm_package_version ? `leadgen@${process.env.npm_package_version}` : undefined,
      // Source-map upload is a separate opt-in (SENTRY_AUTH_TOKEN); here we
      // just enable client-side error reporting.
    });
  } catch (err) {
    // initSentry must NEVER throw — log loudly and move on.
    console.error(`[monitoring] Sentry.init failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Capture an exception. NEVER throws.
 *
 * Routes to Sentry when configured (with optional context for triage),
 * otherwise falls back to console.error (no silent failure).
 *
 * Sync when the module is already loaded (the common path after boot).
 * If the module is still loading (cold start), the call is queued — the
 * error is still routed to Sentry eventually, and we log to console.error
 * synchronously so it isn't lost.
 */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  try {
    if (!isSentryEnabled()) {
      // Fallback: console.error so the error is at least visible in logs.
      if (context) {
        console.error("[monitoring]", error, JSON.stringify(context));
      } else {
        console.error("[monitoring]", error);
      }
      return;
    }
    // Sync fast-path: module already loaded.
    const mod = injectedModule || realModule;
    if (mod) {
      mod.captureException(error, context ? { extra: context } : undefined);
      return;
    }
    // Async path: module still loading (cold start). Log synchronously to
    // console so the error isn't lost, AND queue a Sentry capture for when
    // the module finishes loading.
    console.error("[monitoring] (Sentry still loading)", error);
    void getSentryModule().then((m) => {
      if (m) {
        try { m.captureException(error, context ? { extra: context } : undefined); } catch { /* best effort */ }
      }
    });
  } catch (err) {
    // Last-resort: the error reporter must not become an error source.
    try { console.error("[monitoring] captureException itself failed:", err, "original:", error); } catch { /* nothing more we can do */ }
  }
}

/**
 * Capture a non-error message. NEVER throws.
 *
 * Routes to Sentry when configured, otherwise falls back to console.info
 * (messages are not errors; console.info is the right severity).
 */
export function captureMessage(message: string, level?: string): void {
  try {
    if (!isSentryEnabled()) {
      console.info("[monitoring]", message);
      return;
    }
    const mod = injectedModule || realModule;
    if (mod) {
      mod.captureMessage(message, level);
      return;
    }
    console.info("[monitoring] (Sentry still loading)", message);
    void getSentryModule().then((m) => {
      if (m) {
        try { m.captureMessage(message, level); } catch { /* best effort */ }
      }
    });
  } catch (err) {
    try { console.error("[monitoring] captureMessage itself failed:", err, "original:", message); } catch { /* nothing */ }
  }
}
