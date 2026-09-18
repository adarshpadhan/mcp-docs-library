ALTER TABLE documents ADD COLUMN IF NOT EXISTS subject text NOT NULL DEFAULT 'Unknown';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS raw_object_key text;
