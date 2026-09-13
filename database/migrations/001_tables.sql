-- PostgreSQL 14+. Apply through database/migrate.py in a transaction.
-- Deliberately separate from the legacy public tables used by existing exports.
CREATE SCHEMA cbm;
REVOKE ALL ON SCHEMA cbm FROM PUBLIC;
SET LOCAL search_path = cbm, pg_catalog;

CREATE TABLE actors (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 kind text NOT NULL CHECK (kind IN ('HUMAN','AGENT','SERVICE')),
 name text NOT NULL CHECK (btrim(name) <> ''),
 email text CHECK (email IS NULL OR (email = btrim(email) AND position('@' IN email)>1)),
 external_identity text UNIQUE,
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX actors_email_unique ON actors(lower(email)) WHERE email IS NOT NULL;
-- Bootstrap identity for database setup and explicitly unattributed system work.
INSERT INTO actors(kind,name,external_identity) VALUES ('SERVICE','CBM database','cbm.database');

CREATE TABLE site_settings (
 id smallint PRIMARY KEY DEFAULT 1 CHECK (id=1),
 building_code text NOT NULL CHECK (btrim(building_code)<>''),
 building_name text NOT NULL CHECK (btrim(building_name)<>''),
 timezone text NOT NULL DEFAULT 'Europe/Rome' CHECK (timezone='Europe/Rome'),
 facility_manager_actor_id bigint NOT NULL REFERENCES actors,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE technician_profiles (
 actor_id bigint PRIMARY KEY REFERENCES actors,
 dispatch_enabled boolean NOT NULL DEFAULT true,
 profile_text text,
 rating numeric(3,2) NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
 rating_source text NOT NULL DEFAULT 'UNRATED',
 rating_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE skills (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z_]*$'),
 label text NOT NULL, active boolean NOT NULL DEFAULT true
);
INSERT INTO skills(code,label) VALUES ('carpentry','Carpentry'),('plumbing','Plumbing'),
 ('electrical','Electrical'),('hvac','HVAC'),('general','General maintenance');
CREATE TABLE technician_skills (
 technician_actor_id bigint NOT NULL REFERENCES technician_profiles(actor_id),
 skill_id bigint NOT NULL REFERENCES skills,
 valid_from timestamptz NOT NULL DEFAULT clock_timestamp(), valid_until timestamptz,
 PRIMARY KEY (technician_actor_id,skill_id),
 CHECK (valid_until IS NULL OR valid_until>valid_from)
);

CREATE TABLE files (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 provider text NOT NULL, object_id text NOT NULL, revision_key text NOT NULL,
 uri text NOT NULL, mime_type text NOT NULL,
 checksum_sha256 text CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
 captured_at timestamptz, uploaded_at timestamptz,
 uploader_actor_id bigint REFERENCES actors,
 derived_from_file_id bigint REFERENCES files,
 width integer CHECK (width>0), height integer CHECK (height>0),
 metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (provider,object_id,revision_key), CHECK (derived_from_file_id IS DISTINCT FROM id)
);
CREATE TABLE bim_versions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 version_label text NOT NULL UNIQUE, file_id bigint NOT NULL UNIQUE REFERENCES files,
 parent_version_id bigint REFERENCES bim_versions,
 is_current boolean NOT NULL DEFAULT false,
 created_by_actor_id bigint REFERENCES actors,
 published_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (parent_version_id IS DISTINCT FROM id), CHECK (NOT is_current OR published_at IS NOT NULL)
);
CREATE UNIQUE INDEX bim_one_current ON bim_versions ((true)) WHERE is_current;
CREATE TABLE assets (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 ifc_global_id text NOT NULL UNIQUE CHECK (btrim(ifc_global_id)<>''),
 ifc_class text NOT NULL, name text, storey text, active boolean NOT NULL DEFAULT true,
 first_seen_version_id bigint NOT NULL REFERENCES bim_versions,
 last_seen_version_id bigint NOT NULL REFERENCES bim_versions,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION valid_transform(m double precision[]) RETURNS boolean
 LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT array_ndims(m)=2 AND array_lower(m,1)=1 AND array_lower(m,2)=1
 AND array_length(m,1)=4 AND array_length(m,2)=4
 AND NOT EXISTS (SELECT 1 FROM unnest(m) x WHERE x IS NULL OR x IN ('NaN'::float8,'Infinity'::float8,'-Infinity'::float8))
 AND m[4][1]=0 AND m[4][2]=0 AND m[4][3]=0 AND m[4][4]=1
 AND abs(m[1][1]*(m[2][2]*m[3][3]-m[2][3]*m[3][2])
       -m[1][2]*(m[2][1]*m[3][3]-m[2][3]*m[3][1])
       +m[1][3]*(m[2][1]*m[3][2]-m[2][2]*m[3][1]))>1e-12
 $$;
CREATE TABLE map_registrations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 map_code text NOT NULL, registration_revision integer NOT NULL CHECK (registration_revision>0),
 reference_bim_version_id bigint NOT NULL REFERENCES bim_versions,
 axis_convention text NOT NULL, units text NOT NULL DEFAULT 'metres' CHECK (units='metres'),
 transform double precision[] NOT NULL CHECK (valid_transform(transform) IS TRUE),
 valid_from timestamptz NOT NULL DEFAULT clock_timestamp(), valid_until timestamptz,
 calibrated_by_actor_id bigint REFERENCES actors,
 UNIQUE (map_code,registration_revision), CHECK (valid_until IS NULL OR valid_until>valid_from)
);

CREATE TABLE tickets (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 status text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','NEEDS_TRIAGE','LOCALIZED','DISPATCHING',
 'ASSIGNED','WORK_DONE','PENDING_APPROVAL','REWORK','ESCALATED','CLOSED','CANCELLED')),
 asset_id bigint REFERENCES assets,
 selected_localization_id bigint, adopted_triage_assessment_id bigint,
 category text, severity smallint CHECK (severity BETWEEN 1 AND 5), description text,
 required_skill_id bigint REFERENCES skills,
 responsible_fm_actor_id bigint NOT NULL REFERENCES actors,
 opened_at timestamptz NOT NULL DEFAULT clock_timestamp(), closed_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
 CHECK ((status IN ('CLOSED','CANCELLED'))=(closed_at IS NOT NULL)),
 CHECK (closed_at IS NULL OR closed_at>=opened_at)
);
CREATE UNIQUE INDEX tickets_one_open_asset ON tickets(asset_id) WHERE status NOT IN ('CLOSED','CANCELLED');
CREATE TABLE reports (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 source_key text NOT NULL UNIQUE CHECK (btrim(source_key)<>''),
 source_file_id bigint NOT NULL REFERENCES files,
 reporter_actor_id bigint REFERENCES actors, asserted_reporter_email text,
 description text, received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 status text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','PROCESSING','LINKED','FAILED','MANUAL_TRIAGE')),
 ticket_id bigint REFERENCES tickets,
 attachment_kind text CHECK (attachment_kind IN ('INITIAL','ADDITIONAL_DUPLICATE')),
 CHECK ((ticket_id IS NULL)=(attachment_kind IS NULL))
);
CREATE UNIQUE INDEX reports_one_initial ON reports(ticket_id) WHERE attachment_kind='INITIAL';
CREATE INDEX reports_ticket ON reports(ticket_id);
CREATE TABLE workflow_runs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 n8n_instance text NOT NULL, workflow_id text NOT NULL, workflow_version text NOT NULL,
 execution_id text NOT NULL, parent_run_id bigint REFERENCES workflow_runs,
 ticket_id bigint REFERENCES tickets, report_id bigint REFERENCES reports,
 executor_actor_id bigint NOT NULL REFERENCES actors,
 trigger_kind text NOT NULL, correlation_key text NOT NULL,
 model text, prompt_version text,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(), ended_at timestamptz,
 outcome text NOT NULL DEFAULT 'RUNNING' CHECK (outcome IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED')),
 error_summary text,
 UNIQUE(n8n_instance,execution_id), CHECK (parent_run_id IS DISTINCT FROM id),
 CHECK ((outcome='RUNNING')=(ended_at IS NULL)), CHECK (ended_at IS NULL OR ended_at>=started_at)
);
CREATE TABLE localization_attempts (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 report_id bigint NOT NULL REFERENCES reports, input_file_id bigint NOT NULL REFERENCES files,
 registration_id bigint REFERENCES map_registrations, observed_map_code text,
 bim_version_id bigint REFERENCES bim_versions, asset_id bigint REFERENCES assets,
 map_x double precision, map_y double precision, map_z double precision,
 ifc_x double precision, ifc_y double precision, ifc_z double precision,
 confidence double precision CHECK (confidence>=0 AND confidence<=1),
 match_distance double precision CHECK (match_distance>=0 AND match_distance<'Infinity'::float8),
 element_snapshot jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(element_snapshot)='object'),
 provider_request_id text, result text NOT NULL CHECK (result IN ('MATCHED','LOW_CONFIDENCE','NO_MATCH','FAILED')),
 error_detail text, workflow_run_id bigint REFERENCES workflow_runs,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (result<>'MATCHED' OR (asset_id IS NOT NULL AND bim_version_id IS NOT NULL AND registration_id IS NOT NULL
 AND map_x IS NOT NULL AND map_y IS NOT NULL AND map_z IS NOT NULL AND ifc_x IS NOT NULL AND ifc_y IS NOT NULL AND ifc_z IS NOT NULL AND confidence IS NOT NULL)),
 CHECK (map_x IS NULL OR abs(map_x)<'Infinity'::float8), CHECK (map_y IS NULL OR abs(map_y)<'Infinity'::float8),
 CHECK (map_z IS NULL OR abs(map_z)<'Infinity'::float8), CHECK (ifc_x IS NULL OR abs(ifc_x)<'Infinity'::float8),
 CHECK (ifc_y IS NULL OR abs(ifc_y)<'Infinity'::float8), CHECK (ifc_z IS NULL OR abs(ifc_z)<'Infinity'::float8)
);

