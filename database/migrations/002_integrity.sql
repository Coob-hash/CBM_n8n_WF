SET LOCAL search_path = cbm, pg_catalog;

CREATE FUNCTION acting_actor() RETURNS bigint LANGUAGE plpgsql STABLE AS $$
DECLARE a bigint; BEGIN
 a:=nullif(current_setting('cbm.actor_id',true),'')::bigint;
 IF a IS NULL THEN RAISE EXCEPTION 'Set cbm.actor_id locally in the transaction before writing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM cbm.actors WHERE id=a AND active) THEN RAISE EXCEPTION 'Unknown or inactive acting actor'; END IF;
 RETURN a;
END $$;

CREATE FUNCTION require_human(a bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM cbm.actors WHERE id=a AND kind='HUMAN' AND active AND email IS NOT NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'An active human actor with an email address is required'; END IF;
END $$;

CREATE FUNCTION lock_ticket(t bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM cbm.tickets WHERE id=t FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Ticket % does not exist',t; END IF;
END $$;

CREATE FUNCTION technician_eligible(a bigint,s bigint) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM cbm.actors WHERE id=a AND kind='HUMAN' AND active AND email IS NOT NULL FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM actor_id FROM cbm.technician_profiles WHERE actor_id=a AND dispatch_enabled FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM ts.technician_actor_id FROM cbm.technician_skills ts JOIN cbm.skills sk ON sk.id=ts.skill_id
 WHERE ts.technician_actor_id=a AND ts.skill_id=s AND sk.active AND ts.valid_from<=clock_timestamp()
 AND (ts.valid_until IS NULL OR ts.valid_until>clock_timestamp()) FOR SHARE OF ts,sk;
 RETURN FOUND;
END $$;

CREATE FUNCTION retain_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is retained history; delete/truncate is prohibited',TG_TABLE_NAME; END $$;

CREATE FUNCTION freeze_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% records are immutable; create a new record',TG_TABLE_NAME; END $$;

CREATE FUNCTION guard_actor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.kind IS DISTINCT FROM OLD.kind THEN RAISE EXCEPTION 'Actor kind is immutable'; END IF;
 IF TG_OP='UPDATE' AND NOT NEW.active AND EXISTS(SELECT 1 FROM cbm.site_settings WHERE facility_manager_actor_id=NEW.id)
 THEN RAISE EXCEPTION 'Replace the current FM before deactivating that actor'; END IF;
 IF NEW.email IS NULL AND (EXISTS(SELECT 1 FROM cbm.site_settings WHERE facility_manager_actor_id=NEW.id) OR EXISTS(SELECT 1 FROM cbm.technician_profiles WHERE actor_id=NEW.id))
 THEN RAISE EXCEPTION 'FM and technician identities require an email address'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER actor_guard BEFORE UPDATE ON actors FOR EACH ROW EXECUTE FUNCTION guard_actor();
CREATE FUNCTION guard_human_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='technician_profiles' THEN PERFORM cbm.require_human(NEW.actor_id);
 ELSE PERFORM cbm.require_human(NEW.facility_manager_actor_id); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER technician_human BEFORE INSERT OR UPDATE ON technician_profiles FOR EACH ROW EXECUTE FUNCTION guard_human_role();
CREATE TRIGGER fm_human BEFORE INSERT OR UPDATE ON site_settings FOR EACH ROW EXECUTE FUNCTION guard_human_role();

CREATE FUNCTION supersede_fm_reviews() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.facility_manager_actor_id IS DISTINCT FROM OLD.facility_manager_actor_id THEN
  UPDATE cbm.approval_requests SET status='SUPERSEDED',reason='Facility manager changed'
  WHERE status='PENDING' AND requested_from_actor_id<>NEW.facility_manager_actor_id;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER fm_changed AFTER UPDATE ON site_settings FOR EACH ROW EXECUTE FUNCTION supersede_fm_reviews();

CREATE FUNCTION guard_ticket() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM cbm.require_human(NEW.responsible_fm_actor_id);
 IF TG_OP='INSERT' THEN
  IF NEW.status NOT IN ('RECEIVED','NEEDS_TRIAGE','LOCALIZED') THEN RAISE EXCEPTION 'Ticket must begin at intake'; END IF;
 ELSE
  IF OLD.status IN ('CLOSED','CANCELLED') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Terminal tickets are immutable'; END IF;
  IF EXISTS(SELECT 1 FROM cbm.dispatch_cases WHERE ticket_id=OLD.id) AND
    ROW(NEW.asset_id,NEW.severity,NEW.required_skill_id,NEW.selected_localization_id,NEW.adopted_triage_assessment_id)
    IS DISTINCT FROM ROW(OLD.asset_id,OLD.severity,OLD.required_skill_id,OLD.selected_localization_id,OLD.adopted_triage_assessment_id)
  THEN RAISE EXCEPTION 'Dispatch evidence and policy fields are frozen after initialization'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
   (OLD.status='RECEIVED' AND NEW.status IN ('NEEDS_TRIAGE','LOCALIZED','CANCELLED')) OR
   (OLD.status='NEEDS_TRIAGE' AND NEW.status IN ('LOCALIZED','CANCELLED')) OR
   (OLD.status='LOCALIZED' AND NEW.status IN ('DISPATCHING','ASSIGNED','ESCALATED','CANCELLED')) OR
   (OLD.status='DISPATCHING' AND NEW.status IN ('ASSIGNED','ESCALATED','CANCELLED')) OR
   (OLD.status='ESCALATED' AND NEW.status IN ('ASSIGNED','CANCELLED')) OR
   (OLD.status='ASSIGNED' AND NEW.status IN ('WORK_DONE','PENDING_APPROVAL','CANCELLED')) OR
   (OLD.status='WORK_DONE' AND NEW.status IN ('PENDING_APPROVAL','REWORK','CANCELLED')) OR
   (OLD.status='PENDING_APPROVAL' AND NEW.status IN ('REWORK','CLOSED','CANCELLED')) OR
   (OLD.status='REWORK' AND NEW.status IN ('ASSIGNED','WORK_DONE','PENDING_APPROVAL','CANCELLED'))
  ) THEN RAISE EXCEPTION 'Invalid ticket transition % -> %',OLD.status,NEW.status; END IF;
  NEW.updated_at:=clock_timestamp(); NEW.revision:=OLD.revision+1;
 END IF;
 IF NEW.status IN ('LOCALIZED','DISPATCHING','ASSIGNED','WORK_DONE','PENDING_APPROVAL','REWORK','ESCALATED','CLOSED')
 AND (NEW.asset_id IS NULL OR NEW.severity IS NULL OR NEW.required_skill_id IS NULL OR NEW.selected_localization_id IS NULL OR NEW.adopted_triage_assessment_id IS NULL)
 THEN RAISE EXCEPTION 'Resolved asset, localization and triage are required'; END IF;
 IF NEW.status='CLOSED' AND NOT EXISTS(
  SELECT 1 FROM cbm.approval_requests p JOIN cbm.completion_submissions c ON c.id=p.completion_id
  JOIN cbm.assignments a ON a.id=c.assignment_id WHERE a.ticket_id=NEW.id AND p.status='APPROVED'
  AND NOT EXISTS(SELECT 1 FROM cbm.completion_submissions newer JOIN cbm.assignments na ON na.id=newer.assignment_id
    WHERE na.ticket_id=NEW.id AND newer.id>c.id)) THEN RAISE EXCEPTION 'Current completion requires explicit FM approval before closure'; END IF;
 IF NEW.status='CANCELLED' AND cbm.acting_actor()<>(SELECT facility_manager_actor_id FROM cbm.site_settings WHERE id=1)
 THEN RAISE EXCEPTION 'Only the FM may cancel a ticket'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ticket_guard BEFORE INSERT OR UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION guard_ticket();

-- Deferred checks permit report -> ticket -> adopted evidence in one transaction.
CREATE FUNCTION check_ticket_links() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t cbm.tickets; tid bigint; BEGIN
 IF TG_TABLE_NAME='tickets' THEN tid:=NEW.id; ELSE tid:=NEW.ticket_id; END IF;
 IF tid IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO t FROM cbm.tickets WHERE id=tid;
 IF NOT EXISTS(SELECT 1 FROM cbm.reports WHERE ticket_id=t.id AND attachment_kind='INITIAL') THEN RAISE EXCEPTION 'Ticket requires its initial report'; END IF;
 IF t.selected_localization_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM cbm.localization_attempts l JOIN cbm.reports r ON r.id=l.report_id
 WHERE l.id=t.selected_localization_id AND r.ticket_id=t.id AND l.asset_id=t.asset_id AND l.result='MATCHED')
 THEN RAISE EXCEPTION 'Selected localization does not match this ticket and asset'; END IF;
 IF t.adopted_triage_assessment_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM cbm.assessments a JOIN cbm.reports r ON r.id=a.report_id
 WHERE a.id=t.adopted_triage_assessment_id AND r.ticket_id=t.id AND a.purpose='TRIAGE' AND a.result_status='SUCCEEDED')
 THEN RAISE EXCEPTION 'Adopted triage does not belong to this ticket'; END IF;
 IF t.status IN ('ASSIGNED','WORK_DONE','PENDING_APPROVAL','REWORK') AND NOT EXISTS(SELECT 1 FROM cbm.assignments WHERE ticket_id=t.id AND status='ACTIVE')
 THEN RAISE EXCEPTION 'Assigned ticket requires one active assignment'; END IF;
 IF t.status IN ('CLOSED','CANCELLED') AND EXISTS(SELECT 1 FROM cbm.assignments WHERE ticket_id=t.id AND status='ACTIVE')
 THEN RAISE EXCEPTION 'Terminal ticket cannot retain an active assignment'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ticket_links AFTER INSERT OR UPDATE ON tickets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ticket_links();
