/**
 * embedding.ts — real text-embedding generation (GAP-1/4, 2026-07-31; Ollama 2026-08-05).
 *
 * Authority: docs/planning/CAPABILITY_GAP_AUDIT.md GAP-1/4 + docs/LOGIC.md CP-16.
 *
 * THE GAP THIS CLOSES: the KB advertised "semantic/embedding" search (the model
 * catalog lists text-embedding-3-*, gemini-embedding, etc.; an EmbeddingRetriever
 * class existed) but NO embeddings were ever generated. `EmbeddingRetriever`
 * threw "not implemented" and was never instantiated. This module is the missing
 * "generate embeddings" step.
 *
 * Provider resolution (2026-08-05):
 * 1. Ollama (local, free, no key): if PLATFORM_OLLAMA_BASE_URL is reachable +
 *    PLATFORM_EMBEDDING_MODEL is set (default "nomic-embed-text"), use Ollama's
 *    /api/embeddings endpoint. Zero cost, runs on the operator's machine.
 * 2. OpenAI (cloud, paid): if OPENAI_API_KEY is set, use the OpenAI embeddings API.
 * 3. Neither: throw honestly (callers fall back to keyword retrieval — never
 *    silently present an empty vector as a real embedding).
 *
 * Injectable: the golden passes a deterministic stub `EmbedFn` to prove the
 * retrieval LOGIC (cosine ranking + paraphrase match) without a network call.
 *
 * ── METERED SPEND (N-AI-9, 2026-08-26) ────────────────────────────────────
 * This function used to take a bare string and nothing else. It reached into
 * the PLATFORM's OpenAI key and billed the resulting spend to nobody: no
 * workspace was named, no cap was consulted, no usage was recorded. It is the
 * same defect as N-AI-7 (voice transcription), in the second and last place
 * the product talks to a paid AI provider without going through LLMService.
 *
 * Every other paid AI call in the product goes through LLMService, which
 * gates on `checkCanRunTask` and records with `recordUsage`. These two did not.
 *
 * Volume matters here more than price per call. `chunkKnowledgeDocument`
 * embeds EVERY chunk of a document (one call per ~900 characters), and
 * `SemanticRetriever` embeds EVERY search query. A single large knowledge-base
 * re-index is hundreds of calls; the platform paid for all of them and could
 * not tell you which customer caused it.
 *
 * The gate sits INSIDE this function, not at the call sites, and the workspace
 * is a required parameter. That is the whole point: any future caller is now
 * forced by the compiler to say whose money it is spending. A gate placed at
 * the call sites would be re-lost the first time someone adds a third caller.
 *
 * ONLY THE PAID PATH IS GATED. Ollama runs locally, costs nothing, and is
 * deliberately left ungated — refusing a free local call because of a dollar
 * budget would be wrong. Nothing is recorded for it either, because nothing
 * was spent.
 *
 * A refusal degrades rather than crashes: both callers already catch embedding
 * failures (chunking stores the chunk without a vector, retrieval falls back to
 * keyword search). A workspace over its cap therefore keeps a working keyword
 * knowledge base instead of a broken one — the same behaviour as a workspace
 * with no embedding key configured, which is the honest comparison.
 */
import { assertSafeFetchUrl } from "@/lib/ssrf-guard";
import { checkCanRunTask, recordUsage } from "@/services/AIUsageService";
import type { RepositoryBundle } from "@/repositories/interfaces";

export type EmbedFn = (workspaceId: string, text: string, repos: RepositoryBundle) => Promise<number[]>;

/**
 * 2026-09-17 (session 56) — batched embeddings with a model label.
 *
 * `embedText` made one HTTP request per chunk, so a 60-chunk upload was 60
 * round trips. Both paid providers accept many texts per request, so documents
 * are now embedded in batches.
 *
 * Every vector is also labelled with the model that made it. Vectors from two
 * different models are not comparable even when they have the same length, and
 * nothing used to record which model produced a stored vector — switching
 * provider would have silently ranked search results by noise.
 */
export type EmbeddingPurpose = "document" | "query";
export type EmbedBatchResult = { vectors: number[][]; model: string };
export type EmbedBatchFn = (
  workspaceId: string,
  texts: string[],
  repos: RepositoryBundle,
  purpose?: EmbeddingPurpose,
) => Promise<EmbedBatchResult>;

