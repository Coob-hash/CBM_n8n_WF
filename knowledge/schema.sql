-- Install in SUPABASE, not in the dispatch database. Separate optional module.
-- Run once as the database owner. Re-running is supported for this initial version.
BEGIN;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

CREATE TABLE IF NOT EXISTS public.cbm_knowledge_generations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), fingerprint text NOT NULL,
 model_sha256 text NOT NULL, observed_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), published_at timestamptz,
 status text NOT NULL CHECK(status IN ('BUILDING','READY','SUPERSEDED'))
);
CREATE TABLE IF NOT EXISTS public.cbm_knowledge_head (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 generation uuid REFERENCES public.cbm_knowledge_generations(id),
 verified_at timestamptz, status text NOT NULL DEFAULT 'UNAVAILABLE'
 CHECK(status IN ('UNAVAILABLE','BUILDING','READY'))
);
INSERT INTO public.cbm_knowledge_head(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.cbm_knowledge_sources (
 generation uuid NOT NULL REFERENCES public.cbm_knowledge_generations(id),
 chunk_id text NOT NULL, content text NOT NULL CHECK(length(content) BETWEEN 1 AND 1800),
 metadata jsonb NOT NULL, PRIMARY KEY(generation,chunk_id)
);
-- Native n8n Supabase Vector Store / LangChain column contract.
CREATE TABLE IF NOT EXISTS public.cbm_knowledge_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), content text NOT NULL,
 metadata jsonb NOT NULL, embedding vector(1536) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS cbm_knowledge_document_identity
 ON public.cbm_knowledge_documents((metadata->>'generation'),(metadata->>'chunk_id'));
CREATE INDEX IF NOT EXISTS cbm_knowledge_document_filter
 ON public.cbm_knowledge_documents USING gin(metadata);
-- Exact search is sufficient for this single-building corpus; no approximate index yet.

