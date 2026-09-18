# Inspect maintained IFC assets through the FM chat

Refresh **CBM - 3. Facility Manager Dashboard**, click **Open chat** in the editor and ask:

- Show me the latest IFC element that was subject to maintenance.
- Show me the latest five maintained elements and the work performed on each.
- Show the maintained assets whose name contains Fondital.
- Inspect these IFC GlobalIds: …

The **FM Dashboard Agent** calls **inspect_ifc_maintenance**, a workflow tool connected
to the agent in the same way as the other tools. The saved helper is
**[CBM] WF3 - Inspect IFC Maintenance** (`cbmWf3IfcInspect`). There is no separate
manual inspection branch to run in WF3.

## Helper steps

1. **When Executed by Another Workflow** receives the requested count, offset,
   optional GlobalIds, literal search and model version.
2. **Validate IFC Request** checks the inputs and caps each page at 20 assets.
3. **Read IFC Maintenance** reads actual `CBM_MaintenanceLog` properties from the
   Python IFC service, newest maintenance first.
4. **Read Matched Technician Reports** queries PostgreSQL for the same asset,
   ticket and successful IFC operation. Technician work is included only when
   the approval and submitted report also match.
5. **Return Maintained Assets** returns compact JSON to the agent. The agent
   presents the requested assets directly in chat.

The reply includes the IFC version, asset name and GlobalId, maintenance date,
ticket, technician, condition and actual work/checks when available. It distinguishes
the IFC description (which can contain the original fault) from the technician's
completed work. Missing evidence is reported explicitly.

## Multiple assets and pagination

A singular request defaults to one asset. Explicit counts are honored up to 20
per tool call. Larger requests use subsequent pages of the **same IFC version**,
so a model update during the conversation does not mix results. A new request
for the latest state reads the current version afresh. Lists contain each asset
once, with its latest intervention; they are not a list of every historical job.

The result includes `count`, `total_matching_assets`, `has_more` and `next_offset`.
The agent must say when fewer assets exist than requested or when an execution
limit prevents finishing all pages. Text fields are bounded to 1,600 characters
and any truncation is marked.

## Demo and deployment

The current demo has one maintained radiator, GlobalId `3kcZF9AH16IwPfuL_CGFlR`,
ticket #1, work **Sostituzione Valvola**, in `office_v2.ifc`.

`Install-Wf3IfcInspection.ps1` deploys the Python service, imports the helper before
WF3, and synchronizes the source and configured exports. Both retain their inactive
state. A helper invoked by another workflow does not need a schedule.

Both editor test chat and hosted FM chat use the dedicated Basic Auth credential
**FM Chat Login**. The original **Unnamed credential** remains assigned only where
it was already used (MultiSet) and its contents were not changed. Publishing WF3
also enables its existing
weekly schedule. This helper itself only reads: it does not email, modify tickets
or modify the IFC. WF3 separately retains its existing question audit log.

The Basic Auth username is `fm_demo`; keep the password in the n8n credential.
After a wrong password is submitted, Chrome can continue sending the cached wrong
HTTP Basic Auth header. The node cannot clear a browser credential cache. Fully
restart Chrome or open the published Chat URL in a new Incognito window, then enter
the credentials from **FM Chat Login**. The embedded editor preview in the already
open browser session can continue to show `Authorization data is wrong!` even after
the credential is corrected.

Implementation: `cbm/app/wf3/ifc_inspection.py`; helper export:
`cbm/app/wf3/workflows/inspect_ifc_maintenance.json`. Validation evidence:
`validation-wf3-agent-tool`. The Python API supports `/maintenance` filters and
version-pinned pagination; the IFC download endpoint remains available internally
but model binaries are not passed to the language model.

## Validation status

The installed helper executed successfully against the actual IFC and PostgreSQL,
returning the radiator, ticket #1 and matched valve replacement report. Four service
tests include several maintained assets, timestamp ordering, filtering and stable
pagination across a model-version change. JavaScript tests verify bounded inputs,
one/multiple/empty results and rejection of mismatched report evidence. WF3 structure
and existing node regression checks pass.

The real agent test has not run: automatic approval review requires confirmation
before sending these internal asset and technician-report details to OpenRouter
and importing the isolated validation workflow. No validation workflow was imported.
