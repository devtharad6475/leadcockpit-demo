/**
 * KnowledgeSourceIndexingService — the uploaded documents themselves become
 * searchable (2026-09-18, session 57).
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
 * An upload took this path: file → extracted text → 424 questions answered →
 * ANSWERS stored in the knowledge base. The document's own text was kept as a
 * source record and never entered the searchable index. So when a customer
 * asked something the question framework does not cover — and 424 questions
 * cannot cover a company — the AI searched only the pre-written answers and
 * found nothing, while the sentence that answered it sat in the PDF the owner
 * had already uploaded.
 *
 * Each ready source now becomes a knowledge document of its own, chunked and
 * embedded like any other. The question framework keeps its separate job:
 * telling the owner what is MISSING, and producing approved facts that other
 * agents read as structured fields.
 *
 * ── THESE CHUNKS ARE UNVERIFIED, AND SAY SO ─────────────────────────────────
 * Nobody has reviewed a line lifted out of a PDF. Every chunk written here is
 * marked `extractionUnverified`, which the product already understands: such a
 * chunk does not raise the confidence that decides whether the AI may answer a
 * customer on its own, and it reaches the model with a label saying it must not
 * be quoted as fact. Approved answers outrank it on a tie (see chunk-authority),
 * and a line the owner has corrected is retired outright
 * (see KnowledgeCorrectionService).
 *
 * ── RE-RUNNING IS SAFE ──────────────────────────────────────────────────────
 * Indexing the same file twice replaces its document rather than adding a
 * second copy — keyed on the file name, which is what the owner sees and what
 * a re-upload of a corrected file carries. Replacing a document deletes its old
 * chunks, and deleting a chunk deletes its vector, so no stale copy survives.
 */
import type { KnowledgeExtractionSource } from "@/lib/types";
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { chunkKnowledgeDocument } from "@/services/KnowledgeBaseService";

/** The documentType every indexed source carries, so the screen can group them. */
export const UPLOADED_SOURCE_DOCUMENT_TYPE = "uploaded_source";
/** The `source` value that makes chunkKnowledgeDocument mark chunks unverified. */
const UPLOADED_SOURCE = "uploaded_document";

export type IndexedSourceResult = {
  sourceId: string;
  documentId: string;
  title: string;
  chunkCount: number;
  replacedExisting: boolean;
};

/**
 * Index these sources into the knowledge base. Best-effort per source: one file
 * that fails to chunk must not stop the others, and none of it may fail the
 * extraction it follows — the answers are already saved by then.
 */
export async function indexSourcesIntoKnowledgeBase(
  workspaceId: string,
  sources: KnowledgeExtractionSource[],
  repos: RepositoryBundle = createRepositories(),
): Promise<IndexedSourceResult[]> {
  const results: IndexedSourceResult[] = [];
  const existing = await repos.knowledgeBaseDocument.listByWorkspace(workspaceId);

  for (const source of sources) {
    const text = (source.extractedText || "").trim();
    if (source.status !== "ready" || !text) continue;
    const label = source.sourceFileName || source.sourceTitle || source.sourceUrl || "Uploaded source";
    try {
      // Keyed on the file name (or URL), so re-uploading a corrected file
      // replaces the old one instead of leaving both in the index.
      const previous = existing.find(
        (doc) =>
          doc.documentType === UPLOADED_SOURCE_DOCUMENT_TYPE &&
          (doc.metadata?.sourceFileName === label ||
            (Boolean(source.sourceUrl) && doc.metadata?.sourceUrl === source.sourceUrl) ||
            (!source.sourceFileName && !source.sourceUrl &&
              doc.metadata?.sourceType === source.sourceType && doc.title === label)),
      );
      const metadata = {
        sourceFileName: source.sourceFileName,
        sourceUrl: source.sourceUrl,
        sourceType: source.sourceType,
        bundleId: source.bundleId,
        extractionUnverified: true,
      };
      const document = previous
        ? await repos.knowledgeBaseDocument.update(workspaceId, previous.id, { title: label, contentText: text, metadata })
        : await repos.knowledgeBaseDocument.create(workspaceId, {
            title: label,
            documentType: UPLOADED_SOURCE_DOCUMENT_TYPE,
            source: UPLOADED_SOURCE,
            status: "active",
            contentText: text,
            metadata,
          });
      // The next source in this same bundle must see this write too: duplicate
      // file names in one request replace their source rather than append it.
      const previousIndex = existing.findIndex(doc => doc.id === document.id);
      if (previousIndex >= 0) existing[previousIndex] = document;
      else existing.push(document);
      const chunks = await chunkKnowledgeDocument(workspaceId, document.id, repos);
      results.push({
        sourceId: source.id,
        documentId: document.id,
        title: label,
        chunkCount: chunks.length,
        replacedExisting: Boolean(previous),
      });
    } catch (error) {
      console.warn(`[knowledge-index] could not index ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return results;
}
