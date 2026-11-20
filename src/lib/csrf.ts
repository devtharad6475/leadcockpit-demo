/**
 * CSRF protection for state-changing requests.
 *
 * Model: Same-Origin via Origin/Referer header check.
 *
 * We use SameSite=Lax session cookies (see session.ts), which already block
 * the vast majority of cross-site CSRF. As defense-in-depth, we ALSO verify
 * that every POST/PUT/DELETE either:
 *   (a) carries an `Origin` or `Referer` header equal to our own host, or
 *   (b) is a same-origin request (no Origin header — browsers send Origin on
 *       all cross-site and most same-site state changes).
 *
 * We intentionally allow the case of "no Origin header" only when there IS a
 * valid same-origin Referer, OR when the request is unauthenticated (in which
 * case auth will reject it anyway). This keeps API-test tooling working in
 * demo mode while closing the real CSRF hole in production.
 *
 * Why not a double-submit token? SameSite + Origin check is what modern
 * frameworks (Django, Rails, Next.js itself) now recommend, and it requires
 * no client-side token plumbing. We can layer a CSRF token on top later if a
 * downstream reverse proxy ever strips Origin headers.
 */
import type { NextRequest } from "next/server";
import { getAuthMode } from "./auth";

function normalizeHost(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return null;
  }
}

/**
 * Every host this server may legitimately be addressed as.
 *
 * ── WHY THIS IS A LIST, AND WHY IT NO LONGER USES nextUrl (P0, 2026-08-26) ──
 * This used to return a single host derived from `request.nextUrl`. In the
 * SHIPPED artifact that is the server's own BIND ADDRESS, not the domain the
 * browser typed. The Dockerfile runs the standalone server with
 * `HOSTNAME=0.0.0.0`, so `expectedHost()` returned `0.0.0.0:3000` and the only
 * `Origin` that could ever match was `http://0.0.0.0:3000` -- which no browser
 * will ever send.
 *
 * The effect on a real deployment: GET is CSRF-safe so the app LOADS and looks
 * healthy, and then every single state-changing request -- save the business
 * profile, add a lead, approve a lead, send a quote, change any setting --
 * comes back 403 CSRF_REJECTED. The product is read-only in production.
 *
 * It hid because it needs THREE things at once to appear: production auth mode
 * (demo mode allows a missing Origin), the built standalone server, and a host
 * that is not the bind address. Dev is `localhost` browsing `localhost`, so it
 * matches there and only there. Same family as the CSP-nonce P0: broken only
 * in the artifact that actually ships.
 *
 * ── WHY COMPARING AGAINST THE `Host` HEADER IS SOUND ────────────────────────
 * This is the standard same-origin CSRF check (Django, Rails). A browser sets
 * `Host` to the site it is actually talking to and does not let script forge
 * it; a cross-site POST from evil.com therefore arrives as
 * `Origin: https://evil.com` + `Host: app.example.com` and still fails. A
 * non-browser client can send any Host it likes, but it has no victim's cookie
 * to ride on, which is the only thing CSRF is about.
 *
 * Order: an explicitly configured public origin wins, then the proxy's
 * forwarded host, then the request's own Host header.
 */
function expectedHosts(request: NextRequest): string[] {
  const hosts = new Set<string>();
  const add = (h: string | null) => {
    if (h) hosts.add(h);
  };

  // 1. Explicit configuration, if the operator set it. Same variable the
  //    invite and verification emails already use for the public URL, so a
  //    deployment states its own address once rather than twice.
  add(normalizeHost(process.env.NEXT_PUBLIC_APP_URL ?? null));
  add(normalizeHost(process.env.NEXT_PUBLIC_APP_ORIGIN ?? null));
  for (const extra of (process.env.APP_TRUSTED_ORIGINS ?? "").split(",")) {
    add(normalizeHost(extra.trim() || null));
  }

  // 2. Behind a reverse proxy or ingress the browser's host arrives here.
  const fwdHost = request.headers.get("x-forwarded-host");
  if (fwdHost) {
    const proto = request.headers.get("x-forwarded-proto") ?? "https";
    add(normalizeHost(`${proto}://${fwdHost.split(",")[0].trim()}`));
  }

  // 3. The request's own Host header — the ordinary, unproxied case.
  const host = request.headers.get("host");
  if (host) {
    const proto = request.nextUrl.protocol === "https:" ? "https" : "http";
    add(normalizeHost(`${proto}://${host}`));
    // A Host header carries no scheme, so accept it under either one rather
    // than guessing: TLS is usually terminated at the proxy, which makes the
    // inbound request plain http while the browser's Origin says https.
    add(normalizeHost(`https://${host}`));
    add(normalizeHost(`http://${host}`));
  }

  return [...hosts];
}

/**
 * Returns true if the request is allowed under the CSRF policy.
 * Returns false if it is a cross-site forgery attempt.
 *
 * Safe methods (GET, HEAD, OPTIONS) are always allowed.
 */
export function isCsrfSafe(request: NextRequest): boolean {
  const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
  if (safeMethods.has(request.method.toUpperCase())) return true;

  const expected = expectedHosts(request);

  // Primary signal: Origin header.
  const origin = normalizeHost(request.headers.get("origin"));
  if (origin) return expected.includes(origin);

  // Fallback: Referer header.
  const referer = normalizeHost(request.headers.get("referer"));
  if (referer) return expected.includes(referer);

  // No Origin AND no Referer on a state-changing request.
  // In demo/local mode, API test tooling (curl, smoke scripts) legitimately
  // sends no Origin; allow it there. In production, reject — real browsers
  // always send Origin or Referer on cross-site POSTs.
  return getAuthMode() !== "production";
}
