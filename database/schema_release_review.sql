-- Apply after schema_wf2_completion.sql and schema_wf3_dashboard.sql.
-- Production contract remains public.tickets / technicians / ticket_events.
BEGIN;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS approval_id uuid;
UPDATE tickets SET closed_at=coalesce(updated_at,created_at,clock_timestamp())
 WHERE status='CLOSED' AND closed_at IS NULL;
UPDATE tickets SET closed_at=NULL WHERE status<>'CLOSED' AND closed_at IS NOT NULL;
ALTER TABLE tickets VALIDATE CONSTRAINT tickets_closed_at_consistent;

-- Fail without changing records if historical duplicates need FM reconciliation.
-- No ticket is silently closed, merged or deleted by this migration.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM tickets WHERE ifc_global_id IS NOT NULL
 AND status NOT IN ('CLOSED','DUPLICATE') GROUP BY ifc_global_id HAVING count(*)>1) THEN
 RAISE EXCEPTION 'Multiple open tickets share an IFC element. Reconcile them before applying schema_release_review.sql.';
 END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_open_element
 ON tickets(ifc_global_id) WHERE status NOT IN ('CLOSED','DUPLICATE');
CREATE UNIQUE INDEX IF NOT EXISTS uq_wf2_stats_receipt
 ON ticket_events(ticket_id) WHERE event='CBM_WF2_STATS';
CREATE UNIQUE INDEX IF NOT EXISTS uq_wf2_fm_notice_claim
 ON ticket_events(ticket_id,(payload->>'approval_id')) WHERE event='CBM_WF2_FM_NOTICE_CLAIM';
CREATE UNIQUE INDEX IF NOT EXISTS uq_wf2_approval_decision
 ON ticket_events(ticket_id,(payload->>'approval_id')) WHERE event='CBM_WF2_APPROVAL';
COMMIT;