CREATE OR REPLACE FUNCTION public.cbm_begin_knowledge(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public,extensions,pg_temp AS $$
DECLARE h cbm_knowledge_head; g cbm_knowledge_generations; k uuid; d jsonb;
 observed timestamptz; pending jsonb;
BEGIN
 SELECT * INTO h FROM cbm_knowledge_head WHERE singleton FOR UPDATE;
 IF coalesce(p->>'fingerprint','') !~ '^[a-f0-9]{64}$' OR coalesce(p->>'model_sha256','') !~ '^[a-f0-9]{64}$'
 OR p->>'embedding_model' IS DISTINCT FROM 'text-embedding-3-small'
 OR jsonb_typeof(p->'chunks') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'Invalid knowledge snapshot';
 END IF;
 observed := (p->>'observed_at')::timestamptz;
 IF observed IS NULL OR observed < clock_timestamp()-interval '5 minutes'
 OR observed > clock_timestamp()+interval '30 seconds' THEN RAISE EXCEPTION 'Snapshot clock is stale or invalid'; END IF;
 IF h.verified_at > observed THEN RETURN jsonb_build_object('action','STALE'); END IF;
 SELECT * INTO g FROM cbm_knowledge_generations WHERE id=h.generation;
 IF g.fingerprint=p->>'fingerprint' AND h.status='READY' THEN
   UPDATE cbm_knowledge_head SET verified_at=observed WHERE singleton;
   RETURN jsonb_build_object('action','UNCHANGED','generation',g.id);
 END IF;
 IF g.fingerprint=p->>'fingerprint' AND h.status='BUILDING'
 AND g.created_at>clock_timestamp()-interval '10 minutes' THEN
   RETURN jsonb_build_object('action','BUSY','generation',g.id);
 END IF;
 UPDATE cbm_knowledge_generations SET status='SUPERSEDED' WHERE id=h.generation;
 INSERT INTO cbm_knowledge_generations(fingerprint,model_sha256,observed_at,status)
 VALUES(p->>'fingerprint',p->>'model_sha256',observed,'BUILDING') RETURNING id INTO k;
 -- Publication switches off previous knowledge immediately when a change is observed.
 UPDATE cbm_knowledge_head SET generation=k,status='BUILDING',verified_at=observed WHERE singleton;
 FOR d IN SELECT value FROM jsonb_array_elements(p->'chunks') LOOP
   IF d#>>'{metadata,chunk_id}' IS NULL OR d#>>'{metadata,ifc_global_id}' IS NULL
   OR coalesce(d#>>'{metadata,content_sha256}','') !~ '^[a-f0-9]{64}$'
   OR d#>>'{metadata,embedding_model}' IS DISTINCT FROM 'text-embedding-3-small'
   OR d#>>'{metadata,source_revision}' IS NULL OR d#>>'{metadata,source_title}' IS NULL THEN
     RAISE EXCEPTION 'Missing chunk identity or provenance';
   END IF;
   INSERT INTO cbm_knowledge_sources VALUES(k,d#>>'{metadata,chunk_id}',d->>'content',
     (d->'metadata') || jsonb_build_object('generation',k::text,'model_sha256',p->>'model_sha256'));
 END LOOP;
 -- Reuse unchanged embeddings, including after geometry / maintenance-only IFC changes.
 INSERT INTO cbm_knowledge_documents(content,metadata,embedding)
 SELECT s.content,s.metadata,old.embedding FROM cbm_knowledge_sources s
 CROSS JOIN LATERAL (SELECT v.embedding FROM cbm_knowledge_documents v
   WHERE v.content=s.content AND v.metadata->>'embedding_model'='text-embedding-3-small'
   AND v.metadata->>'content_sha256'=s.metadata->>'content_sha256' LIMIT 1) old
 WHERE s.generation=k;
 SELECT coalesce(jsonb_agg(jsonb_build_object('content',s.content,'metadata',s.metadata) ORDER BY s.chunk_id),'[]')
 INTO pending FROM cbm_knowledge_sources s WHERE s.generation=k AND NOT EXISTS(
   SELECT 1 FROM cbm_knowledge_documents v WHERE v.metadata->>'generation'=k::text AND v.metadata->>'chunk_id'=s.chunk_id);
 RETURN jsonb_build_object('action','BUILD','generation',k,'documents',pending);
END $$;

CREATE OR REPLACE FUNCTION public.cbm_publish_knowledge(k uuid, fingerprint text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public,extensions,pg_temp AS $$
DECLARE h cbm_knowledge_head; g cbm_knowledge_generations;
BEGIN
 SELECT * INTO h FROM cbm_knowledge_head WHERE singleton FOR UPDATE;
 SELECT * INTO g FROM cbm_knowledge_generations WHERE id=k;
 IF h.generation IS DISTINCT FROM k OR h.status<>'BUILDING' OR g.fingerprint IS DISTINCT FROM fingerprint
 THEN RAISE EXCEPTION 'Superseded or mismatched build'; END IF;
 IF g.observed_at < clock_timestamp()-interval '5 minutes' THEN RAISE EXCEPTION 'Source verification expired; rerun sync'; END IF;
 IF EXISTS(SELECT 1 FROM cbm_knowledge_sources s WHERE s.generation=k AND NOT EXISTS(
   SELECT 1 FROM cbm_knowledge_documents v WHERE v.metadata->>'generation'=k::text
   AND v.metadata->>'chunk_id'=s.chunk_id AND v.content=s.content AND v.metadata @> s.metadata))
 OR (SELECT count(*) FROM cbm_knowledge_sources WHERE generation=k)<>
    (SELECT count(*) FROM cbm_knowledge_documents WHERE metadata->>'generation'=k::text)
 THEN RAISE EXCEPTION 'Incomplete or altered vector build'; END IF;
 UPDATE cbm_knowledge_generations SET status='READY',published_at=clock_timestamp() WHERE id=k;
 UPDATE cbm_knowledge_head SET status='READY' WHERE singleton;
 RETURN jsonb_build_object('status','READY','generation',k);
END $$;

-- Compatible with native Supabase Vector Store options.queryName.
-- A missing metadata filter returns no rows rather than searching all products.
CREATE OR REPLACE FUNCTION public.match_cbm_knowledge(query_embedding vector(1536),
 match_count integer DEFAULT 4, filter jsonb DEFAULT '{}')
RETURNS TABLE(id uuid,content text,metadata jsonb,similarity double precision)
LANGUAGE sql STABLE SET search_path=public,extensions,pg_temp AS $$
 SELECT d.id,d.content,d.metadata,1-(d.embedding <=> query_embedding)
 FROM cbm_knowledge_documents d JOIN cbm_knowledge_head h
 ON d.metadata->>'generation'=h.generation::text
 WHERE h.singleton AND h.status='READY' AND h.verified_at>statement_timestamp()-interval '5 minutes'
 AND nullif(filter->>'ifc_global_id','') IS NOT NULL
 AND filter->>'embedding_model'='text-embedding-3-small'
 AND d.metadata @> filter
 ORDER BY d.embedding <=> query_embedding,d.id LIMIT least(greatest(match_count,0),6)
$$;

-- Re-read selected source text in Supabase immediately before the offer is reserved.
CREATE OR REPLACE FUNCTION public.cbm_offer_knowledge(gid text, selected jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=public,extensions,pg_temp AS $$
DECLARE h cbm_knowledge_head; chunks jsonb;
BEGIN
 SELECT * INTO h FROM cbm_knowledge_head WHERE singleton;
 IF selected IS NULL OR jsonb_typeof(selected)<>'array' THEN
   RETURN jsonb_build_object('status','INVALID_SELECTION','chunks','[]'::jsonb);
 END IF;
 IF jsonb_array_length(selected)>3 OR EXISTS(SELECT 1 FROM jsonb_array_elements(selected) x WHERE jsonb_typeof(x)<>'string')
 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(selected))<>jsonb_array_length(selected) THEN
   RETURN jsonb_build_object('status','INVALID_SELECTION','chunks','[]'::jsonb);
 END IF;
 IF h.status<>'READY' OR h.verified_at IS NULL OR h.verified_at<=statement_timestamp()-interval '5 minutes' THEN
   RETURN jsonb_build_object('status','UNAVAILABLE','chunks','[]'::jsonb);
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('content',s.content,'metadata',s.metadata) ORDER BY x.ord),'[]')
 INTO chunks FROM jsonb_array_elements_text(selected) WITH ORDINALITY x(key,ord)
 JOIN cbm_knowledge_sources s ON s.generation=h.generation AND s.chunk_id=x.key
 WHERE s.metadata->>'ifc_global_id'=gid;
 IF jsonb_array_length(chunks)<>jsonb_array_length(selected) THEN
   RETURN jsonb_build_object('status','INVALID_SELECTION','chunks','[]'::jsonb);
 END IF;
 RETURN jsonb_build_object('status',CASE WHEN jsonb_array_length(chunks)>0 THEN 'VERIFIED' ELSE 'NONE_SELECTED' END,
 'ifc_global_id',gid,'generation',h.generation,'verified_at',h.verified_at,'retrieved_at',statement_timestamp(),'chunks',chunks);
END $$;

ALTER TABLE cbm_knowledge_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE cbm_knowledge_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cbm_knowledge_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE cbm_knowledge_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON cbm_knowledge_head,cbm_knowledge_generations,cbm_knowledge_sources,cbm_knowledge_documents FROM PUBLIC;
REVOKE ALL ON FUNCTION cbm_begin_knowledge(jsonb),cbm_publish_knowledge(uuid,text),
 match_cbm_knowledge(vector,integer,jsonb),cbm_offer_knowledge(text,jsonb) FROM PUBLIC;
-- Supabase backend credentials only. No anon/authenticated policies are created.
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
 GRANT USAGE ON SCHEMA extensions TO service_role;
 GRANT SELECT,INSERT ON cbm_knowledge_documents TO service_role;
 GRANT SELECT ON cbm_knowledge_head TO service_role;
 GRANT EXECUTE ON FUNCTION match_cbm_knowledge(vector,integer,jsonb) TO service_role;
END IF; END $$;
COMMIT;
