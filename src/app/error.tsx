"use client";

/**
 * Route-level error boundary.
 *
 * Catches runtime errors thrown during render of the dashboard subtree and
 * shows a recovery UI instead of a blank white page. This does NOT catch
 * errors in the root layout itself — global-error.tsx handles those.
 *
 * Per Next.js App Router conventions this must be a client component and must
 * accept `error` + `reset` props.
 */
import { useEffect } from "react";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Surface to the browser console so devs can see the stack during triage.
    // We intentionally do NOT send this to a remote telemetry endpoint — there
    // is no vetted telemetry integration yet and silently POSTing user data
    // would violate the no-auto-outreach rule.
    console.error("[LeadCockpit] route error boundary caught:", error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-lg rounded-lg border border-border-default bg-surface p-8 shadow-sm">
        <h2 className="text-xl font-semibold text-foreground">Something went wrong</h2>
        <p className="mt-2 text-sm text-muted">
          The workspace hit an unexpected error while rendering. Your data is safe — try again, or reload the page.
        </p>
        {error?.message ? (
          <pre className="mt-4 overflow-x-auto rounded bg-surface-muted p-3 text-xs text-muted">{error.message}</pre>
        ) : null}
        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.assign("/")}
            className="rounded-md border border-border-default bg-surface px-4 py-2 text-sm font-medium text-foreground hover:bg-surface-muted"
          >
            Reload workspace
          </button>
        </div>
      </div>
    </div>
  );
}
