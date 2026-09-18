-- WF3 facility-manager dashboard: an exact status-change stream
-- ============================================================================
-- Additive migration for the LEGACY contract in schema.sql, layered on top of
-- schema_wf2_completion.sql. Like that file it is deliberately NOT placed in
-- database/migrations/, which migrate.py reserves for the 27-table `cbm` schema.
--
-- Why this exists
-- ---------------
-- The weekly report has to state which tickets CHANGED STATUS during the week.
-- The legacy tickets table keeps only the current status and an updated_at
-- stamp, so "changed status" could otherwise only be guessed: updated_at also
-- moves when a report is stored, a photograph is attached or a reject reason is
-- written. Guessing would put wrong rows in front of the facility manager.
--
-- Instead the change is recorded where it happens, by a trigger, into the
-- existing append-only ticket_events table. WF1 and WF2 need no modification
-- and cannot forget to log: any UPDATE that moves tickets.status is captured,
-- including one typed by hand in psql.
--
-- Apply with:
--     psql -v ON_ERROR_STOP=1 -d cbm -f schema_wf3_dashboard.sql
--
-- Idempotent: the function is replaced, the trigger dropped and recreated, and
-- every index is IF NOT EXISTS. No rows are written or rewritten. History before
-- the migration has no change events, so the first report covers only the period
-- since it was applied; the ticket counts and the overdue list are exact from
-- the first run because they read the tickets table directly.
-- ============================================================================

BEGIN;

-- --- Dependency check ---------------------------------------------------------
-- The dashboard reports closure times and technician throughput, both added by
-- the WF2 migration. Fail here with an instruction rather than later with a
-- missing-column error inside a workflow run.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'tickets'
                    AND column_name = 'closed_at') THEN
    RAISE EXCEPTION 'Apply schema_wf2_completion.sql first: tickets.closed_at is missing';
  END IF;
END $$;

-- --- The status-change stream -------------------------------------------------
-- One CBM_STATUS_CHANGED event per actual transition. IS DISTINCT FROM rather
-- than <> so a transition into or out of NULL is also recorded, and so an UPDATE
-- that rewrites the same status writes nothing.
CREATE OR REPLACE FUNCTION cbm_log_status_change() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO ticket_events (ticket_id, event, payload)
    VALUES (NEW.id, 'CBM_STATUS_CHANGED',
            jsonb_build_object('from', OLD.status,
                               'to', NEW.status,
                               'technician_id', NEW.technician_id));
  END IF;
  RETURN NULL;   -- AFTER trigger: the return value is ignored
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tickets_status_change ON tickets;
CREATE TRIGGER trg_tickets_status_change
  AFTER UPDATE OF status ON tickets
  FOR EACH ROW EXECUTE FUNCTION cbm_log_status_change();

-- --- Freshness ----------------------------------------------------------------
-- The dashboard reports "no change for N days" from tickets.updated_at, so a
-- status change has to move it. WF1 and WF2 already set updated_at themselves,
-- but a status written by any other route - a correction typed in psql, a future
-- workflow - would otherwise leave the ticket looking untouched while its status
-- moved, and the weekly report would name the wrong tickets as stalled.
CREATE OR REPLACE FUNCTION cbm_touch_updated_at() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tickets_status_touch ON tickets;
CREATE TRIGGER trg_tickets_status_touch
  BEFORE UPDATE OF status ON tickets
  FOR EACH ROW EXECUTE FUNCTION cbm_touch_updated_at();

-- --- Indexes for the dashboard queries ----------------------------------------
-- The weekly report reads one week of change events; the chat agent filters and
-- sorts the full history by age and by status.
CREATE INDEX IF NOT EXISTS idx_ticket_events_status_change
  ON ticket_events (created_at, ticket_id)
  WHERE event = 'CBM_STATUS_CHANGED';

CREATE INDEX IF NOT EXISTS idx_tickets_open_age
  ON tickets (created_at)
  WHERE status NOT IN ('CLOSED', 'DUPLICATE');

CREATE INDEX IF NOT EXISTS idx_tickets_status_created
  ON tickets (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tickets_closed_at
  ON tickets (closed_at)
  WHERE closed_at IS NOT NULL;

-- The dashboard's own audit rows (CBM_WF3_QUERY, CBM_WF3_REPORT) carry no
-- ticket, so they are indexed by event alone.
CREATE INDEX IF NOT EXISTS idx_ticket_events_wf3
  ON ticket_events (event, created_at)
  WHERE event IN ('CBM_WF3_QUERY', 'CBM_WF3_REPORT');

COMMIT;
