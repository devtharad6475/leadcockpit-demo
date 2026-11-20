/**
 * golden-team-and-sign-in-safety.ts — the multi-company safety findings S2,
 * S3, S4, S6, S7, S8, S9 from docs/REVIEW-2026-09-27.md §4, plus self-service
 * forgot / change password. Rules: docs/LOGIC.md 2026-09-28.
 *
 *   A  (S3) an owner removes a team member: that person's open session stops
 *      working on the next request, they cannot sign in, and it is audited.
 *   B  (S3) a role change takes effect at once, and the role comes from the
 *      membership row — editing the user record cannot raise anyone.
 *   C  (S3) the guards: sales members cannot change the team; admins cannot
 *      touch owners or make owners; nobody changes themselves.
 *   D  (S3) a removed person invited back gets their old account back.
 *   E  (S4) "Sign out" / "Sign out everywhere" kill a copied cookie; so does
 *      the operator console's sign-out.
 *   F  (S9) /auth/me and /auth/status treat a revoked session as signed out.
 *   G  forgot password: the same answer for a known and an unknown email,
 *      only a known email gets a link, asking does not sign anyone out, the
 *      link sets a password and ends every session; change password needs the
 *      current password and keeps this device signed in.
 *   H  (S7) sign-up answers the same whether or not the email is taken, signs
 *      nobody in, and tells the real owner by email.
 *   I  (S8) sign-in uses one lookup and the same number of password checks
 *      whether an email is in 0, 1 or 2 companies.
 *   J  (S2) the tour refuses (and ends) sessions on a company that holds a
 *      real sign-in or a saved key; a new owner is not put in the demo company.
 *   K  (S6) AI provider keys are sealed with the company's own key; old rows
 *      still read.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-team-and-sign-in-safety.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { repositories } from "@/repositories";
import { signup } from "@/services/SignupService";
import { createInvite, acceptInvite } from "@/services/InviteService";
import { removeTeamMember, changeTeamMemberRole } from "@/services/TeamService";
import {
  loginWithPassword, resolveCurrentUser, resolveUserFromSession, startTourSession, workspaceForNewOwner,
  TOUR_USER_ID, LOGIN_PASSWORD_CHECKS,
} from "@/lib/auth-service";
import { createSessionToken, SESSION_COOKIE } from "@/lib/session";
import { defaultWorkspaceId } from "@/lib/db";
import { hashPassword, passwordChecksPerformed } from "@/lib/password";
import { clearMockOutbox, getMockOutbox } from "@/providers/email";
import { resetMemoryBackend } from "@/services/rate-limit/memoryBackend";

process.env.AUTH_SESSION_SECRET ||= `golden-only-session-secret-${"x".repeat(32)}`;
process.env.AUTH_MODE = "production";
process.env.ENCRYPTION_KEY ||= `golden-only-encryption-key-${"y".repeat(16)}`;
process.env.NEXT_PUBLIC_APP_ORIGIN = "http://localhost:3000";

const RUN = Date.now().toString(36);
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);
const pw = (tag: string) => `Pass-${tag}-${RUN}!`;

function req(token?: string, path = "/api/state", init: { method?: string; body?: unknown } = {}): NextRequest {
  const headers = new Headers({ origin: "http://localhost:3000", "content-type": "application/json" });
  if (token) headers.set("cookie", `${SESSION_COOKIE}=${token}`);
  return new NextRequest(`http://localhost:3000${path}`, { method: init.method || "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}
async function signedIn(token: string) {
  try { return await resolveCurrentUser(req(token)); } catch { return null; }
}
async function login(email: string, password: string) {
  const r = await loginWithPassword(defaultWorkspaceId, email, password);
  if (!r.ok) throw new Error(`sign-in failed for ${email}: ${r.reason}`);
  return r;
}
async function route(verb: "GET" | "POST", segments: string[], token?: string, body?: unknown) {
  const mod = await import("@/app/api/[[...path]]/route");
  const handler = verb === "GET" ? mod.GET : mod.POST;
  const response = await handler(req(token, `/api/${segments.join("/")}`, { method: verb, body }), { params: Promise.resolve({ path: segments }) });
  const text = await response.text();
  return { status: response.status, body: text, setCookie: response.headers.get("set-cookie") || "" };
}

/** A company with an owner, and invited people who accepted. */
async function company(tag: string, people: Array<{ key: string; role: "admin" | "sales_member" | "viewer" }>) {
  const ownerEmail = `owner_${tag}_${RUN}@example.com`;
  const owner = await signup({ email: ownerEmail, password: pw("owner"), name: `Owner ${tag}`, businessName: `Co ${tag} ${RUN}` });
  const ws = owner.user.workspaceId;
  const out: Record<string, { id: string; email: string; memberId: string }> = { owner: { id: owner.user.id, email: ownerEmail, memberId: "" } };
  for (const p of people) {
    const email = `${p.key}_${tag}_${RUN}@example.com`;
    const inv = await createInvite({ workspaceId: ws, invitedByUserId: owner.user.id, inviteeEmail: email, role: p.role });
    const acc = await acceptInvite({ rawToken: inv.rawToken, name: p.key, password: pw(p.key) });
    out[p.key] = { id: acc.user.id, email, memberId: "" };
  }
  for (const m of await repositories.workspaceMember.listByWorkspace(ws)) {
    for (const v of Object.values(out)) if (m.userId === v.id) v.memberId = m.id;
  }
  return { ws, people: out };
}

