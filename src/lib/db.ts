import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { renameWithRetry } from "./atomic-rename";
import { withJsonFileIO } from "./json-file-io";
import type { AppData } from "./types";
import { activeSnapshotSession } from "@/repositories/snapshot-session";
// Re-export so callers of mutateData / readData can get the type from one
// place (`@/lib/db`) instead of having to know it lives in `./types`.
export type { AppData } from "./types";

// The JSON demo data location. Env-overridable so automated tests (the golden
// suite) can redirect ALL reads/writes to an isolated throwaway file instead of
// polluting the shared demo `app-data.json` (Stage 5 finding F-P0-5). When the
// override is set, each test process gets its own file → no cross-process
// EPERM rename race AND zero demo-file pollution. Unset → the production/demo
// default (.leadgen-data/app-data.json), unchanged.
const dataDir = process.env.LEADGEN_DATA_DIR
  ? path.resolve(process.env.LEADGEN_DATA_DIR)
  : path.join(process.cwd(), ".leadgen-data");
const dataFile = path.join(dataDir, "app-data.json");
const lockDir = path.join(dataDir, "app-data.lock");

// Phase 4E: fail closed if JSON mode is used in a production deployment.
// JSON mode is a single-file, single-process demo runtime — it must NOT be
// used when NODE_ENV=production. We defer the check to the first data access
// (not module load) so it doesn't fire during `next build` which sets
// NODE_ENV=production at build time.
let jsonProductionWarningEmitted = false;
function assertJsonModeSafeForProduction() {
  if (jsonProductionWarningEmitted) return;
  if (process.env.NODE_ENV === "production" && process.env.PERSISTENCE_PROVIDER !== "prisma") {
    jsonProductionWarningEmitted = true;
    console.error(
      "WARNING: PERSISTENCE_PROVIDER=json with NODE_ENV=production is not safe. " +
      "Set PERSISTENCE_PROVIDER=prisma and DATABASE_URL to a real PostgreSQL database."
    );
  }
}

/**
 * Where this process keeps its JSON substrate. Exported so blob-shaped data
 * (uploaded media) can be stored BESIDE app-data.json rather than inside it --
 * a 16 MB base64 string in the single JSON file would be re-read and re-written
 * on every request. Honours LEADGEN_DATA_DIR, so a golden run's blobs land in
 * its own throwaway directory too.
 */
export function dataDirectory() {
  return dataDir;
}

export const defaultWorkspaceId = "workspace_demo";

const now = () => new Date().toISOString();

