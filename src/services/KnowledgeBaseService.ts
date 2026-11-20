import { chunkByStructure } from "@/rag/document-structure";
import type { BusinessProfile, KnowledgeBaseChunk, KnowledgeBaseDocument } from "@/lib/types";
import { SemanticRetriever } from "@/rag/SemanticRetriever";
import type { EmbedFn } from "@/llm/embedding";
import { embedChunks } from "@/rag/embed-chunks";
import { createRepositories } from "@/repositories";
import { normalizeAgentName, pickCurrentAgentInstruction } from "@/lib/agent-instruction-selection";
import type { RepositoryBundle } from "@/repositories/interfaces";

export type KnowledgeSearchResult = {
  chunks: Array<KnowledgeBaseChunk & { score: number; documentTitle?: string }>;
  confidenceScore: number;
};

// 1200, not 900: a chunk now holds a whole section or whole table rows.
const CHUNK_SIZE = 1200;

export async function createKnowledgeDocument(input: Partial<KnowledgeBaseDocument> & { workspaceId: string; title: string; contentText: string }, repos = createRepositories()) {
  return repos.knowledgeBaseDocument.create(input.workspaceId, {
    id: input.id,
    title: input.title,
    documentType: input.documentType || "other",
    source: input.source || "manual",
    status: input.status || "active",
    contentText: input.contentText,
    metadata: input.metadata || {},
  });
}

/**
 * N-AI-11 (2026-08-27): editing a document used to be a bare repo update, which
 * left the derived KnowledgeBaseChunk rows holding the OLD chunkText and the OLD
 * embedding. Retrieval reads chunkText, never document.contentText — so the
 * screen showed the new text while the AI kept quoting the old text to
 * customers. The rebuild belongs HERE, not in the route: every present and
 * future caller of this function gets it, which is the whole point of putting
 * the choke point at the service layer.
 *
 * Rebuild is skipped when the content did not actually change, because chunking
 * embeds every chunk and embedding is metered spend (see N-AI-9). A title-only
 * edit must not cost money.
 */
export async function updateKnowledgeDocument(workspaceId: string, documentId: string, input: Partial<KnowledgeBaseDocument>, repos = createRepositories(), options: { embedFn?: EmbedFn } = {}) {
  const before = await repos.knowledgeBaseDocument.getById(workspaceId, documentId);
  const document = await repos.knowledgeBaseDocument.update(workspaceId, documentId, input);
  const contentChanged = typeof input.contentText === "string" && input.contentText !== (before?.contentText ?? "");
  if (contentChanged) {
    await chunkKnowledgeDocument(workspaceId, documentId, repos, options);
  }
  return document;
}

// Re-exported so callers that already import from this service keep one import.
export { normalizeAgentName, pickCurrentAgentInstruction };

/**
 * N-AI-12 (2026-08-27): the agent-instruction save used to always CREATE a new
 * knowledge document, never update the existing one, so a workspace accumulated
 * one row per save. AgentInstructionLoader took first-match-wins over an
 * unordered list, which on the JSON substrate is insertion order — the OLDEST
 * instruction won, forever, no matter how many times the owner corrected it.
 *
 * One agent has exactly one workspace override, so this is an upsert keyed on
 * (documentType="agent_instruction", metadata.agentName). Agent names are
 * compared with underscores and hyphens treated as the same character, matching
 * what AgentInstructionLoader does at read time.
 */
