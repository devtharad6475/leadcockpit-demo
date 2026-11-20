/**
 * golden-platform-admin-csrf.ts — pins the CSRF gate on /admin/* POST routes
 * (Stage 5 re-audit, F-P1-6).
 *
 * WHAT THIS PROVES
 *   Before this fix, `handlePlatformAdminPost` ran WITHOUT calling
 *   `isCsrfSafe`. The workspace-side `enforceAuthGate` (which contains the CSRF
 *   check) was deliberately bypassed for `/admin/*` because those routes use a
 *   DIFFERENT session (the platform-admin cookie, not the workspace cookie).
 *   But bypassing the auth gate also bypassed CSRF — so a malicious site could
 *   forge a cross-site POST to `/admin/users/block` or
 *   `/admin/workspaces/:id/suspend` and, if the operator was logged in, the
 *   action would execute. That is a CSRF backdoor on the highest-privilege
 *   surface in the system (build-right Angle Bank A7 "CSRF / Cross-Site Check").
 *
 *   The fix: add an `isCsrfSafe(request)` check at the top of
 *   `handlePlatformAdminPost`, returning 403 CSRF_REJECTED on a forged
 *   cross-site request, BEFORE any platform-admin action runs. The auth check
 *   (platform-admin session per-route) was already present; CSRF was the gap.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat):
 *
 *   CASE A — the chokepoint itself behaves correctly (defends against the
 *            classic cross-site Origin attack). We construct real NextRequest
 *            objects with crafted headers:
 *              1. POST with matching Origin → allowed (true).
 *              2. POST with mismatched Origin (evil.com) → blocked (false).
 *              3. GET request → always allowed (safe method).
 *              4. POST with same-host Referer, no Origin → allowed (fallback).
 *              5. POST with cross-host Referer → blocked.
 *            The mode-dependent cases (no Origin AND no Referer, which demo
 *            allows and production refuses) belong to golden-csrf-public-host.ts,
 *            which forces AUTH_MODE; this file must not depend on the mode the
 *            machine happens to be in.
 *
 *   CASE B — the route is WIRED to the chokepoint. We read the route file
 *            source and assert `isCsrfSafe` is imported AND called inside
 *            `handlePlatformAdminPost` BEFORE the first `requirePlatformAdmin`
 *            call. This catches the dead-chokepoint anti-pattern (function
 *            exists but is never invoked). A future agent who removes the call
 *            fails this case instantly.
 *
 * NOTE: A full CSRF attack requires a real browser. CASE A proves the gate
 * logic is honest; CASE B proves the route invokes it. Together they pin the
 * contract as strongly as a unit test can without spinning up a server.
 *
 * Run: npx tsx scripts/golden/golden-platform-admin-csrf.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isCsrfSafe } from "@/lib/csrf";
import { NextRequest } from "next/server";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

/**
 * Build a real NextRequest against localhost:3000 with given headers.
 *
 * THE `host` HEADER IS LOAD-BEARING (2026-08-26, session 40). Every real HTTP
 * request carries one — HTTP/1.1 requires it and HTTP/2's `:authority` is
 * mapped onto it — but `new NextRequest(url, { headers })` synthesises no
 * headers whatsoever. A request built without it is not a request any server
 * has ever received.
 *
 * That stopped being harmless the day `isCsrfSafe` correctly stopped deriving
 * the expected host from `request.nextUrl` (the P0 pinned by
 * golden-csrf-public-host.ts: nextUrl is the server's BIND address, not the
 * domain the browser typed). From then on a header-less request had ZERO
 * expected hosts, so the gate refused it — the two `true` assertions below
 * correctly went red, and, far worse, every `false` assertion below was
 * passing for the wrong reason.
 *
 * Supplying the header makes these requests realistic. It does not loosen a
 * single assertion; it is what lets the refusals mean something. Callers may
 * still override `host` — the spread is deliberately last.
 */
function makeRequest(method: string, headers: Record<string, string> = {}): NextRequest {
  const url = "http://localhost:3000/api/admin/users/block";
  return new NextRequest(url, { method, headers: { host: "localhost:3000", ...headers } });
}

