# WF1 Phase B implementation

The modified import file is **`../wf1_ticket_intake_and_dispatch.json`**. The original file is backed up byte-for-byte in `original_wf1.json`. Only the Phase B part of WF1 was replaced. All 15 original nodes through `Parse Triage JSON`, their outgoing connections, WF2, and `schema.sql` are preserved.

## Implemented behavior

| Ticket | Live offers per ticket | Offer expiry | Scheduling |
|---|---:|---|---|
| Ordinary, severity 1–3 | 1 | 48 elapsed hours from the recorded send acknowledgement | Fixed 14:00–16:00 business-day slot, after the response window |
| Urgent, severity 4–5 | Up to 2 | Earlier of 48 hours or the appointment start | Original next-business-day 08:00–10:00 slot; never postponed |

The first valid, persisted acceptance wins one assignment. Competing offers are withdrawn. A denial or expiry allows the next ranked candidate to be contacted while the appointment policy permits it. The shortlist remains five technicians, filtered by active status, matching skill and `building-A`, ordered by workload, oldest assignment with never-assigned first, rating, and ID for exact ties.

For ordinary offers, the original two-business-day date is retained when it leaves the full response window. A later offer receives the earliest suitable business-day afternoon slot after its own window, with a small send margin. Each email states its fixed date. This avoids sending a later candidate an appointment that already passed, without reducing the ordinary 48-hour response window. Business days exclude weekends, matching the source; public holidays are not modeled.

The FM receives the opening notice and assignment or escalation notice. The winner receives confirmation and the original completion-photo instructions. Outstanding urgent candidates receive withdrawal notices. WF2 remains responsible for completion approval and IFC updates.

## Agent, tools, and durable memory

`Dispatch Agent` uses an Anthropic Chat Model, initially `claude-sonnet-4-6`, matching the provider/model already used in Phase A. Temperature is 0, the output limit is 2,000 tokens, and each event has a maximum of 12 agent iterations. The full configured system message is in `system-message.txt` and embedded in the JSON.

Seven attached tools perform the operations: `create_ticket`, `get_context`, `send_opening`, `offer_next`, `process_events`, `send_notices`, and `escalate`. Each tool contains an inline workflow with the necessary Code/Postgres/Gmail nodes. The model chooses the operation; it cannot supply arbitrary SQL, recipients, dates, tokens, or a different ticket. Credentials belong to n8n, not the model prompt. See `embedded-operation.example.json` for a readable representative tool definition; do not import that file as another production workflow.

Memory is the existing PostgreSQL data, exposed by `get_context` and loaded before and after the agent. No chat-memory table or schema migration is needed. Append-only `CBM_DISPATCH_STATE` events hold bounded state snapshots and audit entries; `CBM_SOURCE` records upload identity; `CBM_RESPONSE` records verified responses. `get_context` omits response tokens and email bodies. Stored capability tokens and message content remain sensitive database/execution data and should only be accessible to workflow operators.

Tools are serialized through optimistic concurrency checks on the ticket row. Each state commit checks the exact database revision, updates the ticket and appends the state event atomically. A losing operation reloads and retries up to five times. Response recording also changes the revision, so an older timeout calculation cannot erase a timely acceptance. Creation uses a short transaction-level table lock to serialize duplicate checks without changing the schema. This protects participating WF1 paths; the original non-unique index does not enforce uniqueness against arbitrary external writers.

## Response and waiting implementation

The email links open a read-only confirmation page. Only submitting Accept or Deny by POST records a response. The links bind the ticket, offer, and a random capability token; the database validates status and expiry. A repeated or stale response cannot accept another technician's offer. The browser receives a receipt immediately; an assignment is confirmed separately by email after the agent processes the event.

The implementation uses **persisted deadlines, response webhooks, and a recovery Schedule Trigger inside WF1** instead of one shared long-running Wait node. This is the concrete implementation of the planned wait/recovery function. Two urgent responses can arrive independently, including while the agent is busy. No LLM request stays open for 48 hours. The recovery SQL checks every minute and launches an agent only for due work. Normal uploads and responses invoke the agent immediately.

The recovery tick processes one ticket per minute, appropriate for this PoC. A backlog can delay timeout processing and notifications, but the SQL deadline check rejects late responses immediately. At larger volume, scale the recovery dispatcher deliberately while retaining one ticket per agent invocation. WF1 must be active/published for the production webhooks and schedule to operate.

## Configure and import

1. Create or identify the existing n8n **Postgres**, **Gmail OAuth2**, and **Anthropic** credentials. The Postgres account needs SELECT/INSERT/UPDATE on the existing tables, sequence access for inserts, and sufficient permission for the short creation lock. There are no CREATE TABLE or extension requirements beyond the existing PostgreSQL 14+ schema.
2. Copy `deployment.example.json` to `deployment.local.json`. Set the FM address, n8n credential IDs/names, and `callbackBase` to your public production webhook prefix, for example `https://n8n.example.org/webhook`. Include any deployment subpath before `/webhook`; do not use `/webhook-test`. These are references/configuration, not API keys or database passwords.
3. Run the following commands from this `phase_b` directory:

   ```powershell
   node .\build-workflow.js .\deployment.local.json
   node .\test-dispatch.js
   ```

