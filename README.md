# Community-Based Maintenance — n8n and Python

Application source for maintenance ticket intake, technician dispatch, and IFC-related services. This directory is the Git repository root. The initial commit captures the current application, including the agent-based WF1 Phase B implementation.

## Application files

- `wf1_ticket_intake_and_dispatch.json`: complete WF1 import, including original intake/localization and the agent dispatch section.
- `n8n_wf2_completion_approval_ifc_update.json`: completion, facility-manager approval, and IFC update workflow.
- `ifc_service.py`: FastAPI IFC and capture-normalization service.
- `capture_normalize.py`, `calibrate_registration.py`, `create_sample_ifc.py`: supporting Python utilities.
- `schema.sql`: supplied PostgreSQL schema and demonstration data.
- `phase_b/`: dispatch source, generator, configuration template, tests, and implementation guide.
- `Old/`: historical project drafts retained for reference.

See `phase_b/README.md` for configuring and importing WF1, and `tutorial_nodes_1-7_localization.md` for localization setup. Existing WF2/schema compatibility limitations are documented in the Phase B guide.

## Versioning workflow

Track the application code, SQL, documentation, and n8n JSON exports together. The workflow JSON is generated from the Phase B helpers, so change those helpers and regenerate when modifying dispatch logic. Local deployment values belong in ignored `phase_b/deployment.local.json`; retain placeholders in the tracked deployment example. Do not commit actual credentials or API keys embedded in exported n8n nodes.

From the repository root, local checks can be run with:

```powershell
node .\phase_b\setup-test-runtime.js
node .\phase_b\test-dispatch.js
```

The test runtime is downloaded on first setup and is ignored by Git. Python virtual environments, caches, incidental backups, logs, and generated IFC files in `models/` are also ignored. The original WF1 backup and the validation report are intentionally tracked.

For subsequent changes:

```powershell
git status
git diff
git add <changed-files>
git commit -m "Describe the application change"
```

The repository starts locally on `main`. A remote host can be connected separately when needed.
