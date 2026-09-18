ALTER TABLE documents ADD COLUMN IF NOT EXISTS subject_short_name text NOT NULL DEFAULT '';
