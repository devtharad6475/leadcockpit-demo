/**
 * Probe setup (2026-09-27): one email with the SAME password in two companies,
 * on the production-mode throwaway server's data copy, for the "which
 * company?" sign-in screen. The password is generated here and written only
 * to the file given as the first argument (a scratch file, never the repo).
 *
 *   PERSISTENCE_PROVIDER=json LEADGEN_DATA_DIR=<data copy> \
 *     npx tsx scripts/probes/seed-two-companies.ts <scratch-file>
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";

(async () => {
  const out = process.argv[2];
  if (!out) throw new Error("Give a scratch file path for the generated sign-in.");
  const { signup } = await import("@/services/SignupService");
  const { createInvite, acceptInvite } = await import("@/services/InviteService");
  const stamp = Date.now();
  const email = `pick.${stamp}@companies.example`;
  const password = `Fx-${randomBytes(18).toString("base64url")}`;
  await signup({ email, password, name: "Pick Owner", businessName: "Shree Zari Works" });
  const boss = await signup({ email: `boss.${stamp}@companies.example`, password: `Fx-${randomBytes(18).toString("base64url")}`, name: "Boss", businessName: "Mehta Lace House" });
  const invite = await createInvite({ workspaceId: boss.user.workspaceId, invitedByUserId: boss.user.id, inviteeEmail: email, role: "sales_member" });
  await acceptInvite({ rawToken: invite.rawToken, name: "Pick Owner", password });
  fs.writeFileSync(out, JSON.stringify({ email, password }));
  console.log(`Seeded ${email} in two companies.`);
})().catch((error) => { console.error(error); process.exit(1); });

export {};
