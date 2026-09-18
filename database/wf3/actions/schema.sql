-- Additive WF3 functions only. Existing WF1/WF2 functions and triggers are retained.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS uq_wf3_action_request ON ticket_events(ticket_id,(payload->>'request_key'))
 WHERE event='CBM_WF3_ACTION_REQUEST';
CREATE TABLE IF NOT EXISTS cbm_wf3_approval_emails (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_key text NOT NULL UNIQUE,
 ticket_id integer NOT NULL REFERENCES tickets(id), approval_id uuid NOT NULL,
 token text NOT NULL DEFAULT replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '72 hours',
 send_status text NOT NULL DEFAULT 'SENDING' CHECK(send_status IN ('SENDING','SENT','UNCONFIRMED')),
 message_id text, error text, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION cbm_wf3_action_context(tid integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('approval_id',CASE WHEN t.status IN ('PENDING_AUTHORIZATION','LOCALIZED','REJECTED')
  THEN t.dispatch_authorization_id ELSE t.approval_id END,
  'expected_updated_at',t.updated_at,'requires_dispatch_authorization',t.requires_dispatch_authorization,
  'completion_decision',(SELECT e.payload->>'decision' FROM ticket_events e WHERE e.ticket_id=t.id
   AND e.event='CBM_WF2_APPROVAL' AND e.payload->>'approval_id'=t.approval_id::text LIMIT 1),
  'ifc_update_succeeded',coalesce(cbm_wf2_ifc_succeeded(t.id,t.approval_id),false),
  'allowed_actions',CASE t.status WHEN 'PENDING_AUTHORIZATION' THEN
   jsonb_build_array('approve_intervention','reject_intervention','resend_approval_email')
   WHEN 'PENDING_APPROVAL' THEN CASE
    WHEN EXISTS(SELECT 1 FROM ticket_events e WHERE e.ticket_id=t.id AND e.event='CBM_WF2_APPROVAL'
     AND e.payload->>'approval_id'=t.approval_id::text AND e.payload->>'decision'='APPROVED') THEN jsonb_build_array('approve_completion')
    WHEN EXISTS(SELECT 1 FROM ticket_events e WHERE e.ticket_id=t.id AND e.event='CBM_WF2_APPROVAL'
     AND e.payload->>'approval_id'=t.approval_id::text AND e.payload->>'decision'='REJECTED') THEN jsonb_build_array('request_rework')
    ELSE jsonb_build_array('approve_completion','request_rework','resend_approval_email') END
   ELSE '[]'::jsonb END)
 FROM tickets t WHERE t.id=tid;
$$;

CREATE OR REPLACE FUNCTION cbm_wf3_begin_action(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE t tickets%ROWTYPE; tech technicians%ROWTYPE; a text=p->>'action'; aid uuid;
 k text; previous jsonb; decision text; old_decision text; outbox_id bigint; r jsonb; c jsonb;
BEGIN
 IF a NOT IN ('approve_intervention','reject_intervention','resend_approval_email','approve_completion','request_rework')
 OR a IS NULL OR coalesce(p->>'requestId','')='' OR coalesce(p->>'sessionId','')=''
 OR coalesce(p->>'question','')='' OR p->>'actor' NOT IN ('FM_CHAT','FM_EMAIL_LINK')
 OR p->>'actor' IS NULL OR (p->>'truncated')::boolean IS DISTINCT FROM false THEN
  RETURN jsonb_build_object('outcome','BLOCKED','reason','Invalid or truncated FM request'); END IF;
 IF a IN ('reject_intervention','request_rework') AND length(btrim(coalesce(p->>'reason','')))<2 THEN
  RETURN jsonb_build_object('outcome','BLOCKED','reason','The FM must supply a rejection/rework reason'); END IF;
 aid=(p->>'approvalId')::uuid;
 SELECT * INTO t FROM tickets WHERE id=(p->>'ticketId')::int FOR UPDATE;
 IF t.id IS NULL THEN RETURN jsonb_build_object('outcome','BLOCKED','reason','Ticket not found'); END IF;
 k=left(p->>'requestId',150)||':'||a||':'||t.id||':'||coalesce(aid::text,'missing');
 SELECT payload INTO previous FROM ticket_events WHERE ticket_id=t.id AND event='CBM_WF3_ACTION_REQUEST' AND payload->>'request_key'=k;
 IF previous IS NOT NULL THEN
  IF previous->>'action' IN ('approve_intervention','reject_intervention') OR previous->>'route'='intake_resend' THEN
   RETURN previous->'result'||jsonb_build_object('already_processed',true,'ticket_status',t.status); END IF;
  -- Continuations still validate current approval and the persisted decision below.
 END IF;
 IF aid IS NULL OR aid IS DISTINCT FROM (CASE WHEN a IN ('approve_intervention','reject_intervention')
   OR (a='resend_approval_email' AND t.status='PENDING_AUTHORIZATION') THEN t.dispatch_authorization_id ELSE t.approval_id END) THEN
  RETURN jsonb_build_object('outcome','BLOCKED','reason','Stale approval: read ticket_lookup again','ticket_status',t.status); END IF;
 IF previous IS NULL AND t.updated_at IS DISTINCT FROM (p->>'expectedUpdatedAt')::timestamptz THEN
  RETURN jsonb_build_object('outcome','BLOCKED','reason','Ticket changed: read ticket_lookup again','ticket_status',t.status); END IF;
 IF a IN ('approve_intervention','reject_intervention') THEN
  IF (a='approve_intervention' AND t.dispatch_authorized_at IS NOT NULL)
    OR (a='reject_intervention' AND t.status='REJECTED' AND t.dispatch_rejected_at IS NOT NULL) THEN
   RETURN jsonb_build_object('outcome','ALREADY_DONE','ticketId',t.id,'ticket_status',t.status); END IF;
  IF t.status<>'PENDING_AUTHORIZATION' OR NOT t.requires_dispatch_authorization THEN
   RETURN jsonb_build_object('outcome','BLOCKED','reason','Ticket is not awaiting initial authorization','ticket_status',t.status); END IF;
  -- The authenticated FM may decide in chat after an email link expires. Renew
  -- that ticket's token before calling the existing authorization function.
  IF t.dispatch_authorization_expires_at IS NULL OR t.dispatch_authorization_expires_at<=clock_timestamp() THEN
   UPDATE tickets SET dispatch_authorization_token=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''),
    dispatch_authorization_expires_at=clock_timestamp()+interval '72 hours' WHERE id=t.id RETURNING * INTO t;
  END IF;
  r=cbm_authorize_dispatch(t.id,t.dispatch_authorization_id,t.dispatch_authorization_token,
    CASE a WHEN 'approve_intervention' THEN 'approve' ELSE 'reject' END);
  IF coalesce((r->>'applied')::boolean,false) THEN
   UPDATE ticket_events SET payload=payload||jsonb_build_object('actor',p->>'actor','source','WF3',
    'reason',nullif(p->>'reason',''),'request_key',k) WHERE ticket_id=t.id AND event='CBM_DISPATCH_AUTHORIZATION'
    AND payload->>'authorization_id'=t.dispatch_authorization_id::text;
  END IF;
  SELECT status INTO decision FROM tickets WHERE id=t.id;
  r=jsonb_build_object('outcome',CASE WHEN (r->>'applied')::boolean THEN 'APPLIED' ELSE 'BLOCKED' END,
   'ticketId',t.id,'ticket_status',decision,'request_key',k,'reason',r->>'reason');
 ELSIF a='resend_approval_email' AND t.status='PENDING_AUTHORIZATION' THEN
  IF t.dispatch_authorization_expires_at IS NULL OR t.dispatch_authorization_expires_at<=clock_timestamp() THEN
   UPDATE tickets SET dispatch_authorization_token=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''),
    dispatch_authorization_expires_at=clock_timestamp()+interval '72 hours' WHERE id=t.id RETURNING * INTO t;
  END IF;
  -- Reuse the WF1 outbox and its Gmail/receipt handling. Do not claim it was sent.
  INSERT INTO cbm_intake_outbox(event_key,kind,payload) VALUES('wf3-resend:'||k,'AUTHORIZATION',
   jsonb_build_object('ticket_id',t.id,'authorization_id',t.dispatch_authorization_id,'token',t.dispatch_authorization_token,
    'ifc_global_id',t.ifc_global_id,'ifc_name',t.ifc_name,'description',t.description,'severity',t.severity,
    'photo_url',t.photo_before_url,'expires_at',t.dispatch_authorization_expires_at,'reminder',true))
   ON CONFLICT(event_key) DO UPDATE SET event_key=excluded.event_key RETURNING id INTO outbox_id;
  r=jsonb_build_object('outcome','QUEUED','route','intake_resend','ticketId',t.id,'ticket_status',t.status,
   'request_key',k,'outbox_id',outbox_id,'reason','WF1 notification recovery will send this request');
 ELSE
  decision=CASE a WHEN 'approve_completion' THEN 'APPROVED' WHEN 'request_rework' THEN 'REJECTED' END;
  SELECT payload->>'decision' INTO old_decision FROM ticket_events WHERE ticket_id=t.id
   AND event='CBM_WF2_APPROVAL' AND payload->>'approval_id'=aid::text;
  IF a='resend_approval_email' THEN
   IF t.status<>'PENDING_APPROVAL' OR old_decision IS NOT NULL THEN
    RETURN jsonb_build_object('outcome','BLOCKED','reason','There is no undecided completion awaiting approval','ticket_status',t.status); END IF;
  ELSE
   IF t.status<>'PENDING_APPROVAL' AND NOT (a='approve_completion' AND t.status='CLOSED')
     AND NOT(a='request_rework' AND t.status='REWORK') THEN
    RETURN jsonb_build_object('outcome','BLOCKED','reason','Ticket is not awaiting completion approval','ticket_status',t.status); END IF;
   IF old_decision IS NOT NULL AND old_decision<>decision THEN
    RETURN jsonb_build_object('outcome','BLOCKED','reason','An opposite FM decision is already recorded','ticket_status',t.status); END IF;
   IF t.status<>'PENDING_APPROVAL' AND old_decision IS NULL THEN
    RETURN jsonb_build_object('outcome','BLOCKED','reason','Current FM decision is missing'); END IF;
   INSERT INTO ticket_events(ticket_id,event,payload) VALUES(t.id,'CBM_WF2_APPROVAL',
    jsonb_build_object('approval_id',aid,'decision',decision,'actor',p->>'actor','source','WF3',
     'request_key',k,'reason',nullif(p->>'reason',''))) ON CONFLICT DO NOTHING;
   SELECT payload->>'decision' INTO old_decision FROM ticket_events WHERE ticket_id=t.id
    AND event='CBM_WF2_APPROVAL' AND payload->>'approval_id'=aid::text;
   IF old_decision IS DISTINCT FROM decision THEN
    RETURN jsonb_build_object('outcome','BLOCKED','reason','Another approval decision won the race'); END IF;
  END IF;
  SELECT * INTO tech FROM technicians WHERE id=t.technician_id;
  c=jsonb_build_object('ticketId',t.id,'approvalId',aid,'operationKey','wf2:'||t.id||':'||aid,
   'decision',decision,'technicianId',tech.id,'technicianName',tech.full_name,'technicianEmail',tech.email,
   'ifcGlobalId',t.ifc_global_id,'rejectionReason',coalesce((SELECT payload->>'reason' FROM ticket_events
      WHERE ticket_id=t.id AND event='CBM_WF2_APPROVAL' AND payload->>'approval_id'=aid::text),p->>'reason'),
   'request_key',k,'action',a);
  r=jsonb_build_object('outcome','READY','route',CASE a WHEN 'resend_approval_email' THEN 'completion_resend'
    WHEN 'approve_completion' THEN 'completion_approve' ELSE 'completion_rework' END,
   'ticketId',t.id,'ticket_status',t.status,'request_key',k,'context',c);
 END IF;
 INSERT INTO ticket_events(ticket_id,event,payload) VALUES(t.id,'CBM_WF3_ACTION_REQUEST',
  jsonb_build_object('request_key',k,'action',a,'approval_id',aid,'actor',p->>'actor','session',p->>'sessionId',
   'request_id',p->>'requestId','question',left(p->>'question',1500),'reason',left(p->>'reason',2000),
   'route',r->>'route','result',r)) ON CONFLICT DO NOTHING;
 RETURN r;
END $$;

CREATE OR REPLACE FUNCTION cbm_wf3_finish_action(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE t tickets%ROWTYPE; r jsonb; request jsonb;
BEGIN
 SELECT * INTO t FROM tickets WHERE id=(p->>'ticketId')::int FOR UPDATE;
 SELECT payload INTO request FROM ticket_events WHERE ticket_id=t.id AND event='CBM_WF3_ACTION_REQUEST'
  AND payload->>'request_key'=p->>'request_key';
 IF request IS NULL THEN RETURN jsonb_build_object('outcome','BLOCKED','reason','Action request was not recorded'); END IF;
 IF p->>'decision' IN ('APPROVED','REJECTED') THEN
  r=cbm_wf2_closure_outcome(p);
  r=r||jsonb_build_object('outcome',CASE WHEN (r->>'settled')::boolean THEN 'APPLIED' ELSE 'INCOMPLETE' END);
 ELSE
  r=coalesce(p->'emailResult','{}'::jsonb)||jsonb_build_object('ticket_status',t.status);
 END IF;
 r=r||jsonb_build_object('ticketId',t.id,'action',request->>'action','request_key',p->>'request_key');
 INSERT INTO ticket_events(ticket_id,event,payload) VALUES(t.id,'CBM_WF3_ACTION_RESULT',r);
 RETURN r;
END $$;

CREATE OR REPLACE FUNCTION cbm_wf3_prepare_email(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE t tickets%ROWTYPE; e cbm_wf3_approval_emails%ROWTYPE;
BEGIN
 SELECT * INTO t FROM tickets WHERE id=(p->>'ticketId')::int FOR UPDATE;
 IF t.id IS NULL OR t.status<>'PENDING_APPROVAL' OR t.approval_id IS DISTINCT FROM (p->>'approvalId')::uuid
 OR EXISTS(SELECT 1 FROM ticket_events WHERE ticket_id=t.id AND event='CBM_WF2_APPROVAL' AND payload->>'approval_id'=t.approval_id::text)
 OR NOT EXISTS(SELECT 1 FROM ticket_events WHERE ticket_id=t.id AND event='CBM_WF3_ACTION_REQUEST'
  AND payload->>'request_key'=p->>'request_key' AND payload->>'action'='resend_approval_email') THEN
  RETURN jsonb_build_object('outcome','BLOCKED','reason','No current undecided completion approval'); END IF;
 SELECT * INTO e FROM cbm_wf3_approval_emails WHERE request_key=p->>'request_key';
 IF e.id IS NOT NULL THEN RETURN jsonb_build_object('outcome',CASE WHEN e.send_status='SENT' THEN 'SENT' ELSE 'UNCONFIRMED' END,
  'already_processed',true,'message_id',e.message_id,'reason','Existing email attempt is not sent again'); END IF;
 INSERT INTO cbm_wf3_approval_emails(request_key,ticket_id,approval_id) VALUES(p->>'request_key',t.id,t.approval_id) RETURNING * INTO e;
 RETURN jsonb_build_object('outcome','SEND','email_id',e.id,'ticketId',t.id,'approvalId',t.approval_id,
  'token',e.token,'expires_at',e.expires_at,'ifc_name',t.ifc_name,'description',left(t.description,1000),
  'report_text',left(t.report_text,5000),'report_file_id',t.report_file_id);
END $$;

CREATE OR REPLACE FUNCTION cbm_wf3_record_email(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE e cbm_wf3_approval_emails%ROWTYPE;
BEGIN
 UPDATE cbm_wf3_approval_emails SET send_status=CASE WHEN p->>'send_status'='SENT' AND nullif(p->>'message_id','') IS NOT NULL
  THEN 'SENT' ELSE 'UNCONFIRMED' END,message_id=nullif(p->>'message_id',''),error=left(p->>'error',1000)
 WHERE id=(p->>'email_id')::uuid AND send_status='SENDING' RETURNING * INTO e;
 IF e.id IS NULL THEN RETURN jsonb_build_object('outcome','UNCONFIRMED','reason','No pending email send claim'); END IF;
 INSERT INTO ticket_events(ticket_id,event,payload) VALUES(e.ticket_id,'CBM_WF3_APPROVAL_EMAIL',
  jsonb_build_object('request_key',e.request_key,'approval_id',e.approval_id,'outcome',e.send_status,'message_id',e.message_id));
 RETURN jsonb_build_object('outcome',e.send_status,'message_id',e.message_id,'ticketId',e.ticket_id,'approvalId',e.approval_id);
END $$;

CREATE OR REPLACE FUNCTION cbm_wf3_email_access(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE e cbm_wf3_approval_emails%ROWTYPE; t tickets%ROWTYPE; decision text;
BEGIN
 IF coalesce(p->>'emailId','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
 OR coalesce(p->>'token','') !~ '^[0-9a-f]{64}$' THEN
  RETURN jsonb_build_object('valid',false,'reason','Invalid approval link'); END IF;
 IF p->>'decision'='reject' AND length(btrim(coalesce(p->>'reason','')))<2 THEN
  RETURN jsonb_build_object('valid',false,'reason','Enter a reason for rework, then submit again'); END IF;
 SELECT * INTO e FROM cbm_wf3_approval_emails WHERE id=(p->>'emailId')::uuid AND token=p->>'token';
 IF e.id IS NULL OR e.expires_at<=clock_timestamp() THEN
  RETURN jsonb_build_object('valid',false,'reason','Invalid or expired approval link'); END IF;
 SELECT * INTO t FROM tickets WHERE id=e.ticket_id;
 IF t.approval_id IS DISTINCT FROM e.approval_id OR t.status<>'PENDING_APPROVAL'
 OR EXISTS(SELECT 1 FROM ticket_events WHERE ticket_id=t.id AND event='CBM_WF2_APPROVAL' AND payload->>'approval_id'=e.approval_id::text) THEN
  RETURN jsonb_build_object('valid',false,'reason','This approval was already decided or replaced'); END IF;
 IF p->>'decision' IS NOT NULL AND p->>'decision' NOT IN ('approve','reject') THEN
  RETURN jsonb_build_object('valid',false,'reason','Invalid decision'); END IF;
 RETURN jsonb_build_object('valid',true,'ticketId',t.id,'approvalId',t.approval_id,'expectedUpdatedAt',t.updated_at,
  'ifc_name',t.ifc_name,'description',left(t.description,1000),'emailId',e.id,'token',e.token,
  'context',jsonb_build_object('ticketId',t.id,'approvalId',t.approval_id,'expectedUpdatedAt',t.updated_at,
   'action',CASE p->>'decision' WHEN 'approve' THEN 'approve_completion' ELSE 'request_rework' END,
   'reason',left(p->>'reason',2000),'actor','FM_EMAIL_LINK','truncated',false,
   'sessionId','wf3-email:'||e.id,'requestId','wf3-email:'||e.id,
   'question','FM submitted completion decision '||coalesce(p->>'decision','view')||' for ticket #'||t.id));
END $$;
COMMIT;