CREATE CONSTRAINT TRIGGER report_links AFTER INSERT OR UPDATE ON reports DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ticket_links();
CREATE CONSTRAINT TRIGGER assignment_links AFTER INSERT OR UPDATE ON assignments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ticket_links();
CREATE FUNCTION guard_report() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.source_key,NEW.source_file_id,NEW.reporter_actor_id,NEW.asserted_reporter_email,NEW.received_at)
 IS DISTINCT FROM ROW(OLD.source_key,OLD.source_file_id,OLD.reporter_actor_id,OLD.asserted_reporter_email,OLD.received_at)
 THEN RAISE EXCEPTION 'Report provenance is immutable'; END IF;
 IF OLD.ticket_id IS NOT NULL AND ROW(NEW.ticket_id,NEW.attachment_kind) IS DISTINCT FROM ROW(OLD.ticket_id,OLD.attachment_kind)
 THEN RAISE EXCEPTION 'A linked report cannot be moved to another case'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER report_guard BEFORE UPDATE ON reports FOR EACH ROW EXECUTE FUNCTION guard_report();

CREATE FUNCTION guard_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tid bigint; original bigint; BEGIN
 IF TG_TABLE_NAME='localization_attempts' THEN
  SELECT source_file_id INTO original FROM cbm.reports WHERE id=NEW.report_id;
  IF NEW.input_file_id<>original AND NOT EXISTS(SELECT 1 FROM cbm.files WHERE id=NEW.input_file_id AND derived_from_file_id=original)
  THEN RAISE EXCEPTION 'Localization input must be the report photo or its normalized derivative'; END IF;
  IF NEW.registration_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cbm.map_registrations WHERE id=NEW.registration_id AND map_code=NEW.observed_map_code)
  THEN RAISE EXCEPTION 'Map registration mismatch'; END IF;
 ELSIF TG_TABLE_NAME='assessments' THEN
  IF NEW.purpose='TRIAGE' THEN
   SELECT source_file_id INTO original FROM cbm.reports WHERE id=NEW.report_id;
   IF NEW.before_file_id<>original AND NOT EXISTS(SELECT 1 FROM cbm.files WHERE id=NEW.before_file_id AND derived_from_file_id=original)
   THEN RAISE EXCEPTION 'Triage image does not belong to report'; END IF;
  ELSE
   SELECT a.ticket_id INTO tid FROM cbm.completion_submissions c JOIN cbm.assignments a ON a.id=c.assignment_id WHERE c.id=NEW.completion_id;
   IF NOT EXISTS(SELECT 1 FROM cbm.completion_files WHERE completion_id=NEW.completion_id AND file_id=NEW.after_file_id)
   THEN RAISE EXCEPTION 'After image is not evidence for this completion'; END IF;
   IF NOT EXISTS(SELECT 1 FROM cbm.reports r WHERE r.ticket_id=tid AND (r.source_file_id=NEW.before_file_id OR EXISTS(
    SELECT 1 FROM cbm.files f WHERE f.id=NEW.before_file_id AND f.derived_from_file_id=r.source_file_id)))
   THEN RAISE EXCEPTION 'Before image is not evidence for this ticket'; END IF;
  END IF;
  IF (SELECT kind FROM cbm.actors WHERE id=NEW.assessor_actor_id)='AGENT' AND (NEW.model IS NULL OR NEW.prompt_version IS NULL)
  THEN RAISE EXCEPTION 'AI assessments require model and prompt version'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER localization_evidence BEFORE INSERT ON localization_attempts FOR EACH ROW EXECUTE FUNCTION guard_evidence();
