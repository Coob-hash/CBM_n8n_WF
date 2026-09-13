SET LOCAL search_path = cbm, pg_catalog;

CREATE VIEW technician_workload AS
SELECT p.actor_id, a.name, a.email, p.rating, p.dispatch_enabled, a.active,
 (SELECT count(*) FROM cbm.assignments x JOIN cbm.tickets t ON t.id=x.ticket_id
  WHERE x.technician_actor_id=p.actor_id AND x.status='ACTIVE' AND t.status NOT IN ('CLOSED','CANCELLED')) AS open_jobs,
 (SELECT max(assigned_at) FROM cbm.assignments WHERE technician_actor_id=p.actor_id) AS last_assigned_at,
 (SELECT count(DISTINCT x.ticket_id) FROM cbm.assignments x JOIN cbm.tickets t ON t.id=x.ticket_id
  WHERE x.technician_actor_id=p.actor_id AND x.status='COMPLETED' AND t.status='CLOSED') AS jobs_completed
FROM cbm.technician_profiles p JOIN cbm.actors a ON a.id=p.actor_id;

CREATE FUNCTION business_date(d date, n integer) RETURNS date LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE i integer:=0; BEGIN
 IF n<0 THEN RAISE EXCEPTION 'Business-day offset must be nonnegative'; END IF;
 WHILE i<n LOOP d:=d+1; IF extract(isodow FROM d)<6 THEN i:=i+1; END IF; END LOOP;
 RETURN d;
END $$;

CREATE FUNCTION initialize_dispatch(p_ticket bigint) RETURNS bigint LANGUAGE plpgsql SET search_path=cbm,pg_catalog AS $$
DECLARE t tickets; d bigint; start_at timestamptz; BEGIN
 PERFORM acting_actor(); PERFORM lock_ticket(p_ticket);
 SELECT id INTO d FROM dispatch_cases WHERE ticket_id=p_ticket; IF FOUND THEN RETURN d; END IF;
 SELECT * INTO t FROM tickets WHERE id=p_ticket;
 IF t.severity>=4 THEN start_at:=(business_date((t.opened_at AT TIME ZONE 'Europe/Rome')::date,1)+time '08:00') AT TIME ZONE 'Europe/Rome'; END IF;
 INSERT INTO dispatch_cases(ticket_id,severity_snapshot,max_active_offers,urgent_start,urgent_end,next_recovery_at)
 VALUES(t.id,t.severity,CASE WHEN t.severity>=4 THEN 2 ELSE 1 END,start_at,start_at+interval '2 hours',clock_timestamp()) RETURNING id INTO d;
 INSERT INTO dispatch_candidates(dispatch_id,technician_actor_id,rank,open_jobs_snapshot,last_assigned_snapshot,rating_snapshot,required_skill_id)
 SELECT d,actor_id,row_number() OVER(ORDER BY open_jobs,last_assigned_at ASC NULLS FIRST,rating DESC,actor_id),open_jobs,last_assigned_at,rating,t.required_skill_id
 FROM technician_workload WHERE technician_eligible(actor_id,t.required_skill_id)
 ORDER BY open_jobs,last_assigned_at ASC NULLS FIRST,rating DESC,actor_id LIMIT 5;
 RETURN d;
END $$;

