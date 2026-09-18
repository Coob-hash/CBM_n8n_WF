# WF2 closure contract

## Approved completion

1. `log_ifc_maintenance` must record `SUCCEEDED`, with the returned version for the correct IFC GlobalId and current approval operation key. A prior matching success is returned without rewriting the model.
2. `close_ticket` checks the current FM approval and that successful receipt against `tickets.ifc_new_version`. Failure, missing element, skip, stale approval or mismatched version leaves the ticket open. A database trigger also prevents a direct transition to CLOSED without this proof.
3. `update_technician_stats` records the existing idempotent completion receipt.
4. `notify_technician` and `notify_fm` use the existing notification helper. It reads committed state, claims the notice for this approval and recipient, sends via Gmail, and records the actual message ID. An agent-written diagnostic cannot stand in for that receipt.
5. `Verify Closure Outcome` requires CLOSED, the current approved decision, matching IFC success/version, the statistics receipt, and both required email receipts. Only then does `Closure Settled?` return true.

## Rejected completion

REWORK and a successful technician rework-notice receipt for the current approval are required. There is no IFC update or FM closure email on this path.

## Incomplete or uncertain results

- IFC failure: retain PENDING_APPROVAL; do not send a closure email.
- Email failure or missing message ID: the ticket may already be CLOSED, but the workflow remains unsettled. Do not undo the completed maintenance work merely because sending mail failed.
- A send claim without a receipt is UNCONFIRMED. Inspect the Gmail execution and Sent mail before deciding whether to record a recovered receipt or authorize a retry. There is no automatic claim expiry or blind resend.
- The false branch first appends `CBM_WF2_INCOMPLETE` with missing objectives and the approval/execution IDs, then attempts an FM attention email. The database evidence remains even if this alert email fails too.

`SENT` means Gmail accepted the message and returned its ID. It does not prove inbox delivery or that the recipient read it.

## Installation and validation

Apply `cbm/app/schema_wf2_strict_closure.sql` after `schema_release_review.sql`. It adds functions, indexes and a closure trigger; it does not rewrite historical tickets. Docker initialization includes it for new databases. Existing databases require the migration once; it is safe to reapply.

Save WF2 plus its two existing helpers. `apply-strict-closure.cjs` preserves the policy when running workflow preparation, compatibility adaptation or the WF2 builder.

`node cbm/app/wf2/test-strict-closure.cjs` executes the actual exported SQL on PostgreSQL (PGlite) and tests failure, stale evidence, repeated calls, missing receipts, successful approval and rejection. No real emails or IFC writes are required for these tests.
