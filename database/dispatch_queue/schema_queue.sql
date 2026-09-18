-- Apply after the intake migration. No existing ticket or dispatch snapshot is replaced.
BEGIN;
CREATE TABLE IF NOT EXISTS cbm_dispatch_queue_visits (
 ticket_id integer PRIMARY KEY REFERENCES tickets(id),
 last_selected_at timestamptz, last_finished_at timestamptz,
 lease_token uuid, batch_id uuid, lease_until timestamptz,
 worker_execution_id text, selection_reason text, last_outcome text
);

CREATE OR REPLACE VIEW cbm_dispatch_queue_items AS
WITH base AS (
 SELECT t.*, s.payload AS dispatch_state,
  coalesce((s.payload->>'halted')::boolean,false)
  OR EXISTS(SELECT 1 FROM jsonb_each(coalesce(s.payload->'messages','{}')) m
   WHERE m.value->>'status'='UNCERTAIN' OR
   (m.value->>'status'='SENDING' AND (m.value->>'claimed_at')::timestamptz+interval '5 minutes'<statement_timestamp()))
  OR (s.payload IS NULL AND (SELECT count(*) FROM ticket_events e WHERE e.ticket_id=t.id AND e.event='CBM_INIT_FAILURE')>=3)
  AS operator_required,
  (SELECT count(*) FROM ticket_events e WHERE e.ticket_id=t.id AND e.event='CBM_RESPONSE'
   AND e.id>coalesce((s.payload->>'response_cursor')::bigint,0)) AS pending_responses,
  EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(s.payload->'offers','[]')) o
   WHERE o->>'status' IN ('SENDING','LIVE','UNCERTAIN') AND (o->>'expires_at')::timestamptz<=statement_timestamp()) AS expired_offers,
  EXISTS(SELECT 1 FROM jsonb_each(coalesce(s.payload->'messages','{}')) m
   WHERE m.value->>'status'='PENDING' AND m.key NOT LIKE 'offer:%'
   AND (m.key<>'opening' OR t.status IN ('LOCALIZED','DISPATCHING'))) AS pending_notices,
  (SELECT max(e.created_at) FROM ticket_events e WHERE e.ticket_id=t.id AND e.event='CBM_INIT_FAILURE') AS last_init_failure
 FROM tickets t LEFT JOIN LATERAL (
  SELECT payload FROM ticket_events WHERE ticket_id=t.id AND event='CBM_DISPATCH_STATE' ORDER BY id DESC LIMIT 1
 ) s ON true WHERE t.status<>'CLOSED'
)
SELECT b.id AS ticket_id,b.created_at,b.status,b.severity,b.required_skill,b.ifc_name,
 left(b.description,240) AS issue_summary,b.dispatch_authorized_at,
 b.operator_required,b.operator_required OR b.status IN ('ESCALATED','REWORK','NEEDS_TRIAGE') AS attention_required,
 CASE WHEN b.status='PENDING_AUTHORIZATION' THEN 'AWAITING_FM_AUTHORIZATION'
  WHEN b.operator_required THEN 'OPERATOR_ACTION_REQUIRED'
  WHEN b.status IN ('ASSIGNED','WORK_DONE','PENDING_APPROVAL','REWORK') THEN 'WF2_COMPLETION'
  WHEN b.status IN ('REJECTED','DUPLICATE') THEN 'NO_DISPATCH'
  WHEN b.status='ESCALATED' THEN 'MANUAL_DISPATCH'
  ELSE 'DISPATCH' END AS responsibility,
 (NOT b.operator_required AND (NOT b.requires_dispatch_authorization OR b.dispatch_authorized_at IS NOT NULL)
  AND ((b.dispatch_state IS NULL AND b.status='LOCALIZED'
        AND (b.last_init_failure IS NULL OR b.last_init_failure+interval '1 minute'<=statement_timestamp()))
   OR (b.dispatch_state IS NOT NULL AND (b.pending_responses>0 OR b.expired_offers OR b.pending_notices
    OR (b.status IN ('LOCALIZED','DISPATCHING') AND (b.dispatch_state->>'next_wake')::timestamptz<=statement_timestamp()))))) AS actionable,
 q.last_selected_at,q.last_finished_at,q.lease_until,q.last_outcome