4. Import the updated `wf1_ticket_intake_and_dispatch.json` into your intended WF1 and review credential resolution. The builder propagates credentials into the embedded tools as well as the visible Phase B nodes. It refuses to overwrite if any preserved Phase A node or connection differs from the reviewed source. Rebuilding replaces Phase B from the checked-in helper files, so make durable Phase B edits in those helpers.
5. Check node availability in your n8n version: AI Agent v2, Anthropic Chat Model v1.3, Call n8n Workflow Tool v2.1, Execute Sub-workflow v1.2, Postgres v2.6, Gmail v2.1, Schedule Trigger v1.2, Webhook v2, and Respond to Webhook v1.4. The user's n8n version was not supplied; actual import/runtime compatibility remains to be checked in that instance. Do not silently remap missing node versions.
6. Test in a separate test database and controlled Gmail mailbox first, including two urgent offers and an acceptance/expiry race, then activate/publish WF1. Do not run the old and new active WF1 against the same intake simultaneously. The existing Phase A placeholders and credentials remain exactly as supplied and still require their normal project setup.

The supplied JSON still contains deployment placeholders. No live database connection, Gmail delivery, model invocation, import, or activation was performed here.

## Failure handling and recovery

Each normal email has a persisted send claim and a Gmail receipt. Known-success operations are not sent again. A failed or missing receipt becomes uncertain delivery and stops automatic resends; claims without receipts are detected after five minutes. PostgreSQL and Gmail do not share a transaction, so this does not claim exactly-once email delivery. An email already in flight can arrive after its offer was withdrawn, but its link cannot secure an assignment.

The verification branch checks committed state rather than trusting the agent's final words. Incomplete initialized dispatches get at most three failed invocations before halting for operator attention. A deterministic error branch attempts to notify the FM when intervention is required, then marks the n8n execution failed. If Gmail itself is unavailable, that notification can also fail; the n8n failure remains visible. Failure before a ticket has initialized requires retrying the failed intake execution rather than waiting for a recovery record that does not yet exist.

To recover uncertain delivery, first inspect the failed child execution and Gmail Sent records. If a send succeeded, its receipt must be reconciled to the existing claim; do not resend the message or reset the ticket. `dispatchPolicy` has an internal `ack` operation for recording that verified receipt; it is deliberately not an agent-selectable tool. An operator can use a controlled copy of the embedded operation with `operation: "ack"`, the existing ticket ID, and `receipt: { key, claim, message_id }` from the recorded claim/provider receipt. After resolving all uncertainties, review and clear the halt in a controlled state transition before resuming. Automatic reconciliation that guesses whether a mail was delivered is intentionally absent.

If a deployment update is needed, finish or explicitly reconcile outstanding offers first. Restore `original_wf1.json` only as a workflow rollback; it cannot undo sent emails or database state.

## Validation

`validation-report.json` records the completed checks. The tests use PGlite 0.5.8, a PostgreSQL WASM runtime, with the actual project schema and actual implementation SQL. They exercise the policy and embedded Code/SQL/If execution paths; Gmail is mocked and the agent tool choice is scripted. They are not a live n8n-engine or real-model integration test, and competing transactions are tested through overlapping snapshots rather than independent PostgreSQL server sessions.

The isolated test runtime is in `.test-runtime`, excluded from version control. To install it again:

```powershell
node .\setup-test-runtime.js
node .\test-dispatch.js
```

The installer downloads a pinned package from the npm registry, verifies its SHA-256, and extracts it locally. Node.js with built-in `fetch` and `tar` are required.

The checks cover source preservation, idempotent creation, ranking and eligibility, concurrency caps, a single winner, stale/replayed/forged links, response-versus-timeout conflicts, ordinary 48-hour offers, urgent cutoffs, Rome DST/weekends, candidate exhaustion, send uncertainty, crash recovery, bounded retries, downstream-state preservation, generated expression syntax and tool-graph execution.

Pre-existing out-of-scope issue: WF2 references columns such as `after_file_id`, `verification`, `closed_at`, `ifc_version`, and technician `jobs_completed` that are absent from this directory's `schema.sql`. Those files were not changed; this implementation does not certify the full project's WF2/database compatibility.

## n8n references used

The node configuration was checked against the official [Tools Agent](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/tools-agent/), [Call n8n Workflow Tool](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolworkflow/), and [Postgres](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.postgres/) documentation and corresponding public n8n source. The confirmation form uses an absolute POST URL, as required for forms in the HTML response sandbox described by [Respond to Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.respondtowebhook/).
