import assert from "node:assert/strict";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { ensureWorkspaces } from "./fixtures";
import { restoreWorkspaceAtomically } from "@/services/WorkspaceRestoreService";
import { saveMediaCatalogItem, readMediaCatalogFile } from "@/services/MediaCatalogService";
import { runJob } from "@/services/OrchestrationService";

export async function checkWeekFourRestore(repos: RepositoryBundle) {
  const workspaceId = `week_four_${Date.now()}`;
  const other = `${workspaceId}_other`;
  await ensureWorkspaces(repos, [workspaceId, other]);
  const original = await repos.lead.createLead({workspaceId, companyName: "Original customer"});
  const foreign = await repos.lead.createLead({workspaceId: other, companyName: "Other company's customer"});
  const rows = {leads: [{...original, companyName: "Restored customer"}]};
  const restore = () => restoreWorkspaceAtomically(repos, workspaceId, rows, ["leads"]);
  const writer = repos.lead.createLead.bind(repos.lead);
  repos.lead.createLead = async () => {throw new Error("Injected restore failure after clear");};
  await assert.rejects(restore(), /previous data was kept/);
  repos.lead.createLead = writer;
  assert.equal((await repos.lead.getLeadById(workspaceId, original.id))?.companyName, "Original customer");
  assert.equal((await repos.lead.getLeadById(other, foreign.id))?.companyName, "Other company's customer");
  console.log("PASS restore failure after clear rolls back and preserves both companies");
  await assert.rejects(restoreWorkspaceAtomically(repos, workspaceId, {leads: [{...foreign, workspaceId}]}, ["leads"]), /another company/);
  await assert.rejects(restoreWorkspaceAtomically(repos, workspaceId, {leads: [{...original}, {...original}]}, ["leads"]), /repeated/);
  await assert.rejects(restoreWorkspaceAtomically(repos, workspaceId, {interactions: [{id: "unsupported"}]}, ["leads"]), /cannot be restored/);
  assert.equal((await repos.lead.getLeadById(workspaceId, original.id))?.companyName, "Original customer");
  console.log("PASS foreign identifiers, duplicate records and unsupported sections refuse without erasure");
  await assert.rejects(restoreWorkspaceAtomically(repos, workspaceId,
    {quotes: [{id: "forged_quote", workspaceId, leadId: foreign.id}]}, ["leads", "quotes"]), /does not belong/);
  await assert.rejects(restoreWorkspaceAtomically(repos, workspaceId,
    {quotes: [{id: "dangling_quote", workspaceId, leadId: original.id}]}, ["leads", "quotes"]), /does not belong/);
  assert.equal((await repos.lead.getLeadById(workspaceId, original.id))?.companyName, "Original customer");
  console.log("PASS foreign and soon-to-be-cleared customer links refuse before erasure");
  const result = await restore();
  assert.equal(result.result.restored.leads, 1);
  assert.equal((await repos.lead.getLeadById(workspaceId, original.id))?.companyName, "Restored customer");
  console.log("PASS valid restore retains exact customer identity and values");
  const bytes = Buffer.from("Durable catalogue bytes", "utf8");
  await assert.rejects(saveMediaCatalogItem({workspaceId, fileName: "foreign.txt", fileType: "text/plain", buffer: bytes, leadId: foreign.id}, repos), /not available/);
  const media = await saveMediaCatalogItem({workspaceId, fileName: "catalogue.txt", fileType: "text/plain", buffer: bytes, leadId: ` ${original.id} `}, repos);
  assert.equal(media.leadId, original.id);
  await restoreWorkspaceAtomically(repos, workspaceId, {mediaCatalogItems: [{...media}]}, ["mediaCatalogItems"]);
  assert.deepEqual((await readMediaCatalogFile(workspaceId, media.id, repos))?.bytes, bytes);
  assert.equal(await readMediaCatalogFile(other, media.id, repos), undefined);
  await assert.rejects(restoreWorkspaceAtomically(repos, workspaceId, {mediaCatalogItems: [{...media, id: "missing_upload"}]}, ["mediaCatalogItems"]), /uploaded files/);
  assert.deepEqual((await readMediaCatalogFile(workspaceId, media.id, repos))?.bytes, bytes);
  console.log("PASS upload/customer links stay scoped; metadata restore preserves bytes and refuses missing files");
  const plan = {summary: "Read facts", subtasks: [{id: "facts", agent: "knowledge-base-agent", instruction: "Read approved facts", dependsOn: []}]};
  const job = await repos.jobRun.create({workspaceId, jobType: "orchestration", status: "awaiting_confirmation", payload: {plan}});
  const claim = repos.jobRun.claim.bind(repos.jobRun);
  repos.jobRun.claim = async (...args) => {
    const won = await claim(...args);
    if (won && args[3] === "running") {
      const record = await repos.jobRun.getById(workspaceId, job.id);
      assert.ok(record?.startedAt, "first running state must already include its start evidence");
      assert.equal(record.payload?.runDeadlineMs, 1000);
    }
    return won;
  };
  await runJob({workspaceId, jobId: job.id, repos, deadlineMs: 1000, seams: {
    checkBudget: async () => ({allowed: true}),
    runChild: async () => ({answer: "Approved facts", steps: [], stoppedBy: "model", llmCalls: 1}),
    merger: async () => "Approved facts",
  }});
  repos.jobRun.claim = claim;
  assert.equal((await repos.jobRun.getById(workspaceId, job.id))?.status, "completed");
  console.log("PASS the job claim stores start evidence and deadline atomically");
  return {workspaceId, other, original, foreign, media, bytes};
}
