# WF3: the facility manager's dashboard

## FM actions upgrade — 18 September 2026

WF3 now also acts on explicit FM requests through five guarded workflow tools:
`approve_intervention`, `reject_intervention`, `resend_approval_email`,
`approve_completion`, and `request_rework`. See [the action guide](../../../docs/wf3/WF3_FM_ACTIONS.md)
for states, helper reuse, email confirmation and retry behavior. The live chat uses
the user's current `n8nUserAuth` setting and 50-turn memory.

WF1 takes a fault report and dispatches a technician. WF2 takes the technician's
completion report and closes the ticket. Neither of them is a place to *ask a
question*. WF3 is: the facility manager is treated as a distinct user with a
surface of their own — a chat window over the whole ticket history, and a weekly
report that arrives whether or not anyone opens the chat.

```
FM Chat  (authenticated hosted chat)    Weekly Report Schedule  (Mondays 07:00)
  └ FM Chat Context                         └ Report Window          previous 7 days
    │ normalises the turn, fixes the           └ Collect Weekly Data one query,
    │ date anchors                                │                  one JSON document
    └ Question Asked?                             └ Build Weekly Report
       ├ no  → Empty Question Reply                  │ groups, marks, formats
       └ yes → FM Dashboard Agent                    └ Weekly Narrative  (LLM chain)
                 ├ FM Chat Model                        └ Compose Weekly Email
                 ├ FM Chat Memory   (50 turns)             └ Email Weekly Report
                 ├ 9 read-only tools                          └ Record Weekly Report
                 ├ 5 guarded action tools
                 └ Log FM Question
                   └ Chat Response
```

## The chat

**An agent, because the question is not known in advance.** WF2's report
assessment is a chain: one decision, one body of text, no tools. Here the shape of
the work depends on what was asked — "is #42 done?" is one lookup, "which of
Lucia's jobs have been open longest, and did any of them come back for rework?" is
three, and the second cannot be planned before the first returns. That is what an
agent is for.

**Read tools use fixed queries; action tools use guarded subworkflows.** Each direct database tool is a `SELECT` over fixed SQL. The
manager's words never become SQL: where the question decides something — a ticket
id, a status, a date bound — it arrives as a typed `$fromAI` argument bound into a
placeholder. `validate_wf3.py` refuses an export in which a direct database tool holds a writing
verb, fails to bind its parameter, or accepts an argument named `sql`, `query`,
`where` or `filter`; `test_wf3_queries.mjs` then runs all eight inside a
`READ ONLY` transaction, and proves the transaction has teeth by watching an
`UPDATE` be refused in it. The five action tools are explicitly validated as calls
to the shared WF3 helper. Its database functions validate state, current approval
and revision, and reuse the existing authorization and closure guards.

This matters more here than in WF1 or WF2. Those agents are driven by data the
system produced. This one is driven by a human typing into a box, and the box is
reachable over HTTP.

| Tool | Answers |
|---|---|
| `ticket_lookup` | everything about one ticket, including its completion report |
| `ticket_search` | the full history, filtered by status, technician, element, free text or date range |
| `ticket_counts` | how many tickets sit in each status, all time |
| `ticket_history` | one ticket's audit trail, with the status it moved from and to |
| `overdue_tickets` | still open after N days, default 30 — the report's definition |
| `technician_workload` | open, closed, average days to close, per technician |
| `throughput_stats` | opened and closed per week or month, for trend questions |
| `inspect_schema` | read-only column listing, for recovering from a failed call |

`inspect_schema` is the same diagnostic WF2's supervisor holds, and for the same
reason: when a tool fails because a column moved, the agent should correct itself
and retry — at most three times — rather than tell the facility manager it does
not know.

