/**
 * golden-csrf-public-host.ts — pins the host the CSRF gate compares against.
 *
 * ── THE DEFECT THIS EXISTS FOR (P0, found 2026-08-26 by walking the product) ─
 * `isCsrfSafe` compares the browser's `Origin` against "this server's host".
 * That host used to be derived from `request.nextUrl`, which in the SHIPPED
 * artifact is the server's own BIND ADDRESS. The Dockerfile runs the standalone
 * server with `HOSTNAME=0.0.0.0`, so the only `Origin` that could ever match
 * was `http://0.0.0.0:3000` — a value no browser will ever send.
 *
 * Measured against the real built server before the fix, with the Dockerfile's
 * own hostname:
 *
 *   Host + Origin: app.leadcockpit.com   →  403 CSRF_REJECTED
 *   Host + Origin: localhost:3011        →  403 CSRF_REJECTED
 *   Host + Origin: 0.0.0.0:3011          →  passes CSRF (401, i.e. it got through)
 *
 * GET is a safe method, so reads were unaffected: the deployed app LOADS, looks
 * healthy, and then every state-changing request — save the business profile,
 * add a lead, approve a lead, send a quote, change any setting — returns 403.
 * The product is read-only in production.
 *
 * ── WHY THE EXISTING CSRF GOLDEN DID NOT CATCH IT ───────────────────────────
 * `golden-platform-admin-csrf.ts` builds its request URL and its `Origin`
 * header from the same constant, so `nextUrl` and the browser's host agree BY
 * CONSTRUCTION. The bug lives precisely where those two disagree, which that
 * test can never express. This golden's whole job is to make them disagree.
 *
 * ── WHAT IS ASSERTED ────────────────────────────────────────────────────────
 *   1. Real deployment: bind address ≠ public host, Origin matches Host → ALLOWED.
 *      (This is the P0. Reverting the fix turns this red.)
 *   2. Behind a proxy: X-Forwarded-Host carries the browser's host → ALLOWED.
 *   3. The attack still fails: Origin is evil.example, Host is ours → BLOCKED.
 *      (The fix must not be a hole. This is the case that keeps it honest.)
 *   4. Explicit configuration (NEXT_PUBLIC_APP_URL) is honoured → ALLOWED.
 *   5. Production with no Origin and no Referer → BLOCKED.
 *   6. Safe methods bypass the gate entirely → ALLOWED.
 *
 * Run: npx tsx scripts/golden/golden-csrf-public-host.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { isCsrfSafe } from "@/lib/csrf";
import { NextRequest } from "next/server";

let passed = 0;
let failed = 0;
const cases: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  cases.push({ name, fn });
}

/**
 * A request as it arrives at the SHIPPED server: the URL carries the bind
 * address (that is what `nextUrl` sees), while the headers carry what the
 * browser actually used. Those two differing is the entire point.
 */
function request(opts: {
  method?: string;
  bind?: string;
  headers?: Record<string, string>;
}): NextRequest {
  const bind = opts.bind ?? "http://0.0.0.0:3000";
  return new NextRequest(`${bind}/api/business-profile`, {
    method: opts.method ?? "POST",
    headers: opts.headers ?? {},
  });
}

/** Run a case with AUTH_MODE forced, restoring it afterwards. */
function withAuthMode<T>(mode: string, fn: () => T): T {
  const before = process.env.AUTH_MODE;
  process.env.AUTH_MODE = mode;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = before;
  }
}

/** Run a case with an env var forced, restoring it afterwards. */
function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const before = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
}

// ─── CASE 1 — the P0 itself ──────────────────────────────────────────────────
test("CASE 1 — a browser on the real domain may write, though the server is bound to 0.0.0.0", () => {
  withAuthMode("production", () => {
    const req = request({
      headers: { host: "app.leadcockpit.com", origin: "https://app.leadcockpit.com" },
    });
    assert.strictEqual(
      isCsrfSafe(req),
      true,
      "a browser whose Origin matches the Host it addressed MUST be allowed to write. " +
        "Refusing it makes the deployed product read-only: every save, approve and quote returns 403.",
    );
  });
});

// ─── CASE 2 — behind a reverse proxy ─────────────────────────────────────────
test("CASE 2 — behind a proxy, the forwarded host is what the browser used", () => {
  withAuthMode("production", () => {
    const req = request({
      headers: {
        host: "10.0.0.5:3000",
        "x-forwarded-host": "app.leadcockpit.com",
        "x-forwarded-proto": "https",
        origin: "https://app.leadcockpit.com",
      },
    });
    assert.strictEqual(
      isCsrfSafe(req),
      true,
      "with an ingress or load balancer in front, the browser's host arrives in X-Forwarded-Host. " +
        "Ignoring it reproduces the same read-only failure one layer up.",
    );
  });
});

// ─── CASE 3 — the fix must not become a hole ─────────────────────────────────
test("CASE 3 — a genuine cross-site forgery is still refused", () => {
  withAuthMode("production", () => {
    const attack = request({
      headers: { host: "app.leadcockpit.com", origin: "https://evil.example" },
    });
    assert.strictEqual(
      isCsrfSafe(attack),
      false,
      "THE SECURITY PROPERTY. A browser sets Host to the site it is really talking to and will not " +
        "let a script forge it, so a forged POST from evil.example arrives with its own Origin and " +
        "our Host. If this ever returns true the gate has been widened into a hole.",
    );

    const badReferer = request({
      headers: { host: "app.leadcockpit.com", referer: "https://evil.example/attack.html" },
    });
    assert.strictEqual(isCsrfSafe(badReferer), false, "a cross-site Referer must be refused too");
  });
});

// ─── CASE 4 — explicit configuration is honoured ─────────────────────────────
test("CASE 4 — a configured public origin is accepted even when the Host differs", () => {
  withAuthMode("production", () => {
    withEnv("NEXT_PUBLIC_APP_URL", "https://app.leadcockpit.com", () => {
      const req = request({
        headers: { host: "internal-service:3000", origin: "https://app.leadcockpit.com" },
      });
      assert.strictEqual(
        isCsrfSafe(req),
        true,
        "an operator who states the public URL must be believed — that variable already names the " +
          "public address for invite and verification emails.",
      );
    });
  });
});

// ─── CASE 5 — no Origin, no Referer, in production ───────────────────────────
test("CASE 5 — production still refuses a write carrying no Origin and no Referer", () => {
  withAuthMode("production", () => {
    const bare = request({ headers: { host: "app.leadcockpit.com" } });
    assert.strictEqual(
      isCsrfSafe(bare),
      false,
      "real browsers always send one or the other on a state-changing request; production must not " +
        "fall back to allowing headerless writes",
    );
  });
});

// ─── CASE 6 — safe methods ───────────────────────────────────────────────────
test("CASE 6 — reads bypass the gate", () => {
  withAuthMode("production", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const req = request({ method, headers: { host: "app.leadcockpit.com", origin: "https://evil.example" } });
      assert.strictEqual(isCsrfSafe(req), true, `${method} is a safe method and must bypass CSRF`);
    }
  });
});

// ─── RUN ─────────────────────────────────────────────────────────────────────
for (const c of cases) {
  try {
    c.fn();
    passed++;
    console.log(`  ✅ ${c.name}`);
  } catch (e) {
    failed++;
    console.error(`  ❌ ${c.name}`);
    console.error(`     ${(e as Error).message}`);
  }
}
console.log(`\ncsrf-public-host: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
