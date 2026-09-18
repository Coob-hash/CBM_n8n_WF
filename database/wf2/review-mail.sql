-- WF2 requests a review; both email and chat use the existing guarded decision executor.
BEGIN;
CREATE OR REPLACE FUNCTION cbm_wf2_prepare_review_email(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE t tickets%ROWTYPE; e cbm_wf3_approval_emails%ROWTYPE; prefix text; eid uuid;
BEGIN
 SELECT * INTO t FROM tickets WHERE id=(p->>'ticketId')::int FOR UPDATE;
 IF t.id IS NULL OR t.status<>'PENDING_APPROVAL' OR t.approval_id IS DISTINCT FROM (p->>'approvalId')::uuid
 OR nullif(t.report_file_id,'') IS NULL OR coalesce(p->>'source','')<>'WF2_REPORT' THEN
  RETURN jsonb_build_object('outcome','BLOCKED','reason','No matching completion report awaiting approval'); END IF;
 IF EXISTS(SELECT 1 FROM ticket_events WHERE ticket_id=t.id AND event='CBM_WF2_APPROVAL' AND payload->>'approval_id'=t.approval_id::text) THEN
  RETURN jsonb_build_object('outcome','ALREADY_DECIDED','reason','Read the stored decision; no new approval email needed'); END IF;
 prefix='wf2-review:'||t.id||':'||t.approval_id||':';
 SELECT * INTO e FROM cbm_wf3_approval_emails WHERE ticket_id=t.id AND approval_id=t.approval_id
  AND left(request_key,length(prefix))=prefix ORDER BY created_at DESC LIMIT 1;
 IF e.id IS NOT NULL AND e.expires_at>clock_timestamp() THEN
  RETURN jsonb_build_object('outcome',CASE WHEN e.send_status='SENT' THEN 'SENT' ELSE 'UNCONFIRMED' END,
   'already_processed',true,'message_id',e.message_id,'expires_at',e.expires_at); END IF;
 IF e.id IS NOT NULL THEN
  INSERT INTO ticket_events(ticket_id,event,payload) VALUES(t.id,'CBM_WF2_APPROVAL_EXPIRED',
   jsonb_build_object('approval_id',t.approval_id,'email_id',e.id,'status',t.status)); END IF;
 eid=gen_random_uuid();
 INSERT INTO cbm_wf3_approval_emails(id,request_key,ticket_id,approval_id)
  VALUES(eid,prefix||eid,t.id,t.approval_id) RETURNING * INTO e;
 INSERT INTO ticket_events(ticket_id,event,payload) VALUES(t.id,'CBM_WF2_APPROVAL_REQUEST',
  jsonb_build_object('approval_id',t.approval_id,'email_id',e.id,'source','WF2_REPORT','execution_id',p->>'executionId'));
 RETURN jsonb_build_object('outcome','SEND','email_id',e.id,'ticketId',t.id,'approvalId',t.approval_id,
  'token',e.token,'expires_at',e.expires_at,'ifc_name',t.ifc_name,'description',left(t.description,1000),
  'report_text',left(t.report_text,5000),'report_file_id',t.report_file_id);
END $$;

CREATE OR REPLACE FUNCTION cbm_wf2_review_status(p jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE t tickets%ROWTYPE; ev ticket_events%ROWTYPE; r jsonb; route text; prefix text;
BEGIN
 SELECT * INTO t FROM tickets WHERE id=(p->>'ticketId')::int;
 IF t.id IS NULL OR t.approval_id IS DISTINCT FROM (p->>'approvalId')::uuid THEN
  RETURN jsonb_build_object('route','SUPERSEDED','reason','The ticket or approval cycle was replaced'); END IF;
 SELECT * INTO ev FROM ticket_events WHERE ticket_id=t.id AND event='CBM_WF2_APPROVAL'
  AND payload->>'approval_id'=t.approval_id::text ORDER BY id LIMIT 1;
 IF ev.id IS NOT NULL THEN
  r=cbm_wf2_closure_outcome(jsonb_build_object('ticketId',t.id,'approvalId',t.approval_id,
   'decision',ev.payload->>'decision','fmEmail','gruppo1isteagiovani@gmail.com'));
  IF (r->>'settled')::boolean THEN route='SETTLED';
  ELSIF EXISTS(SELECT 1 FROM ticket_events WHERE ticket_id=t.id AND event='CBM_WF3_ACTION_RESULT'
   AND payload->>'request_key'=ev.payload->>'request_key') THEN route='DECIDED';
  ELSIF ev.payload->>'request_key' IS NULL THEN route='DECIDED';
  ELSIF ev.created_at<statement_timestamp()-interval '10 minutes' THEN route='ATTENTION';
  ELSE route='PROCESSING'; END IF;
  RETURN r||jsonb_build_object('route',route,'decision',ev.payload->>'decision',
   'rejection_reason',ev.payload->>'reason','decision_source',ev.payload->>'source');
 END IF;
 IF t.status<>'PENDING_APPROVAL' THEN
  RETURN jsonb_build_object('route','SUPERSEDED','status',t.status,'reason','Ticket is no longer awaiting this review'); END IF;
 prefix='wf2-review:'||t.id||':'||t.approval_id||':';
 IF EXISTS(SELECT 1 FROM cbm_wf3_approval_emails WHERE ticket_id=t.id AND approval_id=t.approval_id
  AND left(request_key,length(prefix))=prefix AND expires_at>statement_timestamp()) THEN route='WAIT';
 ELSE route='NEEDS_EMAIL'; END IF;
 RETURN jsonb_build_object('route',route,'id',t.id,'status',t.status,'approval_id',t.approval_id);
END $$;
COMMIT;
