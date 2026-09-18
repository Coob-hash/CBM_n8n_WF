-- Synthetic transaction only: no email or IFC service call, no retained demo rows.
BEGIN;
INSERT INTO technicians(id,full_name,email,skills,jobs_completed)
 VALUES(-917200,'Closure validation','closure-validation@example.invalid','{general}',0);
INSERT INTO tickets(id,status,technician_id,approval_id,dispatch_authorized_at)
 VALUES(-917200,'PENDING_APPROVAL',-917200,'11111111-1111-4111-8111-111111111111',clock_timestamp());
INSERT INTO ticket_events(ticket_id,event,payload) VALUES(-917200,'CBM_WF2_APPROVAL',
 '{"approval_id":"11111111-1111-4111-8111-111111111111","decision":"APPROVED"}');
DO $$
DECLARE p jsonb='{"ticketId":-917200,"approvalId":"11111111-1111-4111-8111-111111111111","decision":"APPROVED","fmEmail":"fm-validation@example.invalid"}';
 c jsonb; r jsonb;
BEGIN
 IF cbm_wf2_close_ticket(p)->>'status'<>'BLOCKED' THEN RAISE EXCEPTION 'Missing IFC did not block closure'; END IF;
 INSERT INTO ticket_events(ticket_id,event,payload) VALUES(-917200,'CBM_WF2_ATTEMPT',
  '{"operation_key":"wf2:-917200:11111111-1111-4111-8111-111111111111","outcome":"FAILED"}');
 IF cbm_wf2_close_ticket(p)->>'status'<>'BLOCKED' THEN RAISE EXCEPTION 'IFC failure did not block closure'; END IF;
 BEGIN
  UPDATE tickets SET status='CLOSED',closed_at=now() WHERE id=-917200;
  RAISE EXCEPTION 'Direct closure bypassed guard';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM NOT LIKE 'Closure requires%' THEN RAISE; END IF;
 END;
 UPDATE tickets SET ifc_new_version='synthetic_v2.ifc' WHERE id=-917200;
 INSERT INTO ticket_events(ticket_id,event,payload) VALUES(-917200,'CBM_WF2_IFC_RESULT',
  '{"operation_key":"wf2:-917200:11111111-1111-4111-8111-111111111111","outcome":"SUCCEEDED","version_file":"synthetic_v2.ifc"}');
 IF cbm_wf2_close_ticket(p)->>'status'<>'CLOSED' THEN RAISE EXCEPTION 'Verified IFC failed to allow closure'; END IF;
 IF (cbm_wf2_closure_outcome(p)->>'settled')::boolean THEN RAISE EXCEPTION 'Status alone incorrectly settled'; END IF;
 INSERT INTO ticket_events(ticket_id,event,payload) VALUES(-917200,'CBM_WF2_STATS',
  '{"approval_id":"11111111-1111-4111-8111-111111111111"}');
 UPDATE technicians SET jobs_completed=1 WHERE id=-917200;
 c=cbm_wf2_claim_notice(p||'{"noticeRecipient":"fm"}');
 IF c->>'send_status'<>'SEND' THEN RAISE EXCEPTION 'Notice not claimable'; END IF;
 IF cbm_wf2_claim_notice(p||'{"noticeRecipient":"fm"}')->>'send_status'<>'UNCONFIRMED' THEN RAISE EXCEPTION 'Duplicate send permitted'; END IF;
 PERFORM cbm_wf2_record_notice(c||'{"send_status":"UNCONFIRMED","message_id":null}');
 IF (cbm_wf2_closure_outcome(p)->>'settled')::boolean THEN RAISE EXCEPTION 'Failed notification settled'; END IF;
 PERFORM cbm_wf2_record_notice(c||'{"send_status":"SENT","message_id":"synthetic-fm-receipt"}');
 c=cbm_wf2_claim_notice(p||'{"noticeRecipient":"technician"}');
 PERFORM cbm_wf2_record_notice(c||'{"send_status":"SENT","message_id":"synthetic-technician-receipt"}');
 IF NOT (cbm_wf2_closure_outcome(p)->>'settled')::boolean THEN RAISE EXCEPTION 'Complete closure did not settle'; END IF;
 RAISE NOTICE 'PASS: PostgreSQL closure guards and notification receipt checks';
END $$;
ROLLBACK;