CREATE TRIGGER assessment_evidence BEFORE INSERT ON assessments FOR EACH ROW EXECUTE FUNCTION guard_evidence();

CREATE FUNCTION guard_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t cbm.tickets; BEGIN
 PERFORM cbm.lock_ticket(NEW.ticket_id); SELECT * INTO t FROM cbm.tickets WHERE id=NEW.ticket_id;
 IF TG_OP='INSERT' THEN
  IF t.status<>'LOCALIZED' OR t.severity<>NEW.severity_snapshot THEN RAISE EXCEPTION 'Only a resolved ticket can initialize dispatch'; END IF;
 ELSE
  IF ROW(NEW.ticket_id,NEW.policy_version,NEW.severity_snapshot,NEW.max_active_offers,NEW.offer_timeout_hours,NEW.urgent_start,NEW.urgent_end,NEW.timezone)
  IS DISTINCT FROM ROW(OLD.ticket_id,OLD.policy_version,OLD.severity_snapshot,OLD.max_active_offers,OLD.offer_timeout_hours,OLD.urgent_start,OLD.urgent_end,OLD.timezone)
  THEN RAISE EXCEPTION 'Dispatch policy and appointment are immutable'; END IF;
  IF OLD.halted AND NOT NEW.halted THEN
   IF cbm.acting_actor()<>(SELECT facility_manager_actor_id FROM cbm.site_settings WHERE id=1) THEN RAISE EXCEPTION 'Only FM can resume a halted dispatch'; END IF;
   IF EXISTS(SELECT 1 FROM cbm.messages m JOIN cbm.message_attempts a ON a.message_id=m.id WHERE m.ticket_id=NEW.ticket_id
    AND ((a.result='UNCERTAIN' AND a.reconciled_at IS NULL) OR a.result='CLAIMED')) THEN RAISE EXCEPTION 'Resolve delivery claims before resuming'; END IF;
  END IF;
  NEW.revision:=OLD.revision+1; NEW.updated_at:=clock_timestamp();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dispatch_guard BEFORE INSERT OR UPDATE ON dispatch_cases FOR EACH ROW EXECUTE FUNCTION guard_dispatch();
CREATE FUNCTION guard_candidate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t cbm.tickets; BEGIN
 SELECT tt.* INTO t FROM cbm.dispatch_cases d JOIN cbm.tickets tt ON tt.id=d.ticket_id WHERE d.id=NEW.dispatch_id;
 PERFORM cbm.lock_ticket(t.id);
 IF EXISTS(SELECT 1 FROM cbm.offers WHERE dispatch_id=NEW.dispatch_id) THEN RAISE EXCEPTION 'Shortlist is frozen after the first offer'; END IF;
 IF NEW.required_skill_id<>t.required_skill_id OR NOT cbm.technician_eligible(NEW.technician_actor_id,t.required_skill_id)
 THEN RAISE EXCEPTION 'Candidate is not eligible for ticket skill'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER candidate_guard BEFORE INSERT ON dispatch_candidates FOR EACH ROW EXECUTE FUNCTION guard_candidate();

