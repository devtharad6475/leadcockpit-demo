/**
 * vector-store.ts — pgvector + HNSW index over knowledge-base chunk embeddings
 * (2026-09-17, session 56).
 *
 * The table is created by migration 20260917180000_knowledge_chunk_vectors ONLY
 * on databases that have pgvector (production Neon does; the stock Postgres used
 * for local development and CI does not). Everything here therefore starts by
 * asking whether the table exists, and every caller keeps working without it:
 * writes are skipped, and searches return `null` so the caller falls back to
 * comparing the stored JSON embeddings in memory.
 *
 * `knowledge_base_chunks.embedding_json` stays the source of truth. This table
 * is an index over it — `backfillChunkVectors` rebuilds it.
 */
import { EMBEDDING_DIMENSIONS } from "@/llm/embedding";

const TABLE = "knowledge_chunk_vectors";

type RawClient = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $transaction<T>(fn: (tx: RawClient) => Promise<T>, options?: unknown): Promise<T>;
};

let availability: { value: boolean; checkedAt: number } | null = null;
/** A "not available" answer is re-checked after this long, in case the migration ran since. */
const RECHECK_UNAVAILABLE_MS = 5 * 60 * 1000;

async function client(): Promise<RawClient | null> {
  if (process.env.PERSISTENCE_PROVIDER !== "prisma") return null;
  const { prisma } = await import("@/lib/prisma");
  return prisma as unknown as RawClient;
}

/** Whether the vector table exists on this database. Cached per process. */
export async function vectorStoreAvailable(): Promise<boolean> {
  if (availability && (availability.value || Date.now() - availability.checkedAt < RECHECK_UNAVAILABLE_MS)) {
    return availability.value;
  }
  const db = await client();
  if (!db) return false;
  try {
    const rows = await db.$queryRawUnsafe<Array<{ present: boolean }>>(
      "SELECT to_regclass($1) IS NOT NULL AS present",
      `public.${TABLE}`,
    );
    availability = { value: Boolean(rows[0]?.present), checkedAt: Date.now() };
  } catch {
    availability = { value: false, checkedAt: Date.now() };
  }
  return availability.value;
}

/** Test hook: forget the cached availability answer. */
export function resetVectorStoreAvailabilityCache() {
  availability = null;
}

/** pgvector's text form: "[0.1,0.2,...]". Returns null for anything that is not a usable vector. */
export function toVectorLiteral(vector: unknown): string | null {
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) return null;
  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
  }
  return `[${vector.join(",")}]`;
}

export type ChunkVectorRow = { chunkId: string; model: string; vector: unknown };

/**
 * Write (or replace) the index rows for these chunks. Rows whose vector is not
 * exactly EMBEDDING_DIMENSIONS long are skipped — a 768-dimension Ollama vector
 * cannot go in a 1536-dimension column, and stays searchable in memory.
 * Returns how many rows were written. Never throws: a failed index write must
 * not fail the chunk write it follows.
 */
