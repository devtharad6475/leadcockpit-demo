"use client";

/**
 * Global error boundary — the *only* error boundary that catches errors thrown
 * from the root layout itself (html/body tags). Must render its own <html> and
 * <body> because the root layout is bypassed when this boundary activates.
 *
 * Kept intentionally minimal (inline styles, no Tailwind dependency, no fonts)
 * because if we got here the normal layout/CSS pipeline may be broken.
 */
import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[LeadCockpit] global error boundary caught:", error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", background: "#f8fafc", padding: "24px", fontFamily: "system-ui, sans-serif" }}>
          <div style={{ maxWidth: "520px", width: "100%", background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "32px", boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}>
            <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 600, color: "#0f172a" }}>LeadCockpit hit a critical error</h2>
            <p style={{ marginTop: "8px", fontSize: "14px", color: "#475569" }}>
              The application shell failed to load. Your saved data is not affected by this error.
            </p>
            {error?.message ? (
              <pre style={{ marginTop: "16px", padding: "12px", background: "#f1f5f9", borderRadius: "4px", fontSize: "12px", color: "#334155", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{error.message}</pre>
            ) : null}
            <div style={{ marginTop: "24px", display: "flex", gap: "12px", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={reset}
                style={{ background: "#0f172a", color: "#ffffff", border: "none", borderRadius: "6px", padding: "8px 16px", fontSize: "14px", fontWeight: 500, cursor: "pointer" }}
              >
                Try again
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                style={{ background: "#ffffff", color: "#334155", border: "1px solid #cbd5e1", borderRadius: "6px", padding: "8px 16px", fontSize: "14px", fontWeight: 500, cursor: "pointer" }}
              >
                Reload page
              </button>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
