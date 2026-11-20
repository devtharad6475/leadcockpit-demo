/**
 * search-status.ts — is meaning-search actually working here? (N10, 2026-09-23)
 *
 * Until this existed nobody could tell. Meaning-search degrades silently to
 * keyword search — by design, so a missing key never breaks a customer reply —
 * and the price of that design is that "switched on and working" and "switched
 * on and doing nothing" looked identical from every screen. The first
 * measurement of it (session 57) found it added nothing, and could not say
 * whether that was because it is weak or because no passage had a vector.
 * Locally it was the second: 163 passages, 0 vectors.
 *
 * Counts only. No model call, no spend.
 */
import type { RepositoryBundle } from "@/repositories/interfaces";
import { configuredEmbeddingModels } from "@/llm/embedding";

export type SearchStatus = {
  /** "on" only when a provider is configured AND passages carry its vectors. */
  meaningSearch: "on" | "partial" | "off";
  /** Plain sentence for a screen. */
  summary: string;
  passages: number;
  /** Passages a query could actually be compared against right now. */
  searchable: number;
  /** Vectors made by a model that is no longer configured — present but unusable. */
  orphaned: number;
  providers: string[];
};

export async function getSearchStatus(workspaceId: string, repos: RepositoryBundle): Promise<SearchStatus> {
  const providers = configuredEmbeddingModels();
  const usable = new Set(providers);
  const chunks = await repos.knowledgeBaseChunk.listByWorkspace(workspaceId);
  let searchable = 0;
  let orphaned = 0;
  for (const chunk of chunks) {
    if (!Array.isArray(chunk.embedding) || !chunk.embedding.length) continue;
    const label = chunk.metadata?.embeddingModel;
    if (typeof label === "string" && usable.has(label)) searchable += 1;
    else orphaned += 1;
  }
  const passages = chunks.length;

  if (!providers.length) {
    return { meaningSearch: "off", passages, searchable: 0, orphaned, providers,
      summary: "Meaning search is off: no embedding provider is set up, so the AI finds answers by matching words only." };
  }
  if (!searchable) {
    return { meaningSearch: "off", passages, searchable, orphaned, providers,
      summary: `Meaning search is set up but has nothing to search: none of the ${passages} passages has been indexed for it yet. The AI is matching words only.` };
  }
  if (searchable < passages) {
    return { meaningSearch: "partial", passages, searchable, orphaned, providers,
      summary: `Meaning search covers ${searchable} of ${passages} passages. The rest are found by matching words only.` };
  }
  return { meaningSearch: "on", passages, searchable, orphaned, providers,
    summary: `Meaning search is on for all ${passages} passages.` };
}
