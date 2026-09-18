# Operator scripts

Scripts are grouped by the task or workflow they serve. Each resolves the repository root from its own location, so it can be started from any directory. The PowerShell scripts require PowerShell 7.3 or later.

## `deployment/` — set up, start and check the stack

| Script | Purpose |
| --- | --- |
| `Initialize-Cbm.ps1` | Creates the private `cbm/cbm.env` next to the existing n8n/ngrok `.env`; never replaces existing secrets |
| `Cbm-Compose.ps1` | `docker compose` wrapper that always supplies both env files and the `n8n_deploy` project name |
| `Start-Cbm.ps1` | Backed-up build and start: retains a rollback image, copies n8n data, starts the stack, applies the intake migration |
| `Test-Cbm.ps1` | Infrastructure checks for n8n, runners, IFC, knowledge, OCR and PostgreSQL |
| `Apply-CbmIntakeMigration.ps1` | Backs up and migrates an existing `cbm_demo` database (init SQL only runs on an empty volume) |
| `Install-CbmExtension.ps1` | Installs this package into the `n8n_deploy` folder, backing up its configuration first |

## `workflows/` — build the n8n workflow exports

| Script | Purpose |
| --- | --- |
| `Prepare-CbmWorkflows.ps1` | Writes the inactive, deployment-bound workflow exports to `cbm/workflows-configured/` |
| `Apply-CbmCompatibility.ps1` | Reapplies the WF1/WF2 overlays (intake, case study, dispatch, OpenRouter, credentials, technician portal) |

## Per-workflow updaters

Each installs one reviewed update into an existing deployment: it backs up the files it replaces, applies its SQL from `database/`, and imports the workflows as drafts. None of them publishes or executes a workflow. Several read evidence payloads from the local `validation*` folders, which are not tracked in git.

| Folder | Script | Purpose |
| --- | --- | --- |
| `wf1/` | `Install-TriageChainUpdate.ps1` | WF1 native IFC-matching triage chain |
| `dispatch/` | `Install-DispatchQueueUpdate.ps1` | Dispatch queue and context SQL plus the 14 workflow drafts |
| `dispatch/` | `Install-SingleTicketUpdate.ps1` | Single-ticket dispatch and single vision pass for WF1 |
| `dispatch/` | `Install-PhaseBContextUpdate.ps1` | Phase B dispatch context and ticket-database bindings |
| `wf2/` | `Install-Wf2SharedReview.ps1` | WF2 shared FM review mail and approval helper |
| `wf2/` | `Wf2Checkpoint.cmd` / `Wf2Checkpoint.py` | Create, inspect or restore a WF2-ready database checkpoint in `wf2-checkpoints/` |
| `wf3/` | `Install-Wf3Actions.ps1` | WF3 FM ticket actions and approval mail helper |
| `wf3/` | `Install-Wf3IfcInspection.ps1` | WF3 IFC maintenance inspection tool and service rebuild |

## `demo/` — prepare demo data

| Script | Purpose |
| --- | --- |
| `Set-CbmDemoTechnicians.ps1` | Registers one or two controlled technician mailboxes |
| `Prepare-CaseStudyPhotos.ps1` | Copies audited case-study photos with the WF1 upload filename convention |
| `Reset-CbmDemo.py` | Resets the demo database (dry run unless `--execute`); backups go to `database-reset-backups/` |
