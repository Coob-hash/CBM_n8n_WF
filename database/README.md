> **2026.09.14 release decision:** this package is frozen as a design study. The live workflow contract remains the root legacy public schema. Do not apply these migrations to deploy the release. A future cutover must revise both the REPAIR_VERIFICATION AFTER-photo check and the approval evidence guard to support mandatory reports with optional photos, define PDF REPORT evidence roles, and rewrite all WF1/WF2/WF3 queries. Historical text below describes that proposed design, not current application wiring.

# CBM PostgreSQL database — design study (not deployed)

The approved 27-table database is implemented by the migrations in this directory. It supports one building and one current facility manager, with historical actors, evidence, dispatch, review, delivery and IFC records.

This package has been prepared and validated locally. It has not been applied to an external PostgreSQL server. The existing WF1/WF2 exports and the old root `schema.sql` are unchanged and still use the legacy database contract. **Do not switch their search path to `cbm`: their queries must be adapted first.**

## Files

| File | Purpose |
|---|---|
| `migrations/001_tables.sql` | All 27 domain tables, foreign keys, checks, indexes, five skill codes and one bootstrap service identity |
| `migrations/002_integrity.sql` | Ownership, lifecycle and concurrency guards; retained evidence; automatic audit history |
| `migrations/003_operations.sql` | Transaction functions for dispatch, delivery, review and IFC updates; safe read views |
| `migrate.py` | Transactional migration runner with file checksums and an installation lock |
| `site.example.json` | Template for the one building and FM; contains no real user records |
| `tests/test_database.js` | Executable SQL and domain-rule tests using PGlite |
| `tests/test_migrate.py` | Offline migration-history and configuration validation tests |
| `validation-report.json` | SQL test results and the hashes of the tested migrations |

The domain tables live under `cbm`. The runner separately maintains one technical table, `cbm_meta.migrations`, to record applied migration checksums. It does not drop, rename or overwrite existing public tables. Fresh installation creates no invented technicians, tickets or FM; those are configured explicitly.

## Install on PostgreSQL when ready

PostgreSQL 14 or newer is required. No pgvector, PostGIS or pgcrypto extension is required. Use a database owner or a dedicated migration account with permission to create schemas and their objects. The script installs schemas inside an existing database; it does not create a PostgreSQL server or database.

From the project root, in your Python virtual environment:

```powershell
python -m pip install -r .\database\requirements.txt

# Set your actual target values. Use a libpq password file or your existing
# authentication mechanism; the migration tool has no password CLI argument.
$env:PGHOST = 'your-postgres-host'
$env:PGPORT = '5432'
$env:PGDATABASE = 'your-cbm-database'
$env:PGUSER = 'your-migration-account'

python .\database\migrate.py --check
python .\database\migrate.py
```

`CBM_DATABASE_URL` can be used instead of the standard libpq environment settings. Do not put a real connection string in tracked files. The runner refuses to connect unless a target database is explicitly configured. It never prints the connection string.

Each migration and its checksum record commit in one transaction. Re-running skips applied migrations. A changed checksum, missing historical file or gap in the applied sequence stops the runner. On a failure, the current migration rolls back; earlier completed migrations remain recorded. The runner will not take ownership of a pre-existing `cbm` schema without migration history. After a release has been deployed, add a new migration instead of editing an applied file.

The `--check` option reads status without creating schemas or data. It briefly uses the same advisory installation lock as the apply path. Changes to the database are made only by the apply path or an explicitly requested site configuration.

## Configure the single building and FM

```powershell
Copy-Item .\database\site.example.json .\database\site.local.json
# Edit site.local.json with the real building name and FM name/address.
python .\database\migrate.py --site-config .\database\site.local.json
```

The local file is ignored by Git. Placeholders are rejected. Configuration creates or reuses an active human FM actor and sets the singleton `site_settings` row. Reapplying the same configuration does not create duplicate people. Deliberately changing the FM supersedes outstanding approval requests addressed to the former FM.

Actual technicians, their skills, the IFC version, assets and map registration must be loaded from the project's real data before dispatch. This package does not manufacture those records from missing legacy metadata.