/**
 * Every paid provider is asked for this many dimensions, so vectors fit the
 * fixed-width pgvector column (see src/rag/vector-store.ts). OpenAI's
 * text-embedding-3-small is natively 1536; text-embedding-3-large and
 * gemini-embedding-001 are shortened to it on request.
 */
export const EMBEDDING_DIMENSIONS = 1536;
/** Texts per provider request. OpenAI allows 2048 and Gemini 100; stay well under both. */
const EMBED_BATCH_SIZE = 64;
/** Characters per text, as before. */
const EMBED_MAX_CHARS = 8000;

const OPENAI_ENDPOINT = "https://api.openai.com/v1/embeddings";
const OPENAI_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const GEMINI_EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
const OLLAMA_BASE = process.env.PLATFORM_OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.PLATFORM_EMBEDDING_MODEL || "nomic-embed-text";

/**
 * USD per 1,000 tokens, by embedding model. Mirrors COST_PER_1K_TOKENS_USD in
 * LLMService — same unit (US dollars, see N-AI-8), same shape.
 *
 * The fallback is deliberately the price of the MOST expensive model rather
 * than an average: an unknown model name must never be cheaper to guess than
 * to look up, or a mis-set EMBEDDING_MODEL becomes a way to under-bill.
 */
const EMBEDDING_USD_PER_1K_TOKENS: Record<string, number> = {
  "text-embedding-3-small": 0.00002,
  "text-embedding-3-large": 0.00013,
  "text-embedding-ada-002": 0.0001,
  "gemini-embedding-001": 0.00015,
};
const EMBEDDING_FALLBACK_USD_PER_1K_TOKENS = 0.00015;

/** Roughly 4 characters per token — the standard approximation. Used ONLY for
 *  the pre-call estimate; the real token count comes back in the response and
 *  is what actually gets recorded. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function usdPer1kTokens(model: string): number {
  return EMBEDDING_USD_PER_1K_TOKENS[model] ?? EMBEDDING_FALLBACK_USD_PER_1K_TOKENS;
}

/**
 * USD cost of `tokens` tokens on `model`. Exported so the price of an UNKNOWN
 * model can be proven rather than assumed: a fallback that guessed cheap (or,
 * worse, zero) would quietly re-open N-AI-9 through the back door — spend that
 * passes every cap because it is priced at nothing.
 */
export function embeddingCostUsd(tokens: number, model: string): number {
  return (tokens / 1000) * usdPer1kTokens(model);
}

type ProviderChoice = "ollama" | "openai" | "gemini";

function openAiKey() {
  return process.env.OPENAI_API_KEY || process.env.PLATFORM_OPENAI_API_KEY || "";
}

function geminiKey() {
  return process.env.PLATFORM_GEMINI_API_KEY || process.env.GEMINI_API_KEY || "";
}

function ollamaOptedIn() {
  return Boolean(process.env.PLATFORM_OLLAMA_BASE_URL) || process.env.USE_OLLAMA_EMBEDDINGS === "true";
}

/**
 * The providers to try, in order. Ollama first when opted in (free, local),
 * then OpenAI, then Gemini. EMBEDDING_PROVIDER pins one provider and nothing
 * else is tried — for a deployment that holds several keys and wants to choose.
 */
function providerOrder(): ProviderChoice[] {
  const pinned = String(process.env.EMBEDDING_PROVIDER || "").toLowerCase();
  if (pinned === "ollama" || pinned === "openai" || pinned === "gemini") return [pinned];
  const order: ProviderChoice[] = [];
  if (ollamaOptedIn()) order.push("ollama");
  if (openAiKey()) order.push("openai");
  if (geminiKey()) order.push("gemini");
  return order;
}

/**
 * The label vectors made RIGHT NOW would carry, or null when no provider is
 * configured. A search only compares a query against chunks with this label.
 * Ollama is reported optimistically: whether the daemon answers is only known
 * by calling it.
 */
export function activeEmbeddingModel(): string | null {
  const first = providerOrder()[0];
  if (first === "ollama") return `ollama:${OLLAMA_MODEL}`;
  if (first === "openai") return `openai:${OPENAI_MODEL}`;
  if (first === "gemini") return `gemini:${GEMINI_EMBEDDING_MODEL}`;
  return null;
}

/**
 * Every label a vector made RIGHT NOW could carry — one per configured
 * provider, in fallback order. `activeEmbeddingModel()` names only the first,
 * which is wrong whenever the first is switched on but not answering (Ollama
 * not running): the vectors then come from the next provider in line.
 */
