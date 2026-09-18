CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  subject text NOT NULL DEFAULT 'Unknown',
  filename text NOT NULL,
  mime_type text NOT NULL,
  document_type text NOT NULL,
  course_code text NOT NULL,
  raw_object_key text NOT NULL UNIQUE,
  source_sha256 char(64) NOT NULL,
  raw_license jsonb NOT NULL,
  processed_license jsonb,
  raw_status text NOT NULL DEFAULT 'private',
  processed_status text NOT NULL DEFAULT 'withheld',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_pages (
  id bigserial PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number integer NOT NULL,
  text text NOT NULL,
  confidence real,
  UNIQUE (document_id, page_number)
);

CREATE TABLE IF NOT EXISTS chunks (
  id bigserial PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_start integer NOT NULL,
  page_end integer NOT NULL,
  content text NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);

CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id bigint PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  model text NOT NULL,
  embedding vector(1536) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chunks_search_idx ON chunks USING gin (search_vector);
CREATE INDEX IF NOT EXISTS chunk_embeddings_vector_idx
  ON chunk_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'uploaded',
  attempt_count integer NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  worker_id text,
  error_code text,
  error_message text,
  ocr_engine text,
  ocr_version text,
  parser_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ingestion_jobs_claim_idx
  ON ingestion_jobs (status, lease_expires_at, created_at);
