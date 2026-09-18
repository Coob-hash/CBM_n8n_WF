BEGIN;
CREATE TABLE IF NOT EXISTS cbm_technician_submissions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 ticket_id integer NOT NULL REFERENCES tickets(id),
 approval_cycle text NOT NULL,
 technician_id integer NOT NULL REFERENCES technicians(id),
 pdf_sha256 text NOT NULL CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$'),
 report jsonb NOT NULL,
 status text NOT NULL DEFAULT 'CLAIMED' CHECK (status IN ('CLAIMED','SUBMITTED','UNCONFIRMED')),
 drive_file_id text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 submitted_at timestamptz,
 UNIQUE(ticket_id,approval_cycle)
);

CREATE OR REPLACE FUNCTION cbm_issue_technician_report_link(p_ticket integer)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE t tickets%ROWTYPE; s jsonb; o jsonb; i integer; token text;
BEGIN
 SELECT * INTO t FROM tickets WHERE id=p_ticket FOR UPDATE;
 IF NOT FOUND OR t.status NOT IN ('ASSIGNED','REWORK') THEN RETURN NULL; END IF;
 SELECT payload INTO s FROM ticket_events WHERE ticket_id=t.id AND event='CBM_DISPATCH_STATE' ORDER BY id DESC LIMIT 1;
 SELECT value,ordinality::int-1 INTO o,i FROM jsonb_array_elements(s->'offers') WITH ORDINALITY
 WHERE value->>'status'='ACCEPTED' AND (value->>'technician_id')::int=t.technician_id LIMIT 1;
 IF o IS NULL THEN RETURN NULL; END IF;
 token=o->>'report_token';
 IF token IS NULL OR coalesce((o->>'report_expires_at')::timestamptz,'epoch')<=clock_timestamp() THEN
  token=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
  o=o||jsonb_build_object('report_token',token,'report_expires_at',clock_timestamp()+interval '30 days');
  s=jsonb_set(s,ARRAY['offers',i::text],o);
  INSERT INTO ticket_events(ticket_id,event,payload) VALUES(t.id,'CBM_DISPATCH_STATE',s);
  UPDATE tickets SET updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond') WHERE id=t.id;
 END IF;
 RETURN jsonb_build_object('ticketId',t.id,'token',token,'expires_at',o->>'report_expires_at');
END $$;

CREATE OR REPLACE FUNCTION cbm_technician_report_access(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE t tickets%ROWTYPE; s jsonb; o jsonb; tech technicians%ROWTYPE; submission cbm_technician_submissions%ROWTYPE;
BEGIN
 IF coalesce(p->>'ticketId','') !~ '^[1-9][0-9]{0,9}$' OR coalesce(p->>'token','') !~ '^[0-9a-f]{64}$'
  OR (p->>'ticketId')::bigint>2147483647 THEN RETURN jsonb_build_object('status','UNAVAILABLE'); END IF;
 SELECT * INTO t FROM tickets WHERE id=(p->>'ticketId')::int;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','UNAVAILABLE'); END IF;
 SELECT payload INTO s FROM ticket_events WHERE ticket_id=t.id AND event='CBM_DISPATCH_STATE' ORDER BY id DESC LIMIT 1;
 SELECT value INTO o FROM jsonb_array_elements(s->'offers') WHERE value->>'status'='ACCEPTED'
  AND (value->>'technician_id')::int=t.technician_id AND value->>'report_token'=p->>'token'
  AND (value->>'report_expires_at')::timestamptz>now() LIMIT 1;
 IF o IS NULL THEN RETURN jsonb_build_object('status','UNAVAILABLE'); END IF;
 SELECT * INTO submission FROM cbm_technician_submissions WHERE ticket_id=t.id AND approval_cycle=coalesce(t.approval_id::text,'initial');
 IF FOUND THEN RETURN jsonb_build_object('status',CASE WHEN submission.status='SUBMITTED' THEN 'SUBMITTED' ELSE 'UNCONFIRMED' END,'ticketId',t.id,'submissionId',submission.id); END IF;
 IF t.status NOT IN ('ASSIGNED','REWORK') THEN RETURN jsonb_build_object('status','NOT_OPEN','ticketId',t.id); END IF;
 SELECT * INTO tech FROM technicians WHERE id=t.technician_id;
 RETURN jsonb_build_object('status','OK','ticketId',t.id,'technicianId',tech.id,'approvalCycle',coalesce(t.approval_id::text,'initial'),
  'fields',jsonb_build_object('ticket_id',t.id,'technician_name',tech.full_name,'technician_email',tech.email,
  'asset_name',coalesce(nullif(t.ifc_name,''),t.ifc_global_id),'location',coalesce(t.ifc_storey,''),'reported_issue',t.description));
END $$;

CREATE OR REPLACE FUNCTION cbm_claim_technician_report(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE access jsonb; sid uuid;
BEGIN
 IF coalesce(p->>'ticketId','') !~ '^[1-9][0-9]{0,9}$' THEN RETURN jsonb_build_object('status','UNAVAILABLE'); END IF;
 PERFORM 1 FROM tickets WHERE id=(p->>'ticketId')::int FOR UPDATE;
 access=cbm_technician_report_access(p);
 IF access->>'status'<>'OK' THEN RETURN access; END IF;
 IF coalesce(p->>'pdf_sha256','') !~ '^[0-9a-f]{64}$' OR jsonb_typeof(p->'report')<>'object' THEN
  RETURN jsonb_build_object('status','INVALID'); END IF;
 INSERT INTO cbm_technician_submissions(ticket_id,approval_cycle,technician_id,pdf_sha256,report)
 VALUES((access->>'ticketId')::int,access->>'approvalCycle',(access->>'technicianId')::int,p->>'pdf_sha256',p->'report')
 ON CONFLICT(ticket_id,approval_cycle) DO NOTHING RETURNING id INTO sid;
 IF sid IS NULL THEN RETURN jsonb_build_object('status','UNCONFIRMED'); END IF;
 RETURN jsonb_build_object('status','UPLOAD','ticketId',access->'ticketId','submissionId',sid);
END $$;

CREATE OR REPLACE FUNCTION cbm_record_technician_report(p jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r cbm_technician_submissions%ROWTYPE; fid text=nullif(p->>'fileId','');
BEGIN
 SELECT * INTO r FROM cbm_technician_submissions WHERE id=(p->>'submissionId')::uuid FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','UNAVAILABLE'); END IF;
 IF r.status='SUBMITTED' THEN RETURN jsonb_build_object('status','SUBMITTED','ticketId',r.ticket_id,'submissionId',r.id); END IF;
 IF fid IS NOT NULL AND fid !~ '^[A-Za-z0-9_-]{1,200}$' THEN fid=NULL; END IF;
 UPDATE cbm_technician_submissions SET status=CASE WHEN fid IS NULL THEN 'UNCONFIRMED' ELSE 'SUBMITTED' END,
 drive_file_id=fid,submitted_at=CASE WHEN fid IS NOT NULL THEN clock_timestamp() END WHERE id=r.id;
 INSERT INTO ticket_events(ticket_id,event,payload) VALUES(r.ticket_id,'CBM_TECHNICIAN_REPORT',
  jsonb_build_object('submission_id',r.id,'drive_file_id',fid,'status',CASE WHEN fid IS NULL THEN 'UNCONFIRMED' ELSE 'SUBMITTED' END));
 RETURN jsonb_build_object('status',CASE WHEN fid IS NULL THEN 'UNCONFIRMED' ELSE 'SUBMITTED' END,'ticketId',r.ticket_id,'submissionId',r.id);
END $$;
COMMIT;