export async function saveAgentInstruction(workspaceId: string, agentName: string, contentText: string, repos = createRepositories(), input: Partial<KnowledgeBaseDocument> = {}, options: { embedFn?: EmbedFn } = {}) {
  const documents = await repos.knowledgeBaseDocument.listByWorkspace(workspaceId);
  const existing = pickCurrentAgentInstruction(documents, agentName);
  const metadata = { ...(input.metadata || {}), agentName };
  const document = existing
    ? await repos.knowledgeBaseDocument.update(workspaceId, existing.id, {
      title: input.title || existing.title,
      contentText,
      metadata,
      status: input.status || existing.status,
    })
    : await repos.knowledgeBaseDocument.create(workspaceId, {
      title: input.title || `${agentName} workspace instructions`,
      documentType: "agent_instruction",
      source: input.source || "workspace_override",
      status: input.status || "active",
      contentText,
      metadata,
    });
  // Job guidance belongs only to its selected specialist, never the searchable
  // company facts. Clear legacy chunks even on an unchanged save; do not embed.
  void options;
  const chunks = await repos.knowledgeBaseChunk.replaceForDocument(workspaceId, document.id, []);
  return { document, chunks, replacedExisting: Boolean(existing) };
}

export async function listKnowledgeDocuments(workspaceId: string, repos = createRepositories()) {
  return repos.knowledgeBaseDocument.listByWorkspace(workspaceId);
}

export async function getKnowledgeDocument(workspaceId: string, documentId: string, repos = createRepositories()) {
  return repos.knowledgeBaseDocument.getById(workspaceId, documentId);
}

export async function chunkKnowledgeDocument(workspaceId: string, documentId: string, repos = createRepositories(), options: { embedFn?: EmbedFn; embeddingModel?: string } = {}) {
  const document = await repos.knowledgeBaseDocument.getById(workspaceId, documentId);
  if (!document) throw new Error("Knowledge document not found");
  if (document.documentType === "agent_instruction" || document.source === "workspace_override") {
    return repos.knowledgeBaseChunk.replaceForDocument(workspaceId, documentId, []);
  }
  // M3.4 / O2 audit fix: propagate the document's extractionUnverified flag
  // onto every chunk's metadata, so the retriever can filter unverified
  // chunks out of customer-facing context. Previously the flag was stamped
  // on the document but never reached retrieval, letting unverified extraction
  // be quoted to customers.
  const docMeta = (document.metadata || {}) as Record<string, unknown>;
  const extractionUnverified = Boolean(docMeta.extractionUnverified) || document.source === "uploaded_document";
  const chunks = splitText(document.contentText).map((chunkText, index): Partial<KnowledgeBaseChunk> => ({
    chunkIndex: index,
    chunkText,
    metadata: {
      documentType: document.documentType,
      source: document.source || "manual",
      extractionUnverified,
      documentId: document.id,
    },
  }));
  // GAP-1/4 (2026-07-31): generate an embedding for each chunk so the
  // SemanticRetriever can rank by cosine similarity (paraphrase matching).
  // Best-effort: if no embedding key is configured, chunks are stored WITHOUT
  // vectors and retrieval degrades honestly to keyword. This must never make
  // chunking fail — a missing key is the common JSON-demo case. The embedFn is
  // injectable so the golden can use a deterministic stub.
  //
  // N-AI-9 (2026-08-26): the workspace and the repositories are threaded through
  // because embedding is METERED spend. One document is one call per chunk, so
  // this loop is the highest-volume paid-AI path in the product — it used to be
  // billed to the platform and attributed to nobody.
  if (options.embedFn) {
    // An injected embedder (tests) — one call per chunk, as before. It is not
    // labelled with a model unless the caller says which one it is.
    for (const chunk of chunks) {
      try {
        chunk.embedding = await options.embedFn(workspaceId, chunk.chunkText || "", repos);
        if (options.embeddingModel) chunk.metadata = { ...(chunk.metadata || {}), embeddingModel: options.embeddingModel };
      } catch {
        // No key / over spend cap / embedding unavailable → leave embedding unset.
        // Chunking must never fail for this: the document is still stored and
        // still searchable by keyword. Deliberately per-chunk rather than
        // aborting the loop, because a transient failure on one chunk must not
        // discard the rest.
      }
    }
  } else {
    // 2026-09-17 (session 56): the real path is batched — one provider request
    // per 64 chunks instead of one per chunk — and every vector is labelled
    // with the model that made it, so a search never compares vectors from two
    // different models. See src/rag/embed-chunks.ts.
    // Re-chunking the same document reuses the vectors of unchanged chunks.
    const previous = await repos.knowledgeBaseChunk.listByDocument(workspaceId, documentId);
    const embedded = await embedChunks(workspaceId, chunks, repos, previous);
    return repos.knowledgeBaseChunk.replaceForDocument(workspaceId, documentId, embedded);
  }
  return repos.knowledgeBaseChunk.replaceForDocument(workspaceId, documentId, chunks);
}

