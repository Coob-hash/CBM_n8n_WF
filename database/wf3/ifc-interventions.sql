WITH refs AS (
  SELECT value AS asset FROM jsonb_array_elements($1::jsonb)
)
SELECT coalesce(json_agg(x ORDER BY ticket_id),'[]'::json) AS interventions FROM (
 SELECT t.id AS ticket_id,t.ifc_global_id,t.status,t.closed_at,
   tech.full_name AS technician_name,
   (e.payload->>'approval_id'=t.approval_id::text) AS matches_current_approval,
   s.report->>'work_performed' AS work_performed,s.report->>'findings' AS findings,
   s.report->>'checks' AS checks,s.report->>'work_date' AS work_date,
   s.report->>'materials' AS materials,s.report->>'remaining_issues' AS remaining_issues,
   s.report->>'outcome' AS technician_outcome,s.drive_file_id AS report_file_id,
   CASE WHEN s.id IS NULL AND e.payload->>'approval_id'=t.approval_id::text
     THEN t.report_text END AS report_text
 FROM refs r JOIN tickets t ON t.id::text=r.asset->>'last_ticket_id'
   AND t.ifc_global_id=r.asset->>'global_id'
 LEFT JOIN technicians tech ON tech.id=t.technician_id
 LEFT JOIN LATERAL (SELECT payload,created_at FROM ticket_events
   WHERE ticket_id=t.id AND event='CBM_WF2_IFC_RESULT' AND payload->>'outcome'='SUCCEEDED'
     AND payload->>'operation_key'=r.asset->'history'->0->>'operation_key'
   ORDER BY id DESC LIMIT 1) e ON true
 LEFT JOIN LATERAL (SELECT id,report,drive_file_id FROM cbm_technician_submissions
   WHERE ticket_id=t.id AND status='SUBMITTED' AND drive_file_id=t.report_file_id
     AND submitted_at<=e.created_at AND e.payload->>'approval_id'=t.approval_id::text
   ORDER BY submitted_at DESC LIMIT 1) s ON true
) x;