CREATE FUNCTION guard_offer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d cbm.dispatch_cases; t cbm.tickets; candidate cbm.dispatch_candidates; BEGIN
 SELECT * INTO d FROM cbm.dispatch_cases WHERE id=NEW.dispatch_id;
 PERFORM cbm.lock_ticket(d.ticket_id); SELECT * INTO d FROM cbm.dispatch_cases WHERE id=NEW.dispatch_id FOR UPDATE;
 SELECT * INTO t FROM cbm.tickets WHERE id=d.ticket_id;
 SELECT * INTO candidate FROM cbm.dispatch_candidates WHERE id=NEW.candidate_id;
 IF NEW.capacity_slot>d.max_active_offers THEN RAISE EXCEPTION 'Offer exceeds ticket capacity'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'RESERVED' OR NEW.sent_at IS NOT NULL OR d.halted OR t.status NOT IN ('LOCALIZED','DISPATCHING')
  THEN RAISE EXCEPTION 'Dispatch is not open for a new reservation'; END IF;
  IF EXISTS(SELECT 1 FROM cbm.offer_responses WHERE dispatch_id=d.id AND processing_state='PENDING')
  OR EXISTS(SELECT 1 FROM cbm.offers WHERE dispatch_id=d.id AND state IN ('RESERVED','SENDING','LIVE','UNCERTAIN') AND expires_at<=clock_timestamp())
  THEN RAISE EXCEPTION 'Process responses and expiry before reserving another offer'; END IF;
  IF NOT EXISTS(SELECT 1 FROM cbm.messages WHERE ticket_id=t.id AND purpose='FM_OPENING' AND status='ACKNOWLEDGED')
  THEN RAISE EXCEPTION 'FM opening must have a confirmed send acknowledgement'; END IF;
  IF NOT cbm.technician_eligible(candidate.technician_actor_id,t.required_skill_id) THEN RAISE EXCEPTION 'Technician is no longer eligible'; END IF;
  IF EXISTS(SELECT 1 FROM cbm.dispatch_candidates c WHERE c.dispatch_id=d.id AND c.rank<candidate.rank
    AND NOT EXISTS(SELECT 1 FROM cbm.offers o WHERE o.candidate_id=c.id) AND cbm.technician_eligible(c.technician_actor_id,t.required_skill_id))
  THEN RAISE EXCEPTION 'Offer must go to the next ranked eligible candidate'; END IF;
  IF NEW.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Offer deadline has already passed'; END IF;
 ELSE
  IF ROW(NEW.public_reference,NEW.candidate_id,NEW.dispatch_id,NEW.capacity_slot,NEW.reserved_at,NEW.appointment_start,NEW.appointment_end,NEW.token_digest)
  IS DISTINCT FROM ROW(OLD.public_reference,OLD.candidate_id,OLD.dispatch_id,OLD.capacity_slot,OLD.reserved_at,OLD.appointment_start,OLD.appointment_end,OLD.token_digest)
  THEN RAISE EXCEPTION 'Offer identity, recipient and appointment are immutable'; END IF;
  IF OLD.state IN ('ACCEPTED','DECLINED','EXPIRED','WITHDRAWN','INELIGIBLE') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Terminal offer is immutable'; END IF;
  IF OLD.sent_at IS NOT NULL AND ROW(NEW.sent_at,NEW.expires_at,NEW.token_expires_at) IS DISTINCT FROM ROW(OLD.sent_at,OLD.expires_at,OLD.token_expires_at)
  THEN RAISE EXCEPTION 'Acknowledged deadlines cannot be extended'; END IF;
  IF NEW.state<>OLD.state AND NOT (
   (OLD.state='RESERVED' AND NEW.state IN ('SENDING','EXPIRED','WITHDRAWN')) OR
   (OLD.state='SENDING' AND NEW.state IN ('LIVE','UNCERTAIN','ACCEPTED','DECLINED','EXPIRED','WITHDRAWN','INELIGIBLE')) OR
   (OLD.state='LIVE' AND NEW.state IN ('ACCEPTED','DECLINED','EXPIRED','WITHDRAWN','INELIGIBLE')) OR
   (OLD.state='UNCERTAIN' AND NEW.state IN ('LIVE','ACCEPTED','DECLINED','EXPIRED','WITHDRAWN','INELIGIBLE'))
  ) THEN RAISE EXCEPTION 'Invalid offer transition'; END IF;
  IF NEW.state='ACCEPTED' AND NOT EXISTS(SELECT 1 FROM cbm.offer_responses r JOIN cbm.assignments a ON a.winning_response_id=r.id WHERE r.offer_id=NEW.id)
  THEN RAISE EXCEPTION 'Accepted offer requires its winning assignment'; END IF;
  IF NEW.state='EXPIRED' AND NEW.expires_at>clock_timestamp() THEN RAISE EXCEPTION 'Offer cannot expire before its deadline'; END IF;
  IF NEW.state='DECLINED' AND NOT EXISTS(SELECT 1 FROM cbm.offer_responses WHERE offer_id=NEW.id AND decision='DECLINE') THEN RAISE EXCEPTION 'Decline requires its persisted response'; END IF;
  IF NEW.state='INELIGIBLE' AND cbm.technician_eligible(candidate.technician_actor_id,t.required_skill_id) THEN RAISE EXCEPTION 'Candidate is still eligible'; END IF;
  IF NEW.state='WITHDRAWN' AND NOT EXISTS(SELECT 1 FROM cbm.assignments WHERE ticket_id=t.id AND status='ACTIVE')
    AND cbm.acting_actor() IS DISTINCT FROM (SELECT facility_manager_actor_id FROM cbm.site_settings WHERE id=1)
  THEN RAISE EXCEPTION 'Unassigned offer withdrawal requires FM'; END IF;
 END IF;
 IF d.severity_snapshot>=4 AND (ROW(NEW.appointment_start,NEW.appointment_end) IS DISTINCT FROM ROW(d.urgent_start,d.urgent_end) OR NEW.expires_at>d.urgent_start)
 THEN RAISE EXCEPTION 'Urgent appointment is fixed and bounds response expiry'; END IF;
 IF NEW.sent_at IS NOT NULL AND NEW.expires_at<>least(NEW.sent_at+interval '48 hours',coalesce(d.urgent_start,'infinity'::timestamptz))
 THEN RAISE EXCEPTION 'Invalid 48-hour offer deadline'; END IF;
 IF NEW.sent_at IS NULL AND NEW.expires_at<>least(NEW.reserved_at+interval '48 hours',coalesce(d.urgent_start,'infinity'::timestamptz))
 THEN RAISE EXCEPTION 'Invalid provisional response deadline'; END IF;
 IF NEW.state='LIVE' AND NOT EXISTS(SELECT 1 FROM cbm.messages m JOIN cbm.message_attempts a ON a.message_id=m.id WHERE m.offer_id=NEW.id AND m.purpose='TECHNICIAN_OFFER' AND a.result='ACKNOWLEDGED')
 THEN RAISE EXCEPTION 'Live offer requires its provider acknowledgement'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER offer_guard BEFORE INSERT OR UPDATE ON offers FOR EACH ROW EXECUTE FUNCTION guard_offer();

CREATE FUNCTION guard_response() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o cbm.offers; d cbm.dispatch_cases; BEGIN
 SELECT * INTO d FROM cbm.dispatch_cases WHERE id=NEW.dispatch_id;
 PERFORM cbm.lock_ticket(d.ticket_id);
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['processing_state','processing_result','processed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['processing_state','processing_result','processed_at'])
  OR OLD.processing_state<>'PENDING' THEN RAISE EXCEPTION 'Response identity and processed decisions are immutable'; END IF;
  SELECT * INTO o FROM cbm.offers WHERE id=NEW.offer_id;
  IF NEW.processing_state='APPLIED' AND ((NEW.decision='ACCEPT' AND NOT EXISTS(SELECT 1 FROM cbm.assignments WHERE winning_response_id=NEW.id))
    OR (NEW.decision='DECLINE' AND o.state<>'DECLINED')) THEN RAISE EXCEPTION 'Applied response requires its committed outcome'; END IF;
  IF NEW.processing_state='SUPERSEDED' AND NOT EXISTS(SELECT 1 FROM cbm.assignments WHERE ticket_id=d.ticket_id AND status='ACTIVE')
  THEN RAISE EXCEPTION 'Response cannot be superseded without an assignment'; END IF;
  IF NEW.processing_state='INELIGIBLE' AND o.state<>'INELIGIBLE' THEN RAISE EXCEPTION 'Response requires a recorded eligibility failure'; END IF;
 ELSE
  SELECT * INTO o FROM cbm.offers WHERE id=NEW.offer_id;
  NEW.received_at:=clock_timestamp();
  IF o.dispatch_id IS DISTINCT FROM NEW.dispatch_id OR o.state NOT IN ('SENDING','LIVE','UNCERTAIN') OR o.expires_at<=NEW.received_at
  OR o.token_revoked_at IS NOT NULL OR (SELECT status FROM cbm.tickets WHERE id=d.ticket_id)<>'DISPATCHING'
  THEN RAISE EXCEPTION 'Offer is invalid, expired or no longer open'; END IF;
  IF NEW.processing_state<>'PENDING' THEN RAISE EXCEPTION 'Response must begin pending'; END IF;
  UPDATE cbm.dispatch_cases SET next_receipt_order=next_receipt_order+1 WHERE id=d.id RETURNING next_receipt_order-1 INTO NEW.receipt_order;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER response_guard BEFORE INSERT OR UPDATE ON offer_responses FOR EACH ROW EXECUTE FUNCTION guard_response();

CREATE FUNCTION guard_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t cbm.tickets; r cbm.offer_responses; o cbm.offers; d cbm.dispatch_cases; BEGIN
 PERFORM cbm.lock_ticket(NEW.ticket_id); SELECT * INTO t FROM cbm.tickets WHERE id=NEW.ticket_id;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['status','ended_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','ended_at']) OR OLD.status<>'ACTIVE'
  THEN RAISE EXCEPTION 'Assignment history is immutable'; END IF;
  IF NEW.status='COMPLETED' AND t.status<>'CLOSED' THEN RAISE EXCEPTION 'Complete assignment only after approved closure'; END IF;
  IF NEW.status IN ('REASSIGNED','CANCELLED') AND cbm.acting_actor() IS DISTINCT FROM (SELECT facility_manager_actor_id FROM cbm.site_settings WHERE id=1)
  THEN RAISE EXCEPTION 'Only FM may end or reassign an active assignment'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.status<>'ACTIVE' OR t.status NOT IN ('LOCALIZED','DISPATCHING','ESCALATED','REWORK','ASSIGNED') THEN RAISE EXCEPTION 'Ticket cannot be assigned'; END IF;
 IF NEW.assigned_by_actor_id IS DISTINCT FROM cbm.acting_actor() THEN RAISE EXCEPTION 'Assignment actor does not match transaction actor'; END IF;
 IF NOT cbm.technician_eligible(NEW.technician_actor_id,t.required_skill_id) THEN RAISE EXCEPTION 'Assignee is not currently eligible'; END IF;
 IF NEW.origin='MANUAL' THEN
  IF NEW.assigned_by_actor_id<>cbm.acting_actor() OR NEW.assigned_by_actor_id<>(SELECT facility_manager_actor_id FROM cbm.site_settings WHERE id=1)
  THEN RAISE EXCEPTION 'Manual assignment requires current FM'; END IF;
 ELSE
  SELECT * INTO r FROM cbm.offer_responses WHERE id=NEW.winning_response_id;
  SELECT * INTO o FROM cbm.offers WHERE id=r.offer_id;
  SELECT * INTO d FROM cbm.dispatch_cases WHERE id=o.dispatch_id;
  IF r.decision IS DISTINCT FROM 'ACCEPT' OR r.processing_state IS DISTINCT FROM 'PENDING' OR d.ticket_id IS DISTINCT FROM NEW.ticket_id
   OR NEW.technician_actor_id IS DISTINCT FROM (SELECT technician_actor_id FROM cbm.dispatch_candidates WHERE id=o.candidate_id)
   OR o.state NOT IN ('SENDING','LIVE','UNCERTAIN') OR r.received_at>=o.expires_at
   OR ROW(NEW.appointment_start,NEW.appointment_end) IS DISTINCT FROM ROW(o.appointment_start,o.appointment_end)
  THEN RAISE EXCEPTION 'Assignment does not match a valid acceptance'; END IF;
  IF EXISTS(SELECT 1 FROM cbm.offer_responses earlier WHERE earlier.dispatch_id=d.id AND earlier.processing_state='PENDING' AND earlier.receipt_order<r.receipt_order)
  THEN RAISE EXCEPTION 'Earlier responses must be processed first'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assignment_guard BEFORE INSERT OR UPDATE ON assignments FOR EACH ROW EXECUTE FUNCTION guard_assignment();