export async function searchKnowledge(workspaceId: string, query: string, repos = createRepositories()): Promise<KnowledgeSearchResult> {
  // GAP-1/4 (2026-07-31): semantic-first retrieval (cosine similarity over
  // stored embeddings → paraphrase matching), with an honest keyword fallback
  // when embeddings are unavailable (no key / un-embedded chunks). Previously
  // this was keyword-only despite the catalog advertising semantic search.
  const retriever = new SemanticRetriever(repos);
  const chunks = await retriever.retrieve(workspaceId, query, { limit: 5 });
  const confidenceScore = chunks[0]?.score ? Math.min(0.95, chunks[0].score) : 0;
  await repos.knowledgeBaseQueryLog.create(workspaceId, {
    queryText: query,
    retrievedChunks: chunks.map((item) => ({ id: item.id, score: item.score, documentTitle: item.documentTitle })),
    answerUsed: confidenceScore >= 0.35,
    confidenceScore,
  });
  return { chunks, confidenceScore };
}

/**
 * Helper: returns true when a chunk is verified (safe to quote to customers).
 * M3.4 / O2 audit fix. A chunk is unverified when its metadata explicitly
 * marks it so, OR when it comes from an uploaded_document source that has
 * not passed owner review.
 */
export function isVerifiedChunk(chunk: { metadata?: Record<string, unknown> } | undefined): boolean {
  if (!chunk?.metadata) return true;
  if (chunk.metadata.documentType === "agent_instruction" || chunk.metadata.source === "workspace_override") return false;
  return chunk.metadata.extractionUnverified !== true;
}

/**
 * Marks a chunk that extraction produced but nobody verified. Exported so the
 * consumers that must not repeat such a chunk to a customer can recognise one,
 * rather than each re-typing the sentence and drifting from it.
 */
export const UNVERIFIED_CHUNK_MARKER = "[UNVERIFIED EXTRACTION — do not quote as fact to the customer]";

export async function getRelevantContext(workspaceId: string, query: string, repos = createRepositories()) {
  const result = await searchKnowledge(workspaceId, query, repos);
  // M3.4 / O2: split chunks into verified vs unverified. Customer-facing
  // confidence is computed from VERIFIED chunks only — unverified extraction
  // must not push the WhatsApp engine past its auto-reply threshold.
  const verifiedChunks = result.chunks.filter(isVerifiedChunk);
  const verifiedConfidence = verifiedChunks[0]?.score ? Math.min(0.95, verifiedChunks[0].score) : 0;
  return {
    // Context text still includes unverified chunks for the agent to read,
    // but they are clearly labelled so the prompt can instruct the LLM not
    // to quote them as fact.
    contextText: result.chunks.map((chunk) => {
      const prefix = isVerifiedChunk(chunk) ? "" : `${UNVERIFIED_CHUNK_MARKER} `;
      return `${prefix}${chunk.chunkText}`;
    }).join("\n\n"),
    chunks: result.chunks,
    confidenceScore: verifiedConfidence,
    unverifiedChunkCount: result.chunks.length - verifiedChunks.length,
  };
}