export function configuredEmbeddingModels(): string[] {
  return providerOrder().map((provider) =>
    provider === "ollama" ? `ollama:${OLLAMA_MODEL}` : provider === "openai" ? `openai:${OPENAI_MODEL}` : `gemini:${GEMINI_EMBEDDING_MODEL}`,
  );
}

async function embedWithOllama(texts: string[]): Promise<EmbedBatchResult | null> {
  // The Ollama daemon runs on localhost:11434. Its /api/embeddings endpoint
  // takes { model, prompt } and returns { embedding: number[] }. No API key,
  // no cost — one text per request is its contract.
  try {
    const url = `${OLLAMA_BASE.replace(/\/$/, "")}/api/embeddings`;
    const vectors: number[][] = [];
    for (const text of texts) {
      const res = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(30000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: OLLAMA_MODEL, prompt: text }),
      });
      if (!res.ok) return null;
      const payload = (await res.json()) as { embedding?: number[] };
      if (!Array.isArray(payload.embedding) || payload.embedding.length === 0) return null;
      vectors.push(payload.embedding);
    }
    return { vectors, model: `ollama:${OLLAMA_MODEL}` };
  } catch {
    // Not reachable — the caller falls through to a paid provider.
    return null;
  }
}

/** A refusal by the spend gate. Final: never retried on another paid provider. */
export class EmbeddingSpendRefused extends Error {}

async function gate(workspaceId: string, texts: string[], model: string, repos: RepositoryBundle) {
  // Check BEFORE spending (N-AI-9). The estimate is what the cap is tested
  // against; the REAL token count comes back in the response and is what
  // gets recorded, exactly as LLMService does it.
  const estimatedTokens = texts.reduce((sum, text) => sum + estimateTokens(text), 0);
  const decision = await checkCanRunTask(workspaceId, "embedding", estimatedTokens, embeddingCostUsd(estimatedTokens, model), repos);
  if (!decision.allowed) throw new EmbeddingSpendRefused(decision.reason);
  return estimatedTokens;
}

