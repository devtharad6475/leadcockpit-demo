/**
 * SemanticRetriever — HYBRID retrieval for the Knowledge Base (GAP-1/4).
 *
 * Authority: docs/planning/CAPABILITY_GAP_AUDIT.md GAP-1/4 + docs/LOGIC.md CP-16.
 *
 * THE GAP THIS CLOSES: KB retrieval was bag-of-words keyword matching
 * (KeywordRetriever) despite the catalog advertising embedding/semantic search.
 * A query "gold border" has to be able to match a chunk written as "zari
 * trimming" — the core value for a textile business.
 *
 * ── WHY HYBRID AND NOT PURE VECTORS (2026-09-17, session 56) ────────────────
 * Vectors alone are worse than keywords at exactly the things a business asks
 * about: a part number, a GSTIN, a person's name, "Rs 295". Those are rare
 * tokens, and an embedding blurs them into the sentence around them. Keywords
 * alone miss every paraphrase. So both searches run, and their results are
 * fused — this is standard practice, not a compromise.
 *
 * The fusion is Reciprocal Rank Fusion: a chunk's fused weight is the sum of
 * 1/(K + rank) over the lists it appears in. It uses RANKS, not scores, so a
 * cosine similarity (0.8 is a good match) and a keyword score (fraction of the
 * query's words present) never have to be made comparable — which is the step
 * that usually goes wrong. Appearing in both lists beats topping either one.
 *
 * The `score` FIELD each result carries is deliberately NOT the RRF weight: it
 * stays max(keyword, cosine), because callers read it as a confidence and
 * compare it against fixed thresholds (getRelevantContext: answerUsed at 0.35).
 * RRF decides the ORDER; the score keeps its meaning.
 *
 * ── WHERE THE VECTOR SEARCH RUNS ────────────────────────────────────────────
 * Against the pgvector HNSW index when the database has one (production), which
 * is a logarithmic index lookup of just the top chunks. Where it does not exist
 * (local/CI on stock postgres, and the JSON demo substrate), it falls back to
 * loading the workspace's chunks and comparing in memory — the old behaviour,
 * correct but linear. See src/rag/vector-store.ts.
 *
 * ── HONEST FALLBACK (CP-16) ─────────────────────────────────────────────────
 * No embedding key, spend cap reached, provider down, or no chunk has a vector
 * → plain keyword results. Retrieval degrades, it never crashes and never
 * invents a match.
 *
 * ── VECTORS ARE ONLY COMPARED WITH THEIR OWN MODEL ──────────────────────────
 * Cosine similarity between vectors from two different models is noise that
 * looks like a number. Every chunk records the model that embedded it
 * (metadata.embeddingModel), and only chunks carrying the model the QUERY was
 * embedded with take part in the vector half. Chunks embedded before labels
 * existed count only when the caller injected an embedder and named no model,
 * which is the goldens' deterministic-stub case.
 */
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { KnowledgeBaseChunk } from "@/lib/types";
import { KeywordRetriever } from "./KeywordRetriever";
import type { Retriever, RetrieveOptions, RetrievalResult } from "./Retriever";
import { activeEmbeddingModel, cosineSimilarity, embedQuery, embedTexts, type EmbedFn } from "@/llm/embedding";
import { searchChunkVectors } from "./vector-store";
import { authorityRank, isSuperseded, withoutSuperseded } from "./chunk-authority";

export type SemanticRetrieverOptions = {
  /** Override the embedding function (tests inject a deterministic stub). */
  embed?: EmbedFn;
  /**
   * The model the injected embedder imitates. Omitted with an injected
   * embedder means "compare against unlabelled vectors too".
   */
  embeddingModel?: string;
  /**
   * Override the vector-index lookup. Injected by the golden so the indexed
   * path can be proven on a machine with no pgvector; production uses the real
   * one, which returns null wherever the index does not exist.
   */
  vectorSearch?: typeof searchChunkVectors;
  /**
   * Seam: embed the query AND report which model actually made the vector.
   * The default goes through the real provider chain. Injected by the golden
   * that proves the label fix without a billed call.
   */
  embedWithModel?: (workspaceId: string, text: string, repos: RepositoryBundle) => Promise<{ vector: number[]; model: string }>;
};

