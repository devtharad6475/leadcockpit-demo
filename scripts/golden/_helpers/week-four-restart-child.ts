import "./readiness-prisma-environment";
import assert from "node:assert/strict";
import {createRepositories} from "@/repositories";
import {prisma} from "@/lib/prisma";
import {runJob} from "@/services/OrchestrationService";
import {readMediaCatalogFile} from "@/services/MediaCatalogService";

async function main() {
  const [mode, workspaceId, jobId, mediaId] = process.argv.slice(2);
  const repos = createRepositories("prisma");
  if (mode === "interrupt") {
    await runJob({workspaceId, jobId, repos, deadlineMs: 1000, seams: {
      checkBudget: async () => ({allowed: true}),
      // Exit with a committed running record, without a terminal write.
      runChild: async () => process.exit(19),
      merger: async () => {throw new Error("Must not merge interrupted work");},
    }});
    throw new Error("The interruption seam was not reached");
  }
  assert.equal((await repos.jobRun.getById(workspaceId, jobId))?.status, "awaiting_confirmation");
  assert.equal((await repos.jobRun.getById(workspaceId, jobId))?.startedAt ?? undefined, undefined);
  assert.equal((await readMediaCatalogFile(workspaceId, mediaId, repos))?.bytes.toString(), "Durable catalogue bytes");
  console.log("PASS fresh process reads the unexecuted retry and exact upload bytes");
}
main().catch(error => {console.error(error); process.exitCode = 1;}).finally(() => prisma.$disconnect());
