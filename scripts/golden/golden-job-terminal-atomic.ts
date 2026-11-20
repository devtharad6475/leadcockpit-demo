import './_helpers/isolate-standalone';
import assert from 'node:assert/strict';
import {createJsonRepos} from './_helpers/provider';
import {copyJobToRunAgain, getJob, INTERRUPTED_MESSAGE, runJob} from '@/services/OrchestrationService';
import type {RepositoryBundle} from '@/repositories/interfaces';

async function main() {
  const repos = createJsonRepos() as RepositoryBundle;
  const workspaceId = `atomic_job_${Date.now()}`;
  const plan = {summary: 'Read facts', subtasks: [{id: 't1', agent: 'knowledge-base-agent', instruction: 'Read facts', dependsOn: []}]};
  const stale = await repos.jobRun.create({workspaceId, jobType: 'orchestration', status: 'running',
    payload: {plan, runDeadlineMs: 1000}, startedAt: new Date(Date.now() - 60 * 60_000).toISOString()});
  const originalClaim = repos.jobRun.claim.bind(repos.jobRun);
  const seen: string[] = [];
  // Read immediately after the conditional write, before the service can do a
  // second update: exactly where the concurrent browser GET observed no reason.
  repos.jobRun.claim = async (...args) => {
    const claimed = await originalClaim(...args);
    if (claimed && ['failed', 'completed', 'partial'].includes(args[3])) {
      const record = await repos.jobRun.getById(args[0], args[1]);
      assert.ok(record?.completedAt, 'terminal state must include completion evidence in its first visible write');
      if (args[1] === stale.id) assert.equal(record?.errorMessage, INTERRUPTED_MESSAGE);
      else assert.ok(record?.result?.text, 'finished state must include report in its first visible write');
      seen.push(args[3]);
    }
    return claimed;
  };
  await Promise.all([getJob(workspaceId, stale.id, repos), getJob(workspaceId, stale.id, repos)]);
  assert.deepEqual(seen, ['failed']);
  console.log('PASS concurrent stale reads never expose failed without its explanation');
  const job = await repos.jobRun.create({workspaceId, jobType: 'orchestration', status: 'awaiting_confirmation', payload: {plan, goal: 'Read facts'}});
  await runJob({workspaceId, jobId: job.id, repos, seams: {
    checkBudget: async () => ({allowed: true}),
    runChild: async () => ({answer: 'Approved facts read.', steps: [], stoppedBy: 'model', llmCalls: 1}),
    merger: async () => 'Approved facts read.',
  }});
  assert.deepEqual(seen, ['failed', 'completed']);
  console.log('PASS completed status and report are visible atomically');
  assert.equal(await originalClaim(workspaceId, job.id, 'running', 'failed', {errorMessage: 'wrong overwrite'}), false);
  assert.equal((await repos.jobRun.getById(workspaceId, job.id))?.errorMessage, undefined);
  console.log('PASS losing conditional writer cannot replace completed evidence');
  const conversation = await repos.ownerCopilotConversation.create({workspaceId, ownerUserId: 'fixture_owner'});
  const interrupted = await repos.jobRun.create({workspaceId, jobType: 'orchestration', status: 'failed', payload: {plan, goal: 'Read facts', conversationId: conversation.id}, errorMessage: INTERRUPTED_MESSAGE});
  const retry = await copyJobToRunAgain(workspaceId, interrupted.id, repos);
  const proposal = (await repos.ownerCopilotMessage.listByConversation(workspaceId, conversation.id)).find(m => m.pendingAction?.entityId === retry.jobId);
  assert.equal(proposal?.kind, 'copilot_confirm'); assert.equal(proposal?.tier, 'T3');
  assert.equal(proposal?.pendingAction?.intent, 'orchestrated_job');
  assert.equal((await repos.jobRun.getById(workspaceId, retry.jobId))?.status, 'awaiting_confirmation');
  assert.equal((await repos.jobRun.getById(workspaceId, interrupted.id))?.errorMessage, INTERRUPTED_MESSAGE);
  console.log('PASS retry persists a fresh chat proposal without executing or replacing the original evidence');
  const broken = await repos.jobRun.create({workspaceId, jobType: 'orchestration', status: 'failed', payload: {plan, conversationId: 'nonexistent_parent'}});
  const count = (await repos.jobRun.listByWorkspace(workspaceId)).length;
  await assert.rejects(() => copyJobToRunAgain(workspaceId, broken.id, repos), /conversation is no longer available/);
  assert.equal((await repos.jobRun.listByWorkspace(workspaceId)).length, count);
  const standalone = await copyJobToRunAgain(workspaceId, job.id, repos);
  assert.equal(standalone.status, 'awaiting_confirmation');
  assert.equal((await repos.ownerCopilotMessage.listByConversation(workspaceId, conversation.id)).length, 1);
  console.log('PASS absent chat parents fail before copying; standalone jobs do not invent a chat');
  console.log('5 passed, 0 failed');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
