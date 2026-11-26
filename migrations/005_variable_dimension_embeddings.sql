-- Support neural embedding models whose vector dimensions differ from the original 768-d CPU embedder.
-- pgvector's unconstrained vector type stores up to 16,000 dimensions while preserving existing values.
ALTER TABLE memories
  ALTER COLUMN embedding TYPE vector
  USING embedding::vector;

