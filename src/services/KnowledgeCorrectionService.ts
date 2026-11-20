/**
 * KnowledgeCorrectionService — when the owner corrects a fact, the old line in
 * the uploaded document has to stop answering customers (2026-09-18, session 57).
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────
 * Uploaded documents are searchable. The owner corrects "MOQ is 50 kg" to
 * "MOQ is 100 kg". The correction is stored, re-chunked and re-embedded — and
 * the ORIGINAL PDF line still sits in the index, still matching the question
 * "what is your minimum order?". A meaning-search can hand the model the
 * outdated line, and the customer is told a number the owner has already
 * corrected. Confidently, with no error anywhere.
 *
 * ── WHY THE OWNER CONFIRMS, RATHER THAN THE SYSTEM GUESSING ─────────────────
 * The obvious design is to detect the contradiction automatically and retire
 * the line. That requires the system to be sure two sentences disagree, which
 * is exactly the judgement it is worst at: "MOQ 50 kg for stocked shades" and
 * "MOQ 100 kg for custom shades" look like a contradiction and are not. Getting
 * that wrong deletes a true fact from the knowledge base, silently.
 *
 * So this service PROPOSES and the owner DISPOSES. It finds the document lines
 * that answer the same question, shows them, and does nothing until the owner
 * says which are superseded. One click, and it is also how the owner catches
 * the case where the document was right and the memory was wrong.
 *
 * ── RETIRED, NOT DELETED ────────────────────────────────────────────────────
 * A retired chunk keeps its row and its text. It is the evidence of what the
 * uploaded file actually said, and if a correction is ever itself wrong, that
 * is how anyone finds out. It leaves the vector index and is skipped by
 * retrieval; it does not leave history. `restoreChunk` undoes the whole thing.
 */
import { timestamp } from "@/lib/db";
import type { KnowledgeBaseChunk, KnowledgeQuestionAnswer } from "@/lib/types";
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { SemanticRetriever } from "@/rag/SemanticRetriever";
import { chunkAuthority, isSuperseded, supersededMetadata, type SupersededMark } from "@/rag/chunk-authority";
import { oneAtATime } from "@/lib/one-at-a-time";

/** A document line the owner is being asked about. */
export type SupersedeCandidate = {
  chunkId: string;
  documentTitle?: string;
  sourceFileName?: string;
  /** The line itself, as it appears in the uploaded document. */
  text: string;
  /** How strongly it answers the same question (0-1). */
  score: number;
};

/** How many lines to put in front of the owner. More than a handful is a chore, not a review. */
const MAX_CANDIDATES = 5;
/**
 * Below this, a line is not really answering the same question, and showing it
 * trains the owner to click through the list without reading — which is worse
 * than showing nothing.
 */
const MIN_SCORE = 0.25;

/**
 * Document lines that answer the same question as this answer, and are
 * therefore candidates to retire. Approved text is never a candidate: this is
 * about unverified document text losing to an owner's correction, not about
 * one approved fact overruling another.
 */
export async function proposeSupersededChunks(
  workspaceId: string,
  answer: Pick<KnowledgeQuestionAnswer, "question" | "answer">,
  repos: RepositoryBundle = createRepositories(),
  options: { retriever?: SemanticRetriever; limit?: number } = {},
): Promise<SupersedeCandidate[]> {
  const query = [answer.question, answer.answer].filter(Boolean).join(" ").trim();
  if (!query) return [];
  const retriever = options.retriever ?? new SemanticRetriever(repos);
  const hits = await retriever.retrieve(workspaceId, query, { limit: (options.limit ?? MAX_CANDIDATES) * 3 });
  const documents = await repos.knowledgeBaseDocument.listByWorkspace(workspaceId);
  const titleById = new Map(documents.map((doc) => [doc.id, doc.title]));

  return hits
    .filter((hit) => chunkAuthority(hit) === "document" && !isSuperseded(hit) && hit.score >= MIN_SCORE)
    .slice(0, options.limit ?? MAX_CANDIDATES)
    .map((hit) => ({
      chunkId: hit.id,
      documentTitle: hit.documentTitle || titleById.get(hit.documentId),
      sourceFileName: typeof hit.metadata?.sourceFileName === "string" ? hit.metadata.sourceFileName : undefined,
      text: hit.chunkText,
      score: hit.score,
    }));
}