**Dates are decided once, in code.** `FM Chat Context` stamps every turn with
`now`, `week_start` and `month_start` as ISO timestamps, and the system message
forbids passing words like "last week" to a tool. A model left to work out dates
from a prompt will not agree with SQL that computes them from `now()`, and the
disagreement would surface as the chat and the weekly report quoting different
numbers for the same week.

An empty turn is answered with examples and never reaches the model. A question
over 1500 characters is cut, and the reply says so. Questions are logged as
`CBM_WF3_QUERY` events — the only thing the chat branch writes, and it writes it
through a parameterized node, not through the agent.

## The weekly report

**Mondays at 07:00, covering the previous seven days.** The window is fixed rather
than derived from the last run, so a report can be re-run by hand and produce the
same figures; the window is recorded with each run, so a skipped week is visible
in `ticket_events` instead of being silently absorbed.

**"Changed status" is a recorded fact, not an inference.** The legacy schema keeps
only the current status, and `updated_at` also moves when a report is stored or a
photograph attached — so filtering on it would put the wrong tickets in front of
the manager. `schema_wf3_dashboard.sql` installs a trigger that writes one
`CBM_STATUS_CHANGED` event per real transition, carrying the status it came from
and went to. WF1 and WF2 need no change and cannot forget to log: a correction
typed into `psql` is captured too.

A ticket that moved twice in the week is one line showing the path
(`RECEIVED -> ASSIGNED -> CLOSED`), not three lines to reassemble.

**Tickets open longer than 30 days are listed and marked**, ordered oldest first,
each with its age and how long since anything last happened to it. The report also
counts how many of them did not move at all during the week — movement is not
progress, and a ticket that has been bouncing between `REWORK` and `ASSIGNED` for
two months still appears here.

**One query, not three.** `Collect Weekly Data` returns the whole report as a
single JSON document in one execution. Three separate query nodes chained together
would each re-run once per input row of the one before; run in parallel they would
need merging. One document avoids both.

**The model writes the covering paragraph and nothing else.** Every figure is
computed in SQL and formatted in code. `Weekly Narrative` is given the finished
counts and no ticket text, and is told not to introduce a number that is not in
front of it. `Compose Weekly Email` discards its output if it comes back as JSON,
as a heading, or over 1200 characters, escapes what survives, and sends the report
either way. A model outage costs the opening paragraph; it does not delay or
shorten the report.

## Files

| File | Purpose |
|---|---|
| `build_wf3.py` | The workflow's source. Generates `n8n_wf3_fm_dashboard.json` and re-pins the fixture hash |
| `validate_wf3.py` | Structure: dangling connections, unresolved `$('Node')`, reachability, agent wiring, and the read-only boundary |
| `test_wf3_nodes.mjs` | Behavioural tests for the Code nodes, run against the JavaScript stored in the export |
| `test_wf3_queries.mjs` | Applies all three schema files to PGlite and runs every query the workflow ships, against a fixture with controlled ticket ages |

```powershell
python wf3\build_wf3.py
python wf3\validate_wf3.py
node wf3\test_wf3_nodes.mjs
node wf3\test_wf3_queries.mjs
node phase_b\test-dispatch.js     # WF3 is hash-pinned there; the build re-pins it
```

There is no `original_wf3.json`: WF3 was never exported from n8n, so `build_wf3.py`
is the baseline. Edit the builder and re-run it; do not edit the JSON.

## Before importing

1. Apply the migrations in order. WF3's own migration refuses to apply without
   WF2's and says so, rather than failing later inside a workflow run:

   ```powershell
   psql -v ON_ERROR_STOP=1 -d cbm -f schema.sql
   psql -v ON_ERROR_STOP=1 -d cbm -f schema_wf2_completion.sql
   psql -v ON_ERROR_STOP=1 -d cbm -f schema_wf3_dashboard.sql
   ```

