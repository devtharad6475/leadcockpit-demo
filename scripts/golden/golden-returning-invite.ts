import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { repositories as repos } from "@/repositories";
import { acceptInvite } from "@/services/InviteService";
import { hashPassword, verifyPassword } from "@/lib/password";

async function setup(suffix: string) {
  const workspaceId = `return-${suffix}`;
  const email = `${suffix}@example.test`;
  const user = await repos.user.create({ workspaceId, name: "Former employee", email, role: "sales_member" });
  const passwordHash = await hashPassword("OldPassword123!");
  await repos.userCredential.create({ userId: user.id, workspaceId, email, passwordHash, sessionVersion: 7 });
  const now = new Date().toISOString();
  const member = await repos.workspaceMember.create({ id: `member-${suffix}`, workspaceId, userId: user.id, email, name: "Former employee", role: "sales_member", status: "invited", createdAt: now, updatedAt: now });
  const rawToken = `synthetic-return-${suffix}`;
  const invite = await repos.invite.create({ workspaceId, email, role: "admin", invitedByUserId: "synthetic-owner",
    tokenHash: createHash("sha256").update(rawToken).digest("hex"), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  return { workspaceId, user, member, invite, rawToken, passwordHash };
}

async function main() {
  process.env.AUTH_SESSION_SECRET = "synthetic-accept-invite-secret-at-least32characters";
  const row = await setup("rollback");
  const originalUpdate = repos.workspaceMember.update.bind(repos.workspaceMember);
  repos.workspaceMember.update = async () => { throw new Error("Injected membership save failure"); };
  try {
    await assert.rejects(() => acceptInvite({ rawToken: row.rawToken, name: "Returned employee", password: "NewPassword123!" }), /Injected membership/);
  } finally { repos.workspaceMember.update = originalUpdate; }
  assert.equal((await repos.userCredential.findByUserId(row.user.id))?.passwordHash, row.passwordHash);
  assert.equal((await repos.userCredential.findByUserId(row.user.id))?.sessionVersion, 7);
  assert.equal((await repos.user.findById(row.user.id))?.role, "sales_member");
  assert.equal((await repos.workspaceMember.findForUser(row.workspaceId, row.user.id))?.status, "invited");
  assert.equal((await repos.invite.findById(row.invite.id))?.status, "pending");
  const accepted = await acceptInvite({ rawToken: row.rawToken, name: "Returned employee", password: "NewPassword123!" });
  assert.equal(accepted.user.id, row.user.id); assert.equal(accepted.user.role, "admin");
  assert.equal((await repos.workspaceMember.findForUser(row.workspaceId, row.user.id))?.status, "active");
  assert.equal((await repos.invite.findById(row.invite.id))?.status, "accepted");
  const credential = await repos.userCredential.findByUserId(row.user.id);
  assert.equal(credential?.sessionVersion, 8);
  assert.equal(await verifyPassword("NewPassword123!", credential!.passwordHash), true);
  const concurrent = await setup("concurrent");
  const results = await Promise.allSettled([1, 2].map(index => acceptInvite({ rawToken: concurrent.rawToken, name: `Employee ${index}`, password: "NewPassword123!" })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.equal((await repos.userCredential.findByUserId(concurrent.user.id))?.sessionVersion, 8);
  console.log("PASS returning invitation: failed reactivation rolls back credential/user/member/token; retry succeeds; concurrent acceptance consumes once; no email sent");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
