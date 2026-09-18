# CBM release 2026.09.14

This separate release implements the application review in `2026_09_14_CBM_release_review.md`. The predecessor, `13_09_2026 release CBM`, is preserved. See [release changes and review disposition](RELEASE_NOTES.md) and [generated validation results](validation/release-validation.json).

The deployable database contract is **the legacy public schema**. `database/` is a retained, tested **design study**, not the production migration path. Its report-only completion checks are incompatible with these workflows; do not install it alongside this release as an application upgrade.

## Rebuild everything

Use Node.js and Python 3.13. The local release includes an isolated `.venv`; a clean checkout can prepare it with:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-lock.txt
.\rebuild.ps1
```

The script stops on any failure, builds WF1 **including all 22 demo nodes**, then WF2 and WF3, runs every offline suite and the Python services, and verifies a second build produces identical exports and pins. Test logs go to `output/validation/`; the summary goes to `validation/release-validation.json`. Use `-Python <interpreter>` to select another interpreter or `-BuildOnly` to regenerate exports. Builders do not activate workflows.

The equivalent build order is `node phase_b/build-workflow.js` (which calls `demo_ingestion/build.js`), `python wf2/build_wf2.py`, then `python wf3/build_wf3.py`. The complete test command order is maintained in `rebuild.ps1` rather than duplicated in documents.

## Database installation and upgrade

Use a separate test database first and `psql -v ON_ERROR_STOP=1` for each file. For a fresh demonstration database, start with `schema.sql` (includes sample technicians). For an existing legacy database, skip that fixture. Then apply, in order:

1. `schema_dispatch_functions.sql` — single-call dispatch creation/response routines with transactional locks.
2. `schema_wf2_completion.sql` — report columns and backfill/validation of old closed tickets.
3. `schema_wf3_dashboard.sql` — dashboard status-change audit.
4. `schema_release_review.sql` — approval identity, unique open element, and idempotency indexes.

The last migration refuses to proceed if historical open tickets share an element. Reconcile those tickets with the FM; it does not delete or close them automatically. Never apply `database/migrations/` to deploy these workflow exports.

Optional Supabase database: apply `knowledge/schema.sql` for production retrieval and `knowledge/demo_schema.sql` for the independent demo library. These belong in Supabase, not the dispatch database.

## Import order

Import and configure the seven `phase_b/workflows/*.json` helpers, two `wf2/workflows/*.json` helpers, and `knowledge/error_workflow.json`. Then import `knowledge/sync_workflow.json`, `wf1_ticket_intake_and_dispatch.json`, `n8n_wf2_completion_approval_ifc_update.json`, and `n8n_wf3_fm_dashboard.json`. All are inactive templates. Verify and rebind saved-workflow IDs after import; imports can assign new IDs. Rebind the sync workflow's error-workflow setting as well.

WF2 helper IDs are `cbmWf2IfcReview1` (guarded IFC write) and `cbmWf2FmNotice1` (FM notice from committed state). WF1 IDs are in `phase_b/workflow-manifest.json`. Use internal n8n credential IDs, never Google OAuth client IDs; the WF1 builder rejects that common mistake. Private `deployment.local.json` was deliberately not copied from the predecessor; start from `phase_b/deployment.example.json`.

No target n8n instance/version was provided and live import compatibility is **not certified**. Before activation, record the actual version in `deployment/acceptance.json` and run the ordinary/urgent ticket scenarios listed there. Node type versions are recorded in `deployment/node-versions.json`. Production n8n must allow the `pdf-parse` 1.x API used by WF2 (`NODE_FUNCTION_ALLOW_EXTERNAL=pdf-parse`) in its Code runner. On n8n 2.x, configure the task runner and environment access according to that version's documentation.

## Configuration reference

| Placeholder / environment variable | Purpose |
|---|---|
| `REPLACE_POSTGRES_CREDENTIAL_ID` | n8n credential for the legacy dispatch database; display name **CBM Postgres** |
| `REPLACE_SUPABASE_POSTGRES_CREDENTIAL_ID` | SQL connection to the separate knowledge database; **CBM Supabase Postgres** |
| `REPLACE_SUPABASE_CREDENTIAL_ID` | Supabase backend API credential for vectors |
| `REPLACE_GMAIL_CREDENTIAL_ID` | n8n Gmail OAuth credential; **CBM Gmail** |
| `REPLACE_DRIVE_CREDENTIAL_ID` | n8n Google Drive OAuth credential |
| `REPLACE_ANTHROPIC_CREDENTIAL_ID` | Anthropic credential, including Phase A vision |
| `REPLACE_OPENAI_CREDENTIAL_ID` | OpenAI embeddings credential |
| `REPLACE_MULTISET_CREDENTIAL_ID` | MultiSet M2M Basic Auth credential |
| `REPLACE_KNOWLEDGE_HEADER_CREDENTIAL_ID` | Header Auth sending `X-CBM-Knowledge-Key` |
| `REPLACE_MISTRAL_HEADER_CREDENTIAL_ID` | Header Auth sending `Authorization: Bearer <key>` for demo OCR |
| `REPLACE_FM_RESUME_HEADER_CREDENTIAL_ID` | FM-only Header Auth for `POST /cbm-wf1-resume` |
| `REPLACE_CHAT_AUTH_CREDENTIAL_ID` | FM chat Basic Auth credential |
| `REPLACE_FM_EMAIL@example.com` | Real FM/operator mailbox |
| `REPLACE_N8N_HOST` | Public HTTPS host in `callbackBase`; include `/webhook` once |
| `REPLACE_FOLDER_ID_01_INCOMING_SNAPSHOTS` | Incoming Drive folder |
| `REPLACE_COMPLETED_FOLDER_ID` | Completed reports/photos Drive folder |
| `IFC_SERVICE_URL` | One reachable base URL used by both WF1 and WF2, e.g. `http://ifc-service:8000` |
| `MULTISET_MAP_CODE` | Actual map identifier, never stored as a REPLACE placeholder |
| `CBM_TECHNICAL_SHEETS_DIR` | Absolute path inside the self-hosted n8n runtime containing the demo PDFs |
| `IFC_MODEL_DIR` | Service-side directory containing versioned IFC files and `active_model.txt` |
| `CBM_KNOWLEDGE_CATALOG`, `CBM_KNOWLEDGE_KEY` | Approved extractor catalog and private header key |

Configure `knowledge.snapshotUrl` in the private deployment configuration separately from the IFC endpoint. `AXIS_MODE` and `MULTISET_TO_IFC_MATRIX` configure registration as documented in `ifc_service.py`. Secrets belong in n8n credentials/environment, not exported JSON. See `deployment/nginx.conf.example` for a TLS/IP restriction example for the FM chat and resume routes.

## Services and completion contract

```powershell
.\.venv\Scripts\python.exe create_sample_ifc.py
.\.venv\Scripts\python.exe -m uvicorn ifc_service:app --host 127.0.0.1 --port 8000
# In another terminal, with the approved catalog/key configured:
.\.venv\Scripts\python.exe -m uvicorn knowledge.service:app --host 127.0.0.1 --port 8001
```

The sample now includes a radiator at `(6, 1, 0.6)`. It is synthetic and has no manufacturer mapping until one is explicitly approved. The IFC write API requires `operation_key`; reuse the exact key and body on retry. Writers serialize across processes, journal the result, and atomically switch the active pointer. A conflicting replay returns HTTP 409.

Technicians upload **`TICKET-<id>.pdf`**. An optional **`TICKET-<id>.jpg`** should arrive first to be included in the assessment. A lone photo for an assigned/rework ticket with no stored report prompts a report reminder. FM timeout after 72 hours records expiry, keeps `PENDING_APPROVAL`, and sends a fresh approval request. Only an explicit rejection causes rework. IFC failure is audited and leaves the version NULL; FM mail reads the actual stored result.

## Documentation and demo library

Current guides: [WF1](phase_b/README.md), [WF2](wf2/README.md), [knowledge/demo](knowledge/README.md), [WF3](wf3/README.md). The Word guide `docs/WF1_Native_Tools_Guide.docx` is a **historical architecture reference**, predating both production knowledge and demo ingestion; use these Markdown guides for this release.

The three manufacturer PDFs remain local and ignored. `technical_sheets/README.md` names them; they are excluded from the release archive and source commit. Run **Demo - Load Technical Sheets** manually only after configuring Mistral OCR, OpenAI, Supabase and the mounted directory. Its `cbm_demo_technical_documents` library is **never searched by the dispatch agent**. Source: `demo_ingestion/build.js`; SQL: `knowledge/demo_schema.sql`.

Local verification uses synthetic models, vectors, documents, and mail/model stubs. No production workflow, mailbox, Supabase instance, or repository remote was modified. The local service HTTP smoke tests are real; external provider integrations remain deployment acceptance work.
