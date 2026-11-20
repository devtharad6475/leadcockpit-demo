import type { NextConfig } from "next";

/**
 * Security headers (Session 5 audit fix; revised 2026-07-21 M0).
 *
 * 2026-07-21 REVISION: the Content-Security-Policy header used to live
 * here with `script-src 'self'`. That strict CSP blocked Next.js 16's
 * App Router inline bootstrap scripts (self.__next_r / self.__next_f),
 * which killed React hydration — see
 * https://github.com/vercel/next.js/discussions/81703 and the M0 audit
 * entry in docs/DECISIONS.md.
 *
 * The CSP is now generated PER-REQUEST in src/middleware.ts with a fresh
 * nonce, and Next.js auto-attaches that nonce to its generated inline
 * scripts. CSP is deliberately NOT set here — middleware is the single
 * source of truth for CSP.
 *
 * The other security headers below remain unchanged from the Phase 5
 * audit: nosniff, DENY, no-referrer, locked-down permissions, HSTS.
 * They do not interfere with Next.js hydration.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },
  // NOTE: Content-Security-Policy is intentionally NOT set here.
  // It is generated per-request in src/middleware.ts with a fresh nonce.
];

const nextConfig: NextConfig = {
  // Stage 1 proof run: Next 16 permits exactly ONE dev server per directory,
  // whatever port you give it, so the only way to run this product in
  // AUTH_MODE=production while a dev server is live is a real production build
  // started with `next start` into a build directory of its own. Unset in normal
  // use, so it resolves to ".next" and nothing changes for anybody else.
  distDir: process.env.LEADGEN_DIST_DIR || ".next",
  // Stage D.1: standalone build produces a self-contained .next/standalone/
  // directory with only the needed node_modules. This shrinks the Docker
  // image from ~1.5GB to ~200-300MB and lets the runner stage copy just
  // what's needed (no full node_modules, no source, no devDeps). Verified
  // not to break the catch-all API route, middleware, or any of the 40
  // golden tests + 12 demo smokes (see docs/VERIFICATION-RECEIPTS.md
  // Stage D entry).
  output: "standalone",
  // 2026-08-05 (audit U-9): Next 16 blocks cross-origin requests to dev-only
  // resources (/_next/webpack-hmr, etc.) unless the host is listed here. The
  // dev server binds 0.0.0.0, so opening the app on http://127.0.0.1:3000 or
  // over the LAN silently failed to boot the client bundle — buttons did
  // nothing and no request reached the server, while http://localhost:3000
  // worked fine. Dev-only setting; it has no effect on a production build.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  /**
   * 2026-09-05 (session 52) — hide the dev-tools indicator when a test drives
   * the app.
   *
   * Next 16 draws a floating "N / Issues" badge in the BOTTOM-LEFT corner of the
   * viewport in dev. That is exactly where this app's last sidebar group sits,
   * and the badge's portal swallows pointer events: a Playwright click on
   * "Workspace & admin" then retried for fifteen minutes and the run died on a
   * test timeout that named a portal rather than anything about the product.
   * Worse, the badge only appears once something has been logged as an issue, so
   * the suite passes until the first console error and then hangs on the LAST
   * screens instead of reporting the error it was built to report.
   *
   * The indicator is a developer aid on a human's screen, so it stays on for
   * humans. `LEADGEN_HIDE_DEV_INDICATOR=1` is set by the Playwright web server
   * only (playwright.config.ts). It is dev-only either way — a production build
   * has never drawn it.
   */
  devIndicators: process.env.LEADGEN_HIDE_DEV_INDICATOR === "1" ? false : undefined,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
