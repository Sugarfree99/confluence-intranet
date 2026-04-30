-- 002_pgvector.sql
-- Enable the pgvector extension. The image `pgvector/pgvector:pg15` ships
-- with the extension's shared library; this just activates it for this DB.
--
-- Note: existing embeddings remain stored as `float8[]`. pgvector is now
-- available if/when we want to convert columns to `vector(N)` for ANN
-- indexing. Gemini's 3072-dim embeddings exceed pgvector's HNSW/IVFFlat
-- index limit (2000), so any future conversion would either need
-- dimensionality reduction or storage-only `vector` columns without ANN.
--
-- Idempotent: safe to re-run.

CREATE EXTENSION IF NOT EXISTS vector;
