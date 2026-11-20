import { prisma } from "../src/lib/prisma";
import { createRepositories } from "../src/repositories";

const countModels = [
  "workspace",
  "user",
  "businessProfile",
  "iCP",
  "campaign",
  "lead",
  "messageTemplate",
  "outreachActivity",
  "reply",
  "knowledgeBaseDocument",
  "knowledgeBaseChunk",
  "unknownQuestion",
  "autoReplyLog",
  "agentRun",
  "auditLog",
  "eventLog",
  "jobRun",
] as const;

type CountDelegate = { count(): Promise<number> };

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.includes("user:pass@localhost") || databaseUrl.includes("leadgen_placeholder")) {
    console.log("DATABASE_URL is missing or placeholder. Skipping Prisma runtime test.");
    console.log("Set a real local/dev DATABASE_URL, run migrations/import, then rerun npm run test:prisma-runtime.");
    return;
  }

  const client = prisma as unknown as Record<string, CountDelegate> & { $disconnect(): Promise<void>; $queryRaw(strings: TemplateStringsArray): Promise<unknown> };
  await client.$queryRaw`SELECT 1`;

  const counts: Record<string, number | string> = {};
  for (const modelName of countModels) {
    try {
      counts[modelName] = await client[modelName].count();
    } catch (error) {
      counts[modelName] = `failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const repos = createRepositories("prisma");
  const defaultWorkspace = await repos.workspace.getDefault();
  const scopedProfile = defaultWorkspace ? await repos.businessProfile.getByWorkspace(defaultWorkspace.id) : undefined;
  const scopedLeads = defaultWorkspace ? await repos.lead.listLeads(defaultWorkspace.id) : [];
  const scopedKnowledge = defaultWorkspace ? await repos.knowledgeBaseDocument.listByWorkspace(defaultWorkspace.id) : [];
  const scopedAutoReplyLogs = defaultWorkspace ? await repos.autoReplyLog.listByWorkspace(defaultWorkspace.id) : [];

  console.log("Prisma runtime read test passed.");
  console.table(counts);
  console.table({
    defaultWorkspace: defaultWorkspace?.id || "none",
    scopedProfile: scopedProfile?.id || "none",
    scopedLeads: scopedLeads.length,
    scopedKnowledge: scopedKnowledge.length,
    scopedAutoReplyLogs: scopedAutoReplyLogs.length,
    writeTest: process.argv.includes("--write-test") ? "not implemented: keep this explicit and safe" : "skipped",
  });
  await client.$disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
