-- SUPABASE ONLY. Separate demo library, never retrieved by the dispatch agent.
BEGIN;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
CREATE TABLE IF NOT EXISTS public.cbm_demo_technical_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 content text NOT NULL,metadata jsonb NOT NULL DEFAULT '{}',embedding vector(1536) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS cbm_demo_chunk_identity
 ON cbm_demo_technical_documents((metadata->>'import_id'),(metadata->>'chunk_id'));
CREATE INDEX IF NOT EXISTS cbm_demo_filter ON cbm_demo_technical_documents USING gin(metadata);
ALTER TABLE cbm_demo_technical_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON cbm_demo_technical_documents FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
 GRANT USAGE ON SCHEMA extensions TO service_role;
 GRANT SELECT,INSERT,UPDATE ON cbm_demo_technical_documents TO service_role;
END IF; END $$;
COMMIT;
