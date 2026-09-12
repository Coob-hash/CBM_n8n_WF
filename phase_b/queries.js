'use strict';

// The strings below are fixed SQL; all runtime data is passed as parameters.
const CREATE = `
LOCK TABLE tickets IN SHARE ROW EXCLUSIVE MODE;
WITH prior AS MATERIALIZED (
 SELECT t.id FROM tickets t WHERE
 (NULLIF($1::jsonb->>'ticketId','') IS NOT NULL AND t.id=(NULLIF($1::jsonb->>'ticketId',''))::int)
 OR
 EXISTS (SELECT 1 FROM ticket_events e WHERE e.ticket_id=t.id AND e.event='CBM_SOURCE'
         AND e.payload->>'source_key'=$1::jsonb->>'sourceKey')
 OR (t.ifc_global_id=$1::jsonb#>>'{triage,element,global_id}' AND t.status NOT IN ('CLOSED','DUPLICATE'))
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
SELECT id AS ticket_id FROM selected;`;

const LOAD = `
WITH target AS (
 SELECT t.* FROM tickets t WHERE
 (NULLIF($1::jsonb->>'ticketId','') IS NOT NULL AND t.id=(NULLIF($1::jsonb->>'ticketId',''))::int)
 OR (NULLIF($1::jsonb->>'ticketId','') IS NULL AND EXISTS (
 SELECT 1 FROM ticket_events s WHERE s.ticket_id=t.id AND s.event='CBM_SOURCE' AND s.payload->>'source_key'=$1::jsonb->>'sourceKey'))
 ORDER BY t.id LIMIT 1
)
SELECT jsonb_build_object('now',clock_timestamp(),'nonce',gen_random_uuid()::text,
 'token',replace(gen_random_uuid()::text || gen_random_uuid()::text,'-',''),
 'ticket',(SELECT to_jsonb(t) FROM target t),
 'revision',(SELECT updated_at::text FROM target),
 'state',(SELECT payload FROM ticket_events WHERE ticket_id=(SELECT id FROM target)
          AND event='CBM_DISPATCH_STATE' ORDER BY id DESC LIMIT 1),
 'inbox',COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM ticket_events e
          WHERE e.ticket_id=(SELECT id FROM target) AND e.event='CBM_RESPONSE'), '[]'::jsonb),
 'candidates',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.open_jobs,c.last_assigned_at ASC NULLS FIRST,c.rating DESC,c.technician_id)
 FROM (SELECT x.id AS technician_id,x.full_name,x.email,x.rating,x.last_assigned_at,
 (SELECT count(*) FROM tickets j WHERE j.technician_id=x.id AND j.status IN ('ASSIGNED','WORK_DONE','PENDING_APPROVAL','REWORK')) AS open_jobs
 FROM technicians x WHERE x.active=TRUE AND x.zone='building-A'
 AND (SELECT required_skill FROM target)=ANY(x.skills)) c),'[]'::jsonb)
) AS context;`;

const COMMIT = `
WITH changed AS (
 UPDATE tickets SET status=$3::jsonb->>'status',
 technician_id=CASE WHEN $3::jsonb->>'status'='ASSIGNED' THEN ($3::jsonb->>'assignee')::int ELSE technician_id END,
 scheduled_date=CASE WHEN $3::jsonb->>'status'='ASSIGNED' THEN ($3::jsonb->>'scheduled_date')::date ELSE scheduled_date END,
 scheduled_slot=CASE WHEN $3::jsonb->>'status'='ASSIGNED' THEN $3::jsonb->>'scheduled_slot' ELSE scheduled_slot END,
 updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond')
 WHERE id=$1::int AND updated_at=$2::timestamptz RETURNING id,technician_id
), log AS (
 INSERT INTO ticket_events(ticket_id,event,payload) SELECT id,'CBM_DISPATCH_STATE',$3::jsonb FROM changed RETURNING id
), stats AS (
 UPDATE technicians SET last_assigned_at=clock_timestamp()
 WHERE id IN (SELECT technician_id FROM changed) AND $4::boolean RETURNING id
)
SELECT EXISTS(SELECT 1 FROM changed) AS applied;`;

// GET is read-only. Only an explicit POST from the confirmation page records a decision.
const CHECK_OFFER = `
SELECT jsonb_build_object('valid',EXISTS(
 SELECT 1 FROM tickets t JOIN LATERAL (
 SELECT payload FROM ticket_events WHERE ticket_id=t.id AND event='CBM_DISPATCH_STATE' ORDER BY id DESC LIMIT 1
 ) s ON TRUE CROSS JOIN LATERAL jsonb_array_elements(s.payload->'offers') o
 WHERE t.id=$1::int AND t.status='DISPATCHING' AND o->>'id'=$2 AND o->>'token'=$3
 AND o->>'status' IN ('SENDING','LIVE','UNCERTAIN') AND clock_timestamp()<(o->>'expires_at')::timestamptz
), 'ticket_id',$1::int) AS check_result;`;

// Lock and read occur in separate statements within the node's transaction.
// Fresh read-committed snapshot after the lock prevents stale-offer checks.
const RECORD_RESPONSE = `
SELECT id AS locked_ticket FROM tickets WHERE id=$1::int FOR UPDATE;
WITH valid AS MATERIALIZED (
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
SELECT jsonb_build_object('recorded',EXISTS(SELECT 1 FROM recorded),'ticket_id',$1::int) AS response_result;`;

// One recovery ticket per tick keeps one ticket per agent invocation and per memory scope.
// Normal intake and response webhooks launch their own immediate executions.
const DUE = `
SELECT t.id AS ticket_id FROM tickets t JOIN LATERAL (
 SELECT payload FROM ticket_events WHERE ticket_id=t.id AND event='CBM_DISPATCH_STATE' ORDER BY id DESC LIMIT 1
) s ON TRUE
WHERE COALESCE((s.payload->>'halted')::boolean,FALSE)=FALSE AND (
 (s.payload->>'next_wake')::timestamptz<=clock_timestamp()
 OR EXISTS(SELECT 1 FROM ticket_events e WHERE e.ticket_id=t.id AND e.event='CBM_RESPONSE'
           AND e.id>COALESCE((s.payload->>'response_cursor')::bigint,0)))
ORDER BY (s.payload->>'next_wake')::timestamptz ASC NULLS LAST,t.id LIMIT 1;`;

module.exports = {CREATE,LOAD,COMMIT,CHECK_OFFER,RECORD_RESPONSE,DUE};
