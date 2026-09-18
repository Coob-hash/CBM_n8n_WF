'use strict';

// The strings below are fixed SQL; all runtime data is passed as parameters.
const CREATE = 'SELECT * FROM public.cbm_create_ticket($1::jsonb)';

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
 'init_failures',(SELECT count(*) FROM ticket_events WHERE ticket_id=(SELECT id FROM target) AND event='CBM_INIT_FAILURE'),
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
const RECORD_RESPONSE = 'SELECT * FROM public.cbm_record_offer_response($1::int,$2::text,$3::text,$4::text)';

// Read-only native Postgres tool. Return operational facts, never tokens, message
// bodies, configuration, arbitrary database rows, or a list of next tool calls.
const PUBLIC_CONTEXT = 'SELECT public.cbm_dispatch_context($1::jsonb) AS context;';

const PUBLIC_RESULT = `SELECT context || jsonb_build_object('operation_result',$2::jsonb) AS context FROM (${PUBLIC_CONTEXT.trim().replace(/;$/, '')}) result;`;

// An intake-created, authorized ticket can remain uninitialized after an agent failure.
// Record bounded failures independently so scheduled recovery can retry it.
const INIT_FAILURE = `
WITH target AS (${LOAD.trim().replace(/;$/, '')}), logged AS (
 INSERT INTO ticket_events(ticket_id,event,payload)
 SELECT (context#>>'{ticket,id}')::int,'CBM_INIT_FAILURE','{"reason":"Agent ended before initialization"}'::jsonb
 FROM target WHERE context->'ticket'<>'null'::jsonb AND context->'state'='null'::jsonb RETURNING id
) SELECT count(*) AS recorded FROM logged;`;

const DUE = 'SELECT * FROM public.cbm_claim_dispatch_ticket($1::integer,$2::text);';

module.exports = {CREATE,LOAD,COMMIT,CHECK_OFFER,RECORD_RESPONSE,DUE,PUBLIC_CONTEXT,PUBLIC_RESULT,INIT_FAILURE};