export async function syncBusinessProfileToKnowledgeBase(workspaceId: string, repos = createRepositories(), options: { embedFn?: EmbedFn; force?: boolean } = {}) {
  const profile = await repos.businessProfile.getByWorkspace(workspaceId);
  if (!profile) throw new Error("Business profile not found");
  const contentText = profileToKnowledge(profile);
  const existing = await repos.knowledgeBaseDocument.getByTypeAndSource(workspaceId, "company_profile", "business_profile");
  const document = existing
    ? await repos.knowledgeBaseDocument.update(workspaceId, existing.id, {
      title: `${profile.companyName || "Business"} profile knowledge`,
      contentText,
      metadata: { syncedFromProfileId: profile.id },
    })
    : await repos.knowledgeBaseDocument.create(workspaceId, {
      title: `${profile.companyName || "Business"} profile knowledge`,
      documentType: "company_profile",
      source: "business_profile",
      status: "active",
      contentText,
      metadata: { syncedFromProfileId: profile.id },
    });
  // N-AI-10 (2026-08-27): this now runs automatically on every profile save, so
  // it must be cheap when nothing changed. Chunking embeds every chunk and
  // embedding is metered spend — re-embedding an unchanged profile on each of
  // the many small saves an operator makes during onboarding would be pure
  // waste. `force` exists for the manual Sync button, which the operator
  // presses precisely when they want the rebuild to happen regardless.
  const contentChanged = !existing || existing.contentText !== contentText;
  if (!contentChanged && !options.force) {
    return { document, chunks: [], skipped: true as const };
  }
  const chunks = await chunkKnowledgeDocument(workspaceId, document.id, repos, options);
  return { document, chunks, skipped: false as const };
}

/**
 * N-AI-10: called from every business-profile write path so the AI's searchable
 * copy is rebuilt when the operator saves, instead of waiting for a human to
 * remember the manual Sync button. Never throws: a failed rebuild must not lose
 * the operator's saved profile. Returns whether the rebuild happened so the
 * caller can tell the truth on screen.
 */
export async function refreshBusinessProfileKnowledge(workspaceId: string, repos = createRepositories()) {
  // Session 55: this ran only syncBusinessProfileToKnowledgeBase, which writes
  // the profile as a knowledge DOCUMENT. The framework ANSWERS — what the agent
  // actually quotes when a customer asks who it is talking to — were never
  // touched, so the Profile screen and `factual_company_profile/
  // legal_company_name` could disagree forever with nothing comparing them.
  // Observed live: the screen said "Om Jari & Metallic" while the answer still
  // said "TechNova Solutions" from an old extraction.
  //
  // Both halves run, and the answer sync is reported separately so a failure in
  // one is not read as success of the other. This is the chokepoint every
  // profile write goes through (create, update and approve), which is why it is
  // done here rather than at three call sites.
  let synced = false;
  let unchanged = false;
  let documentError: string | undefined;
  try {
    const result = await syncBusinessProfileToKnowledgeBase(workspaceId, repos);
    synced = !result.skipped;
    unchanged = Boolean(result.skipped);
  } catch (error) {
    console.warn(`[N-AI-10] business profile saved but knowledge rebuild failed for workspace ${workspaceId}:`, error instanceof Error ? error.message : error);
    documentError = error instanceof Error ? error.message : String(error);
  }

  let answersUpdated = 0;
  let answerConflicts = 0;
  let answersError: string | undefined;
  try {
    const profile = await repos.businessProfile.getByWorkspace(workspaceId);
    if (profile) {
      const { syncBusinessProfileToQuestions } = await import("@/services/StructuredSettingsQuestionMappingService");
      const answers = await syncBusinessProfileToQuestions(workspaceId, {
        companyName: profile.companyName,
        industry: profile.industry,
        websiteUrl: profile.websiteUrl,
        contactEmail: profile.contactEmail,
        contactPhone: profile.contactPhone,
        address: profile.address,
        businessType: profile.businessType,
        description: profile.description,
      }, repos);
      answersUpdated = answers.updatedAnswers;
      answerConflicts = answers.conflicts;
    }
  } catch (error) {
    console.warn(`[session 55] business profile saved but the question answers were not updated for workspace ${workspaceId}:`, error instanceof Error ? error.message : error);
    answersError = error instanceof Error ? error.message : String(error);
  }

  return {
    synced,
    unchanged,
    answersUpdated,
    answerConflicts,
    ...(documentError ? { error: documentError } : {}),
    ...(answersError ? { answersError } : {}),
  };
}

