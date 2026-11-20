/**
 * Break test, part 4 (2026-09-26): double-submits that only exist in
 * production mode — signing up twice with one email, inviting one person
 * twice, accepting one invite twice. Fired 5 at once each.
 *
 *   PERSISTENCE_PROVIDER=json LEADGEN_DATA_DIR=<the server's data copy> \
 *     npx tsx scripts/probes/break-races-prod.ts
 *
 * Against the "leadgen-break-prod" throwaway server (port 3021). Passwords
 * are made here and never printed; emails use the reserved .example domain.
 */
import { randomBytes } from "node:crypto";

const BASE = process.env.BREAK_BASE_URL || "http://localhost:3021";
const TIMES = 5;
const password = () => `Fx-${randomBytes(24).toString("base64url")}`;
async function call(path: string, init: { method?: string; body?: unknown; cookie?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", origin: BASE };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.ip) headers["x-forwarded-for"] = init.ip;
  const res = await fetch(`${BASE}/api/${path}`, { method: init.method || "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), redirect: "manual" });
  let json: Record<string, unknown> = {};
  try { json = (await res.json()) as Record<string, unknown>; } catch { /* not JSON */ }
  return { status: res.status, json, cookie: (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ") };
}

(async () => {
  const { repositories } = await import("@/repositories");
  const { createInvite } = await import("@/services/InviteService");
  const stamp = Date.now();
  const lines: string[] = [];

  // 1. Five sign-ups with one email at once.
  const email = `race.${stamp}@signup.example`;
  const signups = await Promise.all(Array.from({ length: TIMES }, (_, i) => call("auth/signup", { method: "POST", ip: `10.0.0.${i + 1}`, body: { email, password: password(), name: "Race Owner", businessName: `Race ${stamp} ${i}` } })));
  const ok = signups.filter((s) => s.status < 300);
  const all = async () => (await repositories.readAll!()) as unknown as Record<string, Array<Record<string, unknown>>>;
  const users = (await all()).users?.filter((u) => u.email === email).length;
  lines.push(`${ok.length === 1 ? "OK  " : "FAIL"} same-email sign-up ×${TIMES}: ${ok.length} accepted (answers ${signups.map((s) => s.status).join(", ")})${users !== undefined ? `, ${users} user row(s)` : ""}`);

  // 2. Five invites to one person at once, from the owner who won.
  const winner = ok[0];
  if (winner) {
    const me = (await call("auth/status", { cookie: winner.cookie })).json.user as { id: string; workspaceId: string };
    const invitee = `invitee.${stamp}@signup.example`;
    const invites = await Promise.all(Array.from({ length: TIMES }, () => call("invites", { method: "POST", cookie: winner.cookie, body: { email: invitee, role: "sales_member" } })));
    const pending = (await all()).invites?.filter((i) => i.workspaceId === me.workspaceId && String(i.email ?? i.inviteeEmail) === invitee && i.status === "pending").length;
    lines.push(`${invites.filter((r) => r.status < 300).length === 1 ? "OK  " : "FAIL"} same-person invite ×${TIMES}: answers ${invites.map((r) => r.status).join(", ")}${pending !== undefined ? `, ${pending} pending invite(s)` : ""}`);

    // 3. One invite link accepted five times at once.
    const other = `accept.${stamp}@signup.example`;
    const { rawToken } = await createInvite({ workspaceId: me.workspaceId, invitedByUserId: me.id, inviteeEmail: other, role: "viewer" });
    const accepts = await Promise.all(Array.from({ length: TIMES }, (_, i) => call("auth/invites/accept", { method: "POST", ip: `10.0.1.${i + 1}`, body: { token: rawToken, name: "Race Viewer", password: password() } })));
    const members = (await all()).users?.filter((u) => u.workspaceId === me.workspaceId).length;
    lines.push(`${accepts.filter((r) => r.status < 300).length === 1 ? "OK  " : "FAIL"} one invite accepted ×${TIMES}: answers ${accepts.map((r) => r.status).join(", ")}${members !== undefined ? `, workspace has ${members} member(s)` : ""}`);
  }
  console.log(`Server ${BASE}. Each action fired ${TIMES} times at once.\n`);
  for (const line of lines) console.log(line);
})().catch((error) => { console.error(error); process.exit(1); });

export {};