/**
 * RRF's smoothing constant. 60 is the value from the paper the method comes
 * from and the one every implementation uses; it flattens the difference
 * between ranks 1 and 2 enough that a chunk found by both searches outranks a
 * chunk that merely tops one of them.
 */
const RRF_K = 60;
/** How deep each search goes before fusing. Fusing only the final N would waste both lists. */
const POOL_MULTIPLIER = 4;

type Scored = KnowledgeBaseChunk & { score: number; documentTitle?: string };

export class SemanticRetriever implements Retriever {
  private readonly keyword: KeywordRetriever;
  private readonly embedFn: EmbedFn;
  private readonly injected: boolean;
  private readonly embeddingModel?: string;
  private readonly indexSearch: typeof searchChunkVectors;
  private readonly embedWithModel: NonNullable<SemanticRetrieverOptions["embedWithModel"]>;

  constructor(
    private readonly repos: RepositoryBundle,
    options: SemanticRetrieverOptions = {},
  ) {
    this.keyword = new KeywordRetriever(repos);
    this.embedFn = options.embed ?? embedQuery;
    this.injected = Boolean(options.embed);
    this.embeddingModel = options.embeddingModel;
    this.indexSearch = options.vectorSearch ?? searchChunkVectors;
    this.embedWithModel = options.embedWithModel ?? (async (workspaceId, text, repos) => {
      const made = await embedTexts(workspaceId, [text], repos, "query");
      return { vector: made.vectors[0], model: made.model };
    });
  }

  async retrieve(workspaceId: string, query: string, options: RetrieveOptions = {}): Promise<RetrievalResult> {
    const limit = options.limit || 5;
    const pool = limit * POOL_MULTIPLIER;
    // Legacy instruction chunks may lack metadata. Inspect their parent
    // documents too, so a specialist's guidance can never become another
    // specialist's company knowledge (or inflate reply confidence).
    const documents = await this.repos.knowledgeBaseDocument.listByWorkspace(workspaceId);
    const instructionIds = new Set(documents
      .filter((document) => document.documentType === "agent_instruction" || document.source === "workspace_override")
      .map((document) => document.id));
    const isCompanyKnowledge = (chunk: KnowledgeBaseChunk) => !instructionIds.has(chunk.documentId)
      && chunk.metadata?.documentType !== "agent_instruction"
      && chunk.metadata?.source !== "workspace_override";

    // The keyword half always runs: it is the floor, and it is what still
    // answers when there is no embedding provider at all.
    //
    // RETIRED CHUNKS ARE DROPPED HERE, in both halves, because this class is
    // the one door every knowledge search goes through (session 57). A chunk
    // the owner has corrected must be unreachable by ANY route — otherwise the
    // customer is told the old price by whichever half happened to match.
    const keywordHits = withoutSuperseded(await this.keyword.retrieve(workspaceId, query, { limit: pool })).filter(isCompanyKnowledge);

    // N-AI-9 (2026-08-26): embedding the query is METERED spend, so the
    // workspace whose search this is pays for it. It used to be billed to the
    // platform and attributed to nobody.
    let queryEmbedding: number[] | undefined;
    // The model that ACTUALLY made the query vector. Not activeEmbeddingModel():
    // that names the FIRST configured provider, and when Ollama is switched on
    // but not running, the vector comes from the next one (OpenAI) while the
    // label said Ollama — so every stored OpenAI vector was ruled "not
    // comparable" and meaning-search silently did nothing (2026-09-23, N10).
    let queryModel: string | undefined;
    try {
      if (this.injected) {
        queryEmbedding = await this.embedFn(workspaceId, query, this.repos);
      } else {
        const made = await this.embedWithModel(workspaceId, query, this.repos);
        queryEmbedding = made.vector;
        queryModel = made.model;
      }
    } catch {
      // No key / over the spend cap / provider down → keyword only.
      return keywordHits.slice(0, limit);
    }
    if (!Array.isArray(queryEmbedding) || !queryEmbedding.length) return keywordHits.slice(0, limit);

    const vectorHits = (await this.rankByVector(workspaceId, queryEmbedding, pool, queryModel)).filter(isCompanyKnowledge);
    if (!vectorHits.length) return keywordHits.slice(0, limit);
    if (!keywordHits.length) return vectorHits.slice(0, limit);
    return this.fuse(keywordHits, vectorHits, limit);
  }