test("A (S3) — removing a member ends their session now, blocks sign-in, and is audited", async () => {
  const { ws, people } = await company("a", [{ key: "sam", role: "sales_member" }]);
  const session = (await login(people.sam.email, pw("sam"))).token;
  assert.equal((await signedIn(session))?.role, "sales_member");
  const versionBefore = (await repositories.userCredential.findByUserId(people.sam.id))?.sessionVersion ?? 1;
  await removeTeamMember({ workspaceId: ws, actorUserId: people.owner.id, memberId: people.sam.memberId });
  assert.equal(await signedIn(session), null, "a removed member's open session still worked");
  const versionAfter = (await repositories.userCredential.findByUserId(people.sam.id))?.sessionVersion ?? 1;
  assert.ok(versionAfter > versionBefore, "removal did not end the person's sessions (belt and braces with the membership check)");
  const again = await loginWithPassword(defaultWorkspaceId, people.sam.email, pw("sam"));
  assert.equal(again.ok, false, "a removed member could still sign in");
  if (!again.ok) assert.match(again.reason, /no longer have access/);
  // Even a freshly minted cookie with the right version is refused: membership decides.
  const cred = await repositories.userCredential.findByUserId(people.sam.id);
  assert.equal(await signedIn(createSessionToken({ userId: people.sam.id, workspaceId: ws, role: "sales_member", sessionVersion: cred?.sessionVersion })), null, "access was decided by the user record, not the membership");
  const audit = await repositories.auditLog.listByWorkspace(ws);
  assert.ok(audit.some((a) => a.eventType === "team.member_removed" && a.entityId === people.sam.memberId), "removal was not audited");
});

test("B (S3) — a role change applies at once and the role comes from the membership", async () => {
  const { ws, people } = await company("b", [{ key: "sue", role: "sales_member" }]);
  const before = (await login(people.sue.email, pw("sue"))).token;
  await changeTeamMemberRole({ workspaceId: ws, actorUserId: people.owner.id, memberId: people.sue.memberId, role: "viewer" });
  assert.equal(await signedIn(before), null, "the old session kept its old role");
  const after = (await login(people.sue.email, pw("sue"))).token;
  assert.equal((await signedIn(after))?.role, "viewer");
  await repositories.user.update(people.sue.id, { role: "owner" });
  assert.equal((await signedIn(after))?.role, "viewer", "editing the user record raised the role");
  const audit = await repositories.auditLog.listByWorkspace(ws);
  assert.ok(audit.some((a) => a.eventType === "team.role_changed" && (a.payload as { toRole?: string }).toRole === "viewer"));
});

