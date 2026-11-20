/**
 * golden-sync-indexes-uploaded-files.ts — N15: Sync Knowledge makes the files
 * the owner already uploaded searchable (2026-09-18, session 57).
 *
 * ── HOW THIS WAS FOUND ──────────────────────────────────────────────────────
 * On production, not in a test. The workspace held 424 question rows, 246 of
 * them answered, one stored source document — and ZERO chunks. The AI had
 * nothing at all to search.
 *
 * Two separate reasons, and this golden is about the second:
 *   1. none of the extracted answers had been approved yet, so none were
 *      servable. That is the product working as designed and waiting on a
 *      person.
 *   2. the uploaded file itself had never been indexed, because source indexing
 *      shipped attached to EXTRACTION and only extraction called it. Every file
 *      uploaded before that day was stranded: its text stored, no chunk in the
 *      index, and the only repair was to pay for a full extraction again.
 *
 * Sync Knowledge is the button that means "make what I have searchable". That
 * is exactly this job, and it was not doing it.
 *
 *   CASE A — a ready source that was never indexed becomes searchable on sync,
 *            with no extraction and no model call for the answers.
 *   CASE B — pressing Sync twice does not leave two copies in the index.
 *   CASE C — a source that cannot be indexed does not take the sync down with
 *            it. The answers are what the owner is waiting on.
 *
 * Run: npx tsx scripts/golden/golden-sync-indexes-uploaded-files.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createJsonRepos } from "./_helpers/provider";
import { syncWorkspaceKnowledge } from "@/services/SyncKnowledgeService";
import { getRelevantContext } from "@/services/KnowledgeBaseService";
import { UPLOADED_SOURCE_DOCUMENT_TYPE } from "@/services/KnowledgeSourceIndexingService";
import type { AppData } from "@/lib/types";
import type { RepositoryBundle } from "@/repositories/interfaces";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

const repos = createJsonRepos();

let seq = 0;
const freshWorkspace = () => `ws_n15_${Date.now()}_${seq++}`;

// A sentence no question in the 424-question framework would ever ask about,
// which is the whole reason indexing the file matters: the framework cannot
// cover a company, and the answer is often only in the PDF.
const RATE_LINE =
  "Neem Zari Thread R is supplied on 250 gram cones packed twelve to a carton, and the carton is sealed with our batch sticker.";
const SEARCH = "how are the cones packed in a carton";

async function plantSource(workspaceId: string, overrides: Record<string, unknown> = {}) {
  const id = `kes_${workspaceId}_${seq++}`;
  await repos.mutateAll!((data: AppData) => {
    data.knowledgeExtractionSources ||= [];
    data.knowledgeExtractionSources.push({
      id,
      workspaceId,
      bundleId: `ksb_${workspaceId}`,
      sourceType: "pdf_upload",
      sourceTitle: "Packing and dispatch notes",
      sourceFileName: "packing-notes.pdf",
      extractedText: RATE_LINE,
      metadataJson: {},
      status: "ready",
      createdAt: "2026-09-17T22:00:00.000Z",
      updatedAt: "2026-09-17T22:00:00.000Z",
      ...overrides,
    } as never);
    return id;
  });
  return id;
}

/**
 * A business profile, so the OTHER steps of the sync succeed.
 *
 * Without it the profile step fails and paints every run "partial" on its own —
 * which would make an assertion about `status` here prove nothing at all. The
 * first version of this golden had exactly that hole, and the mutation removing
 * the partial flag passed unnoticed.
 */
async function plantProfile(workspaceId: string) {
  await repos.mutateAll!((data: AppData) => {
    data.businessProfiles ||= [];
    data.businessProfiles.push({
      id: `bp_${workspaceId}`,
      workspaceId,
      companyName: "Meghdoot Zari",
      industry: "Zari and embroidery thread",
      businessType: "manufacturer",
      description: "Manufactures zari thread and borders in Surat.",
      // The profile serialiser joins every one of these; leaving them out makes
      // the profile step throw, which paints the run "partial" for a reason
      // that has nothing to do with what this golden is testing.
      products: ["Neem Zari Thread R"],
      services: [],
      productCategories: ["zari thread"],
      targetGeographies: ["Surat"],
      currentCustomerTypes: ["wholesalers"],
      desiredCustomerTypes: ["manufacturers"],
      strengths: ["batch consistency"],
      limitations: ["does not export"],
      certifications: [],
      socialLinks: [],
      catalogueLinks: [],
      proofAssets: [],
      status: "approved",
      createdAt: "2026-09-17T22:00:00.000Z",
      updatedAt: "2026-09-17T22:00:00.000Z",
    } as never);
    return workspaceId;
  });
}

async function uploadedDocuments(workspaceId: string) {
  const docs = await repos.knowledgeBaseDocument.listByWorkspace(workspaceId);
  return docs.filter((doc) => doc.documentType === UPLOADED_SOURCE_DOCUMENT_TYPE);
}

test("CASE A — a file uploaded before indexing existed becomes searchable on sync", async () => {
  const workspaceId = freshWorkspace();
  await plantSource(workspaceId);

  const before = await getRelevantContext(workspaceId, SEARCH, repos);
  assert.ok(!/batch sticker/i.test(before.contextText), "fixture: the file's text is not in the index yet");

  const summary = await syncWorkspaceKnowledge(workspaceId, repos);

  assert.ok(summary.sourcesIndexed, "the sync must REPORT what it did with the files, not do it invisibly");
  assert.strictEqual(summary.sourcesIndexed!.indexed, true, `indexing failed: ${JSON.stringify(summary.sourcesIndexed)}`);

  const after = await getRelevantContext(workspaceId, SEARCH, repos);
  assert.match(
    after.contextText,
    /batch sticker/i,
    "THE POINT: the owner already uploaded this file and already paid to have it read. Making it " +
      "searchable must not require paying for a second extraction.",
  );
});