CREATE FUNCTION assignment_effects() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE cbm.tickets SET status='ASSIGNED' WHERE id=NEW.ticket_id;
 UPDATE cbm.dispatch_cases SET state='ASSIGNED',next_recovery_at=NULL WHERE ticket_id=NEW.ticket_id;
 IF NEW.winning_response_id IS NOT NULL THEN
  UPDATE cbm.offers SET state='ACCEPTED',terminal_at=clock_timestamp(),terminal_reason='Winning persisted acceptance',token_revoked_at=clock_timestamp()
  WHERE id=(SELECT offer_id FROM cbm.offer_responses WHERE id=NEW.winning_response_id);
  UPDATE cbm.offer_responses SET processing_state='APPLIED',processed_at=clock_timestamp(),processing_result='ASSIGNED' WHERE id=NEW.winning_response_id;
 END IF;
 UPDATE cbm.offers SET state='WITHDRAWN',terminal_at=clock_timestamp(),terminal_reason='Ticket assigned',token_revoked_at=clock_timestamp()
 WHERE dispatch_id IN (SELECT id FROM cbm.dispatch_cases WHERE ticket_id=NEW.ticket_id) AND state IN ('RESERVED','SENDING','LIVE','UNCERTAIN');
 UPDATE cbm.offer_responses SET processing_state='SUPERSEDED',processed_at=clock_timestamp(),processing_result='Another assignment won'
 WHERE dispatch_id IN (SELECT id FROM cbm.dispatch_cases WHERE ticket_id=NEW.ticket_id) AND processing_state='PENDING';
 RETURN NULL;
END $$;
CREATE TRIGGER assignment_committed AFTER INSERT ON assignments FOR EACH ROW EXECUTE FUNCTION assignment_effects();

CREATE FUNCTION guard_completion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a cbm.assignments; prior cbm.completion_submissions; BEGIN
 SELECT * INTO a FROM cbm.assignments WHERE id=CASE WHEN TG_OP='UPDATE' THEN OLD.assignment_id ELSE NEW.assignment_id END; PERFORM cbm.lock_ticket(a.ticket_id);
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') OR OLD.status IN ('APPROVED','REJECTED','SUPERSEDED')
  THEN RAISE EXCEPTION 'Completion evidence is immutable; submit a new attempt'; END IF;
 ELSE
  IF a.status<>'ACTIVE' OR (SELECT status FROM cbm.tickets WHERE id=a.ticket_id) NOT IN ('ASSIGNED','WORK_DONE','PENDING_APPROVAL','REWORK')
  THEN RAISE EXCEPTION 'Completion requires an active assignment'; END IF;
  IF NEW.submitted_by_actor_id IS NOT NULL AND NEW.submitted_by_actor_id<>a.technician_actor_id THEN RAISE EXCEPTION 'Verified submitter must be assigned technician'; END IF;
  IF NEW.status<>'SUBMITTED' THEN RAISE EXCEPTION 'Completion must begin submitted'; END IF;
  SELECT * INTO prior FROM cbm.completion_submissions WHERE assignment_id=a.id ORDER BY submission_number DESC LIMIT 1;
  IF NEW.submission_number<>coalesce(prior.submission_number,0)+1 OR NEW.supersedes_completion_id IS DISTINCT FROM prior.id
  THEN RAISE EXCEPTION 'Submission must continue the current repair history'; END IF;
  UPDATE cbm.approval_requests SET status='SUPERSEDED',reason='New completion evidence submitted' WHERE completion_id=prior.id AND status='PENDING';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER completion_guard BEFORE INSERT OR UPDATE ON completion_submissions FOR EACH ROW EXECUTE FUNCTION guard_completion();