test("C (S3) — who may change the team", async () => {
  const { ws, people } = await company("c", [{ key: "ada", role: "admin" }, { key: "sid", role: "sales_member" }, { key: "val", role: "viewer" }]);
  const ownerMemberId = (await repositories.workspaceMember.findForUser(ws, people.owner.id))!.id;
  await assert.rejects(() => changeTeamMemberRole({ workspaceId: ws, actorUserId: people.sid.id, memberId: people.val.memberId, role: "admin" }), /owner or admin/, "a sales member changed a role");
  await assert.rejects(() => removeTeamMember({ workspaceId: ws, actorUserId: people.ada.id, memberId: ownerMemberId }), /Only an owner/, "an admin removed the owner");
  await assert.rejects(() => changeTeamMemberRole({ workspaceId: ws, actorUserId: people.ada.id, memberId: ownerMemberId, role: "viewer" }), /Only an owner/, "an admin demoted the owner");
  await assert.rejects(() => changeTeamMemberRole({ workspaceId: ws, actorUserId: people.ada.id, memberId: people.sid.memberId, role: "owner" }), /Only an owner can make/, "an admin made an owner");
  await assert.rejects(() => changeTeamMemberRole({ workspaceId: ws, actorUserId: people.ada.id, memberId: people.ada.memberId, role: "owner" }), /own access/, "an admin raised themselves");
  await assert.rejects(() => removeTeamMember({ workspaceId: ws, actorUserId: people.owner.id, memberId: ownerMemberId }), /own access/, "the owner removed themselves");
  // Allowed: an admin moves a sales member to viewer; the owner makes the admin an owner.
  await changeTeamMemberRole({ workspaceId: ws, actorUserId: people.ada.id, memberId: people.sid.memberId, role: "viewer" });
  await changeTeamMemberRole({ workspaceId: ws, actorUserId: people.owner.id, memberId: people.ada.memberId, role: "owner" });
  // Two owners now: one may demote the other, but never leave zero.
  await changeTeamMemberRole({ workspaceId: ws, actorUserId: people.ada.id, memberId: ownerMemberId, role: "admin" });
  const owners = (await repositories.workspaceMember.listActiveByWorkspace(ws)).filter((m) => m.role === "owner");
  assert.equal(owners.length, 1, "the company must keep exactly the one remaining owner");
});

test("D (S3) — a removed person invited back gets their account back", async () => {
  const { ws, people } = await company("d", [{ key: "rob", role: "sales_member" }]);
  await removeTeamMember({ workspaceId: ws, actorUserId: people.owner.id, memberId: people.rob.memberId });
  const inv = await createInvite({ workspaceId: ws, invitedByUserId: people.owner.id, inviteeEmail: people.rob.email, role: "viewer" });
  const back = await acceptInvite({ rawToken: inv.rawToken, name: "Rob", password: pw("rob2") });
  assert.equal(back.user.id, people.rob.id, "a returning member got a second account");
  const s = (await login(people.rob.email, pw("rob2"))).token;
  assert.equal((await signedIn(s))?.role, "viewer");
});

test("E (S4) — sign-out kills a copied cookie; so does the operator sign-out", async () => {
  const { people } = await company("e", []);
  const laptop = (await login(people.owner.email, pw("owner"))).token;
  const copied = laptop;
  const out = await route("POST", ["auth", "logout"], laptop, {});
  assert.equal(out.status, 200);
  assert.equal(await signedIn(copied), null, "a copied cookie still worked after sign-out");
  const phone = (await login(people.owner.email, pw("owner"))).token;
  const tablet = (await login(people.owner.email, pw("owner"))).token;
  const everywhere = await route("POST", ["auth", "logout-everywhere"], phone, {});
  assert.equal(everywhere.status, 200, everywhere.body);
  assert.equal(await signedIn(tablet), null, "sign out everywhere left another device signed in");

  const { bootstrapPlatformAdmin, loginPlatformAdmin, resolveCurrentPlatformAdmin, PLATFORM_ADMIN_COOKIE } = await import("@/services/PlatformAdminAuthService");
  const adminEmail = `op_${RUN}@example.com`;
  await bootstrapPlatformAdmin({ email: adminEmail, password: pw("op") });
  const adminLogin = await loginPlatformAdmin(adminEmail, pw("op"));
  assert.ok(adminLogin.ok);
  const adminToken = adminLogin.ok ? adminLogin.token : "";
  const adminReq = () => new NextRequest("http://localhost:3000/api/admin/x", { headers: { cookie: `${PLATFORM_ADMIN_COOKIE}=${adminToken}` } });
  assert.ok(await resolveCurrentPlatformAdmin(adminReq()));
  const mod = await import("@/app/api/[[...path]]/route");
  await mod.POST(new NextRequest("http://localhost:3000/api/admin/auth/logout", { method: "POST", headers: { cookie: `${PLATFORM_ADMIN_COOKIE}=${adminToken}`, origin: "http://localhost:3000" } }), { params: Promise.resolve({ path: ["admin", "auth", "logout"] }) });
  assert.equal(await resolveCurrentPlatformAdmin(adminReq()), null, "a copied operator cookie still worked after sign-out");
});

