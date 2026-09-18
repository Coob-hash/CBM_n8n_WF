# Single-ticket dispatch and one vision pass

The update targets existing source WF1 `YZb99Du8CBtsSy7f`. The user's separate backup `8HOnSa9XE7ohpmgG` is not an installation target.

## Dispatch

```text
FM approval / technician response / recovery timer
  → Claim One Dispatch Ticket
  → Phase B Context → Read Dispatch Memory → Read Knowledge Identity
  → Dispatch Agent → Verify Committed Outcome
  → Release Dispatch Claim (or record incomplete work, then release)
```

An approval or response selects its exact ticket. A recovery tick selects at most one eligible ticket, least recently handled first, with oldest creation time breaking ties. It never selects another ticket as a fallback for a busy or ineligible callback ticket. Zero rows stops the dispatch branch. The timer also retains the independent intake-notification recovery branch.

`cbm_claim_dispatch_ticket(ticket_id_or_null, execution_id)` selects and claims atomically in PostgreSQL. A 65-minute claim exceeds the workflow's 60-minute maximum execution time. Another execution cannot claim that ticket until release or expiry. Finishing requires the ticket, claim token and execution ID to match. If a run crashes, a later recovery tick can reclaim it after expiry.

There is no dispatch loop, dispatch self-call or shared capture/dispatch router. `One Capture Input → Capture Input` is photo-only. `Process Each Drive Capture` still invokes that photo entry point for each uploaded image.

The five-entry `portfolio` remains a read-only paginated overview. It does not select five tickets for work. Existing guards for authorization, tool scope, technician ranking, email receipts and assignment remain.

## Vision and IFC matching

```text
Observe Room Image → Validate Room Observations → Vision Clear?
  clear → Match IFC Asset and Describe Issue → Parse Triage JSON → Triage Valid?
  unclear / invalid → Classify Capture Failure → Record Capture Failure
```

The image is sent once to `google/gemini-3.1-flash-lite`. An unclear image or invalid response follows the existing replacement-photo / IT escalation policy for its report. There is no stronger image review.

`Match IFC Asset and Describe Issue` uses `google/gemini-3.8-flash` with text only: validated visual observations and nearby IFC candidates. It selects an exact candidate GlobalId and describes/classifies the observed issue. The code rejects a radiator photo matched to an `IfcDoor`, unknown candidate IDs, ambiguity and unsupported fault claims. Generic IFC proxy objects rely additionally on names and features; format/type checks cannot prove physical identity or distinguish identical nearby assets. Unresolved cases require another photo.

The issue description, severity and required skill remain provisional. Intake creates/reuses the ticket and asks the FM to authorize it before dispatch.

## Rebuild, installation and validation

`scripts/workflows/Prepare-CbmWorkflows.ps1` reapplies the updated overlays; it does not restore the batch or image-review branch. `scripts/dispatch/Install-SingleTicketUpdate.ps1` backs up affected deployment files, updates the bundled application's SQL functions and imports only the inactive source WF1 draft. It preserves existing credential bindings and the source workflow name/ID.

Validation evidence is in `validation-single-ticket`: 11 database/context tests, 12 vision contract/graph tests, graph/preservation checks and the 20 existing dispatch policy/helper tests. Test emails and receipts are mocked. This does not constitute a live MultiSet-to-IFC validation.

**Existing setup issue:** `Postgres account 2` points to the older Supabase project, where CBM application tables were absent at the last check. The tested schema is in bundled local PostgreSQL (`cbm-postgres`, database `cbm_demo`). Choosing and binding the ticket database is still required before live operation. This update does not move ticket data or change database credentials.