test("CASE B — pressing Sync twice does not leave two copies in the index", async () => {
  const workspaceId = freshWorkspace();
  await plantSource(workspaceId);

  await syncWorkspaceKnowledge(workspaceId, repos);
  const afterFirst = await uploadedDocuments(workspaceId);
  await syncWorkspaceKnowledge(workspaceId, repos);
  const afterSecond = await uploadedDocuments(workspaceId);

  assert.strictEqual(afterFirst.length, 1, "fixture: one file, one document");
  assert.strictEqual(
    afterSecond.length,
    1,
    "Sync is a button an owner presses whenever they are unsure. If each press added a copy, the index " +
      "would fill with duplicates of the same company knowledge and every search would return the same " +
      "line several times over.",
  );

  const chunks = await repos.knowledgeBaseChunk.listByDocument(workspaceId, afterSecond[0].id);
  assert.ok(chunks.length > 0, "and the one document still has its chunks after the second pass");
});

test("CASE C — a file that cannot be indexed does not take the whole sync down", async () => {
  const workspaceId = freshWorkspace();
  await plantProfile(workspaceId);
  await plantSource(workspaceId);

  // The index write refuses. The answers the owner is waiting on are compiled
  // by a different step, and they must still arrive.
  const broken = new Proxy(repos as unknown as Record<string, unknown>, {
    get(target, prop) {
      if (prop === "knowledgeBaseChunk") {
        const chunkRepo = Reflect.get(target, prop, target) as Record<string, unknown>;
        return new Proxy(chunkRepo, {
          get(chunkTarget, chunkProp) {
            if (chunkProp === "replaceForDocument") {
              // ONLY the uploaded file's write fails. Breaking every write also
              // breaks the profile and the answers, and then "partial" is true
              // for reasons that have nothing to do with this feature — which
              // is how the first version of this case let a mutation through.
              // Uploaded-source chunks are the ones marked unverified.
              return async (...args: unknown[]) => {
                const chunks = args[2] as Array<{ metadata?: Record<string, unknown> }> | undefined;
                if (chunks?.some((chunk) => chunk?.metadata?.extractionUnverified === true)) {
                  throw new Error("index write refused");
                }
                const original = Reflect.get(chunkTarget, chunkProp, chunkTarget) as (...a: unknown[]) => unknown;
                return original.apply(chunkTarget, args);
              };
            }
            const value = Reflect.get(chunkTarget, chunkProp, chunkTarget);
            return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(chunkTarget) : value;
          },
        });
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as RepositoryBundle;

  const summary = await syncWorkspaceKnowledge(workspaceId, broken);

  assert.strictEqual(summary.sourcesIndexed?.indexed, false, "the failure is REPORTED, not hidden behind a success");
  assert.strictEqual(
    (summary.sourcesIndexed as { failed?: number })?.failed,
    1,
    "COUNTED, not just flagged: the indexer swallows per-file failures, so this count is the only place " +
      "an owner can learn that one of their documents is missing from the index",
  );
  assert.strictEqual(
    summary.status,
    "partial",
    "and it colours the whole result 'partial' — a sync that half worked must not read as a sync that worked",
  );
});

test("CASE D — a source that is not ready yet is not indexed, and is not counted as a failure", async () => {
  // A file still uploading, or one whose text could not be read, has nothing
  // worth indexing. Sweeping it in would put half-read rubbish in front of
  // customers AND make a healthy sync report a failure that never happened.
  const workspaceId = freshWorkspace();
  await plantProfile(workspaceId);
  await plantSource(workspaceId);
  await plantSource(workspaceId, {
    sourceFileName: "half-uploaded.pdf",
    status: "pending",
    extractedText: "PARTIALTEXTMARKER this file is still being processed",
  });

  const summary = await syncWorkspaceKnowledge(workspaceId, repos);

  assert.strictEqual(
    summary.sourcesIndexed?.indexed,
    true,
    `a pending file must not spoil a healthy sync: ${JSON.stringify(summary.sourcesIndexed)}`,
  );
  assert.strictEqual(
    (summary.sourcesIndexed as { failed?: number })?.failed,
    0,
    "and it must not be COUNTED as a file that failed — nothing was attempted on it",
  );
  assert.strictEqual((summary.sourcesIndexed as { documents?: number })?.documents, 1, "exactly the one ready file was indexed");
  assert.strictEqual(summary.status, "synced", "nothing went wrong, so nothing may say it did");

  const search = await getRelevantContext(workspaceId, "is this file still being processed", repos);
  assert.ok(
    !/PARTIALTEXTMARKER/.test(search.contextText),
    "and the half-read text must not be searchable: an unfinished upload is not company knowledge",
  );
});

(async () => {
  console.log("\n=== GOLDEN: Sync makes uploaded files searchable (N15) ===\n");
  for (const c of cases) {
    try {
      await c.fn();
      pass += 1;
      console.log(`  ✓ ${c.name}`);
    } catch (error) {
      fail += 1;
      console.log(`  ✗ ${c.name}\n    ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("❌ GOLDEN FAILED: sync-indexes-uploaded-files");
    process.exit(1);
  }
})();