const seedData: AppData = {
  workspaces: [{
    id: defaultWorkspaceId,
    // 2026-08-02 (UI polish) — display name shown in the header. Was the dev
    // placeholder "CampaignWorkspace". A freshly-bootstrapped workspace has no
    // real business name yet, so this is the honest neutral default.
    name: "My Workspace",
    ownerUserId: "user_owner",
    businessName: "Your Business",
    industry: "B2B products and services",
    targetAudience: "",
    status: "active",
    createdAt: now(),
    updatedAt: now(),
  }],
  users: [{
    id: "user_owner",
    workspaceId: defaultWorkspaceId,
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
    createdAt: now(),
    updatedAt: now(),
  }],
  workspaceMembers: [{
    id: "member_owner",
    workspaceId: defaultWorkspaceId,
    userId: "user_owner",
    email: "owner@example.com",
    name: "Owner",
    role: "owner",
    status: "active",
    createdAt: now(),
    updatedAt: now(),
  }],
  businessProfiles: [{
    id: "profile_demo",
    workspaceId: defaultWorkspaceId,
    // 2026-08-17 (N-DATA-1 / ship gate G8, CEO decision D2) — this default was
    // "Balaji Zari Udyog", which is the operator's REAL first customer. Because
    // this object is production code and not a seed script, a fresh install
    // booted already claiming to be that real company, and then answered using
    // whatever knowledge happened to be loaded. Under D2 ("everything should be
    // the fake data for now") the shipped identity is the fiction instead:
    // Meghdoot Zari & Trims Pvt Ltd, the company specified across the 18
    // documents in fixtures/meghdoot-zari/ — so the profile the product starts
    // with and the knowledge it reasons over finally describe the SAME business.
    //
    // Every contact detail below is unroutable BY CONSTRUCTION, not merely
    // invented (N-SAFETY-1). `.example` is an RFC 2606 reserved TLD that can
    // never be registered, so mail addressed here cannot reach a third party.
    // An Indian mobile number never begins with 0 after +91, so this number is
    // guaranteed unassignable. Both still render as plausible values in the UI.
    // Do not "make these more realistic" — realism here means a live send test
    // reaching a stranger.
    companyName: "Meghdoot Zari & Trims Pvt Ltd",
    websiteUrl: "",
    industry: "Textile trims and zari manufacturing",
    businessType: "Manufacturer",
    description: "Manufacturer of zari thread and supplier of embroidery trims — laces, borders, sequins and cutdana — to the Indian textile trade. Business-to-business only: no retail, no single pieces, no consumer sales.",
    products: ["Zari thread", "Laces", "Borders", "Sequins", "Cutdana"],
    services: ["Bulk supply", "Custom shade matching", "Catalogue sharing"],
    productCategories: ["Textiles", "Ethnic wear material", "Fashion accessories"],
    contactEmail: "sales@meghdootzari.example",
    contactPhone: "+91 00000 00010",
    whatsappNumber: "+910000000010",
    address: "Ring Road, Surat, Gujarat 395002",
    city: "Surat",
    state: "Gujarat",
    country: "India",
    // India only — the fixture profile states plainly "We do not currently
    // export. All of our supply is within India." Adding UAE here would make
    // the shipped ICP contradict the company's own documents on day one.
    targetGeographies: ["India"],
    currentCustomerTypes: ["Saree wholesalers", "Embroidery units", "Garment makers"],
    // "Export buyers" deliberately removed — it was the sharpest contradiction
    // in the old default: the company documents say it does not export, so
    // targeting export buyers would have had the AI qualify leads it can never
    // serve, then discover the problem in front of the customer.
    desiredCustomerTypes: ["Saree wholesalers", "Ethnic wear manufacturers", "Trims distributors"],
    // Straight from fixtures/meghdoot-zari/01-company-profile.md, in the order
    // that document ranks them.
    strengths: ["Batch-to-batch shade consistency", "60+ shades held in stock", "On-time dispatch"],
    limitations: ["Not the cheapest supplier — competes on consistency, not rate", "Does not export; supplies within India only"],
    certifications: [],
    socialLinks: [],
    catalogueLinks: [],
    proofAssets: [],
    languagePreference: "English",
    tonePreference: "Warm, concise, businesslike",
    status: "reviewed",
    fields: [],
    createdAt: now(),
    updatedAt: now(),
  }],
  websiteCrawlConsents: [],
  crawlJobs: [],
  crawlPages: [],
  businessExtractions: [],
  productKnowledges: [],
  productVarieties: [],
  productApplications: [],
  buyerSegments: [],
  productApplicationMarketMaps: [],
  knowledgeEntries: [],
  icps: [],
  campaigns: [],
  leads: [],
  interactions: [],
  humanFallbackTasks: [],
  leadReviewSettings: [],
  leadReviewDecisions: [],
  messageTemplates: [],
  outreachActivities: [],
  replies: [],
  agentRuns: [],
  integrations: [
    "whatsapp_cloud", "gmail", "smtp", "google_maps", "google_search", "instagram",
    "linkedin", "indiamart", "tradeindia", "apollo", "hunter", "clearbit",
    "email_verifier", "crm_hubspot", "crm_zoho", "google_sheets", "zapier_webhook",
  ].map((provider) => ({
    id: `integration_${provider}`,
    workspaceId: defaultWorkspaceId,
    provider,
    status: "not_connected",
    authType: provider === "smtp" ? "password" : "oauth_or_api_key",
    config: { mvpMode: "placeholder", manualFallback: true },
    createdAt: now(),
    updatedAt: now(),
  })),
  campaignLearnings: [],
  campaignMetrics: [],
  eventLogs: [],
  jobRuns: [],
  agentBehaviorPolicies: [],
  companyCommunicationSettings: [],
  conversationPolicies: [],
  whatsAppAgentSettings: [],
  escalationRules: [],
  unknownQuestions: [],
  autoReplyLogs: [],
  mediaCatalogItems: [],
  knowledgeBaseDocuments: [],
  knowledgeBaseChunks: [],
  knowledgeBaseQueryLogs: [],
  knowledgeQuestionAnswers: [],
  knowledgeExtractionRuns: [],
  knowledgeExtractionBatches: [],
  knowledgeExtractionSourceBundles: [],
  knowledgeExtractionSources: [],
  llmProviderCredentials: [],
  llmModelRoutings: [],
  aiUsageLimits: [],
  salesSettings: [],
  productSettings: [],
  policySettings: [],
  communicationSettings: [],
  settingsConflicts: [],
  pendingSettingsDrafts: [],
};

