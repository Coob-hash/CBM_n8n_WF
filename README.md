# CBM

Maintenance ticket intake, technician dispatch and IFC services.

## Project layout

| Path | Purpose |
|---|---|
| `wf1_ticket_intake_and_dispatch.json` | Current WF1 export with native Postgres tools and the dispatch agent |
| `n8n_wf2_completion_approval_ifc_update.json` | Completion, facility-manager approval and IFC update workflow |
| `phase_b/workflows/` | Seven saved helper workflows required by WF1 |
| `phase_b/` | Dispatch source, builder, configuration and tests |
| `database/` | Approved PostgreSQL schema, migration runner, transaction functions and database tests |
| `phase_a/` | Source for the current image-preparation node |
| `ifc_service.py`, `capture_normalize.py` | IFC API and image normalization |
| `calibrate_registration.py`, `create_sample_ifc.py` | Registration calibration and sample model utilities |
| `schema.sql` | Legacy schema fixture used by the current workflow exports |
| `docs/WF1_Native_Tools_Guide.docx` | Current architecture and node-by-node explanation |

## Configure and import

The new 27-table database is implemented separately under the PostgreSQL `cbm` schema. See [database setup](database/README.md) for migrations and validation. The existing workflow exports have not yet been switched to this new database contract.

Follow [the dispatch guide](phase_b/README.md) to configure `phase_b/deployment.local.json`, import the seven helpers, bind their IDs and import WF1. The exported workflows contain template settings. Configure the existing Phase A service endpoints and credentials in n8n as well.

The private local deployment file is retained and ignored by Git. No workflow is activated by rebuilding these files.

## Build and test

From this directory, with Node.js available:

```powershell
node .\phase_b\build-workflow.js
node .\phase_b\setup-test-runtime.js
node .\phase_b\test-dispatch.js
```

The first command regenerates template exports. Pass `phase_b/deployment.local.json` to the builder for locally configured exports; keep those private. Test setup downloads the isolated PGlite runtime on demand into an ignored cache.

For the Python service, install its dependencies in a virtual environment:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install fastapi uvicorn "ifcopenshell>=0.8" numpy pydantic Pillow
python create_sample_ifc.py
uvicorn ifc_service:app --host 0.0.0.0 --port 8000
```

Sample model creation is optional. `ifc_service.py` documents the IFC model directory, axis mapping and registration configuration. Its image-normalization endpoint is used by the current Phase A node.

## Validation and versioning

The 25 local dispatch tests pass. Live n8n, Gmail, model and Python service integration still require environment-specific checks. Existing WF2/schema compatibility limitations are listed in the dispatch guide.

Git history is preserved. Track source and template exports together; do not commit private deployment values. `phase_b/original_wf1.json` is a required builder and regression-test fixture, not an alternate workflow to import.