2. Replace the credential placeholders, as with every export here:
   `REPLACE_POSTGRES_CREDENTIAL_ID`, `REPLACE_GMAIL_CREDENTIAL_ID`,
   `REPLACE_ANTHROPIC_CREDENTIAL_ID` and `REPLACE_CHAT_AUTH_CREDENTIAL_ID` — the
   last is a Basic Auth credential holding the facility manager's chat login.
   Change `facility.manager@example.com` to the real recipient.

3. **Give the dashboard its own database role.** The code forbids writing; the
   database should too, so that a future edit cannot quietly widen what the chat
   can reach:

   ```sql
   CREATE ROLE cbm_dashboard LOGIN PASSWORD '…';
   GRANT CONNECT ON DATABASE cbm TO cbm_dashboard;
   GRANT USAGE ON SCHEMA public TO cbm_dashboard;
   GRANT SELECT ON tickets, technicians, ticket_events TO cbm_dashboard;
   GRANT INSERT ON ticket_events TO cbm_dashboard;   -- audit rows only
   GRANT USAGE ON SEQUENCE ticket_events_id_seq TO cbm_dashboard;
   ```

   If you bind that role, the eight tool nodes and the two audit nodes are the
   only things it can do. WF1 and WF2 keep the existing read-write credential.

4. Activate the workflow. The chat URL appears on the `FM Chat` node once it is
   saved; the schedule fires only when the workflow is active.

## Known limits

- **History begins at the migration.** Status changes before the trigger was
  installed were never recorded, so the first weekly report's "changed status"
  section covers only the period since. Everything read from the `tickets` table —
  counts, ages, the overdue list, technician workload — is exact from the first
  run, because it does not depend on the event stream.
- **The legacy contract.** As with WF2, these queries target the tables in
  `schema.sql`. The newer 27-table `cbm` schema under `database/` models status
  history natively; when the workflows move across, `CBM_STATUS_CHANGED` becomes a
  read of that history rather than a trigger of its own.
- **The week is a wall-clock window, not a ledger.** If the schedule does not fire
  — n8n down, workflow deactivated — that week's changes are not carried into the
  next report. The gap is detectable from the recorded `CBM_WF3_REPORT` windows,
  but nothing closes it automatically.
- **Row caps are silent to the reader, not to the agent.** `ticket_search` returns
  at most 100 rows and the weekly report at most 500 changes and 200 overdue
  tickets. The agent is told to say when a list was capped; the email is not, and
  a facility with more than 200 month-old tickets has a larger problem than the
  formatting.
- **Untested against live services.** Everything here is verified offline: the Code
  nodes against their stored source, the SQL against PGlite. The hosted chat
  surface, Basic Auth, Gmail delivery, and the agent's tool selection still need a
  run against the real instance.


## 2026.09.17 IFC agent tool

The FM agent has a ninth tool, `inspect_ifc_maintenance`, backed by the saved
`[CBM] WF3 - Inspect IFC Maintenance` helper. Ask in chat for the latest maintained
asset or a list. It returns actual IFC records enriched with matching technician
work, supports filters and pages of up to 20, and pins the IFC version across pages.
The previous standalone manual inspection branch has been removed. See
`../../../WF3_IFC_INSPECTION.md` for the current setup and testing instructions.
The helper uses the existing CBM Postgres credential; a separately restricted role
would additionally need SELECT on `cbm_technician_submissions`. `FM Chat` uses the
dedicated **FM Chat Login** Basic Auth credential; the MultiSet **Unnamed credential**
is not shared with the chat. The helper has passed a real read-only execution.

## 2026.09.14 review corrections

The schedule is explicitly Europe/Rome (Monday 07:00), with Rome dates in the chat anchors and email. The query timestamps retain explicit ISO offsets. The weekly window remains seven elapsed days; across DST that is not necessarily the same local wall-clock hour. Both limited weekly CTEs order oldest-first with stable ID tie-breakers. Basic Auth must be served over TLS; restrict the FM chat route by IP or SSO at the reverse proxy before wider use. See deployment/nginx.conf.example.
