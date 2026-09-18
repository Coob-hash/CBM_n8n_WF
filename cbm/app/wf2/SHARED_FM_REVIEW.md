# WF2 completion review: email and FM chat

The former Gmail `sendAndWait` node could only resume from its own email callback. A decision made through WF3 changed the ticket but could not resume that execution.

The current sequence is:

`Set Pending Approval → Approval Cycle → Read FM Review State → FM Review State → Route FM Review`

- **NEEDS_EMAIL:** `Send FM Approval Request` invokes the existing `cbmWf3ApprovalMail` helper with source `WF2_REPORT`. The helper claims and sends a normal Gmail approval email and returns. Its existing signed confirmation page and guarded action executor process the FM's decision.
- **WAIT / PROCESSING:** `Wait for FM Decision` persists the execution for one minute, then reads PostgreSQL again. WF3 approval/rework uses the same `CBM_WF2_APPROVAL` event for the same ticket and `approval_id`.
- **SETTLED:** `Closure Context → Closure Already Handled? → Verify Closure Outcome`. No repeated agent, IFC write, statistics or notices.
- **DECIDED:** a shared action has returned with unfinished operations. The existing Closure Supervisor may finish those operations using its existing guarded tools. Verification remains mandatory.
- **ATTENTION:** a shared action has no final receipt after ten minutes. WF2 reports incomplete closure instead of launching competing closure work.
- **SUPERSEDED:** a newer approval cycle or incompatible ticket state ends the old review.

Closure still requires current FM approval, a matching successful IFC update/version, technician statistics and the required Gmail receipts. A rejected completion settles only after `REWORK` and the technician notice.

Approval links expire after 72 hours. The next poll requests a renewed link and records expiry without approving or rejecting the ticket. Claims prevent automatic duplicate sends. An uncertain Gmail result is retained as unconfirmed; the FM can request an explicit resend through WF3.

## Deployment and regeneration

`review-mail.sql` adds only `cbm_wf2_prepare_review_email(jsonb)` and `cbm_wf2_review_status(jsonb)`. It uses the existing shared approval-email table and guarded action functions. Apply it after the WF3 actions schema.

`shared_review.py` preserves an exported workflow and extends only WF2 and the existing approval email helper. Run its idempotent `extend_wf2` and `extend_email` transformations after any legacy builder that recreates those workflows. Do not import an older generated payload over these current definitions.

`Install-Wf2SharedReview.ps1` installs the reviewed payload and synchronizes the local exports. Publish the shared email helper first, then WF2. The installer does not execute workflows or send test messages.

An execution already waiting in the former Gmail node retains its original workflow snapshot; publishing cannot retrofit it. Start a new test from a suitable checkpoint rather than retrying the old snapshot. No unfinished WF2 executions were present at installation.

Validation: 26 isolated database assertions, graph/reference checks and JavaScript compilation. Synthetic data only; no test emails or external model/IFC calls.