CREATE FUNCTION guard_completion_file() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM cbm.assessments WHERE completion_id=NEW.completion_id) OR EXISTS(SELECT 1 FROM cbm.approval_requests WHERE completion_id=NEW.completion_id)
 THEN RAISE EXCEPTION 'Evidence has already been assessed; submit a new completion'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER completion_file_guard BEFORE INSERT ON completion_files FOR EACH ROW EXECUTE FUNCTION guard_completion_file();

CREATE FUNCTION guard_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c cbm.completion_submissions; a cbm.assignments; fm bigint; BEGIN
 SELECT * INTO c FROM cbm.completion_submissions WHERE id=NEW.completion_id;
 SELECT * INTO a FROM cbm.assignments WHERE id=c.assignment_id;
 PERFORM cbm.lock_ticket(a.ticket_id);
 SELECT facility_manager_actor_id INTO fm FROM cbm.site_settings WHERE id=1 FOR SHARE;
 IF TG_OP='UPDATE' THEN
  IF OLD.status<>'PENDING' THEN RAISE EXCEPTION 'Terminal approval decision is immutable'; END IF;
  IF (to_jsonb(NEW)-ARRAY['status','decided_by_actor_id','decided_at','reason','sent_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['status','decided_by_actor_id','decided_at','reason','sent_at']) THEN RAISE EXCEPTION 'Approval subject and deadline are immutable'; END IF;
  IF OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at THEN RAISE EXCEPTION 'Approval send time is immutable'; END IF;
  IF NEW.status='EXPIRED' AND NEW.expires_at>clock_timestamp() THEN RAISE EXCEPTION 'Review is not due for expiry'; END IF;
 ELSE
  IF NEW.status<>'PENDING' THEN RAISE EXCEPTION 'Approval must begin pending'; END IF;
 END IF;
 IF NEW.status IN ('PENDING','APPROVED','REJECTED') THEN
  IF fm IS NULL OR NEW.requested_from_actor_id<>fm OR a.status<>'ACTIVE' THEN RAISE EXCEPTION 'Review requires current FM and active assignment'; END IF;
  IF TG_OP='INSERT' AND c.status IN ('APPROVED','REJECTED','SUPERSEDED') THEN RAISE EXCEPTION 'Reviewed evidence requires a new completion submission'; END IF;
  IF EXISTS(SELECT 1 FROM cbm.completion_submissions n JOIN cbm.assignments na ON na.id=n.assignment_id WHERE na.ticket_id=a.ticket_id AND n.id>c.id)
  THEN RAISE EXCEPTION 'Review does not concern the latest submission'; END IF;
  IF NOT EXISTS(SELECT 1 FROM cbm.completion_files WHERE completion_id=c.id) THEN RAISE EXCEPTION 'Completion requires evidence'; END IF;
 END IF;
 IF NEW.verification_assessment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cbm.assessments WHERE id=NEW.verification_assessment_id AND completion_id=c.id AND purpose='REPAIR_VERIFICATION')
 THEN RAISE EXCEPTION 'Verification belongs to another completion'; END IF;
 IF NEW.status IN ('APPROVED','REJECTED') THEN
  IF NEW.expires_at<=clock_timestamp() OR NEW.decided_by_actor_id IS DISTINCT FROM fm OR cbm.acting_actor()<>fm THEN RAISE EXCEPTION 'Review expired or decision not made by current FM'; END IF;
  NEW.decided_at:=clock_timestamp();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER approval_guard BEFORE INSERT OR UPDATE ON approval_requests FOR EACH ROW EXECUTE FUNCTION guard_approval();

CREATE FUNCTION guard_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tid bigint; recipient bigint; BEGIN
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['status','next_attempt_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','next_attempt_at'])
  THEN RAISE EXCEPTION 'Logical message content and recipient are immutable'; END IF;
  IF OLD.status IN ('ACKNOWLEDGED','CANCELLED') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Terminal message cannot be reset for another send'; END IF;
  IF NEW.status='PENDING' AND OLD.status<>'PENDING' THEN RAISE EXCEPTION 'A used message cannot be reset to pending'; END IF;
 END IF;
 IF NEW.offer_id IS NOT NULL THEN
  SELECT d.ticket_id,c.technician_actor_id INTO tid,recipient FROM cbm.offers o JOIN cbm.dispatch_cases d ON d.id=o.dispatch_id JOIN cbm.dispatch_candidates c ON c.id=o.candidate_id WHERE o.id=NEW.offer_id;
  IF NEW.ticket_id IS DISTINCT FROM tid THEN RAISE EXCEPTION 'Message offer belongs to another ticket'; END IF;
  IF NEW.purpose='TECHNICIAN_OFFER' AND (NEW.recipient_actor_id IS DISTINCT FROM recipient OR lower(NEW.recipient_address) IS DISTINCT FROM (SELECT lower(email) FROM cbm.actors WHERE id=recipient))
  THEN RAISE EXCEPTION 'Offer recipient does not match candidate'; END IF;
 END IF;
 IF NEW.approval_request_id IS NOT NULL THEN
  SELECT a.ticket_id,p.requested_from_actor_id INTO tid,recipient FROM cbm.approval_requests p JOIN cbm.completion_submissions c ON c.id=p.completion_id JOIN cbm.assignments a ON a.id=c.assignment_id WHERE p.id=NEW.approval_request_id;
  IF NEW.ticket_id IS DISTINCT FROM tid OR NEW.recipient_actor_id IS DISTINCT FROM recipient THEN RAISE EXCEPTION 'Approval message context mismatch'; END IF;
 END IF;
 IF NEW.report_id IS NOT NULL AND NEW.ticket_id IS NOT NULL AND NEW.ticket_id IS DISTINCT FROM (SELECT ticket_id FROM cbm.reports WHERE id=NEW.report_id)
 THEN RAISE EXCEPTION 'Message report belongs to another ticket'; END IF;
 IF NEW.purpose='FM_OPENING' AND (NEW.recipient_actor_id IS DISTINCT FROM (SELECT responsible_fm_actor_id FROM cbm.tickets WHERE id=NEW.ticket_id)
 OR lower(NEW.recipient_address) IS DISTINCT FROM (SELECT lower(email) FROM cbm.actors WHERE id=NEW.recipient_actor_id)) THEN RAISE EXCEPTION 'Opening must target the responsible FM'; END IF;
 IF NEW.purpose='TECHNICIAN_OFFER' AND NEW.offer_id IS NULL THEN RAISE EXCEPTION 'Invitation requires an offer'; END IF;
 IF NEW.purpose='APPROVAL_REQUEST' AND NEW.approval_request_id IS NULL THEN RAISE EXCEPTION 'Review message requires an approval request'; END IF;
 IF TG_OP='INSERT' AND NEW.status<>'PENDING' THEN RAISE EXCEPTION 'Message must begin pending'; END IF;
 IF NEW.status='ACKNOWLEDGED' AND NOT EXISTS(SELECT 1 FROM cbm.message_attempts WHERE message_id=NEW.id AND result='ACKNOWLEDGED')
 THEN RAISE EXCEPTION 'Message acknowledgement requires provider evidence'; END IF;
 IF NEW.status='CLAIMED' AND NOT EXISTS(SELECT 1 FROM cbm.message_attempts WHERE message_id=NEW.id AND result='CLAIMED') THEN RAISE EXCEPTION 'Message requires a recorded claim'; END IF;
 IF NEW.status='UNCERTAIN' AND NOT EXISTS(SELECT 1 FROM cbm.message_attempts WHERE message_id=NEW.id AND result='UNCERTAIN' AND reconciled_at IS NULL) THEN RAISE EXCEPTION 'Message requires an uncertain attempt'; END IF;
 IF NEW.status='FAILED' AND NOT EXISTS(SELECT 1 FROM cbm.message_attempts WHERE message_id=NEW.id AND (result='FAILED' OR (result='UNCERTAIN' AND reconciliation_result='NOT_SENT' AND reconciled_at IS NOT NULL))) THEN RAISE EXCEPTION 'Message requires a failed or reconciled attempt'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER message_guard BEFORE INSERT OR UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION guard_message();

