-- Apply after schema_release_review.sql. Does not rewrite historical tickets.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS uq_wf2_notice_claim
 ON ticket_events(ticket_id,(payload->>'approval_id'),(payload->>'notice_key'))
 WHERE event='CBM_WF2_NOTICE_CLAIM';
CREATE UNIQUE INDEX IF NOT EXISTS uq_wf2_verified_notice
 ON ticket_events(ticket_id,(payload->>'approval_id'),(payload->>'notice_key'))
 WHERE event='CBM_WF2_NOTICE' AND payload->>'source'='GMAIL_API';

CREATE OR REPLACE FUNCTION cbm_wf2_ifc_succeeded(tid integer, aid uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM tickets t JOIN ticket_events e ON e.ticket_id=t.id
 WHERE t.id=tid AND t.approval_id=aid AND nullif(btrim(t.ifc_new_version),'') IS NOT NULL
 AND e.event='CBM_WF2_IFC_RESULT' AND e.payload->>'outcome'='SUCCEEDED'
 AND e.payload->>'operation_key'='wf2:'||tid||':'||aid
 AND e.payload->>'version_file'=t.ifc_new_version);
$$;

CREATE OR REPLACE FUNCTION cbm_wf2_guard_closed()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='CLOSED' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'CLOSED') THEN
  IF NEW.approval_id IS NULL OR nullif(btrim(NEW.ifc_new_version),'') IS NULL
   OR NOT EXISTS(SELECT 1 FROM ticket_events WHERE ticket_id=NEW.id AND event='CBM_WF2_APPROVAL'
      AND payload->>'approval_id'=NEW.approval_id::text AND payload->>'decision'='APPROVED')
   OR NOT EXISTS(SELECT 1 FROM ticket_events WHERE ticket_id=NEW.id AND event='CBM_WF2_IFC_RESULT'
      AND payload->>'operation_key'='wf2:'||NEW.id||':'||NEW.approval_id
      AND payload->>'outcome'='SUCCEEDED' AND payload->>'version_file'=NEW.ifc_new_version) THEN
   RAISE EXCEPTION 'Closure requires current FM approval and a successful IFC result matching the recorded version';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS wf2_require_successful_ifc ON tickets;
CREATE TRIGGER wf2_require_successful_ifc BEFORE INSERT OR UPDATE OF status ON tickets
 FOR EACH ROW EXECUTE FUNCTION cbm_wf2_guard_closed();

CREATE OR REPLACE FUNCTION cbm_wf2_close_ticket(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE t tickets%ROWTYPE;
BEGIN
 SELECT * INTO t FROM tickets WHERE id=(p->>'ticketId')::int FOR UPDATE;
 IF NOT FOUND OR t.approval_id IS DISTINCT FROM (p->>'approvalId')::uuid THEN
  RETURN jsonb_build_object('status','BLOCKED','reason','Missing ticket or stale approval');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM ticket_events WHERE ticket_id=t.id AND event='CBM_WF2_APPROVAL'
  AND payload->>'approval_id'=t.approval_id::text AND payload->>'decision'='APPROVED')
  OR NOT cbm_wf2_ifc_succeeded(t.id,t.approval_id) THEN
  RETURN jsonb_build_object('status','BLOCKED','reason','Successful IFC update and current FM approval are required','ticket_status',t.status);
 END IF;
 IF t.status='CLOSED' THEN RETURN jsonb_build_object('status','CLOSED','changed',false,'version_file',t.ifc_new_version); END IF;
 IF t.status<>'PENDING_APPROVAL' THEN RETURN jsonb_build_object('status','BLOCKED','reason','Ticket is not pending closure'); END IF;
 UPDATE tickets SET status='CLOSED',closed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=t.id;
 RETURN jsonb_build_object('status','CLOSED','changed',true,'version_file',t.ifc_new_version);
END $$;

CREATE OR REPLACE FUNCTION cbm_wf2_notice_sent(tid integer, aid uuid, nkey text, recipient text)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM ticket_events e WHERE e.ticket_id=tid AND e.event='CBM_WF2_NOTICE'
 AND e.payload->>'approval_id'=aid::text AND e.payload->>'notice_key'=nkey
 AND e.payload->>'source'='GMAIL_API' AND e.payload->>'outcome'='SENT'
 AND nullif(btrim(e.payload->>'message_id'),'') IS NOT NULL
 AND lower(e.payload->>'recipient')=lower(recipient));
