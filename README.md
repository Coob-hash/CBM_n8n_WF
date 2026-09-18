# Current update: Single-ticket dispatch and one vision pass, 16 September 2026

Start with [READ-ME-SINGLE-TICKET.md](READ-ME-SINGLE-TICKET.md) for the simplified source workflow. [READ-ME-DISPATCH.md](READ-ME-DISPATCH.md) explains the preserved A-D fixes and context; [READ-ME-OPENROUTER.md](READ-ME-OPENROUTER.md) explains the models. The earlier deployment instructions below describe the base intake release.

---

# CBM intake and approval release — 15 September 2026

This separate release extends the Maddaloni case-study demo with the agreed process:

- One initial photo and up to three replacement photos, linked by report UUID and persisted in PostgreSQL.
- Automatic VPS/IFC/vision asset identification; unresolved captures request another photo, with no FM asset selection.
- A persistent bug issue and IT notification after the fourth failed capture. IT defaults to your_email@....
- Mandatory FM authorization before dispatch; rejection contacts no technician. WF2 completion acceptance remains separate.

Start with [INTAKE_APPROVAL_GUIDE.md](<C:/Users/USER/Desktop/n8n_deploy/INTAKE_APPROVAL_GUIDE.md>), then [CBM_Demo_Tutorial.md](<C:/Users/USER/Desktop/n8n_deploy/CBM_Demo_Tutorial.md>) for every workflow and trigger. [CASE_STUDY_GUIDE.md](<C:/Users/USER/Desktop/n8n_deploy/CASE_STUDY_GUIDE.md>) retains the IFC, E57, photo and intrinsics audit.

The deployment uses the existing n8n/ngrok configuration and case-study volumes. Apply-CbmIntakeMigration.ps1 backs up and updates the existing database; installing or restarting an existing PostgreSQL container alone does not apply initialization SQL. The installer backs up the prior deployment and preserves private configuration, catalog and registration. Workflow imports are separate, inactive templates with a new ID namespace.

The source IFC/photos and all previous source releases remain unchanged. The existing dispatch helpers are retained, with appointment timing anchored to FM authorization; WF3 excludes rejected requests from open totals. No new Python dependency, container, mobile app or external issue-tracker integration is required for the application. The mock provider container exists only in isolated tests.

Validation includes real-IFC offline checks, PostgreSQL concurrency/approval tests and an isolated n8n run with simulated providers/mail. Actual MultiSet localization, map-to-IFC registration and vision accuracy remain to be validated using live credentials and measured correspondences. See DEPLOYMENT_STATUS.md for installed state.