CREATE FUNCTION guard_message_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m cbm.messages; BEGIN
 SELECT * INTO m FROM cbm.messages WHERE id=NEW.message_id;
 IF m.ticket_id IS NOT NULL THEN PERFORM cbm.lock_ticket(m.ticket_id); END IF;
 SELECT * INTO m FROM cbm.messages WHERE id=NEW.message_id FOR UPDATE;
 IF TG_OP='INSERT' THEN
  IF NEW.result<>'CLAIMED' OR m.status NOT IN ('PENDING','FAILED') THEN RAISE EXCEPTION 'Message cannot be claimed for send'; END IF;
  IF NEW.attempt_number<>(SELECT count(*)+1 FROM cbm.message_attempts WHERE message_id=m.id) THEN RAISE EXCEPTION 'Invalid delivery attempt number'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['sent_at','finished_at','provider_message_id','result','error_detail','reconciled_by_actor_id','reconciled_at','reconciliation_result']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['sent_at','finished_at','provider_message_id','result','error_detail','reconciled_by_actor_id','reconciled_at','reconciliation_result'])
  OR OLD.result IN ('ACKNOWLEDGED','FAILED') OR OLD.reconciled_at IS NOT NULL THEN RAISE EXCEPTION 'Delivery history is immutable'; END IF;
  IF OLD.result='UNCERTAIN' AND NEW.reconciled_at IS NULL AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Uncertain delivery requires reconciliation'; END IF;
  IF NEW.reconciled_at IS NOT NULL AND (NEW.reconciled_by_actor_id IS DISTINCT FROM cbm.acting_actor() OR
   NEW.reconciled_by_actor_id IS DISTINCT FROM (SELECT facility_manager_actor_id FROM cbm.site_settings WHERE id=1))
  THEN RAISE EXCEPTION 'Reconciliation requires the FM'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER message_attempt_guard BEFORE INSERT OR UPDATE ON message_attempts FOR EACH ROW EXECUTE FUNCTION guard_message_attempt();
CREATE FUNCTION message_attempt_effects() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tid bigint; BEGIN
 UPDATE cbm.messages SET status=CASE WHEN NEW.result='CLAIMED' THEN 'CLAIMED' WHEN NEW.result='UNCERTAIN' AND NEW.reconciliation_result='NOT_SENT' THEN 'FAILED' ELSE NEW.result END WHERE id=NEW.message_id RETURNING ticket_id INTO tid;
 IF NEW.result='UNCERTAIN' AND NEW.reconciled_at IS NULL THEN
  UPDATE cbm.dispatch_cases SET halted=true,halt_reason='Uncertain email delivery',next_recovery_at=NULL WHERE ticket_id=tid;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER message_attempt_committed AFTER INSERT OR UPDATE ON message_attempts FOR EACH ROW EXECUTE FUNCTION message_attempt_effects();

CREATE FUNCTION guard_ifc_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM cbm.approval_requests p JOIN cbm.completion_submissions c ON c.id=p.completion_id JOIN cbm.assignments a ON a.id=c.assignment_id
 JOIN cbm.tickets t ON t.id=a.ticket_id WHERE p.id=NEW.approval_request_id AND p.status='APPROVED' AND t.asset_id=NEW.asset_id)
 THEN RAISE EXCEPTION 'IFC job requires approval for the same asset'; END IF;
 IF TG_OP='INSERT' AND NEW.status<>'PENDING' THEN RAISE EXCEPTION 'IFC job must begin pending'; END IF;
 IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-ARRAY['status','result_bim_version_id','next_retry_at','completed_at']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['status','result_bim_version_id','next_retry_at','completed_at']) OR OLD.status='SUCCEEDED')
 THEN RAISE EXCEPTION 'IFC job identity and completed results are immutable'; END IF;
 IF NEW.status='SUCCEEDED' AND NOT EXISTS(SELECT 1 FROM cbm.ifc_sync_attempts WHERE job_id=NEW.id AND outcome='SUCCEEDED' AND output_bim_version_id=NEW.result_bim_version_id)
 THEN RAISE EXCEPTION 'IFC success requires successful versioned attempt'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ifc_job_guard BEFORE INSERT OR UPDATE ON ifc_sync_jobs FOR EACH ROW EXECUTE FUNCTION guard_ifc_job();