export function createKnowledgeBaseService(repos: RepositoryBundle = createRepositories()) {
  return {
    createDocument: (input: Partial<KnowledgeBaseDocument> & { workspaceId: string; title: string; contentText: string }) => createKnowledgeDocument(input, repos),
    updateDocument: (workspaceId: string, documentId: string, input: Partial<KnowledgeBaseDocument>) => updateKnowledgeDocument(workspaceId, documentId, input, repos),
    listDocuments: (workspaceId: string) => listKnowledgeDocuments(workspaceId, repos),
    getDocument: (workspaceId: string, documentId: string) => getKnowledgeDocument(workspaceId, documentId, repos),
    chunkDocument: (workspaceId: string, documentId: string) => chunkKnowledgeDocument(workspaceId, documentId, repos),
    searchKnowledge: (workspaceId: string, query: string) => searchKnowledge(workspaceId, query, repos),
    getRelevantContext: (workspaceId: string, query: string) => getRelevantContext(workspaceId, query, repos),
    syncBusinessProfileToKnowledgeBase: (workspaceId: string) => syncBusinessProfileToKnowledgeBase(workspaceId, repos),
    refreshBusinessProfileKnowledge: (workspaceId: string) => refreshBusinessProfileKnowledge(workspaceId, repos),
    saveAgentInstruction: (workspaceId: string, agentName: string, contentText: string, input?: Partial<KnowledgeBaseDocument>) => saveAgentInstruction(workspaceId, agentName, contentText, repos, input),
  };
}

/**
 * 2026-09-17 (session 56): section- and table-aware. This used to pack
 * paragraphs up to 900 characters with no idea what a table or a heading was,
 * so a stored price row could lose the column names that say which quantity
 * band each price is for. See src/rag/document-structure.ts.
 */
function splitText(text: string) {
  const chunks = chunkByStructure(text, CHUNK_SIZE);
  return chunks.length ? chunks : [String(text || "").slice(0, CHUNK_SIZE)];
}

function profileToKnowledge(profile: BusinessProfile) {
  return [
    `Company: ${profile.companyName || "Unknown"}`,
    `Industry: ${profile.industry || "Unknown"}`,
    `Business type: ${profile.businessType || "Unknown"}`,
    `Description: ${profile.description || "Not provided"}`,
    `Products: ${profile.products.join(", ") || "Not provided"}`,
    `Services: ${profile.services.join(", ") || "Not provided"}`,
    `Product categories: ${profile.productCategories.join(", ") || "Not provided"}`,
    `Target geographies: ${profile.targetGeographies.join(", ") || "Not provided"}`,
    `Current customers: ${profile.currentCustomerTypes.join(", ") || "Not provided"}`,
    `Desired customers: ${profile.desiredCustomerTypes.join(", ") || "Not provided"}`,
    `Strengths: ${profile.strengths.join(", ") || "Not provided"}`,
    `Limitations: ${profile.limitations.join(", ") || "Not provided"}`,
    `Certifications: ${profile.certifications.join(", ") || "Not provided"}`,
    `Contact email: ${profile.contactEmail || "Not provided"}`,
    `Phone: ${profile.contactPhone || "Not provided"}`,
    `WhatsApp: ${profile.whatsappNumber || "Not provided"}`,
    `Address: ${[profile.address, profile.city, profile.state, profile.country].filter(Boolean).join(", ") || "Not provided"}`,
    `Catalogue links: ${profile.catalogueLinks.join(", ") || "Not provided"}`,
  ].join("\n");
}
