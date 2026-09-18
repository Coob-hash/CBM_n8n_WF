-- Apply after schema_queue.sql. Public facts only; the request binds one ticket.
CREATE OR REPLACE FUNCTION public.cbm_dispatch_context(p_request jsonb) RETURNS jsonb
LANGUAGE sql VOLATILE AS $context$
SELECT context FROM (WITH loaded AS (WITH target AS (
 SELECT t.* FROM tickets t WHERE
 (NULLIF(p_request::jsonb->>'ticketId','') IS NOT NULL AND t.id=(NULLIF(p_request::jsonb->>'ticketId',''))::int)
 OR (NULLIF(p_request::jsonb->>'ticketId','') IS NULL AND EXISTS (
 SELECT 1 FROM ticket_events s WHERE s.ticket_id=t.id AND s.event='CBM_SOURCE' AND s.payload->>'source_key'=p_request::jsonb->>'sourceKey'))
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
) AS context), base AS (
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
 'ticket',jsonb_build_object('id',t->'id','created_at',t->'created_at','updated_at',t->'updated_at',
 'description',left(t->>'description',1600),'description_truncated',length(t->>'description')>1600,
 'category',t->'category','severity',t->'severity','required_skill',t->'required_skill',
 'asset',jsonb_build_object('ifc_global_id',t->'ifc_global_id','name',t->'ifc_name','class',t->'ifc_class','storey',t->'ifc_storey')),
 'authorization',jsonb_build_object('required',coalesce((t->>'requires_dispatch_authorization')::boolean,false),
 'approved',t->>'dispatch_authorized_at' IS NOT NULL,'approved_at',t->'dispatch_authorized_at'),
 'portfolio',public.cbm_dispatch_portfolio(greatest(0,least(coalesce((p_request::jsonb->>'overviewPage')::integer,0),100000))),
 'ticket_id',t->'id','initialized',s IS NOT NULL,'status',t->>'status',
 'outcome',CASE WHEN t IS NULL OR t='null'::jsonb THEN 'NO_TICKET'
 WHEN t->>'status' IN ('CLOSED','REJECTED','DUPLICATE') THEN t->>'status'
 WHEN t->>'status'='PENDING_AUTHORIZATION' OR (coalesce((t->>'requires_dispatch_authorization')::boolean,false) AND t->>'dispatch_authorized_at' IS NULL) THEN 'AWAITING_FM_AUTHORIZATION'
 WHEN needs_operator OR (s IS NULL AND (raw->>'init_failures')::int>=3) THEN 'OPERATOR_ACTION_REQUIRED'
 WHEN s IS NULL AND t->>'status'='LOCALIZED' THEN 'UNINITIALIZED' WHEN s IS NULL THEN t->>'status' WHEN unfinished THEN 'ACTION_REQUIRED'
 WHEN t->>'status'='ASSIGNED' THEN 'ASSIGNED' WHEN t->>'status'='ESCALATED' THEN 'ESCALATED' ELSE 'WAITING' END,
 'now',instant,'urgent',urgent,'max_live_offers',CASE WHEN urgent THEN 2 ELSE 1 END,
 'active_offer_count',active_count,'expired_offer_count',expired_count,'pending_response_count',response_count,
 'urgent_start',s->'urgent_start','original_date',s->'original_date','opening_status',s#>>'{messages,opening,status}',
 'available_candidate_ids',available,'next_wake',s->'next_wake',
 'error',CASE WHEN needs_operator THEN COALESCE(s->>'error','Delivery receipt missing or uncertain. Operator reconciliation required.') ELSE NULL END,
 'offers',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',o->'id','technician_id',o->'technician_id','full_name',o->'full_name',
 'date',o->'date','slot',o->'slot','status',o->'status','reserved_at',o->'reserved_at','sent_at',o->'sent_at','expires_at',o->'expires_at',
 'knowledge',jsonb_build_object('status',coalesce(o#>>'{technical_knowledge,status}','UNAVAILABLE'),
 'chunk_ids',coalesce((SELECT jsonb_agg(d#>'{metadata,chunk_id}') FROM jsonb_array_elements(coalesce(o#>'{technical_knowledge,chunks}','[]')) d),'[]'::jsonb)))) FROM jsonb_array_elements(COALESCE(s->'offers','[]')) o),'[]'),
 'notices',COALESCE((SELECT jsonb_agg(jsonb_build_object('key',m.key,'status',m.value->>'status','message_id',m.value->'message_id')) FROM jsonb_each(COALESCE(s->'messages','{}')) m),'[]'),
 'candidates',COALESCE((SELECT jsonb_agg(jsonb_build_object('technician_id',id,'eligible',c IS NOT NULL,
 'full_name',c->'full_name','open_jobs',c->'open_jobs','last_assigned_at',c->'last_assigned_at','rating',c->'rating') ORDER BY ord)
 FROM jsonb_array_elements(COALESCE(s->'shortlist','[]')) WITH ORDINALITY ids(id,ord)
 LEFT JOIN LATERAL (SELECT value AS c FROM jsonb_array_elements(raw->'candidates') WHERE value->'technician_id'=id) found ON TRUE),'[]')
) AS context FROM checked) facts;
$context$;