CREATE FUNCTION guard_ifc_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(132849,1);
 IF TG_OP='INSERT' THEN
  IF NEW.outcome<>'IN_PROGRESS' OR NOT EXISTS(SELECT 1 FROM cbm.bim_versions WHERE id=NEW.input_bim_version_id AND is_current)
  OR (SELECT status FROM cbm.ifc_sync_jobs WHERE id=NEW.job_id) NOT IN ('PENDING','FAILED') THEN RAISE EXCEPTION 'IFC attempt requires current version and ready job'; END IF;
  IF NEW.attempt_number<>(SELECT count(*)+1 FROM cbm.ifc_sync_attempts WHERE job_id=NEW.job_id) THEN RAISE EXCEPTION 'Invalid IFC attempt number'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['output_bim_version_id','finished_at','outcome','error_detail','reconciled_at','reconciled_by_actor_id']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['output_bim_version_id','finished_at','outcome','error_detail','reconciled_at','reconciled_by_actor_id']) OR OLD.outcome IN ('SUCCEEDED','FAILED') OR OLD.reconciled_at IS NOT NULL
  THEN RAISE EXCEPTION 'IFC attempt history is immutable'; END IF;
  IF OLD.outcome='UNCERTAIN' AND NEW.reconciled_at IS NULL THEN RAISE EXCEPTION 'Reconcile uncertain IFC write before continuing'; END IF;
  IF NEW.reconciled_at IS NOT NULL AND (NEW.reconciled_by_actor_id IS DISTINCT FROM cbm.acting_actor() OR NEW.reconciled_by_actor_id IS DISTINCT FROM (SELECT facility_manager_actor_id FROM cbm.site_settings WHERE id=1))
  THEN RAISE EXCEPTION 'IFC reconciliation requires FM'; END IF;
 END IF;
 IF NEW.outcome='SUCCEEDED' AND NOT EXISTS(SELECT 1 FROM cbm.bim_versions WHERE id=NEW.output_bim_version_id AND parent_version_id=NEW.input_bim_version_id)
 THEN RAISE EXCEPTION 'IFC output must be a successor of the input version'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ifc_attempt_guard BEFORE INSERT OR UPDATE ON ifc_sync_attempts FOR EACH ROW EXECUTE FUNCTION guard_ifc_attempt();
CREATE FUNCTION guard_bim_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(132849,1);
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['is_current','published_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['is_current','published_at'])
 THEN RAISE EXCEPTION 'IFC version provenance is immutable'; END IF;
 IF NEW.is_current AND (TG_OP='INSERT' OR NOT OLD.is_current) AND EXISTS(SELECT 1 FROM cbm.bim_versions WHERE published_at IS NOT NULL AND id<>NEW.id)
 AND NOT EXISTS(SELECT 1 FROM cbm.ifc_sync_attempts WHERE output_bim_version_id=NEW.id AND outcome='SUCCEEDED')
 THEN RAISE EXCEPTION 'Publish model successors only after a successful IFC job'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bim_guard BEFORE INSERT OR UPDATE ON bim_versions FOR EACH ROW EXECUTE FUNCTION guard_bim_version();

-- Durable, redacted audit records are produced for every domain write.
CREATE FUNCTION audit_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j jsonb:=to_jsonb(NEW); before_j jsonb; changed jsonb; changes jsonb; tid bigint; BEGIN
 IF TG_OP='UPDATE' THEN before_j:=to_jsonb(OLD); END IF;
 SELECT coalesce(jsonb_agg(k ORDER BY k),'[]'::jsonb) INTO changed FROM jsonb_object_keys(j) k WHERE before_j IS NULL OR j->k IS DISTINCT FROM before_j->k;
 SELECT coalesce(jsonb_object_agg(k,jsonb_build_object('before',before_j->k,'after',j->k)),'{}'::jsonb) INTO changes
 FROM jsonb_object_keys(j) k WHERE (before_j IS NULL OR j->k IS DISTINCT FROM before_j->k)
 AND k NOT IN ('token_digest','body','rendering_payload','raw_result','metadata','error_detail','provider_wait_reference','asserted_uploader_identity')
 AND jsonb_typeof(j->k) IN ('string','number','boolean','null');
 tid:=nullif(j->>'ticket_id','')::bigint;
 IF TG_TABLE_NAME='tickets' THEN tid:=NEW.id; END IF;
 IF tid IS NULL AND j ? 'dispatch_id' THEN SELECT ticket_id INTO tid FROM cbm.dispatch_cases WHERE id=(j->>'dispatch_id')::bigint; END IF;
 IF tid IS NULL AND j ? 'assignment_id' THEN SELECT ticket_id INTO tid FROM cbm.assignments WHERE id=(j->>'assignment_id')::bigint; END IF;
 IF tid IS NULL AND j ? 'completion_id' THEN SELECT a.ticket_id INTO tid FROM cbm.completion_submissions c JOIN cbm.assignments a ON a.id=c.assignment_id WHERE c.id=(j->>'completion_id')::bigint; END IF;
 IF tid IS NULL AND j ? 'message_id' THEN SELECT ticket_id INTO tid FROM cbm.messages WHERE id=(j->>'message_id')::bigint; END IF;
 IF tid IS NULL AND TG_TABLE_NAME IN ('ifc_sync_jobs','ifc_sync_attempts') THEN
  SELECT a.ticket_id INTO tid FROM cbm.ifc_sync_jobs job JOIN cbm.approval_requests p ON p.id=job.approval_request_id
  JOIN cbm.completion_submissions c ON c.id=p.completion_id JOIN cbm.assignments a ON a.id=c.assignment_id
  WHERE job.id=CASE WHEN TG_TABLE_NAME='ifc_sync_jobs' THEN (j->>'id')::bigint ELSE (j->>'job_id')::bigint END;
 END IF;
 INSERT INTO cbm.audit_events(event_type,actor_id,workflow_run_id,ticket_id,entity_table,entity_key,previous_state,new_state,details,affected_actor_id)
 VALUES(upper(TG_TABLE_NAME)||CASE WHEN TG_OP='INSERT' THEN '_CREATED' ELSE '_UPDATED' END,cbm.acting_actor(),
 nullif(current_setting('cbm.workflow_run_id',true),'')::bigint,tid,TG_TABLE_NAME,coalesce(j->>'id',j->>'actor_id',(j->>'technician_actor_id')||':'||(j->>'skill_id'),(j->>'completion_id')||':'||(j->>'file_id')),
 coalesce(before_j->>'status',before_j->>'state',before_j->>'result'),coalesce(j->>'status',j->>'state',j->>'result'),
 jsonb_build_object('changed_fields',changed,'changes',changes),CASE WHEN TG_TABLE_NAME='actors' THEN (j->>'id')::bigint ELSE NULL END);
 RETURN NULL;
END $$;
DO $$ DECLARE t text; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='cbm' LOOP
  EXECUTE format('CREATE TRIGGER retain_rows BEFORE DELETE ON cbm.%I FOR EACH ROW EXECUTE FUNCTION cbm.retain_history()',t);
  EXECUTE format('CREATE TRIGGER retain_table BEFORE TRUNCATE ON cbm.%I FOR EACH STATEMENT EXECUTE FUNCTION cbm.retain_history()',t);
  IF t<>'audit_events' THEN EXECUTE format('CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE ON cbm.%I FOR EACH ROW EXECUTE FUNCTION cbm.audit_write()',t); END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['files','map_registrations','localization_attempts','assessments','dispatch_candidates','completion_files','audit_events'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE ON cbm.%I FOR EACH ROW EXECUTE FUNCTION cbm.freeze_record()',t);
 END LOOP;
END $$;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA cbm FROM PUBLIC;
