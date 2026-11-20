/**
 * embed-chunks.ts — attach labelled embeddings to chunks before they are saved
 * (2026-09-17, session 56).
 *
 * One place for "give these chunks vectors", so every chunk writer embeds the
 * same way: batched, labelled with the model, and never able to fail the save.
 * Chunks come back unchanged when no provider is configured or the spend cap
 * refuses — they stay searchable by keyword, which is the honest fallback.
 *
 * REUSE. The knowledge-answer document is rebuilt on every approved answer, and
 * most of its chunks come out byte-identical to last time. Passing the
 * document's previous chunks lets an unchanged chunk keep its vector instead of
 * paying for it again — only new or edited text is sent to the provider.
 */
import { activeEmbeddingModel, configuredEmbeddingModels, embedTexts } from "@/llm/embedding";
import type { KnowledgeBaseChunk } from "@/lib/types";
import type { RepositoryBundle } from "@/repositories/interfaces";

export async function embedChunks<T extends Partial<KnowledgeBaseChunk>>(
  workspaceId: string,
  chunks: T[],
  repos: RepositoryBundle,
  previous: Array<Partial<KnowledgeBaseChunk>> = [],
): Promise<T[]> {
  if (!chunks.length) return chunks;
  const model = activeEmbeddingModel();
  if (!model) return chunks;

  // Previous vectors made by ANY configured provider, keyed by the exact text.
  // Matching only the first provider (the old rule) meant that with Ollama
  // switched on but not running, every OpenAI vector was judged "not ours" and
  // paid for again on each rebuild — and the rebuild runs on every approval.
  const usable = new Set(configuredEmbeddingModels());
  const reusable = new Map<string, { vector: number[]; label: string }>();
  for (const old of previous) {
    const label = old.metadata?.embeddingModel;
    if (typeof label === "string" && usable.has(label) && typeof old.chunkText === "string" && Array.isArray(old.embedding) && old.embedding.length) {
      reusable.set(old.chunkText, { vector: old.embedding, label });
    }
  }

  const out = chunks.map((chunk) => ({ ...chunk }));
  const missing = out.filter((chunk) => !reusable.has(chunk.chunkText || ""));
  for (const chunk of out) {
    const kept = reusable.get(chunk.chunkText || "");
    if (kept) {
      chunk.embedding = kept.vector;
      // The label of the model that MADE it — relabelling a reused vector with
      // a different model's name would make it compared against the wrong queries.
      chunk.metadata = { ...(chunk.metadata || {}), embeddingModel: kept.label };
    }
  }
  if (!missing.length) return out;

  try {
    const result = await embedTexts(workspaceId, missing.map((chunk) => chunk.chunkText || ""), repos, "document");
    missing.forEach((chunk, index) => {
      chunk.embedding = result.vectors[index];
      chunk.metadata = { ...(chunk.metadata || {}), embeddingModel: result.model };
    });
  } catch {
    // No key / over spend cap / provider down → the new chunks are stored
    // without vectors; reused ones keep theirs.
  }
  return out;
}
