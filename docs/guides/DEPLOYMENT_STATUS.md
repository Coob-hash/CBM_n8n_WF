# Current state — 17 September 2026

Use [RUN_DEMO_GUIDE.md](RUN_DEMO_GUIDE.md) for the verified run procedure and remaining setup. Local business PostgreSQL is bound and installed. The bilingual technician portal, its SQL migration and Python endpoint are installed, together with updated assignment/rework helpers; the portal remains inactive. The 15-workflow project comprises three main workflows, eleven existing supporting workflows and the portal. Main WF1/WF2/WF3 user edits were preserved.

Google Drive account 2 passes authentication. Gmail account 3 is connected, and every Gmail node in the 15-workflow application is bound to it. The user can see the MultiSet map and empty Credentials section, but no API credential is bound and measured map-to-IFC registration remains incomplete. The controlled technician email is configured as one active identity. No live emails or reports were sent. See `validation-gmail-account-3-all` for the credential-binding audit and `validation-technician-portal` for installation evidence.

The records below are historical.

# Previous workflow update

See [READ-ME-SINGLE-TICKET.md](../dispatch/READ-ME-SINGLE-TICKET.md) for the 16 September single-ticket source draft and the remaining ticket-database binding issue. The record below describes the earlier base release and is historical.

# Installed intake and approval release

Verified on 15 September 2026 in `C:\Users\USER\Desktop\n8n_deploy`.

The new Python image `cbm-python:2026.09.15-intake-approval` and additive PostgreSQL migration are installed. The existing case-study volumes are reused. Both Python services pass checks, the active model remains the byte-identical original `office_v1.ifc` with 13 maintainable assets, and ngrok HTTPS readiness passes.

n8n and ngrok were not restarted for this update. All 19 existing workflows, 18 credentials and one active workflow were preserved. `.env` and `cbm/cbm.env` remain byte-identical. The real application database has no demo-generated reports, tickets or bugs; all failure and approval simulations ran in separate test containers.

The prior deployment is backed up in `backups/config-before-intake-approval-20260915-132414`. The successful migration's database backup is `backups/intake-database-20260915-132521/cbm_demo.sql`. A Windows stdin-forwarding problem was caught by the migration check and fixed by executing mounted SQL files directly; the final migration and checks passed.

Validation passed: six real-IFC offline tests, seven PostgreSQL concurrency/retry/approval tests, actual n8n 2.29.9 retry and approval paths using local provider/mail simulators, Code/graph checks, authorization-based appointment timing, and WF3 SQL/Code regressions including rejected requests. All 14 application exports imported successfully, inactive, into the isolated n8n. Test containers were stopped; their volumes were retained.

No real email was sent and no live MultiSet query was made. The new application workflows have not been imported or published in your n8n. `cbm/demo.local.json` is not present: configure the FM email and incoming/completed Drive folder IDs, run `scripts/workflows/Prepare-CbmWorkflows.ps1`, then import, bind credentials and publish the new set. IT defaults to **giuseppe.desiderio123@gmail.com**. Existing n8n workflows remain as they were.

Map-to-IFC registration remains unverified. The real-photo success path still requires measured registration and live VPS/vision validation. The new workflow requests up to three replacement photos and then reports an IT bug; it never substitutes FM asset selection for failed identification.

Start with `INTAKE_APPROVAL_GUIDE.md`; the complete tutorial and case-study guide are updated. Structured evidence is in `cbm/case-study/validation/deployment-validation.json` and `intake-runtime.json`.