/**
 * Retire one document line, because the owner said this correction replaces it.
 * Idempotent: retiring an already-retired chunk changes nothing.
 */
export async function retireChunk(
  workspaceId: string,
  chunkId: string,
  context: { answerId: string; replacedBy?: string; actorUserId?: string },
  repos: RepositoryBundle = createRepositories(),
): Promise<KnowledgeBaseChunk | null> {
  return oneAtATime(`knowledge-chunk:${workspaceId}:${chunkId}`, async () => {
  const save = async () => {
  const [chunk] = await repos.knowledgeBaseChunk.listByIds(workspaceId, [chunkId]);
  if (!chunk) return null;
  if (isSuperseded(chunk)) return chunk;
  const mark: SupersededMark = { answerId: context.answerId, at: timestamp(), replacedBy: context.replacedBy };
  const updated = await repos.knowledgeBaseChunk.updateMetadata(workspaceId, chunkId, supersededMetadata(chunk, mark));
  await writeAudit(workspaceId, "knowledge.chunk.retired", chunkId, {
    answerId: context.answerId,
    retiredText: chunk.chunkText.slice(0, 400),
    replacedBy: context.replacedBy?.slice(0, 400),
  }, context.actorUserId, repos);
  return updated;
  };
  return repos.withTransaction ? repos.withTransaction(save) : save();
  });
}

/** Undo a retirement. The chunk returns to search and is re-indexed on its next re-embed. */
export async function restoreChunk(
  workspaceId: string,
  chunkId: string,
  repos: RepositoryBundle = createRepositories(),
  actorUserId?: string,
): Promise<KnowledgeBaseChunk | null> {
  return oneAtATime(`knowledge-chunk:${workspaceId}:${chunkId}`, async () => {
  const save = async () => {
  const [chunk] = await repos.knowledgeBaseChunk.listByIds(workspaceId, [chunkId]);
  if (!chunk) return null;
  if (!isSuperseded(chunk)) return chunk;
  const metadata = { ...(chunk.metadata || {}) };
  delete metadata.supersededBy;
  const updated = await repos.knowledgeBaseChunk.updateMetadata(workspaceId, chunkId, metadata);
  await writeAudit(workspaceId, "knowledge.chunk.restored", chunkId, {}, actorUserId, repos);
  return updated;
  };
  return repos.withTransaction ? repos.withTransaction(save) : save();
  });
}

/** Every retired line, for the screen that lets the owner review or undo them. */
export async function listRetiredChunks(workspaceId: string, repos: RepositoryBundle = createRepositories()) {
  const chunks = await repos.knowledgeBaseChunk.listByWorkspace(workspaceId);
  return chunks
    .filter(isSuperseded)
    .map((chunk) => ({
      chunkId: chunk.id,
      text: chunk.chunkText,
      sourceFileName: typeof chunk.metadata?.sourceFileName === "string" ? chunk.metadata.sourceFileName : undefined,
      retired: chunk.metadata?.supersededBy as SupersededMark,
    }))
    .sort((a, b) => String(b.retired?.at || "").localeCompare(String(a.retired?.at || "")));
}

async function writeAudit(
  workspaceId: string,
  eventType: string,
  chunkId: string,
  payload: Record<string, unknown>,
  actorUserId = "user_owner",
  repos: RepositoryBundle = createRepositories(),
) {
  // Saved source changes and their trace belong to the same transaction.
  // A failed audit must not leave an unexplained change in AI knowledge.
  await repos.auditLog.create({
        workspaceId,
        actorUserId,
        eventType,
        entityType: "knowledge_base_chunk",
        entityId: chunkId,
        payload,
        createdAt: timestamp(),
  });
}
