/**
 * golden-auth-break.ts — what the 2026-09-26 break test found in sign-up,
 * sign-in and saved credentials, pinned so it cannot come back.
 *
 *   A — someone who signed up (their own new workspace) can sign in again from
 *       the sign-in page, which sends only email + password. Before, login
 *       always looked in the demo workspace and said "Incorrect email or
 *       password" for every self-serve owner and invited member elsewhere.
 *       One email in two workspaces: the password decides which one.
 *   B — emails are trimmed and lower-cased at the door: the login rate limit
 *       key cannot be dodged with "Owner@x.com" / "owner@x.com ", and a phone
 *       keyboard's trailing space no longer fails sign-up or invite.
 *   C — the sign-in lockout says how long to wait, not "Daily limit reached …
 *       increase your limit".
 *   D — after the server's encryption key changes, the WhatsApp and SerpApi
 *       views still load (showing "not connected"), and pasting a NEW WhatsApp
 *       token saves. The send path still refuses loudly.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-auth-break.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { signup } from "@/services/SignupService";
import { createInvite, acceptInvite } from "@/services/InviteService";
import { loginWithPassword } from "@/lib/auth-service";
import { defaultWorkspaceId } from "@/lib/db";
import { loginSchema, signupSchema, createInviteSchema } from "@/validation/schemas";
import { checkRateLimitMemory, resetMemoryBackend } from "@/services/rate-limit/memoryBackend";
import { WhatsAppCredentialService } from "@/services/WhatsAppCredentialService";
import { IntegrationCredentialService } from "@/services/IntegrationCredentialService";

const repos = createJsonRepos() as RepositoryBundle;
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);
const RUN = Date.now().toString(36);

test("A — a self-serve owner and an invited member can sign in from the sign-in page", async () => {
  const email = `owner_${RUN}@example.com`;
  const owner = await signup({ email, password: "OwnerPass123!", name: "Owner", businessName: "Break Co" });
  assert.notEqual(owner.user.workspaceId, defaultWorkspaceId);
  // Exactly what POST /auth/login passes when the page sends {email, password}.
  const again = await loginWithPassword(defaultWorkspaceId, email, "OwnerPass123!");
  assert.equal(again.ok, true, "a signed-up owner must be able to sign in again");
  if (again.ok) assert.equal(again.user.workspaceId, owner.user.workspaceId);
  const wrong = await loginWithPassword(defaultWorkspaceId, email, "WrongPass123!");
  assert.equal(wrong.ok, false, "a wrong password is still refused");

  // Invited member of that workspace.
  const memberEmail = `member_${RUN}@example.com`;
  const inv = await createInvite({ workspaceId: owner.user.workspaceId, invitedByUserId: owner.user.id, inviteeEmail: memberEmail, role: "sales_member" });
  await acceptInvite({ rawToken: inv.rawToken, name: "Member", password: "MemberPass123!" });
  const member = await loginWithPassword(defaultWorkspaceId, memberEmail, "MemberPass123!");
  assert.equal(member.ok, true, "an invited member must be able to sign in");
  if (member.ok) assert.equal(member.user.role, "sales_member");

  // Same email in a second workspace with a different password: the password picks.
  const other = await signup({ email: `other_${RUN}@example.com`, password: "OtherPass123!", name: "O" });
  const inv2 = await createInvite({ workspaceId: other.user.workspaceId, invitedByUserId: other.user.id, inviteeEmail: email, role: "viewer" });
  await acceptInvite({ rawToken: inv2.rawToken, name: "Owner as viewer", password: "ViewerPass123!" });
  const asViewer = await loginWithPassword(defaultWorkspaceId, email, "ViewerPass123!");
  assert.equal(asViewer.ok && asViewer.user.workspaceId, other.user.workspaceId);
  const asOwner = await loginWithPassword(defaultWorkspaceId, email, "OwnerPass123!");
  assert.equal(asOwner.ok && asOwner.user.workspaceId, owner.user.workspaceId);
});

test("B — emails are trimmed and lower-cased before the rate limit and sign-up", async () => {
  const a = loginSchema.parse({ email: "Owner@X.com", password: "x" }).email;
  const b = loginSchema.parse({ email: " owner@x.com ", password: "x" }).email;
  assert.equal(a, b, "case/space variants must share one login rate-limit key");
  const s = signupSchema.safeParse({ email: "New@Example.com ", password: "GoodPass123!", name: "N" });
  assert.equal(s.success, true, "a trailing space must not fail sign-up");
  if (s.success) assert.equal(s.data.email, "new@example.com");
  assert.equal(createInviteSchema.safeParse({ email: " Team@Example.com", role: "viewer" }).success, true);
});

test("C — the sign-in lockout says how long to wait", async () => {
  resetMemoryBackend();
  let last;
  for (let i = 0; i < 6; i++) last = checkRateLimitMemory({ workspaceId: "w", userId: "u@example.com", action: "login" });
  assert.equal(last?.allowed, false);
  assert.doesNotMatch(last?.reason || "", /daily|increase your limit/i);
  assert.match(last?.reason || "", /wait 10 minutes/);
  resetMemoryBackend();
});

test("D — a changed encryption key does not lock the owner out of re-entering credentials", async () => {
  const ws = `workspace_authbreak_${RUN}`;
  const wa = new WhatsAppCredentialService(repos);
  const serp = new IntegrationCredentialService(repos);
  const before = process.env.ENCRYPTION_KEY;
  try {
    await wa.save(ws, { accessToken: "EAAoldtoken123456", phoneNumberId: "111" });
    await serp.save(ws, "serpapi", "serp_old_key_123456");
    process.env.ENCRYPTION_KEY = `rotated-key-${RUN}-0123456789`;
    const view = await wa.getView(ws);
    assert.equal(view.hasCredentials, false, "an unreadable token shows as not connected");
    assert.equal((await serp.getView(ws, "serpapi")).hasKey, false);
    await assert.rejects(() => wa.getForProvider(ws), "the send path must still refuse loudly");
    await wa.save(ws, { accessToken: "EAAnewtoken999999", phoneNumberId: "111" });
    assert.equal((await wa.getForProvider(ws))?.accessToken, "EAAnewtoken999999");
    await serp.save(ws, "serpapi", "serp_new_key_999999");
    assert.equal(await serp.resolveKey(ws, "serpapi"), "serp_new_key_999999");
    // Key changes again; a blank token cannot carry an unreadable one forward —
    // the owner is asked for the token in plain words.
    process.env.ENCRYPTION_KEY = `rotated-again-${RUN}-0123456789`;
    await assert.rejects(() => wa.save(ws, { accessToken: "", phoneNumberId: "111" }), /access token and phone number ID are both required/);
  } finally {
    if (before === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = before;
  }
});

test("F — one email with the same password in two companies is asked which company (CEO, 2026-09-27)", async () => {
  const email = `both_${RUN}@example.com`;
  const first = await signup({ email, password: "SamePass123!", name: "Both", businessName: "First Zari Co" });
  const second = await signup({ email: `boss_${RUN}@example.com`, password: "BossPass123!", name: "Boss", businessName: "Second Lace Co" });
  const inv = await createInvite({ workspaceId: second.user.workspaceId, invitedByUserId: second.user.id, inviteeEmail: email, role: "sales_member" });
  await acceptInvite({ rawToken: inv.rawToken, name: "Both", password: "SamePass123!" });
  const asked = await loginWithPassword(defaultWorkspaceId, email, "SamePass123!");
  assert.equal(asked.ok, false, "signed in without asking which company");
  const choices = !asked.ok ? asked.choices ?? [] : [];
  assert.deepEqual(choices.map((c) => c.workspaceId).sort(), [first.user.workspaceId, second.user.workspaceId].sort());
  assert.ok(choices.every((c) => c.name && !c.name.startsWith("workspace_")), "a choice showed an internal id instead of the company name");
  const picked = await loginWithPassword(defaultWorkspaceId, email, "SamePass123!", { chosenWorkspaceId: second.user.workspaceId });
  assert.equal(picked.ok && picked.user.workspaceId, second.user.workspaceId, "the chosen company was not the one signed in to");
  const wrong = await loginWithPassword(defaultWorkspaceId, email, "WrongPass123!");
  assert.equal(!wrong.ok && wrong.choices, undefined, "a wrong password revealed which companies the email belongs to");
});

test("E — a password may contain spaces but not be only spaces (CEO, 2026-09-27)", async () => {
  // Check the concrete error exported by the same module as hashPassword.
  // Node 20/tsx's mixed module graphs otherwise duplicate the base class.
  const { hashPassword, PasswordError } = await import("@/lib/password");
  await assert.rejects(() => hashPassword("          "), (error: unknown) => {
    assert.ok(error instanceof PasswordError);
    assert.equal(error.statusCode, 400, "bad input must not become a server error");
    assert.equal(error.message, "A password can't be only spaces.");
    return true;
  }, "an all-spaces password was hashed");
  assert.ok((await hashPassword("my zari password")).startsWith("scrypt:"), "a password with spaces inside was refused");
  const bad = signupSchema.safeParse({ email: "a@b.example", password: "        ", name: "A", businessName: "B" });
  assert.equal(bad.success, false, "sign-up accepted an all-spaces password");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n  ${(e as Error).message}`); }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
