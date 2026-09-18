-- Configuration faults do not consume the user's four-photo allowance.
-- Apply after schema_intake.sql. Safe to apply repeatedly; no historical data is deleted.
BEGIN;
ALTER TABLE cbm_intake_reports DROP CONSTRAINT IF EXISTS cbm_intake_reports_state_check;
ALTER TABLE cbm_intake_reports ADD CONSTRAINT cbm_intake_reports_state_check
 CHECK(state IN ('NEW','PROCESSING','AWAITING_PHOTO','IT_ISSUE','IDENTIFIED','CONFIGURATION_REQUIRED'));
ALTER TABLE cbm_capture_attempts DROP CONSTRAINT IF EXISTS cbm_capture_attempts_status_check;
ALTER TABLE cbm_capture_attempts ADD CONSTRAINT cbm_capture_attempts_status_check
 CHECK(status IN ('PROCESSING','FAILED','IDENTIFIED','CONFIGURATION_REQUIRED'));
ALTER TABLE cbm_intake_outbox DROP CONSTRAINT IF EXISTS cbm_intake_outbox_kind_check;
ALTER TABLE cbm_intake_outbox ADD CONSTRAINT cbm_intake_outbox_kind_check
 CHECK(kind IN ('RETRY','BUG_RECEIPT','IT_BUG','AUTHORIZATION','RECEIVED','DUPLICATE','REJECTED','BUSY','FINISHED','CONFIGURATION_IT'));
