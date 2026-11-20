import '../../scripts/golden/_helpers/no-platform-ai-keys';
import path from 'node:path';
import { hashPassword } from '@/lib/password';
import { E2E_DATA_DIR, assertE2EDataDirIsIsolated } from './data-dir';

const a = 'week_four_company_a', b = 'week_four_company_b';
const password = 'Disposable-week-four-password!';
async function main() {
  const fixtureDir = path.resolve(process.env.LEADGEN_DATA_DIR || E2E_DATA_DIR);
  assertE2EDataDirIsIsolated(fixtureDir);
  const relative = path.relative(E2E_DATA_DIR, fixtureDir);
  if ((relative === '..' || relative.startsWith(`..${path.sep}`)) || path.isAbsolute(relative)) throw new Error('Fixture seeder requires the isolated E2E namespace');
  process.env.LEADGEN_DATA_DIR = fixtureDir;
  process.env.PERSISTENCE_PROVIDER = 'json';
  process.env.DATABASE_URL = '';
  for (const key of ['RESEND_API_KEY', 'WHATSAPP_CLOUD_ACCESS_TOKEN', 'WHATSAPP_ACCESS_TOKEN', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']) process.env[key] = '';
  const { mutateData } = await import('@/lib/db');
  if (process.argv.includes('--invalidate-b-owner')) {
    await mutateData(data => {
      const credential = data.userCredentials?.find(row => row.userId === `${b}_owner`);
      if (!credential) throw new Error('Owned fixture credential missing');
      credential.sessionVersion = 2;
    });
    return;
  }
  const passwordHash = await hashPassword(password);
  await mutateData(data => {
    const now = new Date().toISOString();
    // Playwright starts a fresh worker after a failure and reruns beforeAll.
    // Replace only these owned synthetic fixtures, rather than duplicating their
    // login rows and accidentally creating a multi-company chooser on restart.
    const workspaceIds = new Set([a, b]);
    const userIds = new Set([`${a}_owner`, `${a}_viewer`, `${b}_owner`]);
    data.workspaces = data.workspaces.filter(row => !workspaceIds.has(row.id));
    data.users = data.users.filter(row => !userIds.has(row.id));
    data.userCredentials = (data.userCredentials ?? []).filter(row => !userIds.has(row.userId));
    data.workspaceMembers = (data.workspaceMembers ?? []).filter(row => row.userId == null || !userIds.has(row.userId));
    data.leads = data.leads.filter(row => row.id !== "week_four_lead_a" && row.id !== "week_four_lead_b");
    data.platformAdmins = (data.platformAdmins ?? []).filter(row => row.id !== "week_four_operator");
    data.platformAdminCredentials = (data.platformAdminCredentials ?? []).filter(row => row.adminId !== "week_four_operator");
    for (const workspaceId of [a, b]) data.workspaces.push({...data.workspaces[0], id: workspaceId, name: workspaceId, ownerUserId: `${workspaceId}_owner`});
    for (const [workspaceId, role] of [[a, "owner"], [a, "viewer"], [b, "owner"]] as const) {
      const id = `${workspaceId}_${role}`, email = `${id}@example.invalid`;
      data.users.push({id, workspaceId, name: role, email, role, createdAt: now, updatedAt: now});
      (data.userCredentials ??= []).push({id: `${id}_cred`, workspaceId, userId: id, email, passwordHash: passwordHash, sessionVersion: 1, createdAt: now, updatedAt: now});
      (data.workspaceMembers ??= []).push({id: `${id}_member`, workspaceId, userId: id, name: role, email, role, status: "active", createdAt: now, updatedAt: now});
    }
    data.leads.push({...data.leads[0], id: "week_four_lead_a", workspaceId: a, companyName: "Company A Private Buyer"});
    data.leads.push({...data.leads[1], id: "week_four_lead_b", workspaceId: b, companyName: "Company B Private Buyer"});
    (data.platformAdmins ??= []).push({id: "week_four_operator", email: "week_four_operator@example.invalid", name: "Test operator", role: "operator", status: "active", createdAt: now, updatedAt: now});
    (data.platformAdminCredentials ??= []).push({id: "week_four_operator_credential", adminId: "week_four_operator", email: "week_four_operator@example.invalid", passwordHash: passwordHash, sessionVersion: 1, createdAt: now, updatedAt: now});
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
