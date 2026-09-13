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
const DUE_INITIALIZED = `
SELECT t.id AS ticket_id FROM tickets t JOIN LATERAL (
 SELECT payload FROM ticket_events WHERE ticket_id=t.id AND event='CBM_DISPATCH_STATE' ORDER BY id DESC LIMIT 1
) s ON TRUE
WHERE COALESCE((s.payload->>'halted')::boolean,FALSE)=FALSE AND (
 (s.payload->>'next_wake')::timestamptz<=clock_timestamp()
 OR EXISTS(SELECT 1 FROM ticket_events e WHERE e.ticket_id=t.id AND e.event='CBM_RESPONSE'
           AND e.id>COALESCE((s.payload->>'response_cursor')::bigint,0)))
ORDER BY (s.payload->>'next_wake')::timestamptz ASC NULLS LAST,t.id LIMIT 1;`;

// Read-only native Postgres tool. Return operational facts, never tokens, message
// bodies, configuration, arbitrary database rows, or a list of next tool calls.
const PUBLIC_CONTEXT = `
WITH loaded AS (${LOAD.trim().replace(/;$/, '')}), base AS (
 SELECT context AS raw, context->'ticket' AS t, NULLIF(context->'state','null'::jsonb) AS s,
 (context->>'now')::timestamptz AS instant FROM loaded
), summary AS (
 SELECT *,
 COALESCE((t->>'severity')::int>=4,FALSE) AS urgent,
 (SELECT count(*) FROM jsonb_array_elements(COALESCE(s->'offers','[]')) o WHERE o->>'status' IN ('SENDING','LIVE','UNCERTAIN')) AS active_count,
 (SELECT count(*) FROM jsonb_array_elements(COALESCE(s->'offers','[]')) o WHERE o->>'status' IN ('SENDING','LIVE','UNCERTAIN') AND (o->>'expires_at')::timestamptz<=instant) AS expired_count,
 (SELECT count(*) FROM jsonb_array_elements(raw->'inbox') e WHERE (e->>'id')::bigint>COALESCE((s->>'response_cursor')::bigint,0)) AS response_count,
 COALESCE((s->>'halted')::boolean,FALSE) OR EXISTS (
 SELECT 1 FROM jsonb_each(COALESCE(s->'messages','{}')) m WHERE m.value->>'status'='UNCERTAIN'
 OR (m.value->>'status'='SENDING' AND (m.value->>'claimed_at')::timestamptz+interval '5 minutes'<instant)) AS needs_operator,
 COALESCE((SELECT jsonb_agg(id ORDER BY ord) FROM jsonb_array_elements(COALESCE(s->'shortlist','[]')) WITH ORDINALITY AS ids(id,ord)
 WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(s->'offers','[]')) o WHERE o->'technician_id'=id)
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(raw->'candidates') c WHERE c->'technician_id'=id)),'[]') AS available,
 EXISTS(SELECT 1 FROM jsonb_each(COALESCE(s->'messages','{}')) m WHERE m.value->>'status'='PENDING'
 AND m.key NOT LIKE 'offer:%' AND (m.key<>'opening' OR t->>'status' IN ('LOCALIZED','DISPATCHING'))) AS pending_notices
 FROM base
), checked AS (
 SELECT *, response_count>0 OR expired_count>0 OR pending_notices OR (
 t->>'status' IN ('LOCALIZED','DISPATCHING') AND s#>>'{messages,opening,status}'='SENT' AND (
 (active_count<CASE WHEN urgent THEN 2 ELSE 1 END AND jsonb_array_length(available)>0 AND (NOT urgent OR instant<(s->>'urgent_start')::timestamptz))
 OR (active_count=0 AND (jsonb_array_length(available)=0 OR (urgent AND instant>=(s->>'urgent_start')::timestamptz))))) AS unfinished
 FROM summary
)
SELECT jsonb_build_object(
 'ticket_id',t->'id','initialized',s IS NOT NULL,'status',t->>'status',
 'outcome',CASE WHEN t IS NULL OR t='null'::jsonb THEN 'NO_TICKET'
 WHEN needs_operator OR (s IS NULL AND (raw->>'init_failures')::int>=3) THEN 'OPERATOR_ACTION_REQUIRED'
 WHEN s IS NULL THEN 'UNINITIALIZED' WHEN unfinished THEN 'ACTION_REQUIRED'
 WHEN t->>'status'='ASSIGNED' THEN 'ASSIGNED' WHEN t->>'status'='ESCALATED' THEN 'ESCALATED' ELSE 'WAITING' END,
 'now',instant,'urgent',urgent,'max_live_offers',CASE WHEN urgent THEN 2 ELSE 1 END,
 'active_offer_count',active_count,'expired_offer_count',expired_count,'pending_response_count',response_count,
 'urgent_start',s->'urgent_start','original_date',s->'original_date','opening_status',s#>>'{messages,opening,status}',
 'available_candidate_ids',available,'next_wake',s->'next_wake',
 'error',CASE WHEN needs_operator THEN COALESCE(s->>'error','Delivery receipt missing or uncertain. Operator reconciliation required.') ELSE NULL END,
 'offers',COALESCE((SELECT jsonb_agg(o-'token') FROM jsonb_array_elements(COALESCE(s->'offers','[]')) o),'[]'),
 'notices',COALESCE((SELECT jsonb_agg(jsonb_build_object('key',m.key,'status',m.value->>'status','message_id',m.value->'message_id')) FROM jsonb_each(COALESCE(s->'messages','{}')) m),'[]'),
 'candidates',COALESCE((SELECT jsonb_agg(jsonb_build_object('technician_id',id,'eligible',c IS NOT NULL,
 'full_name',c->'full_name','open_jobs',c->'open_jobs','last_assigned_at',c->'last_assigned_at','rating',c->'rating') ORDER BY ord)
 FROM jsonb_array_elements(COALESCE(s->'shortlist','[]')) WITH ORDINALITY ids(id,ord)
 LEFT JOIN LATERAL (SELECT value AS c FROM jsonb_array_elements(raw->'candidates') WHERE value->'technician_id'=id) found ON TRUE),'[]')
) AS context FROM checked;`;