FROM base b LEFT JOIN cbm_dispatch_queue_visits q ON q.ticket_id=b.id;

CREATE OR REPLACE FUNCTION cbm_dispatch_portfolio(p_page integer DEFAULT 0) RETURNS jsonb
LANGUAGE sql STABLE AS $$
 WITH selected AS (
  SELECT ticket_id,created_at,status,severity,required_skill,ifc_name,issue_summary,
   dispatch_authorized_at,operator_required,attention_required,responsibility,actionable,last_selected_at
  FROM cbm_dispatch_queue_items ORDER BY created_at DESC,ticket_id DESC
  LIMIT 5 OFFSET greatest(0,least(coalesce(p_page,0),100000))*5
 ), totals AS (
  SELECT count(*) AS total,count(*) FILTER(WHERE actionable) AS actionable,
   count(*) FILTER(WHERE operator_required) AS operator_required,
   count(*) FILTER(WHERE attention_required) AS attention_required FROM cbm_dispatch_queue_items
 ) SELECT jsonb_build_object('scope','ALL_NON_CLOSED_TICKETS','excluded_statuses',jsonb_build_array('CLOSED'),
  'total',total,'actionable',actionable,'operator_required',operator_required,'attention_required',attention_required,
  'page',greatest(0,least(coalesce(p_page,0),100000)),'page_size',5,
  'has_more',total>(greatest(0,least(coalesce(p_page,0),100000))+1)*5,
  'status_counts',coalesce((SELECT jsonb_object_agg(status,n) FROM
    (SELECT status,count(*) n FROM cbm_dispatch_queue_items GROUP BY status) c),'{}'::jsonb),
  'tickets',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY created_at DESC,ticket_id DESC) FROM selected s),'[]'::jsonb))
 FROM totals;
$$;

CREATE OR REPLACE FUNCTION cbm_claim_dispatch_batch(p_limit integer DEFAULT 5)
RETURNS TABLE(dispatch_run boolean,"ticketId" text,"leaseToken" uuid,"batchId" uuid,"selectionReason" text,"batchPosition" integer)
LANGUAGE plpgsql AS $$
DECLARE chosen integer[]:='{}'; tid integer; lim integer:=greatest(1,least(coalesce(p_limit,5),5));
 batch uuid:=gen_random_uuid(); token uuid; pos integer:=0; why text; fair_id integer;
