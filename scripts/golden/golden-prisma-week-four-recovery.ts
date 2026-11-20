// PRISMA_GOLDEN
import "./_helpers/readiness-prisma-environment";
import { readinessFixtureCleanup } from "./_helpers/readiness-fixture-cleanup";
import assert from "node:assert/strict";
import {createRepositories} from "@/repositories";
import {prisma} from "@/lib/prisma";
import {checkWeekFourRestore} from "./_helpers/week-four-restore-contract";
import {spawnSync} from "node:child_process";
import path from "node:path";
import {copyJobToRunAgain, getJob, INTERRUPTED_MESSAGE} from "@/services/OrchestrationService";

const fixtures = readinessFixtureCleanup();
async function main() {
  const repos = createRepositories("prisma");
  fixtures.attach(repos);
  const {workspaceId, original, media} = await checkWeekFourRestore(repos);
  const plan = {summary: "Read facts", subtasks: [{id: "facts", agent: "knowledge-base-agent", instruction: "Read approved facts", dependsOn: []}]};
  const job = await repos.jobRun.create({workspaceId, jobType: "orchestration", status: "awaiting_confirmation", payload: {plan}});
  const child = (mode: string, jobId: string) => spawnSync(process.execPath, [
    path.resolve("node_modules/tsx/dist/cli.mjs"), "scripts/golden/_helpers/week-four-restart-child.ts", mode, workspaceId, jobId, media.id,
  ], {env: process.env, encoding: "utf8", timeout: 30_000, windowsHide: true});
  const interrupted = child("interrupt", job.id);
  assert.equal(interrupted.status, 19, interrupted.stderr);
  assert.equal((await repos.jobRun.getById(workspaceId, job.id))?.status, "running");
  // Advance only the recovery check's clock beyond its saved deadline; no
  // paid work or ten-minute wait is needed to test timeout recovery.
  const recovered = await getJob(workspaceId, job.id, repos, Date.now() + 60 * 60_000);
  assert.equal(recovered.status, "failed"); assert.equal(recovered.errorMessage, INTERRUPTED_MESSAGE);
  const retry = await copyJobToRunAgain(workspaceId, job.id, repos);
  const fresh = child("verify", retry.jobId);
  assert.equal(fresh.status, 0, fresh.stderr); console.log(fresh.stdout.trim());
  console.log("PASS actual process interruption leaves recoverable evidence; retry awaits fresh approval");
  const knowledge = {id: "knowledge_restore_sentinel", workspaceId, questionId: "location", questionText: "Where?", domain: "company", confidence: 1, answer: "Original location", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()};
  await repos.mutateAll!(data => {data.knowledgeEntries ??= []; data.knowledgeEntries.push(knowledge as never);});
  // A late table failure must undo an earlier DELETE in the same reset.
  await assert.rejects(repos.clearWorkspaceCollections!(workspaceId, ["leads", "not_a_table"]), /no Postgres table/);
  assert.ok(await repos.lead.getLeadById(workspaceId, original.id));
  console.log("PASS failed multi-table clear rolls back earlier deletions");
  // Trigger failure AFTER the first snapshot upsert exercises the repository
  // model resolver, not only an explicitly passed transaction client.
  await prisma.$executeRawUnsafe("CREATE FUNCTION readiness_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected snapshot audit failure'; END $$");
  await prisma.$executeRawUnsafe("CREATE TRIGGER readiness_audit_failure BEFORE INSERT OR UPDATE ON knowledge_entries FOR EACH ROW EXECUTE FUNCTION readiness_reject_audit()");
  try {
    await assert.rejects(repos.mutateAll!(data => {
      const entry = data.knowledgeEntries!.find(row => row.id === knowledge.id)!;
      entry.answer = "Wrong partially saved location";
      (data.auditLogs ??= []).push({id: "snapshot_fault", workspaceId, eventType: "test", entityType: "test", createdAt: new Date().toISOString()} as never);
    }), /Injected snapshot audit failure/);
    const saved = await repos.readAll!();
    assert.equal(saved.knowledgeEntries!.find(row => row.id === knowledge.id)?.answer, "Original location");
    assert.equal(saved.auditLogs?.some(row => row.id === "snapshot_fault"), false, "earlier successful audit upsert must roll back");
  } finally {
    await prisma.$executeRawUnsafe("DROP TRIGGER readiness_audit_failure ON knowledge_entries");
    await prisma.$executeRawUnsafe("DROP FUNCTION readiness_reject_audit()");
  }
  console.log("PASS snapshot failure rolls back earlier audit writes");
}
main().catch(error => {console.error(error); process.exitCode = 1;}).finally(async () => { try { await fixtures.cleanup(); } finally { await prisma.$disconnect(); } });
