// PRISMA_GOLDEN: two real server processes, disposable local Postgres only.
import "./_helpers/readiness-prisma-environment";
import { readinessFixtureCleanup } from "./_helpers/readiness-fixture-cleanup";
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { repositories } from '@/repositories';
import { prisma } from '@/lib/prisma';
import { createTicketFromInbound, assignTicketToMember } from '@/services/TicketService';
import { removeTeamMember } from '@/services/TeamService';
import { changeLeadDiscoveryFact } from '@/services/DiscoveryService';


const fixtures = readinessFixtureCleanup();
fixtures.attach(repositories);
async function operation(mode: string, company: string, ticketId: string) {
  if (mode.startsWith('fact-')) await changeLeadDiscoveryFact(company, ticketId, mode === 'fact-supplier' ? 'current_supplier' : 'volume', { action: 'correct', value: mode === 'fact-supplier' ? 'Owner confirmed Surat' : 'Owner confirmed 25 boxes' }, `${company}-owner`, repositories);
  else if (mode === 'assign') await assignTicketToMember(company, ticketId, `${company}-staff`, `${company}-owner`, repositories);
  else await removeTeamMember({ workspaceId: company, actorUserId: `${company}-owner`, memberId: `${company}-staff-member` });
}
function child(mode: string, company: string, ticketId: string, hold: boolean) {
  const process = spawn(globalThis.process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/golden/golden-prisma-employee-race.ts', '--child', mode, company, ticketId, hold ? 'hold' : ''], { env: globalThis.process.env, windowsHide: true });
  let output = '', error = '', signal!: () => void;
  const ready = new Promise<void>(resolve => { signal = resolve; });
  process.stdout.on('data', chunk => { output += chunk.toString(); if (output.includes('LOCK_HELD')) signal(); });
  process.stderr.on('data', chunk => { error += chunk.toString(); });
  const done = new Promise<{ code: number | null; output: string; error: string }>((resolve, reject) => {
    const timeout = setTimeout(() => { process.kill(); reject(new Error('Child proof timed out')); }, 30_000);
    process.on('error', reject);
    process.on('close', code => { clearTimeout(timeout); signal(); resolve({ code, output, error }); });
  });
  return { ready, done };
}
async function main() {
  if (process.argv[2] === '--child') {
    const [, , , mode, company, ticketId, hold] = process.argv;
    const work = async () => {
      if (hold) { console.log('LOCK_HELD'); await new Promise(resolve => setTimeout(resolve, 1200)); }
      await operation(mode, company, ticketId);
    };
    if (hold && mode.startsWith('fact-')) await repositories.withLeadMemoryTransaction!(company, ticketId, work);
    else if (hold) await repositories.withWorkspaceTeamTransaction!(company, work); else await work();
    console.log('OPERATION_SAVED'); return;
  }
  for (const first of ['assign', 'remove']) {
    const company = `employee-race-${first}-${Date.now()}`;
    await prisma.workspace.create({ data: { id: company, name: 'Synthetic concurrency company' } });
    fixtures.track(company);
    for (const [name, role] of [['owner', 'owner'], ['staff', 'sales_member']] as const) {
      const id = `${company}-${name}`;
      await repositories.user.create({ id, workspaceId: company, email: `${id}@example.invalid`, name, role });
      await repositories.userCredential.create({ workspaceId: company, userId: id, email: `${id}@example.invalid`, passwordHash: 'unused-synthetic', sessionVersion: 1 });
      const at = new Date().toISOString();
      await repositories.workspaceMember.create({ id: `${id}-member`, workspaceId: company, userId: id, email: `${id}@example.invalid`, name, role, status: 'active', createdAt: at, updatedAt: at });
    }
    const ticket = await createTicketFromInbound({ workspaceId: company, sourceChannel: 'manual', type: 'question', priority: 'medium', subject: 'Synthetic concurrency enquiry', description: 'Synthetic product specification question' }, repositories);
    const a = child(first, company, ticket.id, true); await a.ready;
    const b = child(first === 'assign' ? 'remove' : 'assign', company, ticket.id, false);
    const [saved, refused] = await Promise.all([a.done, b.done]);
    assert.equal(saved.code, 0, saved.error); assert.equal(refused.code, 1, 'conflicting operation must fail');
    assert.match(refused.error, first === 'assign' ? /unfinished ticket/ : /must be an active team member/i);
    const member = await repositories.workspaceMember.findForUser(company, `${company}-staff`);
    const assigned = (await repositories.ticket.getById(company, ticket.id))?.assignedTo;
    assert.ok(member?.status === 'active' || assigned !== `${company}-staff`, 'Unfinished ticket was orphaned');
    console.log(`PASS separate Postgres processes: ${first} wins; conflicting change refused; responsibility preserved`);
  }
  const company = `memory-race-${Date.now()}`;
  await prisma.workspace.create({ data: { id: company, name: 'Synthetic memory concurrency company' } });
  fixtures.track(company);
  const lead = await repositories.lead.createLead({ workspaceId: company, companyName: 'Synthetic buyer', status: 'replied' });
  const a = child('fact-supplier', company, lead.id, true); await a.ready;
  const b = child('fact-volume', company, lead.id, false);
  for (const result of await Promise.all([a.done, b.done])) assert.equal(result.code, 0, result.error);
  const saved = await repositories.lead.getLeadById(company, lead.id);
  assert.equal(saved?.discoveryState?.current_supplier?.value, 'Owner confirmed Surat');
  assert.equal(saved?.discoveryState?.volume?.value, 'Owner confirmed 25 boxes');
  console.log('PASS separate Postgres processes: simultaneous customer corrections both retained');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { try { await fixtures.cleanup(); } finally { await prisma.$disconnect(); } });