## Writing from n8n or another trusted service

All table names should be schema-qualified. Parameterize values. Use one database transaction for the acting-actor context and the operation:

```sql
BEGIN;
SELECT set_config('cbm.actor_id', $1, true);
-- Optional: set cbm.workflow_run_id to an existing execution record.
SELECT cbm.initialize_dispatch($2);
COMMIT;
```

The example is a query contract: bind `$1` and `$2` through the database driver or the native Postgres node. It is not an unparameterized psql script. Set `cbm.actor_id` locally, not session-wide, so a pooled connection cannot leak one invocation's identity into the next. New workflow-run rows can be created first, then selected as the transaction's `cbm.workflow_run_id`.

The acting actor is an assertion by the trusted caller. It is not authentication by itself. n8n must authenticate an FM callback and bind the correct actor before calling `decide_approval`. A raw, unauthenticated request must never choose `cbm.actor_id`. `record_offer_response` validates the offer token internally; GET page views must not call it. A Gmail receipt must come from the actual sending node, not from a model argument.

Schemas, tables, sequences and functions grant no access to `PUBLIC`. The migration owner can administer them. Runtime grants and login membership must be chosen for the target instance; the migration does not create database logins or passwords. Functions use caller permissions rather than blanket elevated privileges. Keep migration credentials out of agent tools and expose fixed parameterized operations, not arbitrary SQL generation.

## Transaction functions

| Function | Contract |
|---|---|
| `initialize_dispatch(ticket_id)` | Idempotently initializes policy and the ranked shortlist of at most five eligible technicians |
| `reserve_offer(dispatch_id, technician_id, token_digest)` | Reserves the next eligible candidate and one permitted capacity slot; returns the existing offer on replay |
| `claim_message(message_id, account_reference)` | Records an exclusive send claim; returns the attempt that the Gmail node should execute |
| `record_delivery(attempt_id, provider_message_id, error)` | Records the actual acknowledgement, or an uncertain outcome when the receipt is missing |
| `record_offer_response(public_reference, token, decision)` | Validates and persists one POST decision; replays return the original receipt |
| `process_responses(dispatch_id)` | Applies receipt order, rechecks eligibility and atomically records one assignment and competing withdrawals |
| `expire_offers(dispatch_id)` | Expires overdue offers after pending responses have been handled |
| `mark_overdue_deliveries()` | Marks five-minute-old claims uncertain and halts affected dispatches |
| `reconcile_delivery(attempt_id, sent, provider_id, note)` | FM records whether an uncertain message was sent, with supporting receipt when sent |
| `resume_dispatch(dispatch_id, note)` | FM explicitly resumes after outstanding delivery claims are resolved |
| `escalate_dispatch(dispatch_id)` | Escalates only when no live offer/response remains and the shortlist is exhausted or the urgent cutoff has arrived |
| `record_dispatch_failure(ticket_id, reason)` | Counts initialized failures and halts at three; separately audits failures before initialization |
| `request_approval(completion_id, assessment_id, token_digest)` | Opens a review for the current evidence and FM with a 72-hour deadline |
| `expire_approval(approval_id)` | Records timeout without treating silence as rejection or approval |
| `decide_approval(approval_id, decision, reason)` | Records the explicit FM decision; rejection requires rework, approval closes the case and queues one IFC job |
| `start_ifc_sync(job_id, request_reference)` | Claims the single model writer using the current IFC version |
| `finish_ifc_sync(attempt_id, file_id, version_label, error)` | Publishes a verified successor file, or records an uncertain outcome if no result is available |

These functions implement database operations. They do not call Gmail, invoke models, upload IFC files or create every notification body. The future workflow integration must create the logical notification records and perform the external operations between the claim and receipt calls.

`cbm.technician_workload` derives open jobs, last assignment time and completed jobs. `cbm.dispatch_context` supplies operational facts without token digests, email bodies or a generated list of tool instructions. Token digests are lowercase SHA-256 hex strings; generate a cryptographically random token outside the model, store its digest on the offer/request, and keep the token only where it is needed to render the callback link. The opaque reference alone is not authorization.