test("F (S9) — /auth/me and /auth/status see a revoked session as signed out", async () => {
  const { ws, people } = await company("f", [{ key: "mia", role: "sales_member" }]);
  const token = (await login(people.mia.email, pw("mia"))).token;
  assert.equal((await route("GET", ["auth", "me"], token)).status, 200);
  await removeTeamMember({ workspaceId: ws, actorUserId: people.owner.id, memberId: people.mia.memberId });
  const me = await route("GET", ["auth", "me"], token);
  assert.equal(me.status, 401, "/auth/me still answered for a removed member");
  const status = await route("GET", ["auth", "status"], token);
  assert.equal(JSON.parse(status.body).authenticated, false, "/auth/status still said signed in");
  assert.equal(await resolveUserFromSession(token), null);
  // Suspended company too.
  const ownerToken = (await login(people.owner.email, pw("owner"))).token;
  await repositories.workspace.update(ws, { status: "suspended" });
  assert.equal(JSON.parse((await route("GET", ["auth", "status"], ownerToken)).body).authenticated, false, "/auth/status said signed in for a suspended company");
  await repositories.workspace.update(ws, { status: "active" });
});

test("G — forgot password and change password", async () => {
  resetMemoryBackend();
  const { people } = await company("g", []);
  const email = people.owner.email;
  const open = (await login(email, pw("owner"))).token;
  clearMockOutbox();
  const unknown = await route("POST", ["auth", "forgot-password"], undefined, { email: `nobody_${RUN}@example.com` });
  const known = await route("POST", ["auth", "forgot-password"], undefined, { email });
  assert.equal(unknown.status, known.status);
  assert.equal(unknown.body, known.body, "the answer tells a stranger whether the email has an account");
  const { requestPasswordReset } = await import("@/services/AccountSecurityService");
  assert.equal((await requestPasswordReset(`nobody_${RUN}@example.com`)).linksSent, 0);
  await new Promise((r) => setTimeout(r, 50));
  clearMockOutbox();
  const sent = await requestPasswordReset(email);
  assert.equal(sent.linksSent, 0, "mock records must never count as real email acceptance");
  assert.equal(sent.emailSent, false, "mock outbox is not a sent email");
  // The newest email: the route above also sent one in the background, and
  // only the newest link works.
  const mail = [...getMockOutbox()].reverse().find((m) => m.to === email);
  assert.ok(mail, "no reset email was sent");
  assert.ok(await signedIn(open), "merely asking for a link signed the person out");
  const token = decodeURIComponent(/token=([^"&]+)/.exec(mail!.html)![1]);
  const redeemed = await route("POST", ["auth", "reset-password"], undefined, { token, password: pw("new") });
  assert.equal(redeemed.status, 200, redeemed.body);
  assert.equal(await signedIn(open), null, "setting a new password left old sessions alive");
  const fresh = (await login(email, pw("new"))).token;
  // Change password.
  const wrong = await route("POST", ["auth", "change-password"], fresh, { currentPassword: "not-it-123", newPassword: pw("newer") });
  assert.equal(wrong.status, 400);
  assert.doesNotMatch(wrong.body, /\{\s*"[a-z]+Error/, "raw error shape");
  const other = (await login(email, pw("new"))).token;
  const changed = await route("POST", ["auth", "change-password"], fresh, { currentPassword: pw("new"), newPassword: pw("newer") });
  assert.equal(changed.status, 200, changed.body);
  assert.equal(await signedIn(other), null, "changing the password left another device signed in");
  const cookie = /lc_session=([^;]+)/.exec(changed.setCookie)?.[1];
  assert.ok(cookie && (await signedIn(cookie)), "this device was not kept signed in");
  resetMemoryBackend();
});

test("H (S7) — sign-up does not reveal taken emails", async () => {
  resetMemoryBackend();
  const { people } = await company("h", []);
  clearMockOutbox();
  const fresh = await route("POST", ["auth", "signup"], undefined, { email: `newco_${RUN}@example.com`, password: pw("x"), name: "N", businessName: "New Co" });
  const taken = await route("POST", ["auth", "signup"], undefined, { email: people.owner.email, password: pw("y"), name: "N", businessName: "Other Co" });
  assert.equal(fresh.status, taken.status);
  assert.equal(fresh.body, taken.body, "sign-up answered differently for a taken email");
  assert.doesNotMatch(fresh.setCookie + taken.setCookie, /lc_session=[^;]+\./, "sign-up signed someone in");
  assert.ok(getMockOutbox().some((m) => m.to === people.owner.email && /tried/i.test(m.subject)), "the real owner was not told");
  assert.ok((await loginWithPassword(defaultWorkspaceId, `newco_${RUN}@example.com`, pw("x"))).ok, "the new owner cannot sign in with the password they chose");
  resetMemoryBackend();
});

test("I (S8) — sign-in does the same work for 0, 1 or 2 companies", async () => {
  const one = await company("i1", []);
  const two = await company("i2", []);
  const inv = await createInvite({ workspaceId: two.ws, invitedByUserId: two.people.owner.id, inviteeEmail: one.people.owner.email, role: "viewer" });
  await acceptInvite({ rawToken: inv.rawToken, name: "x", password: pw("other") });
  const count = async (email: string) => { const b = passwordChecksPerformed(); await loginWithPassword(defaultWorkspaceId, email, "wrong-password-1"); return passwordChecksPerformed() - b; };
  const none = await count(`nobody_i_${RUN}@example.com`);
  const single = await count(two.people.owner.email);
  const double = await count(one.people.owner.email);
  assert.equal(none, LOGIN_PASSWORD_CHECKS);
  assert.deepEqual([single, double], [none, none], "the number of password checks reveals how many companies an email is in");
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/lib/auth-service.ts", "utf8");
  const body = src.slice(src.indexOf("export async function loginWithPassword"), src.indexOf("export function workspaceForNewOwner"));
  assert.doesNotMatch(body, /workspace\.listAll\(true\)[\s\S]*findCredentialByEmail|findCredentialsInOtherWorkspaces/, "sign-in still looks the email up once per company");
});

test("J (S2) — the tour never shows a company in real use; new owners get their own company", async () => {
  const now = new Date().toISOString();
  const { setFeatureFlag } = await import("@/services/FeatureFlagService");
  void setFeatureFlag;
  if (!(await repositories.auth.findUserById(defaultWorkspaceId, TOUR_USER_ID))) {
    await repositories.user.create({ id: TOUR_USER_ID, workspaceId: defaultWorkspaceId, name: "Demo Explorer", email: `tour_${RUN}@example.com`, role: "viewer", createdAt: now, updatedAt: now });
    await repositories.userCredential.create({ userId: TOUR_USER_ID, workspaceId: defaultWorkspaceId, email: `tour_${RUN}@example.com`, passwordHash: await hashPassword(`tour-${RUN}-unused`), sessionVersion: 1 });
  }
  const ok = await startTourSession();
  assert.equal(ok.ok, true, `a clean demo company should tour: ${!ok.ok ? ok.reason : ""}`);
  const tourToken = ok.ok ? ok.token : "";
  assert.equal((await signedIn(tourToken))?.role, "viewer");
  // A saved AI key in the tour company closes the tour.
  const key = await repositories.llmProviderCredential.create(defaultWorkspaceId, { provider: "openai", displayName: "k", encryptedApiKey: "aes-gcm-v1:00:00:00", status: "connected", config: {} });
  const refusedKey = await startTourSession();
  assert.equal(refusedKey.ok, false, "the tour showed a company with a saved key");
  if (!refusedKey.ok) assert.match(refusedKey.reason, /real business/);
  await repositories.llmProviderCredential.delete(defaultWorkspaceId, key.id);
  assert.equal((await startTourSession()).ok, true);
  // A real person who can sign in closes the tour and ends open tour sessions.
  const realId = `user_real_${RUN}`;
  await repositories.user.create({ id: realId, workspaceId: defaultWorkspaceId, name: "Real Owner", email: `real_${RUN}@example.com`, role: "owner", createdAt: now, updatedAt: now });
  await repositories.userCredential.create({ userId: realId, workspaceId: defaultWorkspaceId, email: `real_${RUN}@example.com`, passwordHash: await hashPassword(pw("real")), sessionVersion: 1 });
  assert.equal((await startTourSession()).ok, false, "the tour showed a company a real owner signs in to");
  assert.equal(await signedIn(tourToken), null, "an open tour session kept showing a company now in real use");
  // A new owner lands in a new company, never the demo one.
  assert.notEqual(workspaceForNewOwner(), defaultWorkspaceId);
  assert.notEqual(workspaceForNewOwner(""), defaultWorkspaceId);
  assert.equal(workspaceForNewOwner("ws_named"), "ws_named");
  const { readFileSync } = await import("node:fs");
  assert.doesNotMatch(readFileSync("scripts/bootstrap-owner.ts", "utf8"), /args\["workspace-id"\]\s*\|\|\s*defaultWorkspaceId/, "the owner set-up script still defaults to the demo company");
});

test("K (S6) — AI keys are sealed with the company's own key; old rows still read", async () => {
  const { updateModelSlots } = await import("@/services/AISettingsService");
  const { encryptSecret, decryptSecret } = await import("@/lib/credential-security");
  const ws = `ws_s6_${RUN}`;
  await updateModelSlots(ws, [{ slotId: "daily_workhorse", provider: "openai", modelName: "gpt-4o-mini", apiKey: "sk-test-golden-0000000001" }], repositories as never);
  const rows = await repositories.llmProviderCredential.listByWorkspace(ws);
  const row = rows.find((r) => r.encryptedApiKey);
  assert.ok(row, "the key was not saved");
  assert.ok(row!.encryptedApiKey!.startsWith("aes-gcm-ws:"), "the AI key was sealed with the shared master key");
  assert.equal(decryptSecret(row!.encryptedApiKey, ws), "sk-test-golden-0000000001");
  assert.throws(() => decryptSecret(row!.encryptedApiKey, `other_${RUN}`), "another company's key opened it");
  const legacy = encryptSecret("sk-legacy-000000000002");
  assert.equal(decryptSecret(legacy, ws), "sk-legacy-000000000002", "an older row stopped reading");
  const { readFileSync } = await import("node:fs");
  for (const f of ["src/llm/LLMService.ts", "src/llm/ModelDiscoveryService.ts"]) {
    assert.match(readFileSync(f, "utf8"), /decryptSecret\(credential\?\.encryptedApiKey, credential\?\.workspaceId\)/, `${f} cannot read per-company keys`);
  }
});

test("L (S3) — the team routes: a sales member is refused, the owner's change works", async () => {
  const { ws, people } = await company("l", [{ key: "tom", role: "sales_member" }, { key: "vic", role: "viewer" }]);
  const tom = (await login(people.tom.email, pw("tom"))).token;
  const refused = await route("POST", ["team", "members", people.vic.memberId, "role"], tom, { role: "admin" });
  assert.equal(refused.status, 403, refused.body);
  const owner = (await login(people.owner.email, pw("owner"))).token;
  const changed = await route("POST", ["team", "members", people.vic.memberId, "role"], owner, { role: "sales_member" });
  assert.equal(changed.status, 200, changed.body);
  const removed = await route("POST", ["team", "members", people.tom.memberId, "remove"], owner, {});
  assert.equal(removed.status, 200, removed.body);
  assert.equal(await signedIn(tom), null);
  const self = await route("POST", ["team", "members", (await repositories.workspaceMember.findForUser(ws, people.owner.id))!.id, "remove"], owner, {});
  assert.equal(self.status, 400);
  assert.match(JSON.parse(self.body).error.message, /own access/, "the refusal was not in plain words");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n  ${(e as Error).stack?.split("\n").slice(0, 3).join("\n  ")}`); }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