async function embedWithOpenAI(workspaceId: string, texts: string[], repos: RepositoryBundle, apiKey: string): Promise<EmbedBatchResult> {
  const estimatedTokens = await gate(workspaceId, texts, OPENAI_MODEL, repos);
  const safety = await assertSafeFetchUrl(OPENAI_ENDPOINT);
  if (!safety.safe) throw new Error(`Embeddings endpoint not allowed: ${safety.reason}`);
  // A single text is sent as a plain string, exactly as before; several as an array.
  const body: Record<string, unknown> = { model: OPENAI_MODEL, input: texts.length === 1 ? texts[0] : texts };
  // Only the text-embedding-3 family accepts `dimensions`; ada-002 rejects it.
  if (OPENAI_MODEL.startsWith("text-embedding-3")) body.dimensions = EMBEDDING_DIMENSIONS;
  const res = await fetch(safety.url.toString(), {
    method: "POST",
    signal: AbortSignal.timeout(60000),
    headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Embedding request failed (${res.status}): ${errText.slice(0, 200)}`);
  }
  const payload = (await res.json()) as {
    data?: Array<{ embedding?: number[]; index?: number }>;
    usage?: { prompt_tokens?: number; total_tokens?: number };
  };
  const rows = (payload.data || []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const vectors = rows.map((row) => row.embedding);
  if (vectors.length !== texts.length || vectors.some((vec) => !Array.isArray(vec) || vec.length === 0)) {
    throw new Error(vectors.length ? "Embedding response did not return one vector per text." : "Embedding response had no vector.");
  }
  // Recorded only AFTER a successful response. A failed call spent nothing
  // the provider will bill for, so charging for it would be inventing a
  // charge — the same rule the transcription path follows (N-AI-7).
  const actualTokens = payload.usage?.total_tokens ?? payload.usage?.prompt_tokens ?? estimatedTokens;
  await recordUsage(workspaceId, { tokens: actualTokens, cost: embeddingCostUsd(actualTokens, OPENAI_MODEL) }, repos);
  return { vectors: vectors as number[][], model: `openai:${OPENAI_MODEL}` };
}

async function embedWithGemini(workspaceId: string, texts: string[], repos: RepositoryBundle, apiKey: string, purpose: EmbeddingPurpose): Promise<EmbedBatchResult> {
  const estimatedTokens = await gate(workspaceId, texts, GEMINI_EMBEDDING_MODEL, repos);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}:batchEmbedContents`;
  const safety = await assertSafeFetchUrl(endpoint);
  if (!safety.safe) throw new Error(`Embeddings endpoint not allowed: ${safety.reason}`);
  const res = await fetch(safety.url.toString(), {
    method: "POST",
    signal: AbortSignal.timeout(60000),
    // The key goes in a header, never the URL: a URL can end up in a log line.
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      requests: texts.map((text) => ({
        model: `models/${GEMINI_EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
        taskType: purpose === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
        outputDimensionality: EMBEDDING_DIMENSIONS,
      })),
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Embedding request failed (${res.status}): ${errText.slice(0, 200)}`);
  }
  const payload = (await res.json()) as { embeddings?: Array<{ values?: number[] }> };
  const vectors = (payload.embeddings || []).map((row) => row.values);
  if (vectors.length !== texts.length || vectors.some((vec) => !Array.isArray(vec) || vec.length === 0)) {
    throw new Error("Embedding response did not return one vector per text.");
  }
  // Gemini's batch endpoint returns no token count; the estimate is recorded.
  await recordUsage(workspaceId, { tokens: estimatedTokens, cost: embeddingCostUsd(estimatedTokens, GEMINI_EMBEDDING_MODEL) }, repos);
  return { vectors: vectors as number[][], model: `gemini:${GEMINI_EMBEDDING_MODEL}` };
}

/**
 * Embed several texts, batched, with the label of the model that made them.
 * Provider resolution: Ollama (opt-in, free), then OpenAI, then Gemini. Throws
 * honestly if none is configured — callers fall back to keyword search; an
 * empty vector is never presented as a real embedding.
 *
 * Paid paths are metered against `workspaceId` (N-AI-9), once per request.
 */
export const embedTexts: EmbedBatchFn = async (workspaceId, texts, repos, purpose = "document") => {
  const inputs = texts.map((text) => String(text || "").slice(0, EMBED_MAX_CHARS));
  if (!inputs.length) return { vectors: [], model: activeEmbeddingModel() || "none" };
  const order = providerOrder();
  let lastError: Error | null = null;
  for (const provider of order) {
    if (provider === "ollama") {
      const local = await embedWithOllama(inputs);
      if (local) return local;
      continue; // fall through to a paid provider, as before
    }
    try {
      const vectors: number[][] = [];
      let model = "";
      for (let start = 0; start < inputs.length; start += EMBED_BATCH_SIZE) {
        const slice = inputs.slice(start, start + EMBED_BATCH_SIZE);
        const result = provider === "openai"
          ? await embedWithOpenAI(workspaceId, slice, repos, openAiKey())
          : await embedWithGemini(workspaceId, slice, repos, geminiKey(), purpose);
        vectors.push(...result.vectors);
        model = result.model;
      }
      return { vectors, model };
    } catch (error) {
      // A refusal by the spend gate is final — it must not be "retried" on a
      // second paid provider, which would spend the money the gate refused.
      if (error instanceof EmbeddingSpendRefused) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      // Only fall through to another PAID provider when a single one is not pinned.
      if (order.length === 1) throw lastError;
    }
  }
  if (lastError) throw lastError;
  throw new Error("No embedding provider configured. Set PLATFORM_OLLAMA_BASE_URL + PLATFORM_EMBEDDING_MODEL for free local Ollama embeddings, or OPENAI_API_KEY / PLATFORM_GEMINI_API_KEY for cloud embeddings. KB will use keyword fallback until then.");
};

/**
 * Generate an embedding vector for one document text. Kept with its original
 * signature — callers and tests inject an `EmbedFn` — and implemented on top of
 * the batched path.
 */
export const embedText: EmbedFn = async (workspaceId, text, repos) => {
  const { vectors } = await embedTexts(workspaceId, [text], repos, "document");
  return vectors[0];
};

/** One query text, embedded for retrieval (Gemini tunes query vectors differently). */
export const embedQuery: EmbedFn = async (workspaceId, text, repos) => {
  const { vectors } = await embedTexts(workspaceId, [text], repos, "query");
  return vectors[0];
};

/**
 * Cosine similarity between two equal-length vectors. Returns 0 for empty/
 * mismatched-length (defensive — never NaN). Range [-1, 1]; for embeddings
 * effectively [0, 1]. Higher = more similar.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