CREATE TABLE IF NOT EXISTS cbm_capture_configuration_events (
 id bigserial PRIMARY KEY, report_id uuid NOT NULL REFERENCES cbm_intake_reports(id),
 file_id text NOT NULL REFERENCES cbm_capture_attempts(file_id),
 action text NOT NULL CHECK(action IN ('PAUSED','RECLASSIFIED','RESUMED')),
 reason text NOT NULL, execution_id text, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS cbm_capture_configuration_events_report ON cbm_capture_configuration_events(report_id,id);

CREATE OR REPLACE FUNCTION cbm_capture_pause_configuration(p_report uuid,p_file text,p_reason text,p_reclassify boolean DEFAULT false)
 RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r cbm_intake_reports; a cbm_capture_attempts; result jsonb; event_id bigint;
BEGIN
 IF p_reason IS NULL OR p_reason NOT IN ('REGISTRATION_REQUIRED','REGISTRATION_INVALID','MAP_CODE_MISMATCH','IFC_SERVICE_UNAVAILABLE','MULTISET_SERVICE_UNAVAILABLE') THEN
  RAISE EXCEPTION 'Expected a configuration diagnostic code';
 END IF;
 SELECT * INTO r FROM cbm_intake_reports WHERE id=p_report FOR UPDATE;
 SELECT * INTO a FROM cbm_capture_attempts WHERE file_id=p_file AND report_id=p_report FOR UPDATE;
 IF r.id IS NULL OR a.file_id IS NULL OR a.attempt<>r.attempts OR NOT (
  (r.state='PROCESSING' AND a.status='PROCESSING') OR
  (p_reclassify AND r.state='AWAITING_PHOTO' AND a.status='FAILED' AND a.reason=p_reason)) THEN
  RETURN jsonb_build_object('changed',false);
 END IF;
 -- Retain the reserved slot and file row: only this same file can resume it.
 UPDATE cbm_capture_attempts SET status='CONFIGURATION_REQUIRED',reason=p_reason,completed_at=clock_timestamp() WHERE file_id=p_file;
 UPDATE cbm_intake_reports SET state='CONFIGURATION_REQUIRED',attempts=attempts-1,updated_at=clock_timestamp()
  WHERE id=p_report RETURNING * INTO r;
 INSERT INTO cbm_capture_configuration_events(report_id,file_id,action,reason,execution_id)
 VALUES(p_report,p_file,CASE WHEN a.status='FAILED' THEN 'RECLASSIFIED' ELSE 'PAUSED' END,p_reason,a.execution_id)
 RETURNING id INTO event_id;
 UPDATE cbm_intake_outbox SET status='CANCELLED' WHERE event_key='retry:'||p_file AND status='PENDING';
 UPDATE cbm_intake_outbox
 SET event_key=event_key||':superseded:'||id,
     payload=payload||jsonb_build_object('superseded_event_key',event_key,'resolution','Technical failure did not consume a photo attempt')
 WHERE event_key='retry:'||p_file AND status='CANCELLED';
 result:=jsonb_build_object('changed',true,'report_id',r.id,'file_id',p_file,'attempts',r.attempts,
  'retries_remaining',4-r.attempts,'state',r.state,'reason',p_reason,'configuration_event_id',event_id,
  'requires_new_photo',false);
 INSERT INTO cbm_intake_outbox(event_key,kind,reporter_email,payload)
 VALUES('configuration:'||event_id,'CONFIGURATION_IT',NULL,result);
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION cbm_capture_failed(p_report uuid,p_file text,p_reason text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r cbm_intake_reports; a cbm_capture_attempts; bug uuid; result jsonb;
BEGIN
 IF p_reason IN ('REGISTRATION_REQUIRED','REGISTRATION_INVALID','MAP_CODE_MISMATCH','IFC_SERVICE_UNAVAILABLE','MULTISET_SERVICE_UNAVAILABLE') THEN
  RETURN cbm_capture_pause_configuration(p_report,p_file,p_reason);
 END IF;
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
 IF FOUND THEN
  SELECT * INTO r FROM cbm_intake_reports WHERE id=a.report_id FOR UPDATE;
  SELECT * INTO a FROM cbm_capture_attempts WHERE file_id=fid FOR UPDATE;
  IF r.reporter_email<>email OR (nullif(p->>'report_id','') IS NOT NULL AND (p->>'report_id')::uuid<>r.id) THEN
   RAISE EXCEPTION 'Report belongs to another reporter or report';
  END IF;
  IF a.status='CONFIGURATION_REQUIRED' AND r.state='CONFIGURATION_REQUIRED' THEN
   IF p->'registration_ready'='true'::jsonb AND a.attempt=r.attempts+1 THEN
    INSERT INTO cbm_capture_configuration_events(report_id,file_id,action,reason,execution_id)
    VALUES(r.id,fid,'RESUMED',a.reason,left(p->>'execution_id',100));
    UPDATE cbm_capture_attempts SET status='PROCESSING',reason=NULL,completed_at=NULL,started_at=clock_timestamp(),
     execution_id=left(p->>'execution_id',100) WHERE file_id=fid;
    UPDATE cbm_intake_reports SET state='PROCESSING',attempts=a.attempt,updated_at=clock_timestamp() WHERE id=r.id;
    -- A queued warning is obsolete once the same capture has safely resumed.
    UPDATE cbm_intake_outbox SET status='CANCELLED' WHERE kind='CONFIGURATION_IT' AND status='PENDING'
     AND payload->>'file_id'=fid;
    RETURN jsonb_build_object('process',true,'report_id',r.id,'file_id',fid,'attempt',a.attempt,
     'reporter_email',email,'resumed',true);
   END IF;
   RETURN jsonb_build_object('process',false,'report_id',r.id,'file_id',fid,'state',r.state,
    'reason',a.reason,'attempts',r.attempts,'requires_new_photo',false);
  END IF;
  RETURN jsonb_build_object('process',false,'reason','FILE_ALREADY_RECORDED','report_id',a.report_id);
 END IF;
 rid:=coalesce(nullif(p->>'report_id','')::uuid,gen_random_uuid());
 INSERT INTO cbm_intake_reports(id,reporter_email) VALUES(rid,email) ON CONFLICT DO NOTHING;
 SELECT * INTO r FROM cbm_intake_reports WHERE id=rid FOR UPDATE;
 IF r.reporter_email<>email THEN RAISE EXCEPTION 'Report belongs to another reporter'; END IF;
 IF r.state='CONFIGURATION_REQUIRED' THEN
  RETURN jsonb_build_object('process',false,'report_id',rid,'state',r.state,'reason','RESUME_RETAINED_FILE',
   'file_id',(SELECT file_id FROM cbm_capture_attempts WHERE report_id=rid AND status='CONFIGURATION_REQUIRED'),
   'attempts',r.attempts,'requires_new_photo',false);
 END IF;
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
 IF p->'registration_ready'='false'::jsonb THEN
  RETURN cbm_capture_pause_configuration(rid,fid,coalesce(p->>'configuration_reason','REGISTRATION_REQUIRED'))
   ||jsonb_build_object('process',false);
 END IF;
 RETURN jsonb_build_object('process',true,'report_id',rid,'file_id',fid,'attempt',r.attempts,'reporter_email',email);
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