export function uid(prefix: string) {
  // Phase 4E: use crypto.randomUUID() for collision-resistant IDs (was
  // Date.now() + Math.random() which can collide under high concurrency).
  return `${prefix}_${randomUUID()}`;
}

/**
 * N-PERF-3 (2026-08-25): a read inside a session sees the session's own writes.
 *
 * Without this, code that writes and then reads back inside one operation breaks
 * — chunkKnowledgeDocument loads the document createKnowledgeDocument just made,
 * and in a session that document is still only in memory. Note the guard is
 * `session.snapshot`, not `session`: a read that happens before the session has
 * written anything goes to the file as usual, so a session that never writes
 * costs nothing and takes no lock.
 */
export async function readData(): Promise<AppData> {
  const session = activeSnapshotSession();
  if (session?.snapshot) return session.snapshot;
  assertJsonModeSafeForProduction();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const raw = await withJsonFileIO(() => readFile(dataFile, "utf8"));
      return ensureDataShape(parseAppData(raw));
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      if (attempt < 4 && await dataWriteMayBeInFlight()) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      await writeData(seedData);
      // Through ensureDataShape like every other return, not around it. The
      // seed literal is a hand-written object and has drifted from the shape
      // the readers expect before; a brand-new store must not be the one case
      // that skips normalisation.
      return ensureDataShape(structuredClone(seedData));
    }
  }
  return ensureDataShape(structuredClone(seedData));
}