$$;

CREATE OR REPLACE FUNCTION cbm_wf2_claim_notice(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE t tickets%ROWTYPE; nkey text; recipient text; claim_id uuid; claim_row integer;
BEGIN
 SELECT * INTO t FROM tickets WHERE id=(p->>'ticketId')::int FOR UPDATE;
 IF NOT FOUND OR t.approval_id IS DISTINCT FROM (p->>'approvalId')::uuid THEN
  RETURN jsonb_build_object('send_status','BLOCKED','reason','Missing ticket or stale approval');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM ticket_events WHERE ticket_id=t.id AND event='CBM_WF2_APPROVAL'
  AND payload->>'approval_id'=t.approval_id::text AND payload->>'decision'=p->>'decision') THEN
  RETURN jsonb_build_object('send_status','BLOCKED','reason','No matching FM decision');
 END IF;
 IF p->>'decision'='APPROVED' THEN
  IF t.status<>'CLOSED' OR NOT cbm_wf2_ifc_succeeded(t.id,t.approval_id) THEN
   RETURN jsonb_build_object('send_status','BLOCKED','reason','Ticket must be closed with successful IFC update before a closure email');
  END IF;
  nkey=CASE p->>'noticeRecipient' WHEN 'fm' THEN 'fm:closed' WHEN 'technician' THEN 'technician:closed' END;
 ELSIF p->>'decision'='REJECTED' AND t.status='REWORK' AND p->>'noticeRecipient'='technician' THEN
  nkey='technician:rework';
 END IF;
 IF nkey IS NULL THEN RETURN jsonb_build_object('send_status','BLOCKED','reason','Invalid notification for current decision/state'); END IF;
 IF p->>'noticeRecipient'='fm' THEN recipient=p->>'fmEmail';
 ELSE SELECT email INTO recipient FROM technicians WHERE id=t.technician_id; END IF;
 IF recipient IS NULL OR recipient !~ '^[^[:space:]<>@]+@[^[:space:]<>@]+\.[^[:space:]<>@]+$' THEN
  RETURN jsonb_build_object('send_status','BLOCKED','reason','Recipient is missing or invalid');
 END IF;
 IF cbm_wf2_notice_sent(t.id,t.approval_id,nkey,recipient) THEN
  RETURN jsonb_build_object('send_status','SENT','notice_key',nkey,'already_sent',true);
 END IF;
 -- Old claims without verified receipts need reconciliation, never a blind resend.
 IF nkey='fm:closed' AND EXISTS(SELECT 1 FROM ticket_events WHERE ticket_id=t.id
  AND event='CBM_WF2_FM_NOTICE_CLAIM' AND payload->>'approval_id'=t.approval_id::text) THEN
  RETURN jsonb_build_object('send_status','UNCONFIRMED','reason','Legacy email claim requires reconciliation');
 END IF;
 claim_id=gen_random_uuid();
 INSERT INTO ticket_events(ticket_id,event,payload) VALUES(t.id,'CBM_WF2_NOTICE_CLAIM',
  jsonb_build_object('approval_id',t.approval_id,'notice_key',nkey,'claim_id',claim_id,'recipient',recipient))
 ON CONFLICT DO NOTHING RETURNING id INTO claim_row;
 IF claim_row IS NULL THEN RETURN jsonb_build_object('send_status','UNCONFIRMED','notice_key',nkey,'reason','Existing send claim has no verified receipt; inspect the Gmail execution before retrying'); END IF;
 RETURN jsonb_build_object('send_status','SEND','ticket_id',t.id,'approval_id',t.approval_id,
  'notice_key',nkey,'claim_id',claim_id,'recipient',recipient,'ifc_new_version',t.ifc_new_version,
  'reason',coalesce(t.fm_reject_reason,'The facility manager rejected this completion. Contact the FM for details.'));
END $$;