const PUBLIC_RESULT = `SELECT context || jsonb_build_object('operation_result',$2::jsonb) AS context FROM (${PUBLIC_CONTEXT.trim().replace(/;$/, '')}) result;`;

// A native create call can finish before dispatch initialization. Such tickets
// remain recoverable, with bounded initialization failures recorded independently.
const INIT_FAILURE = `
WITH target AS (${LOAD.trim().replace(/;$/, '')}), logged AS (
 INSERT INTO ticket_events(ticket_id,event,payload)
 SELECT (context#>>'{ticket,id}')::int,'CBM_INIT_FAILURE','{"reason":"Agent ended before initialization"}'::jsonb
 FROM target WHERE context->'ticket'<>'null'::jsonb AND context->'state'='null'::jsonb RETURNING id
) SELECT count(*) AS recorded FROM logged;`;

const DUE = `
SELECT ticket_id FROM (
 SELECT ticket_id,0 AS priority FROM (${DUE_INITIALIZED.trim().replace(/;$/, '')}) initialized
 UNION ALL
 SELECT t.id,1 FROM tickets t WHERE t.status='LOCALIZED'
 AND EXISTS(SELECT 1 FROM ticket_events e WHERE e.ticket_id=t.id AND e.event='CBM_SOURCE')
 AND NOT EXISTS(SELECT 1 FROM ticket_events e WHERE e.ticket_id=t.id AND e.event='CBM_DISPATCH_STATE')
 AND (SELECT count(*) FROM ticket_events e WHERE e.ticket_id=t.id AND e.event='CBM_INIT_FAILURE')<3
 AND COALESCE((SELECT max(created_at) FROM ticket_events e WHERE e.ticket_id=t.id AND e.event='CBM_INIT_FAILURE'),t.created_at)+interval '1 minute'<=clock_timestamp()
) due ORDER BY priority,ticket_id LIMIT 1;`;

module.exports = {CREATE,LOAD,COMMIT,CHECK_OFFER,RECORD_RESPONSE,DUE,PUBLIC_CONTEXT,PUBLIC_RESULT,INIT_FAILURE};