export async function upsertChunkVectors(workspaceId: string, rows: ChunkVectorRow[]): Promise<number> {
  if (!rows.length || !(await vectorStoreAvailable())) return 0;
  const db = await client();
  if (!db) return 0;
  let written = 0;
  for (const row of rows) {
    const literal = toVectorLiteral(row.vector);
    if (!literal || !row.chunkId || !row.model) continue;
    try {
      await db.$executeRawUnsafe(
        `INSERT INTO ${TABLE} (chunk_id, workspace_id, model, embedding)
         VALUES ($1, $2, $3, $4::vector)
         ON CONFLICT (chunk_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, model = EXCLUDED.model, embedding = EXCLUDED.embedding`,
        row.chunkId,
        workspaceId,
        row.model,
        literal,
      );
      written += 1;
    } catch (error) {
      console.warn(`[vector-store] could not index chunk ${row.chunkId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return written;
}

/**
 * Remove index rows for these chunks. Used when a chunk is RETIRED: the chunk
 * row stays as evidence of what an uploaded document said, but a meaning-search
 * must never return text the owner has corrected. Never throws — failing to
 * clean the index must not fail the correction the owner just made; the chunk
 * is skipped at retrieval by its `supersededBy` mark either way.
 */
export async function deleteChunkVectors(chunkIds: string[]): Promise<number> {
  if (!chunkIds.length || !(await vectorStoreAvailable())) return 0;
  const db = await client();
  if (!db) return 0;
  try {
    return await db.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE chunk_id = ANY($1::text[])`, chunkIds);
  } catch (error) {
    console.warn(`[vector-store] could not delete vectors: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}

export type VectorHit = { chunkId: string; similarity: number };

/**
 * Nearest chunks to `vector` in this workspace, among vectors made by `model`.
 * Returns null when the index is not available, so the caller knows to fall
 * back rather than concluding that nothing matched.
 *
 * `hnsw.iterative_scan` (pgvector 0.8+) matters here: HNSW finds the nearest
 * vectors across ALL workspaces first and the WHERE clause filters afterwards,
 * so without it a small workspace on a big table can get fewer results than
 * asked for. Iterative scan keeps searching until the filter is satisfied.
 */
export async function searchChunkVectors(workspaceId: string, model: string, vector: unknown, limit: number): Promise<VectorHit[] | null> {
  const literal = toVectorLiteral(vector);
  if (!literal || !(await vectorStoreAvailable())) return null;
  const db = await client();
  if (!db) return null;
  const query = `SELECT chunk_id AS "chunkId", 1 - (embedding <=> $1::vector) AS similarity
     FROM ${TABLE}
     WHERE workspace_id = $2 AND model = $3
     ORDER BY embedding <=> $1::vector
     LIMIT $4`;
  try {
    const rows = await db.$transaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe("SET LOCAL hnsw.iterative_scan = relaxed_order");
      } catch {
        // Older pgvector: the setting does not exist. The query still works.
      }
      return tx.$queryRawUnsafe<Array<{ chunkId: string; similarity: number }>>(query, literal, workspaceId, model, Math.max(1, Math.floor(limit)));
    });
    return rows.map((row) => ({ chunkId: String(row.chunkId), similarity: Number(row.similarity) }));
  } catch (error) {
    console.warn(`[vector-store] search failed, falling back: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Rebuild index rows from `embedding_json` for chunks that are missing one.
 * For chunks embedded before the index existed, or after it was dropped.
 */
export async function backfillChunkVectors(workspaceId?: string): Promise<number> {
  if (!(await vectorStoreAvailable())) return 0;
  const db = await client();
  if (!db) return 0;
  const rows = await db.$queryRawUnsafe<Array<{ id: string; workspace_id: string; embedding_json: unknown; metadata_json: unknown }>>(
    `SELECT c.id, c.workspace_id, c.embedding_json, c.metadata_json
       FROM knowledge_base_chunks c
       LEFT JOIN ${TABLE} v ON v.chunk_id = c.id
      WHERE v.chunk_id IS NULL AND c.embedding_json IS NOT NULL
        ${workspaceId ? "AND c.workspace_id = $1" : ""}`,
    ...(workspaceId ? [workspaceId] : []),
  );
  let written = 0;
  const byWorkspace = new Map<string, ChunkVectorRow[]>();
  for (const row of rows) {
    const meta = (row.metadata_json || {}) as Record<string, unknown>;
    const model = typeof meta.embeddingModel === "string" ? meta.embeddingModel : "";
    if (!model) continue; // an unlabelled vector cannot be searched safely
    const list = byWorkspace.get(row.workspace_id) || [];
    list.push({ chunkId: row.id, model, vector: row.embedding_json });
    byWorkspace.set(row.workspace_id, list);
  }
  for (const [ws, list] of byWorkspace) written += await upsertChunkVectors(ws, list);
  return written;
}