CREATE OR REPLACE FUNCTION cbm_wf2_record_notice(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE claim jsonb; aid uuid; tid integer; sent boolean;
BEGIN
 tid=(p->>'ticket_id')::int; aid=(p->>'approval_id')::uuid;
 PERFORM 1 FROM tickets WHERE id=tid FOR UPDATE;
 SELECT payload INTO claim FROM ticket_events WHERE ticket_id=tid AND event='CBM_WF2_NOTICE_CLAIM'
  AND payload->>'approval_id'=aid::text AND payload->>'notice_key'=p->>'notice_key'
  AND payload->>'claim_id'=p->>'claim_id';
 IF claim IS NULL THEN RETURN jsonb_build_object('send_status','BLOCKED','reason','Send claim not found'); END IF;
 sent=coalesce(p->>'send_status'='SENT' AND nullif(btrim(p->>'message_id'),'') IS NOT NULL,false);
 INSERT INTO ticket_events(ticket_id,event,payload) VALUES(tid,
  CASE WHEN sent THEN 'CBM_WF2_NOTICE' ELSE 'CBM_WF2_NOTICE_FAILED' END,
  jsonb_build_object('approval_id',aid,'notice_key',claim->>'notice_key','claim_id',claim->>'claim_id',
   'recipient',claim->>'recipient','message_id',CASE WHEN sent THEN p->>'message_id' END,
   'source','GMAIL_API','outcome',CASE WHEN sent THEN 'SENT' ELSE 'UNCONFIRMED' END,'error',p->>'error'))
 ON CONFLICT DO NOTHING;
 RETURN jsonb_build_object('send_status',CASE WHEN sent THEN 'SENT' ELSE 'UNCONFIRMED' END,'notice_key',claim->>'notice_key');
END $$;

CREATE OR REPLACE FUNCTION cbm_wf2_closure_outcome(p jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE t tickets%ROWTYPE; missing text[]='{}'; decision text=p->>'decision'; tech_email text; nkey text;
BEGIN
 SELECT * INTO t FROM tickets WHERE id=(p->>'ticketId')::int;
 IF NOT FOUND THEN RETURN jsonb_build_object('settled',false,'missing_operations',ARRAY['ticket']); END IF;
 IF t.approval_id IS DISTINCT FROM (p->>'approvalId')::uuid THEN missing=array_append(missing,'current_approval'); END IF;
 IF NOT EXISTS(SELECT 1 FROM ticket_events WHERE ticket_id=t.id AND event='CBM_WF2_APPROVAL'
  AND payload->>'approval_id'=p->>'approvalId' AND payload->>'decision'=decision) THEN missing=array_append(missing,'fm_decision'); END IF;
 SELECT email INTO tech_email FROM technicians WHERE id=t.technician_id;
 IF decision='APPROVED' THEN
  IF t.status<>'CLOSED' OR t.closed_at IS NULL THEN missing=array_append(missing,'close_ticket'); END IF;
  IF NOT cbm_wf2_ifc_succeeded(t.id,(p->>'approvalId')::uuid) THEN missing=array_append(missing,'log_ifc_maintenance'); END IF;
  IF NOT EXISTS(SELECT 1 FROM ticket_events WHERE ticket_id=t.id AND event='CBM_WF2_STATS'
   AND payload->>'approval_id'=p->>'approvalId') THEN missing=array_append(missing,'update_technician_stats'); END IF;
  IF NOT cbm_wf2_notice_sent(t.id,(p->>'approvalId')::uuid,'fm:closed',p->>'fmEmail') THEN missing=array_append(missing,'notify_fm_closed'); END IF;
  nkey='technician:closed';
 ELSIF decision='REJECTED' THEN
  IF t.status<>'REWORK' OR t.closed_at IS NOT NULL THEN missing=array_append(missing,'reopen_for_rework'); END IF;
  nkey='technician:rework';
 ELSE missing=array_append(missing,'explicit_fm_decision');
 END IF;
 IF nkey IS NOT NULL AND NOT cbm_wf2_notice_sent(t.id,(p->>'approvalId')::uuid,nkey,tech_email) THEN missing=array_append(missing,replace(nkey,':','_')||'_notice'); END IF;
 RETURN jsonb_build_object('id',t.id,'status',t.status,'approval_id',t.approval_id,'closed_at',t.closed_at,
  'ifc_new_version',t.ifc_new_version,'settled',cardinality(missing)=0,'missing_operations',missing);
END $$;
COMMIT;
