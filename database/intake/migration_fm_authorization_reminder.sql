BEGIN;

CREATE OR REPLACE FUNCTION cbm_intake_recover() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE a record; t tickets; n integer:=0; added integer:=0;
BEGIN
 FOR a IN SELECT report_id,file_id FROM cbm_capture_attempts WHERE status='PROCESSING'
 AND started_at<clock_timestamp()-interval '10 minutes' ORDER BY started_at LIMIT 20 LOOP
  PERFORM cbm_capture_failed(a.report_id,a.file_id,'CAPTURE_TIMEOUT'); n:=n+1;
 END LOOP;
 -- Lost Gmail receipts are uncertain; never automatically send the same message twice.
 UPDATE cbm_intake_outbox SET status='UNCERTAIN' WHERE status='SENDING' AND claimed_at<clock_timestamp()-interval '5 minutes';
 -- Queue one reminder while the original approval link is still valid.
 INSERT INTO cbm_intake_outbox(event_key,kind,payload)
 SELECT 'authorize-reminder:'||pending_ticket.dispatch_authorization_id,'AUTHORIZATION',
  jsonb_build_object('ticket_id',pending_ticket.id,'authorization_id',pending_ticket.dispatch_authorization_id,
   'token',pending_ticket.dispatch_authorization_token,'ifc_global_id',pending_ticket.ifc_global_id,'ifc_name',pending_ticket.ifc_name,
   'description',pending_ticket.description,'severity',pending_ticket.severity,'photo_url',pending_ticket.photo_before_url,
   'expires_at',pending_ticket.dispatch_authorization_expires_at,'reminder',true)
 FROM tickets pending_ticket
 JOIN cbm_intake_outbox original ON original.event_key='authorize:'||pending_ticket.dispatch_authorization_id
  AND original.status='SENT' AND original.sent_at<=clock_timestamp()-interval '24 hours'
 WHERE pending_ticket.status='PENDING_AUTHORIZATION' AND pending_ticket.requires_dispatch_authorization
  AND pending_ticket.dispatch_authorization_expires_at>clock_timestamp()
 ON CONFLICT (event_key) DO NOTHING;
 GET DIAGNOSTICS added = ROW_COUNT;
 n:=n+added;
 -- Renew expired business-approval links. Timeout is neither approval nor rejection.
 FOR t IN SELECT * FROM tickets WHERE status='PENDING_AUTHORIZATION' AND requires_dispatch_authorization
 AND dispatch_authorization_expires_at<clock_timestamp()
 ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED LOOP
  UPDATE cbm_intake_outbox SET status='CANCELLED' WHERE event_key='authorize:'||t.dispatch_authorization_id AND status='PENDING';
  UPDATE tickets SET dispatch_authorization_id=gen_random_uuid(),
   dispatch_authorization_token=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''),
   dispatch_authorization_expires_at=clock_timestamp()+interval '72 hours',updated_at=clock_timestamp()
   WHERE id=t.id RETURNING * INTO t;
  INSERT INTO cbm_intake_outbox(event_key,kind,payload) VALUES('authorize:'||t.dispatch_authorization_id,'AUTHORIZATION',
   jsonb_build_object('ticket_id',t.id,'authorization_id',t.dispatch_authorization_id,'token',t.dispatch_authorization_token,
    'ifc_global_id',t.ifc_global_id,'ifc_name',t.ifc_name,'description',t.description,'severity',t.severity,
    'photo_url',t.photo_before_url,'expires_at',t.dispatch_authorization_expires_at));
 END LOOP;
 RETURN n;
END $$;

CREATE OR REPLACE FUNCTION cbm_intake_claim_notice() RETURNS SETOF cbm_intake_outbox LANGUAGE sql AS $$
 UPDATE cbm_intake_outbox SET status='SENDING',claim=gen_random_uuid(),claimed_at=clock_timestamp()
 WHERE id=(SELECT id FROM cbm_intake_outbox WHERE status='PENDING'
 ORDER BY CASE
  WHEN kind IN ('IT_BUG','CONFIGURATION_IT') THEN 0
  WHEN kind IN ('REJECTED','RECEIVED','DUPLICATE') THEN 1
  WHEN kind='AUTHORIZATION' THEN 2
  ELSE 3 END,id
 LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *;
$$;

COMMIT;
