-- Additive intake migration. Apply AFTER schema_release_review.sql.
-- Captures are not maintenance tickets. Three retries means four captures total.
BEGIN;
CREATE TABLE IF NOT EXISTS cbm_intake_reports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reporter_email text NOT NULL,
 state text NOT NULL DEFAULT 'NEW' CHECK (state IN ('NEW','PROCESSING','AWAITING_PHOTO','IT_ISSUE','IDENTIFIED')),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 4),
 ticket_id integer REFERENCES tickets(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS cbm_capture_attempts (
 file_id text PRIMARY KEY, report_id uuid NOT NULL REFERENCES cbm_intake_reports(id),
 attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 4),
 status text NOT NULL CHECK (status IN ('PROCESSING','FAILED','IDENTIFIED')),
 photo_url text NOT NULL DEFAULT '', execution_id text, reason text,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
 UNIQUE(report_id,attempt)
);
CREATE TABLE IF NOT EXISTS cbm_it_issues (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), report_id uuid NOT NULL UNIQUE REFERENCES cbm_intake_reports(id),
 status text NOT NULL DEFAULT 'OPEN', summary text NOT NULL, diagnostics jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS cbm_intake_outbox (
 id bigserial PRIMARY KEY, event_key text NOT NULL UNIQUE,
 kind text NOT NULL CHECK (kind IN ('RETRY','BUG_RECEIPT','IT_BUG','AUTHORIZATION','RECEIVED','DUPLICATE','REJECTED','BUSY','FINISHED')),
 reporter_email text, payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENDING','SENT','UNCERTAIN','CANCELLED')),
 claim uuid, claimed_at timestamptz, message_id text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS cbm_intake_outbox_pending ON cbm_intake_outbox(id) WHERE status='PENDING';

-- Existing tickets retain their previous contract. Every newly inserted job requires authorization.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS requires_dispatch_authorization boolean NOT NULL DEFAULT false;
ALTER TABLE tickets ALTER COLUMN requires_dispatch_authorization SET DEFAULT true;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS intake_report_id uuid REFERENCES cbm_intake_reports(id);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS dispatch_authorization_id uuid;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS dispatch_authorization_token text;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS dispatch_authorization_expires_at timestamptz;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS dispatch_authorized_at timestamptz;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS dispatch_rejected_at timestamptz;

-- Rejected requests must not prevent a later, legitimate report on the same asset.
DROP INDEX IF EXISTS uq_tickets_open_element;
CREATE UNIQUE INDEX uq_tickets_open_element ON tickets(ifc_global_id)
 WHERE status NOT IN ('CLOSED','DUPLICATE','REJECTED');

CREATE OR REPLACE FUNCTION cbm_guard_dispatch_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.requires_dispatch_authorization AND NEW.status='LOCALIZED' THEN
  NEW.status:='PENDING_AUTHORIZATION';
 END IF;
 IF TG_OP='INSERT' AND NEW.requires_dispatch_authorization AND NEW.status='PENDING_AUTHORIZATION' THEN
  NEW.dispatch_authorization_id:=gen_random_uuid();
  NEW.dispatch_authorization_token:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
  NEW.dispatch_authorization_expires_at:=clock_timestamp()+interval '72 hours';
  NEW.dispatch_authorized_at:=NULL;
 END IF;
 IF TG_OP='UPDATE' AND OLD.requires_dispatch_authorization AND NOT NEW.requires_dispatch_authorization THEN
  RAISE EXCEPTION 'Dispatch authorization cannot be disabled for a new ticket';
 END IF;
 IF NEW.requires_dispatch_authorization AND NEW.status IN
 ('LOCALIZED','DISPATCHING','ASSIGNED','ESCALATED','WORK_DONE','PENDING_APPROVAL','REWORK','CLOSED')
 AND NEW.dispatch_authorized_at IS NULL THEN
  RAISE EXCEPTION 'FM authorization is required before dispatch';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cbm_dispatch_authorization_guard ON tickets;
CREATE TRIGGER cbm_dispatch_authorization_guard BEFORE INSERT OR UPDATE ON tickets
 FOR EACH ROW EXECUTE FUNCTION cbm_guard_dispatch_authorization();

CREATE OR REPLACE FUNCTION cbm_capture_failed(p_report uuid,p_file text,p_reason text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r cbm_intake_reports; a cbm_capture_attempts; bug uuid; result jsonb;
BEGIN
 SELECT * INTO r FROM cbm_intake_reports WHERE id=p_report FOR UPDATE;
 SELECT * INTO a FROM cbm_capture_attempts WHERE file_id=p_file AND report_id=p_report FOR UPDATE;
 IF r.id IS NULL OR a.file_id IS NULL OR r.state<>'PROCESSING' OR a.status<>'PROCESSING' OR a.attempt<>r.attempts THEN
  RETURN jsonb_build_object('changed',false);
 END IF;
 -- Only diagnostic codes are persisted, never provider responses/tokens/image bodies.
 IF p_reason IS NULL OR p_reason !~ '^[A-Z][A-Z0-9_]{0,79}$' THEN p_reason:='IDENTIFICATION_FAILED'; END IF;
 UPDATE cbm_capture_attempts SET status='FAILED',reason=p_reason,completed_at=clock_timestamp() WHERE file_id=p_file;
 UPDATE cbm_intake_reports SET state=CASE WHEN attempts<4 THEN 'AWAITING_PHOTO' ELSE 'IT_ISSUE' END,
 updated_at=clock_timestamp() WHERE id=p_report RETURNING * INTO r;
 result:=jsonb_build_object('changed',true,'report_id',r.id,'attempts',r.attempts,'retries_remaining',4-r.attempts,
 'state',r.state,'reason',p_reason);
 IF r.attempts<4 THEN
  INSERT INTO cbm_intake_outbox(event_key,kind,reporter_email,payload)
  VALUES('retry:'||p_file,'RETRY',r.reporter_email,result) ON CONFLICT DO NOTHING;
 ELSE
  INSERT INTO cbm_it_issues(report_id,summary,diagnostics)
  VALUES(r.id,'IFC identification failed after the initial capture and three replacement photos',
   jsonb_build_object('report_id',r.id,'attempts',(SELECT jsonb_agg(jsonb_build_object('attempt',attempt,'file_id',file_id,
    'reason',reason,'execution_id',execution_id,'started_at',started_at,'completed_at',completed_at) ORDER BY attempt)
    FROM cbm_capture_attempts WHERE report_id=r.id)))
  ON CONFLICT(report_id) DO NOTHING;
  SELECT id INTO bug FROM cbm_it_issues WHERE report_id=r.id;
  result:=result||jsonb_build_object('issue_id',bug);
  INSERT INTO cbm_intake_outbox(event_key,kind,reporter_email,payload) VALUES
   ('bug-receipt:'||r.id,'BUG_RECEIPT',r.reporter_email,result),
   ('bug-it:'||r.id,'IT_BUG',NULL,result||jsonb_build_object('diagnostics',(SELECT diagnostics FROM cbm_it_issues WHERE id=bug)))
  ON CONFLICT DO NOTHING;
 END IF;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION cbm_capture_begin(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r cbm_intake_reports; a cbm_capture_attempts; rid uuid; fid text:=p->>'file_id'; email text:=lower(p->>'reporter_email');
BEGIN
 IF fid IS NULL OR length(fid)>200 OR fid !~ '^[A-Za-z0-9_-]+$' OR email IS NULL OR email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
  RAISE EXCEPTION 'Valid Drive file id and reporter email are required';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('cbm-capture:'||fid,0));
 SELECT * INTO a FROM cbm_capture_attempts WHERE file_id=fid;
 IF FOUND THEN RETURN jsonb_build_object('process',false,'reason','FILE_ALREADY_RECORDED','report_id',a.report_id); END IF;
 rid:=coalesce(nullif(p->>'report_id','')::uuid,gen_random_uuid());
 INSERT INTO cbm_intake_reports(id,reporter_email) VALUES(rid,email) ON CONFLICT DO NOTHING;
 SELECT * INTO r FROM cbm_intake_reports WHERE id=rid FOR UPDATE;
 IF r.reporter_email<>email THEN RAISE EXCEPTION 'Report belongs to another reporter'; END IF;
 IF r.state='PROCESSING' THEN
  SELECT * INTO a FROM cbm_capture_attempts WHERE report_id=rid AND attempt=r.attempts;
  IF a.started_at < clock_timestamp()-interval '10 minutes' THEN
   PERFORM cbm_capture_failed(rid,a.file_id,'CAPTURE_TIMEOUT');
   SELECT * INTO r FROM cbm_intake_reports WHERE id=rid;
  END IF;
 END IF;
 IF r.state IN ('PROCESSING','IT_ISSUE','IDENTIFIED') OR r.attempts>=4 THEN
  INSERT INTO cbm_intake_outbox(event_key,kind,reporter_email,payload)
  VALUES('unprocessed:'||fid,CASE WHEN r.state='PROCESSING' THEN 'BUSY' ELSE 'FINISHED' END,email,
   jsonb_build_object('report_id',rid,'state',r.state,'ticket_id',r.ticket_id)) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('process',false,'report_id',rid,'state',r.state);
 END IF;
 UPDATE cbm_intake_reports SET attempts=attempts+1,state='PROCESSING',updated_at=clock_timestamp() WHERE id=rid RETURNING * INTO r;
 INSERT INTO cbm_capture_attempts(file_id,report_id,attempt,status,photo_url,execution_id)
 VALUES(fid,rid,r.attempts,'PROCESSING',coalesce(p->>'photo_url',''),left(p->>'execution_id',100));
 RETURN jsonb_build_object('process',true,'report_id',rid,'file_id',fid,'attempt',r.attempts,'reporter_email',email);
END $$;

CREATE OR REPLACE FUNCTION cbm_capture_identified(p_report uuid,p_file text,p_request jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r cbm_intake_reports; a cbm_capture_attempts; t tickets; tid integer; prior integer; req jsonb;
BEGIN
 SELECT * INTO r FROM cbm_intake_reports WHERE id=p_report FOR UPDATE;
 SELECT * INTO a FROM cbm_capture_attempts WHERE file_id=p_file AND report_id=p_report FOR UPDATE;
 IF r.id IS NULL OR a.file_id IS NULL OR r.state<>'PROCESSING' OR a.status<>'PROCESSING' OR a.attempt<>r.attempts THEN
  RETURN jsonb_build_object('changed',false,'ticket_id',r.ticket_id);
 END IF;
 IF NOT coalesce((p_request#>>'{triage,triageValid}')::boolean,false) OR p_request#>>'{triage,element,global_id}' IS NULL THEN
  RAISE EXCEPTION 'Validated automatic identification and triage are required';
 END IF;
 req:=p_request||jsonb_build_object('sourceKey',p_file,'ticketId',NULL,'triage',
  (p_request->'triage')||jsonb_build_object('reporterEmail',r.reporter_email,'photoUrl',a.photo_url));
 LOCK TABLE tickets IN SHARE ROW EXCLUSIVE MODE;
 SELECT id INTO prior FROM tickets WHERE ifc_global_id=req#>>'{triage,element,global_id}'
  AND status NOT IN ('CLOSED','DUPLICATE','REJECTED') ORDER BY id LIMIT 1;
 SELECT ticket_id INTO tid FROM public.cbm_create_ticket(req);
 IF tid IS NULL THEN RAISE EXCEPTION 'Ticket creation returned no record'; END IF;
 IF prior IS NULL THEN UPDATE tickets SET intake_report_id=r.id WHERE id=tid; END IF;
 SELECT * INTO t FROM tickets WHERE id=tid;
 UPDATE cbm_capture_attempts SET status='IDENTIFIED',completed_at=clock_timestamp() WHERE file_id=p_file;
 UPDATE cbm_intake_reports SET state='IDENTIFIED',ticket_id=tid,updated_at=clock_timestamp() WHERE id=r.id;
 INSERT INTO ticket_events(ticket_id,event,payload) VALUES(tid,'CBM_CAPTURE_IDENTIFIED',jsonb_build_object('report_id',r.id,'file_id',p_file,'attempt',r.attempts,'duplicate',prior IS NOT NULL));
 INSERT INTO cbm_intake_outbox(event_key,kind,reporter_email,payload)
 VALUES('received:'||r.id,CASE WHEN prior IS NULL THEN 'RECEIVED' ELSE 'DUPLICATE' END,r.reporter_email,
  jsonb_build_object('report_id',r.id,'ticket_id',tid,'status',t.status)) ON CONFLICT DO NOTHING;
 IF prior IS NULL AND t.status='PENDING_AUTHORIZATION' THEN
  INSERT INTO cbm_intake_outbox(event_key,kind,payload)
  VALUES('authorize:'||t.dispatch_authorization_id,'AUTHORIZATION',jsonb_build_object('ticket_id',tid,
   'authorization_id',t.dispatch_authorization_id,'token',t.dispatch_authorization_token,
   'ifc_global_id',t.ifc_global_id,'ifc_name',t.ifc_name,'description',t.description,'severity',t.severity,
   'photo_url',t.photo_before_url,'expires_at',t.dispatch_authorization_expires_at)) ON CONFLICT DO NOTHING;
 END IF;
 RETURN jsonb_build_object('changed',true,'ticket_id',tid,'status',t.status,'duplicate',prior IS NOT NULL);
END $$;

CREATE OR REPLACE FUNCTION cbm_authorize_dispatch(p_ticket integer,p_id uuid,p_token text,p_decision text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE t tickets;
BEGIN
 SELECT * INTO t FROM tickets WHERE id=p_ticket FOR UPDATE;
 IF t.id IS NULL OR NOT t.requires_dispatch_authorization OR t.dispatch_authorization_expires_at IS NULL
 OR p_id IS NULL OR p_token IS NULL OR t.status<>'PENDING_AUTHORIZATION' OR t.dispatch_authorization_id IS DISTINCT FROM p_id
 OR t.dispatch_authorization_token IS DISTINCT FROM p_token OR clock_timestamp()>=t.dispatch_authorization_expires_at
 OR p_decision IS NULL OR p_decision NOT IN ('approve','reject') THEN
  RETURN jsonb_build_object('applied',false,'ticketId',p_ticket,'reason','INVALID_EXPIRED_OR_ALREADY_DECIDED');
 END IF;
 UPDATE tickets SET status=CASE WHEN p_decision='approve' THEN 'LOCALIZED' ELSE 'REJECTED' END,
 dispatch_authorized_at=CASE WHEN p_decision='approve' THEN clock_timestamp() END,
 dispatch_rejected_at=CASE WHEN p_decision='reject' THEN clock_timestamp() END,
 updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond') WHERE id=p_ticket;
 INSERT INTO ticket_events(ticket_id,event,payload) VALUES(p_ticket,'CBM_DISPATCH_AUTHORIZATION',
 jsonb_build_object('authorization_id',p_id,'decision',p_decision,'actor','FM_EMAIL_LINK'));
 IF p_decision='reject' THEN
  INSERT INTO cbm_intake_outbox(event_key,kind,reporter_email,payload)
  VALUES('rejected:'||p_id,'REJECTED',t.reporter_email,jsonb_build_object('ticket_id',p_ticket));
 END IF;
 RETURN jsonb_build_object('applied',true,'ticketId',p_ticket,'approved',p_decision='approve');
END $$;

CREATE OR REPLACE FUNCTION cbm_intake_recover() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE a record; t tickets; n integer:=0; added integer:=0;
BEGIN
 FOR a IN SELECT report_id,file_id FROM cbm_capture_attempts WHERE status='PROCESSING'
 AND started_at<clock_timestamp()-interval '10 minutes' ORDER BY started_at LIMIT 20 LOOP
  PERFORM cbm_capture_failed(a.report_id,a.file_id,'CAPTURE_TIMEOUT'); n:=n+1;
 END LOOP;
 -- Lost Gmail receipts are uncertain; never automatically send the same message twice.
 UPDATE cbm_intake_outbox SET status='UNCERTAIN' WHERE status='SENDING' AND claimed_at<clock_timestamp()-interval '5 minutes';
 -- If the request is still pending, send the FM one reminder with the same valid approval link.
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
 -- Renew only expired business-approval links. Timeout is neither approval nor rejection.
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
