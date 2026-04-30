-- 003_halfvec.sql
-- Promote chunk embeddings from float8[] to pgvector's halfvec(3072) and
-- replace the in-SQL array_cosine() with the native `<=>` operator backed
-- by an HNSW index.
--
-- Why halfvec?
--   * Gemini's gemini-embedding-001 returns 3072-dim float32. pgvector's
--     `vector` HNSW/IVFFlat caps at 2000 dims; `halfvec` (16-bit floats)
--     supports HNSW up to 4000 dims. Cosine quality at fp16 is
--     indistinguishable from fp32 in practice.
--   * Storage drops from 24 KB/row (float8[]) to ~6 KB/row (halfvec).
--
-- Idempotent-ish: the ALTER ... TYPE is a no-op if already halfvec, the
-- DROP FUNCTION/INDEX statements use IF [NOT] EXISTS.
--
-- Requires: extension `vector` (provided by pgvector/pgvector:pg15 image,
-- enabled by 02-pgvector.sql).

BEGIN;

-- 1. Convert column type. The USING expression turns Postgres array
--    literal `{1,2,3}` into pgvector text literal `[1,2,3]`, then casts.
DO $$
DECLARE
  current_type text;
BEGIN
  SELECT format_type(atttypid, atttypmod)
    INTO current_type
    FROM pg_attribute
   WHERE attrelid = 'embeddings'::regclass
     AND attname  = 'embedding'
     AND NOT attisdropped;

  IF current_type IS DISTINCT FROM 'halfvec(3072)' THEN
    EXECUTE $sql$
      ALTER TABLE embeddings
        ALTER COLUMN embedding TYPE halfvec(3072)
        USING CASE
                WHEN embedding IS NULL THEN NULL
                ELSE ('[' || array_to_string(embedding::float8[], ',') || ']')::halfvec(3072)
              END
    $sql$;
  END IF;
END $$;

-- 2. Drop the legacy SQL cosine function (replaced by `<=>`).
DROP FUNCTION IF EXISTS array_cosine(float8[], float8[]);

-- 3. HNSW index for cosine similarity on halfvec.
--    Note: HNSW build can be slow for large datasets; safe for our scale.
CREATE INDEX IF NOT EXISTS idx_embeddings_embedding_hnsw
  ON embeddings USING hnsw (embedding halfvec_cosine_ops);

ANALYZE embeddings;

COMMIT;
