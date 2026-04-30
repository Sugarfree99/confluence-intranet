-- 001_postgres_search.sql
-- Migrate retrieval to be Postgres-native:
--   * server-side cosine similarity for chunk embeddings (top-K in SQL)
--   * FTS index aligned with the query's text search config ('simple')
--
-- Idempotent: safe to re-run.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Cosine similarity over float8[] (server-side scoring)
-- ---------------------------------------------------------------------------
-- Rationale: pgvector is not installed locally. This pure-SQL function lets
-- Postgres do the dot product / norm math and ORDER BY ... LIMIT in the DB,
-- so we no longer ship every embedding to Node.js to score in JS.
--
-- Implementation note: uses the multi-arg `unnest(a, b)` to walk both
-- arrays simultaneously, then aggregates (dot, |a|^2, |b|^2) in a single
-- pass. This is dramatically faster than `generate_subscripts` + array
-- indexing for high-dimensional vectors (e.g. Gemini's 3072-dim).
CREATE OR REPLACE FUNCTION array_cosine(a float8[], b float8[])
RETURNS float8
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT CASE
           WHEN s.na = 0 OR s.nb = 0 THEN 0::float8
           ELSE s.dot / (sqrt(s.na) * sqrt(s.nb))
         END
  FROM (
    SELECT
      sum(va * vb) AS dot,
      sum(va * va) AS na,
      sum(vb * vb) AS nb
    FROM unnest(a, b) AS t(va, vb)
  ) s;
$$;

-- ---------------------------------------------------------------------------
-- 2. FTS index aligned with the actual query (uses 'simple' config)
-- ---------------------------------------------------------------------------
-- Drop the legacy 'english'-config GIN that the query path never uses.
DROP INDEX IF EXISTS idx_chunks_content_tsvector;

-- Create a GIN index that matches the chunker query's tsvector exactly,
-- so the planner can use it. 'simple' is the right choice for mixed
-- Swedish/English content where you don't want stemming/stopword removal.
CREATE INDEX IF NOT EXISTS idx_chunks_content_simple_tsv
  ON chunks
  USING GIN (to_tsvector('simple'::regconfig, coalesce(content, '')));

-- Helpful covering index for the JOIN back to chunks.
CREATE INDEX IF NOT EXISTS idx_embeddings_chunk_id_btree
  ON embeddings (chunk_id);

-- ---------------------------------------------------------------------------
-- 3. Make sure stats are fresh after the index swap.
-- ---------------------------------------------------------------------------
ANALYZE chunks;
ANALYZE embeddings;

COMMIT;
