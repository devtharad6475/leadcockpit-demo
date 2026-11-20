-- 2026-09-17 (session 56): a real vector index for knowledge-base chunks.
--
-- Embeddings have been stored as JSON in knowledge_base_chunks.embedding_json,
-- and a semantic search loaded EVERY chunk of the workspace into memory and
-- compared the query against each one. That is fine for a few hundred chunks
-- and stops being fine as a knowledge base grows.
--
-- This adds a side table with a pgvector column and an HNSW index (approximate
-- nearest-neighbour search, logarithmic rather than linear in the chunk count).
-- embedding_json stays the source of truth; this table is an index over it and
-- can be rebuilt from it at any time.
--
-- CONDITIONAL ON PURPOSE. pgvector is available on the production database
-- (Neon, pgvector 0.8.6) but not on the stock postgres:16 images used for local
-- development and CI. The whole block is skipped where the extension cannot be
-- installed, and the application detects the table at runtime and falls back
-- to the in-memory comparison when it is absent. PL/pgSQL only resolves the
-- `vector` type when the branch executes, so the skipped branch cannot fail.
--
-- The table is deliberately NOT modelled in schema.prisma: Prisma cannot read a
-- `vector` column, and a model for a table that exists on only some databases
-- would make the schema wrong on the others. All access is raw SQL in
-- src/rag/vector-store.ts.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE IF NOT EXISTS knowledge_chunk_vectors (
      -- One vector per chunk. Deleting the chunk (document replaced, workspace
      -- reset) deletes its vector with it, so the index can never point at a
      -- chunk that no longer exists.
      chunk_id     TEXT PRIMARY KEY REFERENCES knowledge_base_chunks(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      -- The model that produced the vector, e.g. "openai:text-embedding-3-small".
      -- Vectors from different models are not comparable; every search filters
      -- on the model the query was embedded with.
      model        TEXT NOT NULL,
      embedding    vector(1536) NOT NULL,
      created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Cosine distance, matching how the application scores similarity.
    CREATE INDEX IF NOT EXISTS knowledge_chunk_vectors_embedding_hnsw
      ON knowledge_chunk_vectors USING hnsw (embedding vector_cosine_ops);

    CREATE INDEX IF NOT EXISTS knowledge_chunk_vectors_workspace_model
      ON knowledge_chunk_vectors (workspace_id, model);
  END IF;
END $$;
