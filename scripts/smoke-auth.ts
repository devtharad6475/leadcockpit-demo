/**
 * smoke-auth.ts — Phase 1.1 acceptance test
 *
 * Proves that in production mode:
 *   1. Anonymous GET to data endpoints → 401 UNAUTHENTICATED
 *   2. Public routes (auth/status, health) → 200 without a session
 *   3. Authenticated GET (valid session) → 200
 *
 * Run: AUTH_MODE=production AUTH_SESSION_SECRET=<32+ chars> npx tsx scripts/smoke-auth.ts
 * (Requires the dev server running on localhost:3000)
 */
const BASE = "http://localhost:3000";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function getStatus(path: string, cookie?: string): Promise<number> {
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = cookie;
  const res = await fetch(`${BASE}${path}`, { headers });
  return res.status;
}

async function main() {
  // Detect the server's auth mode via the public status endpoint rather than
  // process.env (the smoke runs in a separate process that may not load .env).
  const statusRes = await fetch(`${BASE}/api/auth/status`);
  const statusJson = await statusRes.json() as { authMode?: string };
  const mode = statusJson.authMode;
  assert(mode === "production", `smoke-auth requires the server to run in production mode (server reports authMode=${mode}). Start the dev server with AUTH_MODE=production first.`);

  console.log("smoke-auth: testing GET auth gating in production mode...\n");

  // --- 1. Public routes (no session) → 200 ---
  console.log("  [1] Public routes without session...");
  const statusHealth = await getStatus("/api/health");
  assert(statusHealth === 200, `GET /api/health should be 200 (public), got ${statusHealth}`);
  console.log("    OK GET /api/health -> 200");

  const statusAuthStatus = await getStatus("/api/auth/status");
  assert(statusAuthStatus === 200, `GET /api/auth/status should be 200 (public), got ${statusAuthStatus}`);
  console.log("    OK GET /api/auth/status -> 200");

  // --- 2. Data routes anonymous → 401 ---
  console.log("  [2] Data routes anonymous -> 401...");
  const dataRoutes = [
    "/api/state", "/api/leads", "/api/replies", "/api/icp",
    "/api/campaigns", "/api/knowledge/documents", "/api/ai/settings",
    "/api/health/deep", "/api/data/export",
  ];
  for (const route of dataRoutes) {
    const status = await getStatus(route);
    assert(status === 401, `GET ${route} should be 401 anonymous, got ${status}`);
    console.log(`    OK GET ${route} -> 401`);
  }

  // --- 3. Bootstrap + login + authenticated GET → 200 ---
  console.log("  [3] Bootstrap owner + login + authenticated GET -> 200...");
  const bootstrap = await fetch(`${BASE}/api/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "auth-smoke@test.com", password: "SecurePass123", name: "Auth Smoke" }),
  });
  assert(bootstrap.status === 200 || bootstrap.status === 409, `bootstrap should succeed or exist, got ${bootstrap.status}`);

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "auth-smoke@test.com", password: "SecurePass123" }),
  });
  assert(login.status === 200, `login should return 200, got ${login.status}`);
  const setCookie = login.headers.get("set-cookie");
  assert(setCookie && setCookie.includes("lc_session="), "login should set lc_session cookie");
  const cookieMatch = setCookie!.match(/lc_session=([^;]+)/);
  assert(cookieMatch, "could not parse session cookie");
  const cookie = `lc_session=${cookieMatch![1]}`;
  console.log("    OK login -> 200 + session cookie set");

  // Authenticated GET should now work
  const authedState = await getStatus("/api/state", cookie);
  assert(authedState === 200, `authenticated GET /api/state should be 200, got ${authedState}`);
  console.log("    OK authenticated GET /api/state -> 200");

  const authedLeads = await getStatus("/api/leads", cookie);
  assert(authedLeads === 200, `authenticated GET /api/leads should be 200, got ${authedLeads}`);
  console.log("    OK authenticated GET /api/leads -> 200");

  // --- 4. Anonymous POST mutation → 401 ---
  console.log("  [4] POST mutation anonymous -> 401/403...");
  const anonPost = await fetch(`${BASE}/api/leads/manual`, {
    method: "POST",
    headers: { "content-type": "application/json", "origin": "http://localhost:3000" },
    body: "{}",
  });
  assert(anonPost.status === 401 || anonPost.status === 403, `anonymous POST should be 401/403, got ${anonPost.status}`);
  console.log(`    OK anonymous POST /api/leads/manual -> ${anonPost.status}`);

  console.log("\nsmoke-auth: ALL CHECKS PASSED");
}

main().catch((error) => {
  console.error("\nsmoke-auth FAILED:", error.message);
  process.exit(1);
});
