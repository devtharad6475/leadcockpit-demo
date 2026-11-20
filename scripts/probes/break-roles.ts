/**
 * Break test, part 3 (2026-09-26): people INSIDE one company. A salesperson
 * and a view-only user try what only the owner may do, and try to read the
 * owner's assistant chats.
 *
 * Needs the production-mode throwaway server (launch config
 * "leadgen-break-prod", port 3021). Invite links normally arrive by email;
 * here the invite is made through the product's own InviteService on the
 * SAME data copy, then accepted through the real sign-in endpoint.
 *
 *   PERSISTENCE_PROVIDER=json LEADGEN_DATA_DIR=<the server's data copy> \
 *     npx tsx scripts/probes/break-roles.ts
 *
 * Throwaway passwords are made here, never printed. Emails use the reserved
 * .example domain, so nothing can reach a real person.
 */
import { randomBytes } from "node:crypto";

const BASE = process.env.BREAK_BASE_URL || "http://localhost:3021";
type Jar = { cookie: string };
const password = () => `Fx-${randomBytes(24).toString("base64url")}`;

async function call(path: string, init: { method?: string; body?: unknown; jar?: Jar } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", origin: BASE };
  if (init.jar?.cookie) headers.cookie = init.jar.cookie;
  const res = await fetch(`${BASE}/api/${path}`, { method: init.method || "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), redirect: "manual" });
  let json: Record<string, unknown> = {};
  try { json = (await res.json()) as Record<string, unknown>; } catch { /* not JSON */ }
  return { status: res.status, json, setCookie: res.headers.getSetCookie?.() ?? [] };
}
const jarFrom = (setCookie: string[]): Jar => ({ cookie: setCookie.map((c) => c.split(";")[0]).join("; ") });

let failures = 0;
function expectBlocked(label: string, status: number) {
  const ok = status === 401 || status === 403 || status === 404;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label} → ${status}`);
}
function expectAllowed(label: string, status: number) {
  const ok = status >= 200 && status < 300;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label} → ${status}`);
}

(async () => {
  const { createInvite } = await import("@/services/InviteService");
  const stamp = Date.now();
  const signup = await call("auth/signup", { method: "POST", body: { email: `owner.${stamp}@roles.example`, password: password(), name: "Roles Owner", businessName: `Roles Test ${stamp}` } });
  if (signup.status >= 300) throw new Error(`signup failed: ${signup.status} ${JSON.stringify(signup.json)}`);
  const owner = jarFrom(signup.setCookie);
  const me = (await call("auth/status", { jar: owner })).json.user as { id: string; workspaceId: string };
  console.log(`Server ${BASE}, workspace ${me.workspaceId}\n`);

  const member = async (role: "sales_member" | "viewer" | "admin") => {
    const { rawToken } = await createInvite({ workspaceId: me.workspaceId, invitedByUserId: me.id, inviteeEmail: `${role}.${stamp}@roles.example`, role });
    const accepted = await call("auth/invites/accept", { method: "POST", body: { token: rawToken, name: `Roles ${role}`, password: password() } });
    if (accepted.status >= 300) throw new Error(`accept ${role} failed: ${accepted.status} ${JSON.stringify(accepted.json)}`);
    return jarFrom(accepted.setCookie);
  };
  const sales = await member("sales_member");
  const viewer = await member("viewer");
  const admin = await member("admin");

  // The owner's assistant chat, with one message in it.
  const convo = await call("copilot/conversations", { method: "POST", jar: owner, body: {} });
  const convoId = String(convo.json.id);
  await call("copilot/message", { method: "POST", jar: owner, body: { conversationId: convoId, text: "Our biggest buyer is late on payment again." } });
  expectAllowed("owner reads their own chat", (await call(`copilot/conversations/${convoId}/messages`, { jar: owner })).status);

  console.log("\n--- the owner's private assistant chat ---");
  for (const [who, jar] of [["admin", admin], ["salesperson", sales], ["viewer", viewer]] as const) {
    expectBlocked(`${who} reads the owner's chat messages`, (await call(`copilot/conversations/${convoId}/messages`, { jar })).status);
    expectBlocked(`${who} opens the owner's chat`, (await call(`copilot/conversations?id=${convoId}`, { jar })).status);
    expectBlocked(`${who} writes into the owner's chat`, (await call("copilot/message", { method: "POST", jar, body: { conversationId: convoId, text: "hello" } })).status);
    const listed = await call("copilot/conversations?list=1", { jar });
    const leaked = Array.isArray(listed.json) && (listed.json as unknown as Array<{ id: string }>).some((c) => c.id === convoId);
    if (leaked) failures++;
    console.log(`  ${leaked ? "FAIL" : "PASS"}  ${who}'s chat list does not show the owner's chat`);
  }

  console.log("\n--- owner-only actions ---");
  for (const [who, jar] of [["salesperson", sales], ["viewer", viewer]] as const) {
    expectBlocked(`${who} changes AI settings`, (await call("ai/settings", { method: "PUT", jar, body: {} })).status);
    expectBlocked(`${who} reads AI settings`, (await call("ai/settings", { jar })).status);
    expectBlocked(`${who} exports all company data`, (await call("data/export", { jar })).status);
    expectBlocked(`${who} changes sales settings`, (await call("settings/sales", { method: "PUT", jar, body: { defaultMOQ: "1 kg" } })).status);
    expectBlocked(`${who} invites someone`, (await call("invites", { method: "POST", jar, body: { email: `x.${stamp}@roles.example`, role: "admin" } })).status);
    expectBlocked(`${who} approves a customer message`, (await call("messages/none/approve", { method: "POST", jar, body: {} })).status);
  }
  expectBlocked("viewer adds a lead", (await call("leads/manual", { method: "POST", jar: viewer, body: { companyName: "Viewer lead" } })).status);
  expectAllowed("salesperson adds a lead", (await call("leads/manual", { method: "POST", jar: sales, body: { companyName: `Sales lead ${stamp}`, email: `buyer.${stamp}@roles.example` } })).status);
  const ownerInvite = (await call("invites", { method: "POST", jar: admin, body: { email: `o.${stamp}@roles.example`, role: "owner" } })).status;
  if (ownerInvite < 400) failures++;
  console.log(`  ${ownerInvite >= 400 ? "PASS" : "FAIL"}  admin cannot invite a second owner → ${ownerInvite}`);

  console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"}`);
  if (failures) process.exit(1);
})().catch((error) => { console.error(error); process.exit(1); });

export {};
