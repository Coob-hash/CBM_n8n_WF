# Operator scripts

Scripts are grouped by the task or workflow they serve. Each resolves the repository root from its own location, so it can be started from any directory. The PowerShell scripts require PowerShell 7.3 or later.

## `deployment/` — set up, start and check the stack

| Script | Purpose |
| --- | --- |
| `Initialize-Cbm.ps1` | Creates the private `cbm/cbm.env` next to the existing n8n/ngrok `.env`; never replaces existing secrets |
| `Cbm-Compose.ps1` | `docker compose` wrapper that always supplies both env files and the `n8n_deploy` project name |
| `Start-Cbm.ps1` | Backed-up build and start: retains a rollback image, copies n8n data, starts the stack, applies the intake migration |
| `Test-Cbm.ps1` | Infrastructure checks for n8n, runners, IFC, knowledge, OCR and PostgreSQL |
| `Apply-CbmIntakeMigration.ps1` | Backs up and migrates an existing `cbm_demo` database: dispatch, intake, dispatch queue/context, WF2 strict closure, technician portal and configuration pause (init SQL only runs on an empty volume) |
| `Install-CbmExtension.ps1` | Installs this package into the `n8n_deploy` folder, backing up its configuration first |

## `workflows/` — build the n8n workflow exports

| Script | Purpose |
| --- | --- |
| `Prepare-CbmWorkflows.ps1` | Writes the inactive, deployment-bound exports of WF1, the dispatch helpers, WF2 and its helpers, WF3, the knowledge workflows and the technician portal from the current sources in `cbm/app/` to `cbm/workflows-configured/` |

WF1 and the dispatch helpers have no separate installer: `Prepare-CbmWorkflows.ps1` produces their current version, and `Apply-CbmIntakeMigration.ps1` applies their SQL.

## Per-workflow updaters

Each installs the latest reviewed update of one workflow into an existing deployment: it applies its SQL from `database/`, copies its files and imports the workflows as drafts. None of them publishes or executes a workflow. Both read their workflow payload from a local `validation-*` folder, which is not tracked in git. Their helpers do not overlap, so the order does not matter.

| Folder | Script | Purpose |
| --- | --- | --- |
| `wf2/` | `Install-Wf2SharedReview.ps1` | WF2 with the shared FM review mail, plus the current completion-approval email helper |
| `wf2/` | `Wf2Checkpoint.cmd` / `Wf2Checkpoint.py` | Create, inspect or restore a WF2-ready database checkpoint in `wf2-checkpoints/` |
| `wf3/` | `Install-Wf3Actions.ps1` | WF3 with FM ticket actions and the IFC maintenance inspection tool: action SQL, IFC service rebuild (skip with `-SkipServiceBuild`), both helpers |

Superseded one-off installers were removed and remain in git history: `Apply-CbmCompatibility.ps1`, `Install-DispatchQueueUpdate.ps1`, `Install-SingleTicketUpdate.ps1`, `Install-PhaseBContextUpdate.ps1`, `Install-TriageChainUpdate.ps1` and `Install-Wf3IfcInspection.ps1`.

## `demo/` — prepare demo data

| Script | Purpose |
| --- | --- |
| `Set-CbmDemoTechnicians.ps1` | Registers one or two controlled technician mailboxes |
| `Prepare-CaseStudyPhotos.ps1` | Copies audited case-study photos with the WF1 upload filename convention |
| `Reset-CbmDemo.py` | Resets the demo database (dry run unless `--execute`); backups go to `database-reset-backups/` |
