// PRISMA_GOLDEN — disposable readiness database only.
import "./_helpers/readiness-prisma-environment";
import { readinessFixtureCleanup } from "./_helpers/readiness-fixture-cleanup";
import assert from 'node:assert/strict';
import {repositories as repos} from '@/repositories';
import {prisma} from '@/lib/prisma';
import {getJob, INTERRUPTED_MESSAGE} from '@/services/OrchestrationService';

const fixtures = readinessFixtureCleanup();
fixtures.attach(repos);
async function main() {
  const workspace = await repos.workspace.create({name: 'Disposable atomic jobs', status: 'active'});
  const stale = await repos.jobRun.create({workspaceId: workspace.id, jobType: 'orchestration', status: 'running',
    payload: {runDeadlineMs: 1000}, startedAt: new Date(Date.now() - 60 * 60_000).toISOString()});
  const original = repos.jobRun.claim.bind(repos.jobRun);
  let seen = 0;
  repos.jobRun.claim = async (...args) => {
    const changed = await original(...args);
    if (changed) {
      const record = await repos.jobRun.getById(args[0], args[1]);
      assert.equal(record?.errorMessage, INTERRUPTED_MESSAGE);
      assert.ok(record?.completedAt);
      seen++;
    }
    return changed;
  };
  await Promise.all([getJob(workspace.id, stale.id, repos), getJob(workspace.id, stale.id, repos)]);
  assert.equal(seen, 1);
  console.log('PASS actual Postgres concurrent terminal settlement exposes explanation immediately');
  const job = await repos.jobRun.create({workspaceId: workspace.id, jobType: 'orchestration', status: 'running', payload: {}});
  const completedAt = new Date().toISOString();
  const result = {text: 'Recorded report.', outcomes: []};
  assert.equal(await original(workspace.id, job.id, 'running', 'completed', {result, completedAt}), true);
  const completed = await repos.jobRun.getById(workspace.id, job.id);
  assert.deepEqual(completed?.result, result); assert.equal(completed?.completedAt, completedAt);
  assert.equal(await original(workspace.id, job.id, 'running', 'failed', {errorMessage: 'wrong overwrite'}), false);
  // PostgreSQL nullable columns read as null; JSON omission reads undefined.
  assert.equal((await repos.jobRun.getById(workspace.id, job.id))?.errorMessage ?? null, null);
  console.log('PASS actual Postgres completion report survives losing conditional writer');
  console.log('2 passed, 0 failed on disposable PostgreSQL');
}
main().catch(error => {console.error(error); process.exitCode = 1;}).finally(async () => { try { await fixtures.cleanup(); } finally { await prisma.$disconnect(); } });