BEGIN
 -- Serializes selection only. All selected tickets have persistent expiring claims.
 PERFORM pg_advisory_xact_lock(164620260916::bigint);
 SELECT coalesce(array_agg(ticket_id ORDER BY created_at DESC,ticket_id DESC),'{}') INTO chosen
 FROM (SELECT ticket_id,created_at FROM cbm_dispatch_queue_items
  WHERE actionable AND (lease_until IS NULL OR lease_until<=clock_timestamp())
  ORDER BY created_at DESC,ticket_id DESC LIMIT lim-1) newest;
 SELECT ticket_id INTO tid FROM cbm_dispatch_queue_items
 WHERE actionable AND (lease_until IS NULL OR lease_until<=clock_timestamp()) AND NOT(ticket_id=ANY(chosen))
 ORDER BY last_selected_at ASC NULLS FIRST,created_at ASC,ticket_id ASC LIMIT 1;
 fair_id:=tid;
 IF tid IS NOT NULL THEN chosen:=array_append(chosen,tid); END IF;
 FOREACH tid IN ARRAY chosen LOOP
  pos:=pos+1; token:=gen_random_uuid();
  why:=CASE WHEN tid=fair_id THEN 'OLDER_UNFINISHED_TURN'
            ELSE 'NEWEST_CREATED' END;
  INSERT INTO cbm_dispatch_queue_visits(ticket_id,last_selected_at,lease_token,batch_id,lease_until,worker_execution_id,selection_reason)
  VALUES(tid,clock_timestamp(),token,batch,clock_timestamp()+interval '65 minutes',NULL,why)
  ON CONFLICT(ticket_id) DO UPDATE SET last_selected_at=EXCLUDED.last_selected_at,lease_token=EXCLUDED.lease_token,
   batch_id=EXCLUDED.batch_id,lease_until=EXCLUDED.lease_until,worker_execution_id=NULL,selection_reason=EXCLUDED.selection_reason;
  RETURN QUERY SELECT true,tid::text,token,batch,why,pos;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION cbm_start_dispatch_work(p_ticket integer,p_token uuid,p_execution text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE changed integer;
BEGIN
 UPDATE cbm_dispatch_queue_visits SET worker_execution_id=p_execution,lease_until=clock_timestamp()+interval '65 minutes'
 WHERE ticket_id=p_ticket AND lease_token=p_token AND lease_until>clock_timestamp()
 AND worker_execution_id IS NULL RETURNING ticket_id INTO changed;
 RETURN jsonb_build_object('accepted',changed IS NOT NULL,'ticketId',changed);
END $$;

CREATE OR REPLACE FUNCTION cbm_finish_dispatch_work(p_ticket integer,p_token uuid,p_execution text,p_outcome text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE changed integer;
BEGIN
 UPDATE cbm_dispatch_queue_visits SET lease_token=NULL,lease_until=NULL,last_finished_at=clock_timestamp(),
  last_outcome=left(p_outcome,100)
 WHERE ticket_id=p_ticket AND lease_token=p_token AND worker_execution_id=p_execution
 RETURNING ticket_id INTO changed;
 RETURN jsonb_build_object('ticket_id',p_ticket,'released',changed IS NOT NULL,'outcome',p_outcome);
END $$;
-- Single-ticket entry point. Retain the old batch/start functions for saved backups.
-- Selecting the ticket and recording its execution owner is one atomic operation.
CREATE OR REPLACE FUNCTION cbm_claim_dispatch_ticket(p_ticket integer,p_execution text)
RETURNS TABLE("ticketId" text,"leaseToken" uuid,"selectionReason" text)
LANGUAGE plpgsql AS $$
DECLARE tid integer; token uuid:=gen_random_uuid(); why text;
BEGIN
 IF p_execution IS NULL OR btrim(p_execution)='' THEN RAISE EXCEPTION 'Execution ID is required'; END IF;
 PERFORM pg_advisory_xact_lock(164620260916);
 SELECT i.ticket_id INTO tid FROM cbm_dispatch_queue_items i
 WHERE i.actionable AND (i.lease_until IS NULL OR i.lease_until<=clock_timestamp())
  AND (p_ticket IS NULL OR i.ticket_id=p_ticket)
 ORDER BY i.last_selected_at ASC NULLS FIRST,i.created_at ASC,i.ticket_id ASC LIMIT 1;
 IF tid IS NULL THEN RETURN; END IF;
 why:=CASE WHEN p_ticket IS NULL THEN 'RECOVERY_OLDEST_UNFINISHED' ELSE 'EVENT_TICKET' END;
 INSERT INTO cbm_dispatch_queue_visits(ticket_id,last_selected_at,lease_token,batch_id,lease_until,worker_execution_id,selection_reason)
 VALUES(tid,clock_timestamp(),token,NULL,clock_timestamp()+interval '65 minutes',p_execution,why)
 ON CONFLICT(ticket_id) DO UPDATE SET last_selected_at=EXCLUDED.last_selected_at,lease_token=EXCLUDED.lease_token,
  batch_id=NULL,lease_until=EXCLUDED.lease_until,worker_execution_id=EXCLUDED.worker_execution_id,selection_reason=EXCLUDED.selection_reason;
 RETURN QUERY SELECT tid::text,token,why;
END $$;
COMMIT;