CREATE TABLE dispatch_cases (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 ticket_id bigint NOT NULL UNIQUE REFERENCES tickets,
 state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','WAITING','ASSIGNED','ESCALATED','CANCELLED')),
 policy_version text NOT NULL DEFAULT 'cbm-1', severity_snapshot smallint NOT NULL CHECK (severity_snapshot BETWEEN 1 AND 5),
 max_active_offers smallint NOT NULL, offer_timeout_hours smallint NOT NULL DEFAULT 48 CHECK (offer_timeout_hours=48),
 urgent_start timestamptz, urgent_end timestamptz,
 timezone text NOT NULL DEFAULT 'Europe/Rome' CHECK (timezone='Europe/Rome'),
 next_recovery_at timestamptz, failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count>=0),
 halted boolean NOT NULL DEFAULT false, halt_reason text,
 next_receipt_order bigint NOT NULL DEFAULT 1 CHECK (next_receipt_order>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
 CHECK (max_active_offers=CASE WHEN severity_snapshot>=4 THEN 2 ELSE 1 END),
 CHECK ((severity_snapshot>=4)=(urgent_start IS NOT NULL)),
 CHECK ((urgent_start IS NULL)=(urgent_end IS NULL)), CHECK (urgent_end>urgent_start),
 CHECK (NOT halted OR nullif(btrim(halt_reason),'') IS NOT NULL)
);
CREATE TABLE dispatch_candidates (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 dispatch_id bigint NOT NULL REFERENCES dispatch_cases,
 technician_actor_id bigint NOT NULL REFERENCES technician_profiles(actor_id),
 rank smallint NOT NULL CHECK (rank BETWEEN 1 AND 5),
 selected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 open_jobs_snapshot integer NOT NULL CHECK (open_jobs_snapshot>=0), last_assigned_snapshot timestamptz,
 rating_snapshot numeric(3,2) NOT NULL CHECK (rating_snapshot BETWEEN 0 AND 5),
 required_skill_id bigint NOT NULL REFERENCES skills,
 UNIQUE (dispatch_id,technician_actor_id), UNIQUE (dispatch_id,rank), UNIQUE(id,dispatch_id)
);
CREATE TABLE offers (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 public_reference uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 candidate_id bigint NOT NULL UNIQUE, dispatch_id bigint NOT NULL REFERENCES dispatch_cases,
 capacity_slot smallint NOT NULL CHECK (capacity_slot IN (1,2)),
 state text NOT NULL DEFAULT 'RESERVED' CHECK (state IN ('RESERVED','SENDING','LIVE','UNCERTAIN','ACCEPTED','DECLINED','EXPIRED','WITHDRAWN','INELIGIBLE')),
 reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(), sent_at timestamptz, expires_at timestamptz NOT NULL,
 appointment_start timestamptz NOT NULL, appointment_end timestamptz NOT NULL,
 token_digest text NOT NULL CHECK (token_digest ~ '^[a-f0-9]{64}$'),
 token_expires_at timestamptz NOT NULL, token_revoked_at timestamptz,
 terminal_at timestamptz, terminal_reason text,
 FOREIGN KEY (candidate_id,dispatch_id) REFERENCES dispatch_candidates(id,dispatch_id),
 UNIQUE(id,dispatch_id), CHECK (appointment_end>appointment_start), CHECK (expires_at<=appointment_start),
 CHECK (token_expires_at=expires_at), CHECK (sent_at IS NULL OR sent_at>=reserved_at),
 CHECK ((state IN ('ACCEPTED','DECLINED','EXPIRED','WITHDRAWN','INELIGIBLE'))=(terminal_at IS NOT NULL)),
 CHECK (state<>'LIVE' OR sent_at IS NOT NULL)
);
CREATE UNIQUE INDEX offers_capacity ON offers(dispatch_id,capacity_slot) WHERE state IN ('RESERVED','SENDING','LIVE','UNCERTAIN');
CREATE INDEX offers_deadline ON offers(expires_at) WHERE state IN ('RESERVED','SENDING','LIVE','UNCERTAIN');
CREATE TABLE offer_responses (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 offer_id bigint NOT NULL UNIQUE, dispatch_id bigint NOT NULL REFERENCES dispatch_cases,
 decision text NOT NULL CHECK (decision IN ('ACCEPT','DECLINE')),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(), receipt_order bigint NOT NULL CHECK (receipt_order>0),
 channel text NOT NULL DEFAULT 'POST' CHECK (channel='POST'),
 verification_basis text NOT NULL CHECK (verification_basis IN ('TOKEN','AUTHENTICATED_USER')),
 processing_state text NOT NULL DEFAULT 'PENDING' CHECK (processing_state IN ('PENDING','APPLIED','SUPERSEDED','INELIGIBLE')),
 processing_result text, processed_at timestamptz, workflow_run_id bigint REFERENCES workflow_runs,
 FOREIGN KEY (offer_id,dispatch_id) REFERENCES offers(id,dispatch_id),
 UNIQUE(dispatch_id,receipt_order), CHECK ((processing_state='PENDING')=(processed_at IS NULL))
);
CREATE TABLE assignments (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 ticket_id bigint NOT NULL REFERENCES tickets, technician_actor_id bigint NOT NULL REFERENCES technician_profiles(actor_id),
 winning_response_id bigint UNIQUE REFERENCES offer_responses,
 origin text NOT NULL CHECK (origin IN ('OFFER_ACCEPTANCE','MANUAL')),
 assigned_by_actor_id bigint NOT NULL REFERENCES actors,
 assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(), ended_at timestamptz,
 status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','COMPLETED','REASSIGNED','CANCELLED')),
 appointment_start timestamptz NOT NULL, appointment_end timestamptz NOT NULL, manual_reason text,
 CHECK (appointment_end>appointment_start), CHECK ((status='ACTIVE')=(ended_at IS NULL)),
 CHECK (ended_at IS NULL OR ended_at>=assigned_at),
 CHECK ((origin='OFFER_ACCEPTANCE')=(winning_response_id IS NOT NULL)),
 CHECK (origin<>'MANUAL' OR nullif(btrim(manual_reason),'') IS NOT NULL)
);
CREATE UNIQUE INDEX assignments_one_active ON assignments(ticket_id) WHERE status='ACTIVE';
CREATE INDEX assignments_technician ON assignments(technician_actor_id,assigned_at DESC);
CREATE TABLE completion_submissions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 assignment_id bigint NOT NULL REFERENCES assignments,
 submission_number integer NOT NULL CHECK (submission_number>0), source_key text NOT NULL UNIQUE,
 submitted_by_actor_id bigint REFERENCES actors, asserted_uploader_identity text, notes text,
 submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 status text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','PENDING_APPROVAL','APPROVED','REJECTED','SUPERSEDED')),
 supersedes_completion_id bigint UNIQUE REFERENCES completion_submissions,
 UNIQUE(assignment_id,submission_number), CHECK (supersedes_completion_id IS DISTINCT FROM id)
);
CREATE TABLE completion_files (
 completion_id bigint NOT NULL REFERENCES completion_submissions, file_id bigint NOT NULL REFERENCES files,
 evidence_role text NOT NULL DEFAULT 'AFTER' CHECK (evidence_role IN ('AFTER','DETAIL','OTHER')),
 display_order integer NOT NULL DEFAULT 1 CHECK (display_order>0),
 PRIMARY KEY(completion_id,file_id), UNIQUE(completion_id,display_order)
);
CREATE TABLE assessments (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 purpose text NOT NULL CHECK (purpose IN ('TRIAGE','REPAIR_VERIFICATION')),
 result_status text NOT NULL CHECK (result_status IN ('SUCCEEDED','FAILED','PARSE_ERROR')),
 report_id bigint REFERENCES reports, completion_id bigint REFERENCES completion_submissions,
 before_file_id bigint NOT NULL REFERENCES files, after_file_id bigint REFERENCES files,
 assessor_actor_id bigint NOT NULL REFERENCES actors, provider text, model text, prompt_version text,
 category text, severity smallint CHECK (severity BETWEEN 1 AND 5), required_skill_id bigint REFERENCES skills,
 repair_verified boolean, confidence double precision CHECK (confidence>=0 AND confidence<=1), observations text,
 raw_result jsonb, workflow_run_id bigint REFERENCES workflow_runs,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((purpose='TRIAGE' AND report_id IS NOT NULL AND completion_id IS NULL AND after_file_id IS NULL AND repair_verified IS NULL)
 OR (purpose='REPAIR_VERIFICATION' AND completion_id IS NOT NULL AND report_id IS NULL AND after_file_id IS NOT NULL AND severity IS NULL AND required_skill_id IS NULL)),
 CHECK (result_status<>'SUCCEEDED' OR purpose<>'TRIAGE' OR (severity IS NOT NULL AND required_skill_id IS NOT NULL AND category IS NOT NULL)),
 CHECK (result_status<>'SUCCEEDED' OR purpose<>'REPAIR_VERIFICATION' OR (repair_verified IS NOT NULL AND confidence IS NOT NULL)),
 CHECK (result_status='SUCCEEDED' OR repair_verified IS NULL)
);
ALTER TABLE tickets ADD FOREIGN KEY(selected_localization_id) REFERENCES localization_attempts;
ALTER TABLE tickets ADD FOREIGN KEY(adopted_triage_assessment_id) REFERENCES assessments;
CREATE TABLE approval_requests (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 completion_id bigint NOT NULL REFERENCES completion_submissions,
 verification_assessment_id bigint REFERENCES assessments,
 requested_from_actor_id bigint NOT NULL REFERENCES actors, request_sequence integer NOT NULL CHECK (request_sequence>0),
 public_reference uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(), sent_at timestamptz, expires_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED','SUPERSEDED')),
 decided_by_actor_id bigint REFERENCES actors, decided_at timestamptz, reason text,
 token_digest text CHECK (token_digest ~ '^[a-f0-9]{64}$'), provider_wait_reference text,
 UNIQUE(completion_id,request_sequence), CHECK (expires_at>requested_at), CHECK (sent_at IS NULL OR sent_at>=requested_at),
 CHECK (token_digest IS NOT NULL OR provider_wait_reference IS NOT NULL),
 CHECK ((status IN ('APPROVED','REJECTED'))=(decided_at IS NOT NULL AND decided_by_actor_id IS NOT NULL)),
 CHECK (status IN ('APPROVED','REJECTED') OR (decided_at IS NULL AND decided_by_actor_id IS NULL)),
 CHECK (status<>'REJECTED' OR nullif(btrim(reason),'') IS NOT NULL)
);
CREATE UNIQUE INDEX approvals_one_pending ON approval_requests(completion_id) WHERE status='PENDING';
CREATE INDEX approvals_deadline ON approval_requests(expires_at) WHERE status='PENDING';