export async function writeData(data: AppData) {
  await mkdir(dataDir, { recursive: true });
  const tempFile = path.join(dataDir, `app-data.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await writeFile(tempFile, JSON.stringify(data, null, 2));
    // Session 6 audit fix: on Windows, rename() over an existing file fails
    // with EPERM when the target is briefly locked (e.g. by antivirus, a file
    // indexer, or the dev server's own watcher). A single failed write used to
    // crash the whole service with no recovery.
    //
    // 2026-08-19 (N-DATA-5): that retry policy lived here as an inline loop
    // with a 500ms total budget, and it was NOT enough — the EPERM above was
    // still reaching the operator as an api.errorToResponse.500 during the e2e
    // sweep. The policy now lives in src/lib/atomic-rename.ts, where a golden
    // can hand it a failing rename and prove how many transient failures it
    // survives; the budget is ~3s.
    const outcome = await withJsonFileIO(() => renameWithRetry(tempFile, dataFile, {
      rename,
      onRetry: (attempt, waitMs, error) => {
        // Logged at attempt 1 only: a write that had to fight for the file is
        // worth one line, but a chatty log during a long lock is not.
        if (attempt === 1) {
          const code = (error as NodeJS.ErrnoException)?.code;
          console.warn(`[db] rename onto ${path.basename(dataFile)} blocked (${code}); retrying for up to ~3s`);
        }
        void waitMs;
      },
    }));
    if (outcome.attempts > 1) {
      console.warn(`[db] write succeeded after ${outcome.attempts} attempts (${outcome.waitedMs}ms waiting on the file lock)`);
    }
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

let mutationQueue: Promise<void> = Promise.resolve();

/**
 * N-PERF-3 (2026-08-25). Inside a withSnapshotSession this joins the session
 * instead of taking its own turn in the queue: the mutator runs against the one
 * loaded snapshot and the file is written once when the session ends.
 *
 * This has to live HERE and not in the JSON repository bundle. Every JSON
 * repository writes through mutateData, and mutateData serializes on a queue
 * behind a file lock — so a session that only intercepted `repos.mutateAll`
 * would deadlock the moment anything inside it called an ordinary repository
 * write: the session holds the queue slot, the repository write waits for the
 * queue, and neither can finish. That is not theoretical. It is what the first
 * version of this change did, and it hung the golden suite.
 */
export async function mutateData<T>(mutator: (data: AppData) => T | Promise<T>) {
  const session = activeSnapshotSession();
  if (session) {
    if (!session.snapshot) {
      const opened = await beginDataSession();
      session.snapshot = opened.data;
      session.commit = opened.commit;
      session.release = opened.release;
    }
    return mutator(session.snapshot);
  }
  const run = mutationQueue.then(async () => {
    const releaseLock = await acquireDataLock();
    try {
      const data = await readData();
      const result = await mutator(data);
      await writeData(data);
      return result;
    } finally {
      await releaseLock();
    }
  });
  mutationQueue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * N-PERF-3 (2026-08-25) — the JSON half of a snapshot session. See
 * src/repositories/snapshot-session.ts for why sessions exist at all.
 *
 * Takes the same place in the mutation queue that one mutateData call would,
 * holds the same file lock, and hands back the loaded data so the caller can
 * run many mutators against it before a single write. The queue slot is not
 * released until release() runs, so a session is exactly as atomic as the one
 * big mutateData it replaces — and no other writer can interleave inside it.
 *
 * release() MUST be called (a finally block), or the mutation queue stalls for
 * the life of the process. withSnapshotSession does that for every caller.
 */
export async function beginDataSession(): Promise<{ data: AppData; commit: () => Promise<void>; release: () => Promise<void> }> {
  let openTheGate!: () => void;
  const sessionFinished = new Promise<void>((resolve) => {
    openTheGate = resolve;
  });

  const opened = mutationQueue.then(async () => {
    const releaseLock = await acquireDataLock();
    try {
      return { data: await readData(), releaseLock };
    } catch (error) {
      await releaseLock();
      throw error;
    }
  });
  // The queue waits for the whole session — but if opening it failed there is
  // no session to wait for, so let the queue through immediately or every
  // later write in this process deadlocks behind a session that never started.
  mutationQueue = opened.then(() => sessionFinished, () => undefined).then(() => undefined, () => undefined);

  const { data, releaseLock } = await opened;
  let released = false;
  return {
    data,
    commit: async () => {
      await writeData(data);
    },
    release: async () => {
      if (released) return;
      released = true;
      try {
        await releaseLock();
      } finally {
        openTheGate();
      }
    },
  };
}

async function acquireDataLock() {
  await mkdir(dataDir, { recursive: true });
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockDir);
      return async () => {
        await rm(lockDir, { recursive: true, force: true });
      };
    } catch {
      await removeStaleDataLock(startedAt);
      if (Date.now() - startedAt > 8000) {
        throw new Error("JSON demo data is busy. Please retry the action.");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function removeStaleDataLock(currentAttemptStartedAt: number) {
  try {
    const lockStat = await stat(lockDir);
    const lockAgeMs = Date.now() - lockStat.mtimeMs;
    if (lockAgeMs > 15000 && Date.now() - currentAttemptStartedAt > 500) {
      await rm(lockDir, { recursive: true, force: true });
    }
  } catch {
    // Lock disappeared between mkdir attempts.
  }
}

export function touch<T extends { updatedAt: string }>(record: T): T {
  record.updatedAt = now();
  return record;
}

export function timestamp() {
  return now();
}

function ensureDataShape(data: AppData): AppData {
  data.userCredentials ||= [];
  data.doNotContactRegistry ||= [];
  data.leadPhoneNumbers ||= [];
  data.workspaceMembers ||= data.users.map((user) => ({
    id: `member_${user.id}`,
    workspaceId: user.workspaceId,
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: "active",
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }));
  data.websiteCrawlConsents ||= [];
  data.crawlJobs ||= [];
  data.crawlPages ||= [];
  data.businessExtractions ||= [];
  data.productKnowledges ||= [];
  data.productVarieties ||= [];
  data.productApplications ||= [];
  data.buyerSegments ||= [];
  data.productApplicationMarketMaps ||= [];
  data.knowledgeEntries ||= [];
  data.interactions ||= [];
  data.humanFallbackTasks ||= [];
  data.leadReviewSettings ||= [];
  data.leadReviewDecisions ||= [];
  data.campaignLearnings ||= [];
  data.campaignMetrics ||= [];
  data.eventLogs ||= [];
  data.jobRuns ||= [];
  data.auditLogs ||= [];
  data.providerAccounts ||= [];
  data.agentBehaviorPolicies ||= [];
  data.companyCommunicationSettings ||= [];
  data.conversationPolicies ||= [];
  data.whatsAppAgentSettings ||= [];
  data.escalationRules ||= [];
  data.unknownQuestions ||= [];
  data.autoReplyLogs ||= [];
  data.mediaCatalogItems ||= [];
  data.knowledgeBaseDocuments ||= [];
  data.knowledgeBaseChunks ||= [];
  data.knowledgeBaseQueryLogs ||= [];
  data.knowledgeQuestionAnswers ||= [];
  data.knowledgeExtractionRuns ||= [];
  data.knowledgeExtractionBatches ||= [];
  data.knowledgeExtractionSourceBundles ||= [];
  data.knowledgeExtractionSources ||= [];
  data.llmProviderCredentials ||= [];
  data.llmModelRoutings ||= [];
  data.aiUsageLimits ||= [];
  data.salesSettings ||= [];
  data.productSettings ||= [];
  data.policySettings ||= [];
  data.communicationSettings ||= [];
  data.settingsConflicts ||= [];
  data.pendingSettingsDrafts ||= [];
  // 2026-09-08. This one is not cosmetic. WebhookDedupService logs
  // "inbound webhook dedup is INACTIVE ... indicates a regression" whenever
  // readAll() hands it something that is not an array, and JSON's readAll is
  // this function. A store that has simply never processed a webhook has no
  // such key, so every fresh workspace printed that warning while dedup was in
  // fact working correctly (proved: first delivery false, replay true).
  //
  // The cost of a false alarm here is that the TRUE one becomes unreadable —
  // on Prisma the same message would mean duplicate leads, replies, tickets and
  // DNC re-blocks from Meta's retries. Prisma's readAll always returns an array
  // because it maps a findMany; this makes the JSON side say the same thing, so
  // the warning now means what it claims.
  data.processedWebhookMessageIds ||= [];
  return data;
}

function parseAppData(raw: string): AppData {
  return JSON.parse(raw.replace(/^\uFEFF/, "")) as AppData;
}

function isMissingFileError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

async function dataWriteMayBeInFlight() {
  try {
    await stat(lockDir);
    return true;
  } catch {
    return false;
  }
}
