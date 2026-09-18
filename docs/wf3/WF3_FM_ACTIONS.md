# WF3: FM decisions from chat

The existing WF3 agent has five additional workflow tools. Its read tools, model,
memory, authentication and weekly report remain in place.

| Tool | Valid request and result |
|---|---|
| `approve_intervention` | Initial authorization: `PENDING_AUTHORIZATION → LOCALIZED`; existing WF1 recovery handles dispatch. |
| `reject_intervention` | Initial authorization: `PENDING_AUTHORIZATION → REJECTED`, with the FM's reason. |
| `resend_approval_email` | Send another actionable approval request for the current initial or completion approval. No status change. |
| `approve_completion` | Approve completed work, run the existing IFC helper, then `CLOSED` only with its persisted success/version; update statistics and send existing notices. |
| `request_rework` | Completion review: `PENDING_APPROVAL → REWORK`, with a reason and the existing technician report link. |

Examples: “Approve the intervention for the latest ticket”; “Reject ticket #4
because the reported issue is outside our scope”; “Resend the approval email for
ticket #5”; “Approve completed work on ticket #6”; “Request rework on ticket #7:
the valve still leaks”. The agent resolves the ticket and reads its current
approval ID and revision first. It asks for clarification if the ticket, stage or
required reason is missing. “Latest” means creation time descending, ID descending;
it does not silently select an older eligible ticket.

## Subworkflows

- **[CBM] WF3 - Guarded FM Ticket Action** (`cbmWf3TicketAction`): one shared
  action executor called by all five tools. It validates the request, locks and
  rechecks the ticket, records the decision, performs the applicable existing
  operations and returns the committed outcome.
- **[CBM] WF3 - Completion Approval Email** (`cbmWf3ApprovalMail`): prepares and
  sends a completion approval email, records Gmail's message ID and serves its
  confirmation page. The resend tool enters here and first calls the shared
  action helper; initial authorization resends return its WF1 outbox result.
  GET never changes a ticket. POST applies the decision via
  the same guarded action executor. Links expire after 72 hours and become invalid
  after a decision or replacement report. Requires publishing for its webhooks.

Existing reused operations, unchanged:

- `cbm_authorize_dispatch()` and the WF1 intake mail outbox.
- **WF2 Guarded IFC Write** (`eqrcZZLPvsjRgCUR`).
- `cbm_wf2_close_ticket()` and the existing database closure trigger.
- WF2's parameterized rework and technician statistics queries.
- **WF2 Notify FM from Stored Result** (`3sdjXyXedBKiDGXD`), for both FM and technician.
- `cbm_wf2_closure_outcome()`, including actual notification receipts.

WF3 has no action to set `DISPATCHING` or `ESCALATED`. These may still appear as
historical/current states controlled by WF1, which is outside this change.
WF1, WF2 and all existing helper definitions are retained. The migration adds
WF3-specific functions, an audit index and an email claim table.

## Outcome and retry behavior

- `APPLIED`: the action's required operations finished.
- `QUEUED`: initial approval email queued for WF1's notification recovery; not yet sent.
- `SENT`: Gmail returned a message ID, recorded in PostgreSQL.
- `UNCONFIRMED`: the email attempt may have sent; never retry it automatically.
- `BLOCKED`: stale approval/revision, invalid state or conflicting decision.
- `INCOMPLETE`: decision recorded but remaining operations listed. IFC failure
  leaves the ticket `PENDING_APPROVAL`. Notice failure after successful closure
  leaves it `CLOSED`, with the missing notice reported explicitly.

Same-execution retries share a request key. Existing IFC operation keys, statistics
receipts and notice claims prevent repeating successful work. An approved completion
with an IFC failure can be resumed by another explicit “approve completed work”
request; it cannot be reversed into a rejection. The original WF2 email waiter may
remain visible until its own response/timeout, but the shared approval uniqueness
and state guards prevent a second conflicting decision.

## Verification

`cbm/app/wf3/actions/test_database.py` runs on an isolated schema copy. It checks
initial decisions, stale IDs/revisions, expired email links, concurrent opposite
decisions, rework, idempotency, successful IFC evidence before closure, statistics
and notification receipts. It never calls external APIs.
`test_nodes.cjs` validates workflow references, JavaScript, tool wiring, request
validation and escaped confirmation HTML.

Deployment verification: WF3 and both new helpers are published. The isolated
database suite passed 44 assertions. Workflow/code checks passed, including an
acyclic helper dependency graph. Live invalid-token GET and POST requests both
returned HTTP 409. Existing workflow definitions other than WF3 were unchanged.
No real ticket was approved, rejected or closed, and no real email was sent during
these tests; successful Gmail/IFC operations use the existing production helpers.

Do not rerun an older WF3 installer: it would restore its older saved definition.
The generated current definitions live in `cbm/app/wf3/actions/workflows` and the
regular configured WF3 export. The action migration is `actions/schema.sql`.