CREATE TABLE messages (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, idempotency_key text NOT NULL UNIQUE,
 ticket_id bigint REFERENCES tickets, report_id bigint REFERENCES reports, file_id bigint REFERENCES files,
 offer_id bigint REFERENCES offers, approval_request_id bigint REFERENCES approval_requests,
 recipient_actor_id bigint REFERENCES actors, recipient_address text NOT NULL CHECK (position('@' IN recipient_address)>1),
 channel text NOT NULL DEFAULT 'EMAIL' CHECK (channel='EMAIL'), purpose text NOT NULL,
 template_version text NOT NULL, subject text NOT NULL, body text, rendering_payload jsonb,
 status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CLAIMED','ACKNOWLEDGED','FAILED','UNCERTAIN','CANCELLED')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), next_attempt_at timestamptz,
 CHECK (body IS NOT NULL OR rendering_payload IS NOT NULL),
 CHECK (num_nonnulls(ticket_id,report_id,file_id)>0), CHECK (num_nonnulls(offer_id,approval_request_id)<=1)
);
CREATE UNIQUE INDEX messages_one_invitation ON messages(offer_id) WHERE purpose='TECHNICIAN_OFFER';
CREATE UNIQUE INDEX messages_one_review ON messages(approval_request_id) WHERE purpose='APPROVAL_REQUEST';
CREATE INDEX messages_due ON messages(next_attempt_at) WHERE status IN ('PENDING','FAILED');
CREATE TABLE message_attempts (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, message_id bigint NOT NULL REFERENCES messages,
 attempt_number integer NOT NULL CHECK (attempt_number>0), claim_reference uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(), sent_at timestamptz, finished_at timestamptz,
 provider text NOT NULL DEFAULT 'GMAIL', account_reference text NOT NULL, provider_message_id text,
 result text NOT NULL DEFAULT 'CLAIMED' CHECK (result IN ('CLAIMED','ACKNOWLEDGED','FAILED','UNCERTAIN')),
 error_detail text, reconciled_by_actor_id bigint REFERENCES actors, reconciled_at timestamptz, reconciliation_result text,
 workflow_run_id bigint REFERENCES workflow_runs, UNIQUE(message_id,attempt_number),
 CHECK (result<>'ACKNOWLEDGED' OR (provider_message_id IS NOT NULL AND sent_at IS NOT NULL)),
 CHECK ((result='CLAIMED')=(finished_at IS NULL)), CHECK (finished_at IS NULL OR finished_at>=claimed_at),
 CHECK ((reconciled_at IS NULL)=(reconciled_by_actor_id IS NULL)),
 CHECK (reconciled_at IS NULL OR reconciliation_result IN ('SENT','NOT_SENT'))
);
CREATE UNIQUE INDEX messages_one_claim ON message_attempts(message_id) WHERE result='CLAIMED' OR (result='UNCERTAIN' AND reconciled_at IS NULL);
CREATE UNIQUE INDEX messages_provider_receipt ON message_attempts(provider,account_reference,provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE TABLE ifc_sync_jobs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, approval_request_id bigint NOT NULL UNIQUE REFERENCES approval_requests,
 asset_id bigint NOT NULL REFERENCES assets, operation_key text NOT NULL UNIQUE,
 maintenance_payload jsonb NOT NULL CHECK (jsonb_typeof(maintenance_payload)='object'),
 status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','IN_PROGRESS','SUCCEEDED','FAILED','UNCERTAIN')),
 result_bim_version_id bigint REFERENCES bim_versions,
 next_retry_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
 CHECK ((status='SUCCEEDED')=(result_bim_version_id IS NOT NULL)), CHECK ((status='SUCCEEDED')=(completed_at IS NOT NULL))
);
CREATE TABLE ifc_sync_attempts (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, job_id bigint NOT NULL REFERENCES ifc_sync_jobs,
 attempt_number integer NOT NULL CHECK (attempt_number>0), input_bim_version_id bigint NOT NULL REFERENCES bim_versions,
 output_bim_version_id bigint REFERENCES bim_versions,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz, request_reference text,
 outcome text NOT NULL DEFAULT 'IN_PROGRESS' CHECK (outcome IN ('IN_PROGRESS','SUCCEEDED','FAILED','UNCERTAIN')),
 error_detail text, reconciled_at timestamptz, reconciled_by_actor_id bigint REFERENCES actors,
 workflow_run_id bigint REFERENCES workflow_runs, UNIQUE(job_id,attempt_number),
 CHECK ((outcome='IN_PROGRESS')=(finished_at IS NULL)), CHECK (finished_at IS NULL OR finished_at>=started_at),
 CHECK (outcome<>'SUCCEEDED' OR output_bim_version_id IS NOT NULL),
 CHECK ((reconciled_at IS NULL)=(reconciled_by_actor_id IS NULL))
);
CREATE UNIQUE INDEX ifc_one_writer ON ifc_sync_attempts((true)) WHERE outcome='IN_PROGRESS' OR (outcome='UNCERTAIN' AND reconciled_at IS NULL);
CREATE TABLE audit_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 event_type text NOT NULL, schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version>0),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), actor_id bigint NOT NULL REFERENCES actors,
 workflow_run_id bigint REFERENCES workflow_runs, ticket_id bigint REFERENCES tickets,
 report_id bigint REFERENCES reports, asset_id bigint REFERENCES assets, offer_id bigint REFERENCES offers,
 response_id bigint REFERENCES offer_responses, assignment_id bigint REFERENCES assignments,
 completion_id bigint REFERENCES completion_submissions, approval_id bigint REFERENCES approval_requests,
 message_id bigint REFERENCES messages, sync_job_id bigint REFERENCES ifc_sync_jobs, affected_actor_id bigint REFERENCES actors,
 entity_table text, entity_key text, correlation_key text,
 caused_by_event_id bigint REFERENCES audit_events,
 previous_state text, new_state text, details jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details)='object')
);
CREATE INDEX audit_ticket_timeline ON audit_events(ticket_id,id);
CREATE INDEX audit_workflow ON audit_events(workflow_run_id,id);
CREATE INDEX audit_entity ON audit_events(entity_table,entity_key,id);
CREATE INDEX dispatch_recovery ON dispatch_cases(next_recovery_at) WHERE NOT halted AND state IN ('OPEN','WAITING');
CREATE INDEX localizations_report ON localization_attempts(report_id,id);
CREATE INDEX assessments_report ON assessments(report_id,id);
CREATE INDEX assessments_completion ON assessments(completion_id,id);
CREATE INDEX submissions_assignment ON completion_submissions(assignment_id,submission_number DESC);
CREATE INDEX ifc_jobs_due ON ifc_sync_jobs(next_retry_at) WHERE status IN ('PENDING','FAILED');

-- Index remaining referencing columns for FK checks and normal joins.
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT c.conrelid::regclass AS tab, a.attname AS col
 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
 WHERE c.contype='f' AND c.connamespace='cbm'::regnamespace
 AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=c.conrelid AND i.indkey[0]=c.conkey[1] AND i.indpred IS NULL)
 LOOP EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %s (%I)',replace(r.tab::text,'cbm.','')||'_'||r.col||'_fk',r.tab,r.col); END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA cbm FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA cbm FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA cbm FROM PUBLIC;
