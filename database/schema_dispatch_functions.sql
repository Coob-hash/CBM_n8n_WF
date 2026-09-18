-- Legacy dispatch routines: lock and read in one parameterized node call.
-- Each subsequent PL/pgSQL statement gets its READ COMMITTED snapshot after locking.
BEGIN;
CREATE OR REPLACE FUNCTION public.cbm_create_ticket(p_request jsonb) RETURNS TABLE(ticket_id integer)
LANGUAGE plpgsql AS $cbm$
BEGIN
 LOCK TABLE tickets IN SHARE ROW EXCLUSIVE MODE;
 RETURN QUERY WITH prior AS MATERIALIZED (
 SELECT t.id FROM tickets t WHERE
 (NULLIF($1::jsonb->>'ticketId','') IS NOT NULL AND t.id=(NULLIF($1::jsonb->>'ticketId',''))::int)
 OR
 EXISTS (SELECT 1 FROM ticket_events e WHERE e.ticket_id=t.id AND e.event='CBM_SOURCE'
         AND e.payload->>'source_key'=$1::jsonb->>'sourceKey')
 OR (t.ifc_global_id=$1::jsonb#>>'{triage,element,global_id}' AND t.status NOT IN ('CLOSED','DUPLICATE','REJECTED'))
 ORDER BY t.id LIMIT 1
), inserted AS (
 INSERT INTO tickets(status,reporter_email,photo_before_url,map_code,pos_x,pos_y,pos_z,vps_confidence,
 ifc_global_id,ifc_class,ifc_name,ifc_storey,category,severity,description,required_skill)
 SELECT 'LOCALIZED',p#>>'{triage,reporterEmail}',p#>>'{triage,photoUrl}',p#>>'{triage,mapCode}',
 (p#>>'{triage,position,x}')::float8,(p#>>'{triage,position,y}')::float8,(p#>>'{triage,position,z}')::float8,
 (p#>>'{triage,confidence}')::float8,p#>>'{triage,element,global_id}',p#>>'{triage,element,ifc_class}',
 p#>>'{triage,element,name}',p#>>'{triage,element,storey}',p#>>'{triage,category}',(p#>>'{triage,severity}')::int,
 p#>>'{triage,description}',p#>>'{triage,required_skill}'
 FROM (SELECT $1::jsonb AS p) a WHERE NOT EXISTS (SELECT 1 FROM prior)
 AND p#>>'{triage,element,global_id}' IS NOT NULL AND p->>'sourceKey' IS NOT NULL
 RETURNING id
), selected AS (SELECT id FROM inserted UNION ALL SELECT id FROM prior), source AS (
 INSERT INTO ticket_events(ticket_id,event,payload)
 SELECT id,'CBM_SOURCE',jsonb_build_object('source_key',$1::jsonb->>'sourceKey') FROM selected
 WHERE $1::jsonb->>'sourceKey' IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM ticket_events WHERE event='CBM_SOURCE' AND payload->>'source_key'=$1::jsonb->>'sourceKey')
 RETURNING id
)
SELECT id AS ticket_id FROM selected;
END $cbm$;
CREATE OR REPLACE FUNCTION public.cbm_record_offer_response(p_ticket integer,p_offer text,p_token text,p_decision text)
RETURNS TABLE(response_result jsonb) LANGUAGE plpgsql AS $cbm$
BEGIN
 PERFORM id FROM tickets WHERE id=p_ticket FOR UPDATE;
 RETURN QUERY WITH valid AS MATERIALIZED (
 SELECT t.id FROM tickets t JOIN LATERAL (
 SELECT payload FROM ticket_events WHERE ticket_id=t.id AND event='CBM_DISPATCH_STATE' ORDER BY id DESC LIMIT 1
 ) s ON TRUE CROSS JOIN LATERAL jsonb_array_elements(s.payload->'offers') o
 WHERE t.id=$1::int AND t.status='DISPATCHING' AND o->>'id'=$2 AND o->>'token'=$3
 AND o->>'status' IN ('SENDING','LIVE','UNCERTAIN') AND clock_timestamp()<(o->>'expires_at')::timestamptz
 AND $4 IN ('accept','deny')
), recorded AS (
 INSERT INTO ticket_events(ticket_id,event,payload)
 SELECT id,'CBM_RESPONSE',jsonb_build_object('offer_id',$2::text,'decision',$4::text) FROM valid
 WHERE NOT EXISTS (SELECT 1 FROM ticket_events e WHERE e.ticket_id=valid.id AND e.event='CBM_RESPONSE' AND e.payload->>'offer_id'=$2)
 RETURNING id
), invalidate_snapshot AS (
 UPDATE tickets SET updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond')
 WHERE id=$1::int AND EXISTS(SELECT 1 FROM recorded) RETURNING id
)
SELECT jsonb_build_object('recorded',EXISTS(SELECT 1 FROM recorded),'ticket_id',$1::int) AS response_result;
END $cbm$;
COMMIT;
