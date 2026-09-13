# WF2: report-first completion, optional photograph, supervised closure

WF2 previously treated the **photograph** as the completion: a Drive upload named
`TICKET-<id>.jpg` triggered a before/after vision comparison, and that comparison was the
only assessment. The completion contract is now the other way round — the **written report
is mandatory and the photograph optional** — and the closure that follows the facility
manager's approval is carried out by a supervising agent rather than a fixed node chain.

```
Completed Upload (Drive Trigger)      TICKET-<id>.pdf
  └ Extract Ticket ID                 a lone photograph ends the run quietly
    └ Fetch Ticket                    joins technicians; aliases the email fields
      └ Download Report PDF
        └ Extract Report Text         pdf-parse; grades OK / EMPTY / PARSE_ERROR
          └ Find AFTER Photo          searches the folder for a matching image
            └ Photo Available?
               ├ yes → Download AFTER + BEFORE → Merge → Claude Vision → Parse Verification ┐
               └ no  ────────────────────────────────────────────────────────────────────── ┤
                                                                     Build Assessment Input ┘
                                                                     └ Assess Completion (Report)   ← mandatory
                                                                       └ Parse Completion Assessment
                                                                         └ Set Pending Approval
                                                                           └ FM Approval (Email + Wait)
                                                                             └ FM Approved?
                                                                                ├ yes ┐
                                                                                └ no  ┴ Closure Context
                                                                                        └ Closure Supervisor  (agent, 9 tools)
                                                                                          └ Verify Closure Outcome
                                                                                            └ Closure Settled?
                                                                                               ├ yes → Closure Recorded
                                                                                               └ no  → Notify FM - Closure Needs Attention
```

## Why a chain reads the report, not an agent

`Assess Completion (Report)` is an **LLM chain**, not an agent. It makes one decision from
one body of text; it needs no tools and no multi-step reasoning, so an agent would add
latency and nondeterminism and buy nothing. The agent appears where it earns its place:
after approval, where operations can fail for reasons a fixed chain cannot recover from.

**The model proposes a status; `Parse Completion Assessment` decides it.** The chain returns
one of `PENDING_APPROVAL`, `REWORK` or `NEEDS_TRIAGE`. Anything outside that vocabulary,
unparseable output, or a report that could not be read becomes `REWORK` with the reason
recorded — never a silent `PENDING_APPROVAL`, and never an invented status reaching SQL.
When the node overrides the model, the override reason leads the summary the facility
manager reads, so a confident model sentence never sits next to a status contradicting it.

A scanned or photographed report is graded `EMPTY`: `pdf-parse` is a text extractor, not an
OCR engine. Such a report cannot pass, whatever the model concludes about it.

## The closure supervisor

One agent handles both outcomes — the approved and rejected branches of `FM Approved?` both
enter `Closure Context`, which binds the ticket identity and the objective list. The agent
performs the same operations the seven replaced nodes did:

| Decision | Objectives |
|---|---|
| `APPROVED` | `log_ifc_maintenance` → `close_ticket` → `update_technician_stats` → notify technician → notify FM |
| `REJECTED` | `reopen_for_rework` → notify technician |

**Attempt budget: 3 per operation.** On failure the agent reads the error rather than
repeating the identical call. If the error names a missing column, an unknown relation or a
type mismatch, it calls `inspect_schema` — read-only, over `information_schema` — and retries
with corrected arguments. After three attempts it stops, continues with objectives that do
not depend on the failed one, and reports precisely what failed.

**The agent cannot execute free-form SQL.** Every database tool runs fixed parameterized SQL
with the ticket bound by the workflow; where the agent genuinely chooses something it does so
through a typed `$fromAI` argument (the IFC version string, the rejection reason, an email
body). This follows the rule already established for WF1's dispatch agent.

**Its report is not proof.** `Verify Closure Outcome` reads committed database state, and
`Closure Settled?` compares it against the decision. A ticket that did not reach `CLOSED` or
`REWORK` escalates to the facility manager with the attempt count and the agent's own account
of what went wrong. `CBM_WF2_ATTEMPT` and `CBM_WF2_NOTICE` events in `ticket_events` make
every retry auditable.

Database tools are idempotent — closing a closed ticket reports zero rows changed. **Email is
not**, so `check_notice` exists for the agent to consult before re-sending after an uncertain
result.

## Files

| File | Purpose |
|---|---|
| `build_wf2.py` | Rebuilds the workflow from `original_wf2.json`; re-runnable, and re-pins the fixture hash |
| `original_wf2.json` | The pristine export, byte-for-byte; the build reads this, never its own output |
| `validate_wf2.py` | Structural checks: dangling connections, unresolved `$('Node')` expressions, reachability, agent wiring |
| `test_wf2_nodes.mjs` | Behavioural tests for the Code nodes, run against the JavaScript stored in the export |
| `test_migration.mjs` | Applies `schema.sql` + `schema_wf2_completion.sql` to PGlite and exercises every statement WF2 and the tools run |

```powershell
node phase_b\setup-test-runtime.js   # once: installs the PGlite engine the SQL tests need
python wf2\build_wf2.py
python wf2\validate_wf2.py
node wf2\test_wf2_nodes.mjs
node wf2\test_migration.mjs
node phase_b\test-dispatch.js        # WF2 is hash-pinned there; the build re-pins it
```

`test_migration.mjs` and `test-dispatch.js` both run against PGlite, which lives in the
Git-ignored `phase_b/.test-runtime/`. Run `setup-test-runtime.js` once per clone.

## Before importing

1. Apply the migration: `psql -v ON_ERROR_STOP=1 -d cbm -f schema_wf2_completion.sql`.
   It is additive and idempotent. It is deliberately **not** in `database/migrations/`, which
   `migrate.py` reserves for the 27-table `cbm` schema.
2. Replace `REPLACE_WITH_COMPLETED_FOLDER_ID` in both the trigger and `Find AFTER Photo`, and
   the credential placeholders, as with every export here.
3. Technicians upload `TICKET-<id>.pdf`. A photograph may accompany it under the same
   `TICKET-<id>` stem, in any order; only the report starts an assessment.

## Known limits

- **The legacy contract.** These queries target the tables in `schema.sql`, which is what WF1
  writes to. `database/` holds a newer 27-table `cbm` schema whose `completion_submissions`,
  `assessments` and `approval_requests` model this flow more precisely, and whose
  `ifc_sync_attempts` and `message_attempts` carry native attempt tracking. Column names here
  were chosen to mirror it, so that migration is a rename rather than a redesign. Note that
  `cbm.assessments` currently requires `after_file_id` for a `REPAIR_VERIFICATION`, which an
  optional photograph contradicts; that CHECK needs relaxing before the flow moves across.
- **Email idempotency is advisory.** `check_notice` and the recorded `CBM_WF2_NOTICE` events
  let the agent avoid a double send, but nothing enforces it at the transport, unlike
  `cbm.messages.idempotency_key`.
- **Untested against live services.** Everything here is verified offline: the Code nodes
  against their stored source, the SQL against PGlite. The agent's recovery behaviour, Gmail
  delivery and the IFC service call still need a run against the real instance.