CREATE FUNCTION reserve_offer(p_dispatch bigint,p_technician bigint,p_token_digest text) RETURNS offers
LANGUAGE plpgsql SET search_path=cbm,pg_catalog AS $$
DECLARE d dispatch_cases; t tickets; c dispatch_candidates; result offers; slot integer; deadline timestamptz; start_at timestamptz; day date; instant timestamptz;
BEGIN
 PERFORM acting_actor(); SELECT * INTO d FROM dispatch_cases WHERE id=p_dispatch; PERFORM lock_ticket(d.ticket_id);
 SELECT * INTO d FROM dispatch_cases WHERE id=p_dispatch FOR UPDATE; SELECT * INTO t FROM tickets WHERE id=d.ticket_id;
 SELECT * INTO c FROM dispatch_candidates WHERE dispatch_id=d.id AND technician_actor_id=p_technician;
 IF NOT FOUND THEN RAISE EXCEPTION 'Technician is not shortlisted'; END IF;
 -- Replaying the same reservation returns its original ID; it never creates another offer.
 SELECT * INTO result FROM offers WHERE candidate_id=c.id;
 IF FOUND THEN RETURN result; END IF;
 SELECT s INTO slot FROM generate_series(1,d.max_active_offers) s WHERE NOT EXISTS(
 SELECT 1 FROM offers WHERE dispatch_id=d.id AND capacity_slot=s AND state IN ('RESERVED','SENDING','LIVE','UNCERTAIN')) ORDER BY s LIMIT 1;
 IF slot IS NULL THEN RAISE EXCEPTION 'Offer capacity is full'; END IF;
 instant:=clock_timestamp(); deadline:=least(instant+interval '48 hours',coalesce(d.urgent_start,'infinity'::timestamptz));
 IF d.severity_snapshot>=4 THEN start_at:=d.urgent_start;
 ELSE
  day:=business_date((t.opened_at AT TIME ZONE 'Europe/Rome')::date,2);
  WHILE extract(isodow FROM day)>5 OR ((day+time '14:00') AT TIME ZONE 'Europe/Rome')<=deadline+interval '10 minutes' LOOP day:=day+1; END LOOP;
  start_at:=(day+time '14:00') AT TIME ZONE 'Europe/Rome';
 END IF;
 INSERT INTO offers(candidate_id,dispatch_id,capacity_slot,reserved_at,expires_at,appointment_start,appointment_end,token_digest,token_expires_at)
 VALUES(c.id,d.id,slot,instant,deadline,start_at,start_at+interval '2 hours',p_token_digest,deadline) RETURNING * INTO result;
 UPDATE tickets SET status='DISPATCHING' WHERE id=t.id;
 UPDATE dispatch_cases SET state='WAITING',next_recovery_at=least(deadline,instant+interval '5 minutes') WHERE id=d.id;
 RETURN result;
END $$;

CREATE FUNCTION claim_message(p_message bigint,p_account text) RETURNS message_attempts
LANGUAGE plpgsql SET search_path=cbm,pg_catalog AS $$
DECLARE m messages; attempt message_attempts; BEGIN
 PERFORM acting_actor(); SELECT * INTO m FROM messages WHERE id=p_message;
 IF m.ticket_id IS NOT NULL THEN PERFORM lock_ticket(m.ticket_id); END IF;
 SELECT * INTO m FROM messages WHERE id=p_message FOR UPDATE;
 IF m.ticket_id IS NOT NULL AND EXISTS(SELECT 1 FROM dispatch_cases WHERE ticket_id=m.ticket_id AND halted)
 THEN RAISE EXCEPTION 'Dispatch is halted; reconcile before automatic sends'; END IF;
 IF m.offer_id IS NOT NULL AND m.purpose='TECHNICIAN_OFFER' THEN
  UPDATE offers SET state='SENDING' WHERE id=m.offer_id AND state='RESERVED' AND expires_at>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'Offer cannot be sent'; END IF;
 END IF;
 INSERT INTO message_attempts(message_id,attempt_number,account_reference,workflow_run_id)
 VALUES(m.id,(SELECT count(*)+1 FROM message_attempts WHERE message_id=m.id),p_account,nullif(current_setting('cbm.workflow_run_id',true),'')::bigint)
 RETURNING * INTO attempt;
 RETURN attempt;
END $$;

