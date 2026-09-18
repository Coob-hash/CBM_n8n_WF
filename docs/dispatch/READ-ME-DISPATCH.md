# Single-ticket dispatch — 16 September 2026

## What changed

Each dispatch execution selects **at most one actionable ticket**. FM approval and technician-response events select their exact ticket immediately when available. The recovery timer selects the least recently handled eligible ticket, with oldest creation time breaking ties.

The agent chooses operations for that one ticket; SQL selects and claims it atomically. There is no dispatch loop or dispatch self-call. Persistent claims prevent overlapping executions from selecting the same ticket. A callback whose ticket is already busy leaves its persisted event for recovery.

For five previously unhandled approved pending tickets numbered 101 through 105 in creation order, consecutive recovery ticks select **101, then 102, then 103, then 104, then 105**, one per execution. An approval/response event for 105 can process 105 immediately. A live offer awaiting a response becomes actionable again when its response arrives or its deadline expires.

## Where tickets are created

`Prepare Ticket Request` (formerly the Code node named `Create Ticket`) only prepares the validated triage payload.

`Submit Ticket for FM Authorization` calls PostgreSQL function `cbm_capture_identified()`. That function calls `cbm_create_ticket()`, which creates or reuses the asset's existing open ticket. A new ticket enters `PENDING_AUTHORIZATION`; the intake outbox sends the FM approval request. The FM's explicit approval changes it to `LOCALIZED` and makes it eligible for dispatch.

The Dispatch Agent's old `create_ticket` tool was removed. `initialize_dispatch` initializes dispatch data for an existing approved ticket; it does not create another ticket. Its opening notice tells the FM that dispatch has started after approval.

## What get_context returns

There are two scopes in one response:

| Part | Contents | Can the agent modify these tickets? |
| --- | --- | --- |
| Current ticket | Issue, exact IFC asset, severity, skill, timestamps, authorization, shortlist, offer summaries, pending responses and notice keys | Only this workflow-bound ticket, through guarded tools |
| `portfolio` | Counts of **all tickets except CLOSED**, plus five summaries per page, newest first | Awareness only |

Pending authorization, assigned tickets, rework, rejected requests and operator problems remain visible. Visibility does not imply that dispatch may act on them. Completion/acceptance belongs to WF2; uncertain email delivery requires operator reconciliation. The overview identifies responsibility and whether a ticket is currently actionable.

`get_context(overview_page=1)` reads the second overview page while keeping the same current ticket. Page numbering starts at zero. The agent does not need to scan the backlog to process its ticket.

The node's SQL is now:

```sql
SELECT public.cbm_dispatch_context($1::jsonb) AS context;
```

The workflow supplies the bound ticket ID; the model can supply only the overview page. The detailed SQL runs in PostgreSQL. The model receives the returned facts, not the SQL query text or the whole event history.

### Complete example outputs

These files were produced by the isolated tests with synthetic tickets and mocked Gmail receipts. They are not real maintenance reports.

- [Complete PostgreSQL-tool result, including its row/context wrapper](../../validation/get-context-tool-output.json)
- [The initial context object supplied to the agent](../../validation/get-context-example.json)
- [Fresh context after an offer has been sent, with outcome WAITING](../../validation/get-context-waiting-example.json)
- [Committed state trace through later acceptance and assignment](../../validation/dispatch-example-trace.json)

The example binds ticket **1**, an authorized ordinary-priority door-alignment job. Its initial `outcome` is `UNINITIALIZED`. The portfolio has 13 non-closed tickets, including eight actionable approved tickets and tickets awaiting authorization, assigned, requiring rework, rejected and halted by an operator issue. The first page has five summaries; later pages contain the rest. Before initialization the candidate list is empty because the fixed shortlist has not yet been committed.

### Token usage

Ticket descriptions are limited to 1,600 characters in the public context; overview issue summaries to 240 characters each, with five summaries per page. The initialized shortlist contains at most five technicians. Offer summaries contain knowledge status and chunk IDs, **not the saved full excerpts**, bearer tokens, message bodies or configuration.

The initial context is supplied directly. Every helper returns fresh committed context, so the prompt no longer requires a redundant `get_context` call after every helper. Repeated tool results still consume tokens in the current execution, and knowledge search adds its excerpts. These changes bound each result; they do not guarantee an absolute provider token budget. The model's 4,096-token output setting is not an input-context limit. [Measured character counts](../../validation/context-size.json) are not provider token measurements.

## From get_context to the end of WF1

The following is one successful ordinary-priority example, not a mandatory sequence for every ticket:

1. The scheduler runs every minute. FM approval and a newly persisted technician response also enter `Claim One Dispatch Ticket`, calling `cbm_claim_dispatch_ticket(ticket_id_or_null, execution_id)`.
2. A callback supplies its exact ticket ID; the timer supplies null and selects one eligible ticket. The function atomically selects and claims it for this execution. Zero returned rows ends this dispatch branch.
3. `Phase B Context` binds the claimed ticket ID. `Read Dispatch Memory` supplies the initial context, and `Read Knowledge Identity` binds the IFC asset for retrieval. `One Capture Input` is reserved for photographs.
4. The agent sees ticket 1, already FM-authorized, with `UNINITIALIZED` dispatch. It calls `initialize_dispatch`, which saves the ordered shortlist and appointment policy and queues the `opening` notice.
5. It calls `send_notice(notice_key="opening")`. The helper claims the message, sends it through Gmail and records the receipt. In the tests, Gmail is mocked.
6. It searches `Approved Asset Knowledge` using the door's reported alignment issue. Retrieval is constrained to this ticket's IFC object. It selects up to three verified chunk IDs, or `[]` when no relevant reference is available.
7. It calls `send_offer(technician_id=<first available candidate>, knowledge_chunk_ids="[]")` in the no-reference example. The helper independently checks eligibility, rank, capacity, authorization, deadlines and any chosen knowledge sources, then persists and sends the offer and records its receipt.
8. Fresh context shows `status=DISPATCHING`, `outcome=WAITING`, one live offer and no immediately pending notices. The agent finishes. `Verify Committed Outcome` checks PostgreSQL; `Release Dispatch Claim` releases the claim. **This execution of WF1 ends here.** It does not remain running for 48 hours.
9. Later the technician opens the email link (GET) and explicitly confirms acceptance (POST). `Record Offer Response` persists that decision. `Response Ticket Context` passes this exact ticket to the claim node. If it is already being processed, the persisted response remains available for recovery.
10. This new execution reads the saved context and calls `process_events`. The first valid persisted acceptance assigns the technician and queues `assigned:technician` and `assigned:fm` notices (and withdrawals if competing urgent offers exist).
11. The agent sends the pending notices through `send_notice`. Fresh context becomes `ASSIGNED`; the verifier checks it and releases the claim. **This later execution of WF1 ends.** The ticket remains visible in the non-closed overview. The technician's completion report starts WF2; CLOSED is reached only after that separate completion/approval process.

If a technician declines or an offer expires, a later execution processes that event and tries the next eligible candidate. Exhaustion or the urgent appointment cutoff causes guarded escalation. A model/service error is recorded as incomplete processing, not treated as a technician rejection.

## A–D audit corrections

- **A — Missing issue context:** Added asset, issue, category, severity, skill and authorization to the public context, plus the paginated non-closed overview.
- **B — Prompt/tool mismatch:** Removed agent ticket creation; clarified intake creation, prior FM authorization, post-approval notice and WF2 boundaries. The prompt names the seven actual tools: `get_context`, `initialize_dispatch`, `send_offer`, `send_notice`, `process_events`, `escalate`, and `Approved Asset Knowledge`.
- **C — Repeated large excerpts:** Replaced public offer objects with explicit safe summaries. Exact excerpts remain stored for auditing and composing emails, but do not get echoed in each context response. Helpers' fresh results are reused.
- **D — Missing workflow IDs:** Rebound all ten direct/nested helper references to the actual imported workflow IDs, including receipt/failure helpers and the two WF2 helpers. `cbm/imported-workflow-ids.json` keeps preparation aligned with this installation.

## Installation and remaining setup

See [the current OpenRouter installation status](../wf1/READ-ME-OPENROUTER.md). WF1 now uses OpenRouter with a verified replacement key; the knowledge SQL and vector nodes connect to ISTEA_Group1.

**Correction to the previous installation note:** `Postgres account 2` connects to an older Supabase project with no CBM application tables. The tested application migrations are in the bundled local PostgreSQL database. Choosing the ticket/report database and rebinding the application nodes remains pending; the credential name alone did not establish the correct destination.

The 14 CBM workflow drafts remain inactive/unpublished. Refresh the editor before reviewing them. Publishing the main workflow and its called helpers is still required when ready to run the demo; this enables the Drive and scheduled triggers. The installed n8n runtime requires published sub-workflow targets.

The historical isolated PostgreSQL and n8n tests below remain relevant to the queue design. The current OpenRouter guide records the new live model tests and their limits.

## Verification and recovery

- 20 dispatch regressions passed, including guarded ranking/capacity, simulated Gmail delivery, receipt uncertainty, concurrent updates, expiry, escalation and assignment.
- 9 queue/context tests passed, including all non-closed statuses, authorization, four-new/one-old ordering, rotation, expiring claims and compact context.
- Real PostgreSQL 16: four simultaneous batches claimed 17 distinct tickets with no duplicates; only one worker could start a given claim.
- Real n8n 2.29.9: five self-called children ran; the intentionally failing third child did not prevent children four and five from completing.
- All 14 installed inactive workflows were read back and matched the prepared nodes/connections. The live CBM ticket count remained zero before and after the update.

Evidence is in [validation](../../validation). Backups include `before-workflows/`, `before-deployment-files/` and `before-dispatch-database.dump`. The one-off installation script, `Install-DispatchQueueUpdate.ps1`, has been removed: later updates replaced its workflow snapshots, and `scripts/deployment/Apply-CbmIntakeMigration.ps1` now applies its queue and context SQL. Re-import a specific backed-up workflow by its existing ID to restore its draft; restore the database dump only if intentionally reverting the database as a whole.

The queue claim expires after 65 minutes and is renewed when its worker starts; WF1 has a 60-minute execution timeout. Normal and handled-failure paths release claims immediately. A crash before release is recovered after expiry. This protects overlapping selection; existing optimistic database updates and email claims still protect mutations and sends.

To inspect the stored context function:

```sql
SELECT pg_get_functiondef('public.cbm_dispatch_context(jsonb)'::regprocedure);
SELECT pg_get_functiondef('public.cbm_claim_dispatch_batch(integer)'::regprocedure);
```

Implementation: [queue SQL](../../database/dispatch_queue/schema_queue.sql), [context SQL](../../database/dispatch_queue/schema_context.sql), [agent system message](../../cbm/dispatch_queue/system-message.txt).