// ─── CASE A: the isCsrfSafe chokepoint is honest ────────────────────────────
test("CASE A — isCsrfSafe chokepoint: same-origin OK, cross-site BLOCKED, safe-method bypass", async () => {
  // 1. POST with matching Origin → allowed.
  const sameOrigin = makeRequest("POST", { origin: "http://localhost:3000" });
  assert.strictEqual(isCsrfSafe(sameOrigin), true, "same-origin POST must be allowed");

  // 2. POST with mismatched Origin (the classic CSRF attack) → blocked.
  //    This is the LOAD-BEARING assertion: it is mode-independent (Origin
  //    mismatch is rejected in BOTH demo and production).
  const crossSite = makeRequest("POST", { origin: "https://evil.example.com" });
  assert.strictEqual(isCsrfSafe(crossSite), false, "cross-site POST must be BLOCKED (the CSRF hole)");

  // 3. GET → always allowed (safe method).
  const getReq = makeRequest("GET", {});
  assert.strictEqual(isCsrfSafe(getReq), true, "safe methods bypass CSRF");

  // 4. POST with same-host Referer (no Origin header) → allowed (fallback path).
  const refererOk = makeRequest("POST", { referer: "http://localhost:3000/admin" });
  assert.strictEqual(isCsrfSafe(refererOk), true, "same-host Referer must be allowed (Origin-header fallback)");

  // 5. POST with cross-host Referer → blocked.
  const refererBad = makeRequest("POST", { referer: "https://attacker.example.com/x" });
  assert.strictEqual(isCsrfSafe(refererBad), false, "cross-host Referer must be BLOCKED");

  // ── ANTI-VACUITY ──────────────────────────────────────────────────────────
  // A gate that refused EVERYTHING would satisfy both `false` assertions above
  // while proving nothing at all, and that is precisely the state this file sat
  // in until the Host header was supplied. Restating the property as counts
  // says out loud that the three `true` assertions are load-bearing, so a
  // future edit cannot quietly drop them and leave behind a test that only ever
  // proves the gate can say no.
  const allowedCount = [sameOrigin, getReq, refererOk].filter((r) => isCsrfSafe(r)).length;
  const blockedCount = [crossSite, refererBad].filter((r) => !isCsrfSafe(r)).length;
  assert.strictEqual(
    allowedCount,
    3,
    "TARGET CHECK: the gate is refusing legitimate requests, so the refusals it does perform " +
      "prove nothing. Suspect a request missing the Host header every real request carries.",
  );
  assert.strictEqual(blockedCount, 2, "both forgeries must be refused");
});

// ─── CASE B: the route is WIRED to call isCsrfSafe in handlePlatformAdminPost ─
test("CASE B — handlePlatformAdminPost imports + calls isCsrfSafe BEFORE the first requirePlatformAdmin", async () => {
  const routePath = path.resolve(process.cwd(), "src/app/api/[[...path]]/route.ts");
  const src = readFileSync(routePath, "utf8");

  // Extract the handlePlatformAdminPost function body (from its definition to
  // the next top-level `async function`).
  const fnStart = src.indexOf("async function handlePlatformAdminPost");
  assert.ok(fnStart > 0, "handlePlatformAdminPost must exist in the catch-all route");
  const nextFn = src.indexOf("async function", fnStart + 10);
  const fnBody = src.slice(fnStart, nextFn > 0 ? nextFn : undefined);

  // 1. isCsrfSafe is called inside the function body.
  assert.match(fnBody, /isCsrfSafe\s*\(/, "handlePlatformAdminPost MUST call isCsrfSafe (F-P1-6 wiring)");

  // 2. The CSRF check comes BEFORE the first requirePlatformAdmin call (so a
  //    forged request is rejected before any privileged logic runs).
  const csrfIdx = fnBody.indexOf("isCsrfSafe(");
  const firstRequireIdx = fnBody.indexOf("requirePlatformAdmin(");
  assert.ok(csrfIdx > 0 && firstRequireIdx > 0, "both isCsrfSafe and requirePlatformAdmin must be present");
  assert.ok(
    csrfIdx < firstRequireIdx,
    `isCsrfSafe check (offset ${csrfIdx}) must come BEFORE the first requirePlatformAdmin call (offset ${firstRequireIdx}) — CSRF is rejected before privileged logic runs`,
  );

  // 3. The CSRF-rejection path returns the documented 403 CSRF_REJECTED shape.
  assert.match(fnBody, /CSRF_REJECTED/, "the CSRF rejection must return the documented CSRF_REJECTED error code");
});

// ─── Runner ─────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("❌ golden-platform-admin-csrf FAILED — F-P1-6 not closed.");
    process.exit(1);
  }
  console.log("✅ golden-platform-admin-csrf ALL GREEN ✅");
  process.exit(0);
})();