CREATE FUNCTION record_delivery(p_attempt bigint,p_provider_message_id text,p_error text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SET search_path=cbm,pg_catalog AS $$
DECLARE a message_attempts; m messages; o offers; d dispatch_cases; instant timestamptz; deadline timestamptz; BEGIN
 PERFORM acting_actor(); SELECT ma.* INTO a FROM message_attempts ma WHERE ma.id=p_attempt;
 SELECT * INTO m FROM messages WHERE id=a.message_id;
 IF m.ticket_id IS NOT NULL THEN PERFORM lock_ticket(m.ticket_id); END IF;
 SELECT * INTO a FROM message_attempts WHERE id=p_attempt FOR UPDATE;
 IF a.result='ACKNOWLEDGED' AND a.provider_message_id=p_provider_message_id THEN RETURN a.result; END IF;
 IF a.result<>'CLAIMED' THEN RAISE EXCEPTION 'Receipt requires a current claim or operator reconciliation'; END IF;
 instant:=clock_timestamp();
 UPDATE message_attempts SET result=CASE WHEN nullif(p_provider_message_id,'') IS NULL THEN 'UNCERTAIN' ELSE 'ACKNOWLEDGED' END,
 provider_message_id=nullif(p_provider_message_id,''),sent_at=CASE WHEN nullif(p_provider_message_id,'') IS NOT NULL THEN instant END,
 finished_at=instant,error_detail=p_error WHERE id=a.id RETURNING * INTO a;
 IF m.purpose='TECHNICIAN_OFFER' THEN
  SELECT * INTO o FROM offers WHERE id=m.offer_id;
  SELECT * INTO d FROM dispatch_cases WHERE id=o.dispatch_id;
  IF o.state IN ('SENDING','UNCERTAIN') THEN
   deadline:=least(instant+interval '48 hours',coalesce(d.urgent_start,'infinity'::timestamptz));
   IF a.result='UNCERTAIN' OR (d.severity_snapshot<4 AND deadline>=o.appointment_start) THEN
    UPDATE offers SET state='UNCERTAIN' WHERE id=o.id;
    UPDATE dispatch_cases SET halted=true,halt_reason=CASE WHEN a.result='UNCERTAIN' THEN 'Uncertain email delivery' ELSE 'Delayed acknowledgement conflicts with the emailed appointment' END,next_recovery_at=NULL WHERE id=d.id;
   ELSE
    UPDATE offers SET state=CASE WHEN deadline<=instant THEN 'EXPIRED' ELSE 'LIVE' END,sent_at=instant,expires_at=deadline,token_expires_at=deadline,
     terminal_at=CASE WHEN deadline<=instant THEN instant END,terminal_reason=CASE WHEN deadline<=instant THEN 'Appointment reached during send' END WHERE id=o.id;
    UPDATE dispatch_cases SET next_recovery_at=deadline WHERE id=d.id;
   END IF;
  END IF;
 END IF;
 RETURN a.result;
END $$;

CREATE FUNCTION record_offer_response(p_reference uuid,p_token text,p_decision text) RETURNS bigint
LANGUAGE plpgsql SET search_path=cbm,pg_catalog AS $$
DECLARE o offers; tid bigint; result bigint; BEGIN
 PERFORM acting_actor();
 IF p_decision NOT IN ('ACCEPT','DECLINE') OR p_decision IS NULL THEN RAISE EXCEPTION 'Unknown decision'; END IF;
 SELECT * INTO o FROM offers WHERE public_reference=p_reference;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invalid offer reference'; END IF;
 SELECT ticket_id INTO tid FROM dispatch_cases WHERE id=o.dispatch_id; PERFORM lock_ticket(tid);
 SELECT * INTO o FROM offers WHERE id=o.id;
 IF o.token_digest IS DISTINCT FROM encode(sha256(convert_to(p_token,'UTF8')),'hex') THEN RAISE EXCEPTION 'Invalid offer token'; END IF;
 SELECT id INTO result FROM offer_responses WHERE offer_id=o.id;
 IF FOUND THEN RETURN result; END IF;
 INSERT INTO offer_responses(offer_id,dispatch_id,decision,receipt_order,verification_basis,workflow_run_id)
 VALUES(o.id,o.dispatch_id,p_decision,1,'TOKEN',nullif(current_setting('cbm.workflow_run_id',true),'')::bigint) RETURNING id INTO result;
 UPDATE dispatch_cases SET next_recovery_at=clock_timestamp() WHERE id=o.dispatch_id;
 RETURN result;
END $$;

CREATE FUNCTION process_responses(p_dispatch bigint) RETURNS bigint
LANGUAGE plpgsql SET search_path=cbm,pg_catalog AS $$
DECLARE d dispatch_cases; t tickets; r offer_responses; o offers; tech bigint; result bigint; BEGIN
 PERFORM acting_actor(); SELECT * INTO d FROM dispatch_cases WHERE id=p_dispatch; PERFORM lock_ticket(d.ticket_id);
 SELECT * INTO t FROM tickets WHERE id=d.ticket_id;
 SELECT id INTO result FROM assignments WHERE ticket_id=t.id AND status='ACTIVE'; IF FOUND THEN RETURN result; END IF;
 FOR r IN SELECT * FROM offer_responses WHERE dispatch_id=d.id AND processing_state='PENDING' ORDER BY receipt_order LOOP
  SELECT * INTO o FROM offers WHERE id=r.offer_id;
  SELECT technician_actor_id INTO tech FROM dispatch_candidates WHERE id=o.candidate_id;
  IF r.decision='DECLINE' THEN
   UPDATE offers SET state='DECLINED',terminal_at=clock_timestamp(),terminal_reason='Technician declined',token_revoked_at=clock_timestamp() WHERE id=o.id;
   UPDATE offer_responses SET processing_state='APPLIED',processed_at=clock_timestamp(),processing_result='DECLINED' WHERE id=r.id;
  ELSIF NOT technician_eligible(tech,t.required_skill_id) THEN
   UPDATE offers SET state='INELIGIBLE',terminal_at=clock_timestamp(),terminal_reason='Eligibility changed',token_revoked_at=clock_timestamp() WHERE id=o.id;
   UPDATE offer_responses SET processing_state='INELIGIBLE',processed_at=clock_timestamp(),processing_result='Eligibility changed' WHERE id=r.id;
  ELSE
   INSERT INTO assignments(ticket_id,technician_actor_id,winning_response_id,origin,assigned_by_actor_id,appointment_start,appointment_end)
   VALUES(t.id,tech,r.id,'OFFER_ACCEPTANCE',acting_actor(),o.appointment_start,o.appointment_end) RETURNING id INTO result;
   RETURN result;
  END IF;
 END LOOP;
 RETURN NULL;
END $$;

CREATE FUNCTION expire_offers(p_dispatch bigint) RETURNS integer
LANGUAGE plpgsql SET search_path=cbm,pg_catalog AS $$
DECLARE tid bigint; n integer; BEGIN
 PERFORM acting_actor(); SELECT ticket_id INTO tid FROM dispatch_cases WHERE id=p_dispatch; PERFORM lock_ticket(tid);
 IF EXISTS(SELECT 1 FROM offer_responses WHERE dispatch_id=p_dispatch AND processing_state='PENDING') THEN RAISE EXCEPTION 'Process recorded responses before expiry'; END IF;
 UPDATE offers SET state='EXPIRED',terminal_at=clock_timestamp(),terminal_reason='Response deadline passed',token_revoked_at=clock_timestamp()
 WHERE dispatch_id=p_dispatch AND state IN ('RESERVED','SENDING','LIVE','UNCERTAIN') AND expires_at<=clock_timestamp();
 GET DIAGNOSTICS n=ROW_COUNT; RETURN n;
END $$;

CREATE FUNCTION mark_overdue_deliveries() RETURNS integer
LANGUAGE plpgsql SET search_path=cbm,pg_catalog AS $$
DECLARE r record; n integer:=0; BEGIN
 PERFORM acting_actor();
 FOR r IN SELECT a.id FROM message_attempts a WHERE a.result='CLAIMED' AND a.claimed_at+interval '5 minutes'<=clock_timestamp() ORDER BY a.id LOOP
  PERFORM record_delivery(r.id,NULL,'Provider receipt missing after five minutes'); n:=n+1;
 END LOOP;
 RETURN n;
END $$;

CREATE FUNCTION reconcile_delivery(p_attempt bigint,p_sent boolean,p_provider_message_id text,p_note text) RETURNS text
LANGUAGE plpgsql SET search_path=cbm,pg_catalog AS $$
DECLARE a message_attempts; m messages; BEGIN
 IF acting_actor() IS DISTINCT FROM (SELECT facility_manager_actor_id FROM site_settings WHERE id=1) THEN RAISE EXCEPTION 'Reconciliation requires current FM'; END IF;
 IF nullif(btrim(p_note),'') IS NULL OR p_sent IS NULL THEN RAISE EXCEPTION 'Explicit reconciliation outcome and note are required'; END IF;
 SELECT * INTO a FROM message_attempts WHERE id=p_attempt;
 SELECT * INTO m FROM messages WHERE id=a.message_id;
 IF m.ticket_id IS NOT NULL THEN PERFORM lock_ticket(m.ticket_id); END IF;
 SELECT * INTO a FROM message_attempts WHERE id=p_attempt FOR UPDATE;
 IF a.result<>'UNCERTAIN' OR a.reconciled_at IS NOT NULL THEN RAISE EXCEPTION 'Attempt is not awaiting reconciliation'; END IF;
 IF p_sent AND nullif(p_provider_message_id,'') IS NULL THEN RAISE EXCEPTION 'Confirmed send requires a provider receipt'; END IF;
 UPDATE message_attempts SET result=CASE WHEN p_sent THEN 'ACKNOWLEDGED' ELSE 'UNCERTAIN' END,
 provider_message_id=CASE WHEN p_sent THEN p_provider_message_id ELSE provider_message_id END,
 sent_at=CASE WHEN p_sent THEN coalesce(sent_at,clock_timestamp()) ELSE sent_at END,
 reconciled_by_actor_id=acting_actor(),reconciled_at=clock_timestamp(),reconciliation_result=CASE WHEN p_sent THEN 'SENT' ELSE 'NOT_SENT' END,error_detail=p_note WHERE id=a.id;
 -- Do not move an offer's original deadline based on a delayed reconciliation.
 -- A known-unsent offer is withdrawn; it is not silently offered to that candidate again.
 IF NOT p_sent AND m.purpose='TECHNICIAN_OFFER' THEN
  UPDATE offers SET state='WITHDRAWN',terminal_at=clock_timestamp(),terminal_reason='FM confirmed invitation was not sent',token_revoked_at=clock_timestamp()
  WHERE id=m.offer_id AND state IN ('SENDING','UNCERTAIN');
 END IF;
 RETURN CASE WHEN p_sent THEN 'ACKNOWLEDGED' ELSE 'NOT_SENT' END;
END $$;

CREATE FUNCTION resume_dispatch(p_dispatch bigint,p_note text) RETURNS void
LANGUAGE plpgsql SET search_path=cbm,pg_catalog AS $$
BEGIN
 IF acting_actor() IS DISTINCT FROM (SELECT facility_manager_actor_id FROM site_settings WHERE id=1) THEN RAISE EXCEPTION 'Only FM may resume dispatch'; END IF;
 IF nullif(btrim(p_note),'') IS NULL THEN RAISE EXCEPTION 'Resume reason is required'; END IF;
 UPDATE dispatch_cases SET halted=false,halt_reason=NULL,next_recovery_at=clock_timestamp() WHERE id=p_dispatch;
 INSERT INTO audit_events(event_type,actor_id,ticket_id,details)
 SELECT 'DISPATCH_RESUMED',acting_actor(),ticket_id,jsonb_build_object('reason',p_note) FROM dispatch_cases WHERE id=p_dispatch;
END $$;

CREATE FUNCTION escalate_dispatch(p_dispatch bigint) RETURNS void
LANGUAGE plpgsql SET search_path=cbm,pg_catalog AS $$
DECLARE d dispatch_cases; t tickets; BEGIN
 PERFORM acting_actor(); SELECT * INTO d FROM dispatch_cases WHERE id=p_dispatch; PERFORM lock_ticket(d.ticket_id);
 SELECT * INTO d FROM dispatch_cases WHERE id=p_dispatch FOR UPDATE; SELECT * INTO t FROM tickets WHERE id=d.ticket_id;
 IF d.state='ESCALATED' THEN RETURN; END IF;
 IF d.halted OR t.status NOT IN ('LOCALIZED','DISPATCHING') OR EXISTS(SELECT 1 FROM offers WHERE dispatch_id=d.id AND state IN ('RESERVED','SENDING','LIVE','UNCERTAIN'))
 OR EXISTS(SELECT 1 FROM offer_responses WHERE dispatch_id=d.id AND processing_state='PENDING') THEN RAISE EXCEPTION 'Dispatch cannot escalate while work or responses remain'; END IF;
 IF (d.urgent_start IS NULL OR d.urgent_start>clock_timestamp()) AND EXISTS(
 SELECT 1 FROM dispatch_candidates c WHERE c.dispatch_id=d.id AND NOT EXISTS(SELECT 1 FROM offers o WHERE o.candidate_id=c.id) AND technician_eligible(c.technician_actor_id,t.required_skill_id))
 THEN RAISE EXCEPTION 'Eligible unoffered candidates remain'; END IF;
 UPDATE dispatch_cases SET state='ESCALATED',next_recovery_at=NULL WHERE id=d.id;
 UPDATE tickets SET status='ESCALATED' WHERE id=t.id;
END $$;

CREATE FUNCTION record_dispatch_failure(p_ticket bigint,p_reason text) RETURNS integer
LANGUAGE plpgsql SET search_path=cbm,pg_catalog AS $$
DECLARE d dispatch_cases; n integer; BEGIN
 PERFORM acting_actor(); PERFORM lock_ticket(p_ticket);
 SELECT * INTO d FROM dispatch_cases WHERE ticket_id=p_ticket;
 IF FOUND THEN
  n:=d.failure_count+1;
  UPDATE dispatch_cases SET failure_count=n,halted=halted OR n>=3,
   halt_reason=CASE WHEN halted THEN halt_reason WHEN n>=3 THEN p_reason ELSE halt_reason END,
   next_recovery_at=CASE WHEN halted OR n>=3 THEN NULL ELSE clock_timestamp()+interval '1 minute' END WHERE id=d.id;
 ELSE
  INSERT INTO audit_events(event_type,actor_id,ticket_id,details) VALUES('INITIALIZATION_FAILED',acting_actor(),p_ticket,jsonb_build_object('reason',p_reason));
  SELECT count(*) INTO n FROM audit_events WHERE ticket_id=p_ticket AND event_type='INITIALIZATION_FAILED';
 END IF;
 RETURN n;
END $$;

CREATE FUNCTION request_approval(p_completion bigint,p_assessment bigint,p_token_digest text) RETURNS bigint
LANGUAGE plpgsql SET search_path=cbm,pg_catalog AS $$
DECLARE tid bigint; result bigint; instant timestamptz:=clock_timestamp(); BEGIN
 PERFORM acting_actor();
 SELECT a.ticket_id INTO tid FROM completion_submissions c JOIN assignments a ON a.id=c.assignment_id WHERE c.id=p_completion; PERFORM lock_ticket(tid);
 SELECT id INTO result FROM approval_requests WHERE completion_id=p_completion AND status='PENDING'; IF FOUND THEN RETURN result; END IF;
 INSERT INTO approval_requests(completion_id,verification_assessment_id,requested_from_actor_id,request_sequence,requested_at,expires_at,token_digest)
 SELECT p_completion,p_assessment,facility_manager_actor_id,(SELECT count(*)+1 FROM approval_requests WHERE completion_id=p_completion),instant,instant+interval '72 hours',p_token_digest FROM site_settings WHERE id=1 RETURNING id INTO result;
 IF result IS NULL THEN RAISE EXCEPTION 'Configure the site FM first'; END IF;
 UPDATE completion_submissions SET status='PENDING_APPROVAL' WHERE id=p_completion;
 UPDATE tickets SET status='PENDING_APPROVAL' WHERE id=tid;
 RETURN result;
END $$;

CREATE FUNCTION expire_approval(p_approval bigint) RETURNS text
LANGUAGE plpgsql SET search_path=cbm,pg_catalog AS $$
DECLARE tid bigint; p approval_requests; BEGIN
 PERFORM acting_actor(); SELECT a.ticket_id INTO tid FROM approval_requests r JOIN completion_submissions c ON c.id=r.completion_id JOIN assignments a ON a.id=c.assignment_id WHERE r.id=p_approval;
 PERFORM lock_ticket(tid); SELECT * INTO p FROM approval_requests WHERE id=p_approval FOR UPDATE;
 IF p.status<>'PENDING' THEN RETURN p.status; END IF;
 UPDATE approval_requests SET status='EXPIRED',reason='FM did not respond before the deadline' WHERE id=p_approval;
 -- Expiry is not rejection. The ticket stays pending for operator follow-up.
 RETURN 'EXPIRED';
END $$;

CREATE FUNCTION decide_approval(p_approval bigint,p_decision text,p_reason text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SET search_path=cbm,pg_catalog AS $$
DECLARE p approval_requests; c completion_submissions; a assignments; t tickets; BEGIN
 PERFORM acting_actor();
 IF p_decision NOT IN ('APPROVED','REJECTED') OR p_decision IS NULL THEN RAISE EXCEPTION 'Explicit FM approval or rejection required'; END IF;
 SELECT * INTO p FROM approval_requests WHERE id=p_approval;
 SELECT * INTO c FROM completion_submissions WHERE id=p.completion_id;
 SELECT * INTO a FROM assignments WHERE id=c.assignment_id; PERFORM lock_ticket(a.ticket_id);
 SELECT * INTO t FROM tickets WHERE id=a.ticket_id;
 SELECT * INTO p FROM approval_requests WHERE id=p_approval FOR UPDATE;
 IF p.status=p_decision AND p.decided_by_actor_id=acting_actor() THEN RETURN p.status; END IF;
 UPDATE approval_requests SET status=p_decision,decided_by_actor_id=acting_actor(),decided_at=clock_timestamp(),reason=p_reason WHERE id=p.id;
 UPDATE completion_submissions SET status=p_decision WHERE id=c.id;
 IF p_decision='APPROVED' THEN
  UPDATE tickets SET status='CLOSED',closed_at=clock_timestamp() WHERE id=t.id;
  UPDATE assignments SET status='COMPLETED',ended_at=clock_timestamp() WHERE id=a.id;
  INSERT INTO ifc_sync_jobs(approval_request_id,asset_id,operation_key,maintenance_payload,next_retry_at)
  VALUES(p.id,t.asset_id,'approval:'||p.id,jsonb_build_object('ticket_id',t.id,'assignment_id',a.id,'approved_by_actor_id',acting_actor(),'description',t.description,'condition','Repaired'),clock_timestamp());
 ELSE UPDATE tickets SET status='REWORK' WHERE id=t.id;
 END IF;
 RETURN p_decision;
END $$;

CREATE FUNCTION start_ifc_sync(p_job bigint,p_request_reference text) RETURNS ifc_sync_attempts
LANGUAGE plpgsql SET search_path=cbm,pg_catalog AS $$
DECLARE result ifc_sync_attempts; version_id bigint; BEGIN
 PERFORM acting_actor(); PERFORM pg_advisory_xact_lock(132849,1);
 SELECT id INTO version_id FROM bim_versions WHERE is_current FOR UPDATE;
 IF version_id IS NULL THEN RAISE EXCEPTION 'No published IFC model'; END IF;
 INSERT INTO ifc_sync_attempts(job_id,attempt_number,input_bim_version_id,request_reference,workflow_run_id)
 VALUES(p_job,(SELECT count(*)+1 FROM ifc_sync_attempts WHERE job_id=p_job),version_id,p_request_reference,nullif(current_setting('cbm.workflow_run_id',true),'')::bigint) RETURNING * INTO result;
 UPDATE ifc_sync_jobs SET status='IN_PROGRESS' WHERE id=p_job;
 RETURN result;
END $$;

CREATE FUNCTION finish_ifc_sync(p_attempt bigint,p_file bigint,p_version_label text,p_error text DEFAULT NULL) RETURNS bigint
LANGUAGE plpgsql SET search_path=cbm,pg_catalog AS $$
DECLARE a ifc_sync_attempts; result bigint; BEGIN
 PERFORM acting_actor(); PERFORM pg_advisory_xact_lock(132849,1);
 SELECT * INTO a FROM ifc_sync_attempts WHERE id=p_attempt FOR UPDATE;
 IF a.outcome='SUCCEEDED' THEN RETURN a.output_bim_version_id; END IF;
 IF a.outcome<>'IN_PROGRESS' THEN RAISE EXCEPTION 'IFC receipt requires a running attempt'; END IF;
 IF p_file IS NULL THEN
  UPDATE ifc_sync_attempts SET outcome='UNCERTAIN',finished_at=clock_timestamp(),error_detail=p_error WHERE id=a.id;
  UPDATE ifc_sync_jobs SET status='UNCERTAIN' WHERE id=a.job_id; RETURN NULL;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM bim_versions WHERE id=a.input_bim_version_id AND is_current) THEN RAISE EXCEPTION 'IFC current version changed during write'; END IF;
 INSERT INTO bim_versions(version_label,file_id,parent_version_id,created_by_actor_id) VALUES(p_version_label,p_file,a.input_bim_version_id,acting_actor()) RETURNING id INTO result;
 UPDATE ifc_sync_attempts SET outcome='SUCCEEDED',output_bim_version_id=result,finished_at=clock_timestamp() WHERE id=a.id;
 UPDATE bim_versions SET is_current=false WHERE id=a.input_bim_version_id;
 UPDATE bim_versions SET is_current=true,published_at=clock_timestamp() WHERE id=result;
 UPDATE ifc_sync_jobs SET status='SUCCEEDED',result_bim_version_id=result,completed_at=clock_timestamp(),next_retry_at=NULL WHERE id=a.job_id;
 RETURN result;
END $$;

CREATE VIEW dispatch_context AS
SELECT t.id AS ticket_id,t.status,t.severity,t.required_skill_id,d.id AS dispatch_id,d.state AS dispatch_state,
 d.halted,d.halt_reason,d.next_recovery_at,d.max_active_offers,d.urgent_start,
 (SELECT count(*) FROM cbm.offers o WHERE o.dispatch_id=d.id AND o.state IN ('RESERVED','SENDING','LIVE','UNCERTAIN')) AS occupied_slots,
 (SELECT count(*) FROM cbm.offer_responses r WHERE r.dispatch_id=d.id AND r.processing_state='PENDING') AS pending_responses,
 (SELECT id FROM cbm.assignments a WHERE a.ticket_id=t.id AND a.status='ACTIVE') AS active_assignment_id,
 coalesce((SELECT jsonb_agg(jsonb_build_object('technician_id',c.technician_actor_id,'rank',c.rank) ORDER BY c.rank)
 FROM cbm.dispatch_candidates c WHERE c.dispatch_id=d.id AND NOT EXISTS(SELECT 1 FROM cbm.offers o WHERE o.candidate_id=c.id)),'[]'::jsonb) AS unoffered_candidates,
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',o.id,'state',o.state,'expires_at',o.expires_at,'appointment_start',o.appointment_start)) FROM cbm.offers o WHERE o.dispatch_id=d.id),'[]'::jsonb) AS offers,
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',m.id,'purpose',m.purpose,'status',m.status)) FROM cbm.messages m WHERE m.ticket_id=t.id),'[]'::jsonb) AS messages
FROM cbm.tickets t LEFT JOIN cbm.dispatch_cases d ON d.ticket_id=t.id;

CREATE FUNCTION guard_scheduling() RETURNS trigger LANGUAGE plpgsql SET search_path=cbm,pg_catalog AS $$
DECLARE t tickets; d dispatch_cases; expected timestamptz; BEGIN
 IF TG_TABLE_NAME='dispatch_cases' THEN
  SELECT * INTO t FROM tickets WHERE id=NEW.ticket_id;
  IF NEW.severity_snapshot>=4 THEN
   expected:=(business_date((t.opened_at AT TIME ZONE 'Europe/Rome')::date,1)+time '08:00') AT TIME ZONE 'Europe/Rome';
   IF NEW.urgent_start IS DISTINCT FROM expected OR NEW.urgent_end IS DISTINCT FROM expected+interval '2 hours'
   THEN RAISE EXCEPTION 'Urgent appointment must be the original next business day 08:00-10:00'; END IF;
  END IF;
 ELSE
  SELECT * INTO d FROM dispatch_cases WHERE id=NEW.dispatch_id;
  IF d.severity_snapshot<4 AND (extract(isodow FROM NEW.appointment_start AT TIME ZONE 'Europe/Rome')>5
   OR (NEW.appointment_start AT TIME ZONE 'Europe/Rome')::time<>time '14:00'
   OR (NEW.appointment_end AT TIME ZONE 'Europe/Rome')::time<>time '16:00'
   OR (NEW.appointment_start AT TIME ZONE 'Europe/Rome')::date<>(NEW.appointment_end AT TIME ZONE 'Europe/Rome')::date)
  THEN RAISE EXCEPTION 'Ordinary appointment must be a business-day 14:00-16:00 slot'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dispatch_schedule BEFORE INSERT ON dispatch_cases FOR EACH ROW EXECUTE FUNCTION guard_scheduling();
CREATE TRIGGER offer_schedule BEFORE INSERT ON offers FOR EACH ROW EXECUTE FUNCTION guard_scheduling();

CREATE FUNCTION guard_run() RETURNS trigger LANGUAGE plpgsql SET search_path=cbm,pg_catalog AS $$
DECLARE parent workflow_runs; BEGIN
 IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-ARRAY['ended_at','outcome','error_summary','ticket_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['ended_at','outcome','error_summary','ticket_id']) OR OLD.outcome<>'RUNNING')
 THEN RAISE EXCEPTION 'Execution provenance and completed runs are immutable'; END IF;
 IF TG_OP='UPDATE' AND OLD.ticket_id IS NOT NULL AND NEW.ticket_id IS DISTINCT FROM OLD.ticket_id THEN RAISE EXCEPTION 'Execution cannot move to a different ticket'; END IF;
 IF NEW.report_id IS NOT NULL AND NEW.ticket_id IS NOT NULL AND EXISTS(SELECT 1 FROM reports WHERE id=NEW.report_id AND ticket_id IS NOT NULL AND ticket_id<>NEW.ticket_id)
 THEN RAISE EXCEPTION 'Execution report and ticket do not match'; END IF;
 IF NEW.parent_run_id IS NOT NULL THEN
  SELECT * INTO parent FROM workflow_runs WHERE id=NEW.parent_run_id;
  IF parent.ticket_id IS NOT NULL AND NEW.ticket_id IS NOT NULL AND parent.ticket_id<>NEW.ticket_id THEN RAISE EXCEPTION 'Child execution belongs to another ticket'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER execution_guard BEFORE INSERT OR UPDATE ON workflow_runs FOR EACH ROW EXECUTE FUNCTION guard_run();

CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at:=clock_timestamp(); RETURN NEW; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['actors','site_settings','technician_profiles','assets'] LOOP
  EXECUTE format('CREATE TRIGGER z_touch BEFORE UPDATE ON cbm.%I FOR EACH ROW EXECUTE FUNCTION cbm.touch_updated_at()',t);
 END LOOP;
END $$;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA cbm FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA cbm FROM PUBLIC;