## Guarantees and operational boundaries

- Exactly one building-settings row and one current FM; only human actors with email addresses can hold technician or FM roles.
- Ordinary dispatch has one occupied offer slot; urgent dispatch has at most two. Offer recipients, shortlist order and appointments cannot be rewritten after reservation.
- Each ordinary acknowledged offer has 48 elapsed hours. Urgent offers expire at the earlier of 48 hours and the fixed next-business-day appointment start. Scheduling uses Europe/Rome and excludes weekends, not public holidays.
- A late response is rejected even before recovery runs. A timely persisted response is processed before expiry; receipt order is assigned while the ticket is locked.
- A valid assignment and competing offer withdrawals are committed together. Only one assignment can be active. Workload statistics come from history, so replay does not increment counters twice.
- Evidence, processed decisions and audit history cannot be overwritten or deleted through normal DML. Administrative retention or correction requires a deliberate future migration; do not disable triggers in production to bypass a failed transition.
- The FM can approve a repair even if the AI verdict is negative. Only the latest completion can be approved; rework preserves rejected evidence and earlier decisions. Approval expiry stays distinct from rejection.
- Message idempotency separates logical notifications from send attempts. A successful provider receipt does not prove recipient delivery. Uncertain sends halt dispatch until reconciliation. A confirmed-unsent invitation is withdrawn; the candidate is not silently re-invited.
- A very late Gmail acknowledgement that conflicts with an ordinary appointment produces a halt rather than changing the appointment in the email. Operator resolution must reconcile both the communication and the appointment policy; `resume_dispatch` is not a rescheduling tool.
- An uncertain IFC attempt keeps the single model-writer slot occupied. Operator reconciliation of IFC uncertainty is recorded on the attempt, with FM identity, before another write is permitted. The external IFC service still needs idempotency keyed by `ifc_sync_jobs.operation_key`; SQL alone cannot stop a duplicate file write after a lost network response.
- Ticket closure and IFC synchronization are separate. Notifications must use the sync-job status and must not claim the model was updated while its job is pending or uncertain.

Automatic audit events record entity creation/update, state transitions and redacted field changes, plus the acting actor and optional n8n run. Dedicated exceptional events can also be appended. They are history, not a second operational state store. Uninitialized failure events remain queryable even before a dispatch case exists; recovery scheduling and operator alerts are responsibilities of the integrated workflows.

## Local validation

From the project root:

```powershell
node .\phase_b\setup-test-runtime.js
node .\database\tests\test_database.js
python -B .\database\tests\test_migrate.py
```

Alternatively, `CBM_PGLITE_PATH` can identify an already installed PGlite 0.5.8 `dist/index.cjs`, avoiding another dependency download. The tests create disposable in-memory databases and use explicit synthetic fixtures; they do not load `deployment.local.json` or contact real providers.

The SQL suite verifies the 27 tables against the approved design, positive lifecycle operations, invalid cross-ticket writes, race-order protections, deadlines, rework, uncertain delivery, IFC versioning and migration rollback. Clock-boundary tests backdate isolated fixtures as the test owner and restore all guards before exercising the operations. The migration-runner tests verify history ordering, checksum rejection and configuration validation.

PGlite executes PostgreSQL SQL but does not reproduce multiple independent server sessions. The tests do not certify live-server contention, the psycopg connection/apply path, n8n import, or provider behavior. Those checks remain for deployment integration. See `validation-report.json` for the actual successful test count and migration hashes.

## Transition from the old database

The root `schema.sql` is retained as a legacy fixture for the existing workflow exports and their regression tests. Applying these migrations creates the new schema alongside it; it does not transform old JSON dispatch snapshots into relational rows.

Cutover will require a reviewed import of real actors, files, assets and existing work; adaptation of WF1/WF2 SQL and the IFC service's idempotency behavior; and end-to-end tests with controlled mailboxes. Outstanding offers and approval links need a deliberate transition policy. No silent or lossy legacy-data conversion has been included in this database implementation.
