import { readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeCompanySizeBucket } from "../src/lib/company-size";

type ImportableData = Record<string, unknown[]>;

const importOrder = [
  "workspaces",
  "users",
  "workspaceMembers",
  "businessProfiles",
  "websiteCrawlConsents",
  "crawlJobs",
  "crawlPages",
  "businessExtractions",
  "productKnowledges",
  "productVarieties",
  "productApplications",
  "buyerSegments",
  "productApplicationMarketMaps",
  "icps",
  "campaigns",
  "campaignPlans",
  "leads",
  "leadReviewSettings",
  "leadReviewDecisions",
  "leadEnrichmentRuns",
  "duplicateCandidates",
  "messageTemplates",
  "outreachActivities",
  "replies",
  "leadNotes",
  "tasks",
  "campaignMetrics",
  "campaignLearnings",
  "integrations",
  "providerAccounts",
  "agentRuns",
  "auditLogs",
  "eventLogs",
  "jobRuns",
  "agentBehaviorPolicies",
  "companyCommunicationSettings",
  "conversationPolicies",
  "whatsAppAgentSettings",
  "escalationRules",
  "unknownQuestions",
  "autoReplyLogs",
  "knowledgeBaseDocuments",
  "knowledgeBaseChunks",
    "knowledgeBaseQueryLogs",
    "knowledgeQuestionAnswers",
    "knowledgeExtractionRuns",
    "knowledgeExtractionBatches",
    "llmProviderCredentials",
  "llmModelRoutings",
  "aiUsageLimits",
  "webhookEvents",
] as const;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const write = process.argv.includes("--write");
  const dataPath = path.join(process.cwd(), ".leadgen-data", "app-data.json");
  const raw = await readFile(dataPath, "utf8");
  const data = JSON.parse(raw) as ImportableData;

  validateTopLevel(data);
  const skipped = findSkippedRecords(data);
  const counts = summarize(data, skipped);

  console.log("JSON import summary");
  console.table(counts);
  if (skipped.length) {
    console.log("Records that would be skipped or need manual mapping:");
    console.table(skipped);
  }

  const normalizedLeadSizes = (data.leads || []).map((lead) => {
    const record = lead as { companySizeBucket?: string };
    return normalizeCompanySizeBucket(record.companySizeBucket);
  });
  console.log("Normalized lead company size buckets:", Array.from(new Set(normalizedLeadSizes)).join(", ") || "none");

  if (dryRun || !write) {
    console.log("Dry run only. No PostgreSQL writes were attempted. Add --write to request guarded write mode.");
    console.log("Import order is safe for foreign keys and IDs would be preserved where Prisma permits explicit IDs.");
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for --write mode.");
  }

  if (process.env.DATABASE_URL.includes("user:pass@localhost")) {
    throw new Error("Refusing write mode with placeholder DATABASE_URL.");
  }

  console.warn("WRITE MODE REQUESTED. This script never deletes existing DB data. It currently validates records and refuses mutation until upsert mapping is explicitly enabled.");
  console.log("Skipped write phase: mapping is prepared conceptually, but real upserts remain disabled to avoid corrupting a PostgreSQL database before first manual mapping review.");
}

function validateTopLevel(data: ImportableData) {
  for (const key of importOrder) {
    if (data[key] !== undefined && !Array.isArray(data[key])) {
      throw new Error(`Invalid JSON persistence file: missing top-level array ${key}`);
    }
  }
  for (const required of ["workspaces", "users", "businessProfiles", "leads"]) {
    data[required] ||= [];
  }
}

function summarize(data: ImportableData, skipped: Array<{ collection: string }>) {
  return Object.fromEntries(importOrder.map((key) => {
    const read = Array.isArray(data[key]) ? data[key].length : 0;
    const skippedCount = skipped.filter((item) => item.collection === key).length;
    return [key, { read, imported: 0, skipped: skippedCount, failed: 0 }];
  }));
}

function findSkippedRecords(data: ImportableData) {
  const skipped: Array<{ collection: string; id: string; reason: string }> = [];
  for (const lead of data.leads || []) {
    const record = lead as { id?: string; workspaceId?: string; status?: string };
    if (!record.workspaceId) skipped.push({ collection: "leads", id: record.id || "(missing id)", reason: "Missing workspaceId" });
    if (!record.status) skipped.push({ collection: "leads", id: record.id || "(missing id)", reason: "Missing lead status" });
  }
  for (const campaign of data.campaigns || []) {
    const record = campaign as { id?: string; workspaceId?: string; businessProfileId?: string; icpId?: string };
    if (!record.workspaceId || !record.businessProfileId || !record.icpId) {
      skipped.push({ collection: "campaigns", id: record.id || "(missing id)", reason: "Missing workspace/profile/ICP relation" });
    }
  }
  return skipped;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
