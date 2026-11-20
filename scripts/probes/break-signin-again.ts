/**
 * Break test (2026-09-26): can a customer who signed up themselves sign in
 * AGAIN after signing out? The sign-in page sends only email + password.
 * Against the production-mode throwaway server ("leadgen-break-prod", 3021).
 * The password is made here and never printed.
 *
 *   npx tsx scripts/probes/break-signin-again.ts
 */
import { randomBytes } from "node:crypto";

const BASE = process.env.BREAK_BASE_URL || "http://localhost:3021";
async function call(path: string, body?: unknown, cookie = "") {
  const res = await fetch(`${BASE}/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  let json: Record<string, unknown> = {};
  try { json = (await res.json()) as Record<string, unknown>; } catch { /* not JSON */ }
  return { status: res.status, json, cookie: (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ") };
}

(async () => {
  const stamp = Date.now();
  const email = `Again.${stamp}@Signin.example`;
  const password = `Fx-${randomBytes(24).toString("base64url")}`;
  const signup = await call("auth/signup", { email, password, name: "Again Owner", businessName: `Again ${stamp}` });
  const me = (await call("auth/status", undefined, signup.cookie)).json.user as { workspaceId?: string } | undefined;
  await call("auth/logout", {}, signup.cookie);
  const checks: Array<[string, boolean, string]> = [];
  checks.push(["sign up", signup.status < 300 && Boolean(me?.workspaceId), `${signup.status}`]);
  const login = await call("auth/login", { email, password });
  const after = (await call("auth/status", undefined, login.cookie)).json.user as { workspaceId?: string } | undefined;
  checks.push(["sign in again after signing out (email + password only)", login.status === 200 && after?.workspaceId === me?.workspaceId, `${login.status} ${JSON.stringify(login.json).slice(0, 120)}`]);
  const lower = await call("auth/login", { email: `  ${email.toLowerCase()} `, password });
  checks.push(["sign in with different capitals and spaces", lower.status === 200, `${lower.status}`]);
  const wrong = await call("auth/login", { email, password: "wrong-password-123" });
  checks.push(["wrong password is refused", wrong.status === 401 || wrong.status === 400, `${wrong.status}`]);
  let failed = 0;
  for (const [label, ok, detail] of checks) { if (!ok) failed++; console.log(`${ok ? "OK  " : "FAIL"} ${label} → ${detail}`); }
  console.log(failed ? `\n${failed} FAILED` : "\nALL OK");
})().catch((error) => { console.error(error); process.exit(1); });

export {};
