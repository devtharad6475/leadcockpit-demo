/**
 * 2026-07-21 (M0) — Per-request CSP nonce middleware.
 *
 * Root cause of the Next.js 16 hydration bug (caught by Playwright 2026-07-19):
 * the App Router injects internal RSC bootstrap inline scripts
 * (self.__next_r / self.__next_f.push) on every page. A static CSP header
 * with `script-src 'self'` blocks those inline scripts — so React never
 * hydrated, button onClick handlers never fired, and the whole UI was
 * non-interactive. See:
 *   https://github.com/vercel/next.js/discussions/81703
 *
 * The fix is the official Next.js pattern (Content Security Policy guide):
 *   1. Middleware generates a fresh random nonce per request.
 *   2. Middleware sets the `x-nonce` REQUEST header (forwarded into the
 *      Next.js render context). Next.js auto-injects `nonce="<value>"` on
 *      the inline scripts it generates.
 *   3. Middleware sets the COMPLETE Content-Security-Policy RESPONSE
 *      header including `nonce-<value>` in script-src. (We can't read
 *      next.config.ts's CSP — it's applied AFTER middleware, so we set
 *      the full thing here and remove the CSP from next.config.ts.)
 *
 * Per the official guide: "During rendering, Next.js automatically parses
 * the Content-Security-Policy header, extracts the nonce, and applies
 * it to scripts/styles that require it."
 *
 * Why per-request nonce (not 'unsafe-inline' or a static hash):
 *   - 'unsafe-inline' defeats the entire point of CSP for scripts.
 *   - Static hashes break every time Next.js changes its inline payload.
 *   - Per-request nonces are the OWASP-recommended pattern for SPA
 *     frameworks that emit bootstrap scripts.
 */
import { NextResponse, type NextRequest } from "next/server";

/**
 * Build the full CSP string. Kept in sync with the securityHeaders list
 * that previously lived in next.config.ts, plus the nonce on script-src.
 *
 * Security audit (Phase 5): CSP was deliberately strict — connect-src
 * 'self' to block exfiltration, script-src 'self' to block injection,
 * frame-ancestors 'none' to block clickjacking. The ONLY relaxation
 * here is adding `nonce-<value>` to script-src. That keeps the original
 * defence (only our scripts can run) while letting Next.js's own
 * bootstrap scripts execute.
 */
function buildCsp(nonce: string): string {
  // In development, React requires 'unsafe-eval' for stack reconstruction
  // and HMR. In production, we keep CSP strict (no 'unsafe-eval').
  // React does NOT use eval in production — this is a dev-only relaxation.
  const isDev = process.env.NODE_ENV !== "production";
  const scriptSrc = isDev
    ? `script-src 'self' 'nonce-${nonce}' 'unsafe-eval'`
    : `script-src 'self' 'nonce-${nonce}'`;
  return [
    "default-src 'self'",
    // Tailwind v4 injects inline styles; allow 'unsafe-inline' for styles.
    // (Style injection is much lower risk than script injection.)
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    // Block cross-origin fetch/XHR from any injected script (anti-exfil).
    "connect-src 'self'",
    scriptSrc,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function middleware(request: NextRequest) {
  // Generate a fresh nonce. crypto.randomUUID() gives 122 bits of entropy;
  // we combine two for extra strength, base64url-encoded for header safety.
  const nonce = Buffer.from(crypto.randomUUID() + crypto.randomUUID()).toString("base64url");

  // Forward the nonce to Next.js via the request header so Next attaches
  // it to its generated inline scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  // Set the full CSP on the response (overriding any default).
  response.headers.set("Content-Security-Policy", buildCsp(nonce));

  // In non-production, expose the nonce for diagnostics.
  if (process.env.NODE_ENV !== "production") {
    response.headers.set("x-nonce-debug", nonce);
  }

  return response;
}

export const config = {
  matcher: [
    // Match every HTML path except Next internals + API + static assets.
    "/((?!api|_next/static|_next/image|favicon.ico|robots.txt).*)",
  ],
};
