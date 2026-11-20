import assert from 'node:assert/strict';
import { changeTicketStatus } from '@/services/TicketService';
import type { Ticket, TicketEvent } from '@/lib/types';
import type { RepositoryBundle } from '@/repositories/interfaces';

// Pure injected repository: never opens or writes the owner's JSON/database.
function fixture(status: Ticket['status'] = 'open') {
  let ticket = { id: 'case', workspaceId: 'isolated-outcome', status } as Ticket;
  const events: Partial<TicketEvent>[] = [];
  let updates = 0;
  const repos = {
    ticket: {
      getById: async () => ticket,
      update: async (_workspace: string, _id: string, patch: Partial<Ticket>) => {
        updates++;
        ticket = { ...ticket, ...patch };
        return ticket;
      },
    },
    ticketEvent: { create: async (event: Partial<TicketEvent>) => { events.push(event); return event; } },
    withWorkspaceTeamTransaction: async (_workspace: string, work: () => Promise<unknown>) => work(),
  } as unknown as RepositoryBundle;
  return { repos, events, ticket: () => ticket, updates: () => updates };
}

async function main() {
  for (const status of ['resolved', 'closed'] as const) {
    for (const note of [undefined, '', ' \n\t ']) {
      const f = fixture();
      await assert.rejects(changeTicketStatus('isolated-outcome', 'case', status, { actorType: 'owner', userId: 'handler', note }, f.repos), /explain|outcome/i);
      assert.equal(f.updates(), 0, 'refused completion must not change stored work');
      assert.equal(f.events.length, 0, 'refused completion must not create success history');
    }
  }
  console.log('PASS missing/empty/whitespace outcomes cannot resolve or close work');

  const resolved = fixture('in_progress');
  await changeTicketStatus('isolated-outcome', 'case', 'resolved', { actorType: 'owner', userId: 'handler', note: '  Checked sample; replacement agreed.  ' }, resolved.repos);
  assert.equal(resolved.ticket().status, 'resolved');
  assert.equal(resolved.events[0].actorUserId, 'handler');
  assert.equal(resolved.events[0].note, 'Checked sample; replacement agreed.');
  console.log('PASS actual outcome and named handler are stored together');

  const closed = fixture();
  await changeTicketStatus('isolated-outcome', 'case', 'closed', { actorType: 'owner', note: 'Customer confirmed no further action.' }, closed.repos);
  assert.equal(closed.ticket().status, 'closed');
  console.log('PASS documented direct open-to-closed transition remains permitted');

  const active = fixture();
  await changeTicketStatus('isolated-outcome', 'case', 'in_progress', { actorType: 'owner' }, active.repos);
  assert.equal(active.ticket().status, 'in_progress');
  console.log('PASS ordinary work transition requires no completion outcome');

  const repeat = fixture('resolved');
  await changeTicketStatus('isolated-outcome', 'case', 'resolved', { actorType: 'owner' }, repeat.repos);
  assert.equal(repeat.events.length, 0);
  console.log('PASS same-status retry does not add duplicate outcome history');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