  /** The model a stored vector must be labelled with to be comparable with this query's. */
  private modelForQuery(queryModel?: string): string | null {
    if (this.injected) return this.embeddingModel ?? null;
    return this.embeddingModel ?? queryModel ?? activeEmbeddingModel();
  }

  private async rankByVector(workspaceId: string, queryEmbedding: number[], pool: number, queryModel?: string): Promise<Scored[]> {
    const model = this.modelForQuery(queryModel);

    // FAST PATH: the pgvector HNSW index, when the database has one.
    if (model) {
      const hits = await this.indexSearch(workspaceId, model, queryEmbedding, pool);
      if (hits) {
        const chunks = await this.repos.knowledgeBaseChunk.listByIds(workspaceId, hits.map((hit) => hit.chunkId));
        const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
        const rows: Scored[] = [];
        for (const hit of hits) {
          const chunk = byId.get(hit.chunkId);
          // An id with no chunk behind it is a stale index row, not a match.
          if (!chunk || !(hit.similarity > 0)) continue;
          rows.push({ ...chunk, score: hit.similarity, documentTitle: this.docTitle(chunk) });
        }
        return withoutSuperseded(rows);
      }
      // hits === null: no index on this database. Fall through and compare in memory.
    }

    // FALLBACK: compare the stored vectors in memory. Correct, and linear in
    // the size of the workspace's knowledge base.
    const allChunks = await this.repos.knowledgeBaseChunk.listByWorkspace(workspaceId);
    return allChunks
      .filter((chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length > 0 && this.comparable(chunk, model))
      .map((chunk) => ({ ...chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding!), documentTitle: this.docTitle(chunk) }))
      .filter((row) => row.score > 0 && !isSuperseded(row))
      .sort((a, b) => b.score - a.score)
      .slice(0, pool);
  }

  /** Whether this chunk's vector was made by the same model as the query's. */
  private comparable(chunk: KnowledgeBaseChunk, model: string | null): boolean {
    const label = (chunk.metadata || {}).embeddingModel;
    if (!model) return typeof label !== "string" || !label; // unlabelled only (injected stub)
    return label === model;
  }

  /**
   * Reciprocal Rank Fusion of the two lists. Order comes from the fused weight;
   * the score each result keeps is the stronger of its two scores, so callers
   * that threshold on it keep reading it as a confidence.
   */
  private fuse(keywordHits: Scored[], vectorHits: Scored[], limit: number): Scored[] {
    const fused = new Map<string, { row: Scored; weight: number; score: number }>();
    const add = (rows: Scored[]) => {
      rows.forEach((row, index) => {
        const existing = fused.get(row.id);
        const weight = 1 / (RRF_K + index + 1);
        if (existing) {
          existing.weight += weight;
          existing.score = Math.max(existing.score, row.score);
        } else {
          fused.set(row.id, { row, weight, score: row.score });
        }
      });
    };
    add(keywordHits);
    add(vectorHits);
    return [...fused.values()]
      .sort((a, b) => b.weight - a.weight || authorityRank(b.row) - authorityRank(a.row) || b.score - a.score)
      .slice(0, limit)
      .map((entry) => ({ ...entry.row, score: entry.score }));
  }

  private docTitle(chunk: { metadata?: Record<string, unknown> }): string | undefined {
    const meta = chunk.metadata || {};
    return typeof meta.documentTitle === "string" ? meta.documentTitle : undefined;
  }
}
