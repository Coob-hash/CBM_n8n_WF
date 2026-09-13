-- WF2 completion contract: technician report mandatory, photo optional
-- ============================================================================
-- Additive migration for the LEGACY contract in schema.sql, which is what WF1
-- and WF2 currently query. It is deliberately NOT placed in database/migrations/:
-- migrate.py reserves that directory for the 27-table `cbm` schema and applies
-- every NNN_name.sql it finds there.
--
-- Idempotent and additive. Every column is nullable or defaulted, so rows created
-- before the completion-report change keep working and nothing needs backfilling.
--
-- Apply with:
--     psql -v ON_ERROR_STOP=1 -d cbm -f schema_wf2_completion.sql
--
-- Column names are chosen to mirror the forthcoming `cbm` schema so the later
-- migration is a rename rather than a redesign:
--     tickets.report_text      -> cbm.completion_submissions.notes
--     tickets.report_file_id   -> cbm.completion_files (evidence_role 'OTHER')
--     tickets.after_file_id    -> cbm.completion_files (evidence_role 'AFTER')
--     tickets.verification     -> cbm.assessments.raw_result
--     tickets.closed_at        -> cbm.tickets.closed_at
-- ============================================================================

BEGIN;

-- --- The technician's completion report --------------------------------------
-- The report is now mandatory and the photograph optional, so the report text is
-- the evidence of record and must be stored rather than merely emailed.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS report_text      TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS report_file_id   TEXT;

-- --- Completion evidence and verdict ------------------------------------------
-- Referenced by WF2 today but absent from schema.sql: the workflow was writing to
-- columns that do not exist, so `Set Pending Approval` failed against a clean
-- database.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS after_file_id    TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS verification     JSONB;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_at        TIMESTAMPTZ;

-- Technician throughput, incremented at closure.
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS jobs_completed INT NOT NULL DEFAULT 0;

-- --- Guards -------------------------------------------------------------------
-- A closed ticket must carry its closure time, and vice versa. Matches the CHECK
-- the cbm schema already enforces on cbm.tickets.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_closed_at_consistent') THEN
    ALTER TABLE tickets ADD CONSTRAINT tickets_closed_at_consistent
      CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL)) NOT VALID;
  END IF;
END $$;

-- The verification verdict is an object when present, never a bare scalar.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_verification_object') THEN
    ALTER TABLE tickets ADD CONSTRAINT tickets_verification_object
      CHECK (verification IS NULL OR jsonb_typeof(verification) = 'object') NOT VALID;
  END IF;
END $$;

-- Closure and notice bookkeeping for the WF2 supervisor agent lives in the
-- existing append-only ticket_events table (events CBM_WF2_ATTEMPT and
-- CBM_WF2_NOTICE), so no new table is introduced. This index keeps the agent's
-- idempotency lookups cheap.
CREATE INDEX IF NOT EXISTS idx_ticket_events_wf2
  ON ticket_events (ticket_id, event)
  WHERE event IN ('CBM_WF2_ATTEMPT', 'CBM_WF2_NOTICE');

COMMIT;
