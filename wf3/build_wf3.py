"""Build WF3, the facility manager's dashboard.

WF3 is not a rebuild of an existing export: it is generated from nothing, so this
script is the workflow's source and `n8n_wf3_fm_dashboard.json` is its output.
Re-running it reproduces that file byte for byte.

Two entry points, one workflow
------------------------------
1. **A chat interface over the whole ticket history.** A chat trigger, an agent
   with conversation memory, and read-only tools. The facility manager asks in
   plain language; the agent answers only from tool results.

   Every tool runs fixed, parameterized SQL. Where the question decides something
   - a ticket id, a status filter, a date bound - it arrives as a typed `$fromAI`
   argument bound into a placeholder, never as SQL text. That is the rule already
   established by WF1's dispatch agent and WF2's closure supervisor, and here it
   is also the injection boundary: on the other side of this agent is a human
   typing into a chat box.

   Every tool is a SELECT. `validate_wf3.py` enforces both properties.

2. **A weekly report.** A schedule trigger, one query returning the entire report
   as a single JSON document, and a deterministic formatter. The figures are
   computed in SQL; the model only writes the covering paragraph, and if the model
   fails the email still goes out complete.

   "Changed status this week" is read from the CBM_STATUS_CHANGED events that
   `schema_wf3_dashboard.sql` installs a trigger to write - not inferred from
   updated_at, which also moves when a report or a photograph is attached.

   Tickets still open a month after they were raised are listed separately and
   marked. That section is the part of the report the manager is meant to act on.

Run:  python wf3/build_wf3.py
"""
from __future__ import annotations

import hashlib
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(ROOT, "runtime-bindings.json"), encoding="utf-8") as bindings_file:
    BINDINGS = json.load(bindings_file)
def credential(key):
    ref = BINDINGS["credentials"].get(key)
    if not ref or not ref.get("id"):
        raise ValueError("Missing n8n credential binding: " + key + "; configure cbm/app/runtime-bindings.json")
    return dict(ref)
WF3 = os.path.join(ROOT, "n8n_wf3_fm_dashboard.json")
TESTS = os.path.join(ROOT, "phase_b", "test-dispatch.js")

# Identical to WF2 so one deployment configures one set of credentials.
PG_CRED = {"postgres": credential("ticketPostgres")}
GMAIL_CRED = {"gmailOAuth2": credential("gmail")}
ANTHROPIC_CRED = {"anthropicApi": credential("anthropic")}
CHAT_CRED = {"httpBasicAuth": credential("dashboardBasic")}
FM_EMAIL = BINDINGS["fmEmail"]

# Fixed so the export is reproducible; n8n derives the hosted chat URL from it.
CHAT_WEBHOOK_ID = "3f1c9d40-6b2e-4a55-9f77-2c0d8e5b14aa"

MODEL = "claude-sonnet-4-6"
STALE_DAYS = 30           # "pending or not complete after a month"
WINDOW_DAYS = 7           # the weekly reporting window
HISTORY_TURNS = 50        # chat turns the agent remembers
MAX_QUESTION_CHARS = 1500


# ==========================================================================
# Read-only tool SQL
#
# One shape throughout: the single bind parameter is a JSON object, so a tool
# takes several optional arguments without the query changing shape. Optional
# values are normalised to NULL in a CTE rather than cast inline, because an OR
# does not guarantee short-circuit evaluation and an empty string would then
# raise on the cast instead of meaning "no filter".
#
# `FROM v` is not decoration: the Postgres tool node always sends its one
# replacement, so a query that never references $1 fails to bind.
# ==========================================================================

TICKET_LOOKUP_SQL = """WITH v AS (SELECT $1::jsonb AS p)
SELECT t.id, t.status, t.category, t.severity, t.description, t.required_skill,
       t.reporter_email, t.ifc_global_id, t.ifc_class, t.ifc_name, t.ifc_storey,
       t.ifc_new_version, t.map_code, t.vps_confidence,
       t.scheduled_date, t.scheduled_slot, t.fm_reject_reason,
       left(t.report_text, 2000) AS report_text, t.verification,
       t.created_at, t.updated_at, t.closed_at,
       date_part('day', now() - t.created_at)::int AS age_days,
       te.full_name AS technician_name, te.email AS technician_email,
       te.zone AS technician_zone
  FROM v, tickets t
  LEFT JOIN technicians te ON te.id = t.technician_id
 WHERE t.id = (v.p->>'ticketId')::int;"""

TICKET_SEARCH_SQL = """WITH v AS (SELECT $1::jsonb AS p),
     f AS (SELECT upper(NULLIF(v.p->>'status', ''))          AS status,
                  NULLIF(v.p->>'technician', '')             AS technician,
                  NULLIF(v.p->>'element', '')                AS element,
                  NULLIF(v.p->>'text', '')                   AS q,
                  NULLIF(v.p->>'openedAfter', '')::timestamptz  AS opened_after,
                  NULLIF(v.p->>'openedBefore', '')::timestamptz AS opened_before,
                  COALESCE(NULLIF(v.p->>'openOnly', '')::boolean, false) AS open_only,
                  LEAST(COALESCE(NULLIF(v.p->>'limit', '')::int, 25), 100) AS max_rows
             FROM v)
SELECT t.id, t.status, t.category, t.severity,
       left(t.description, 300) AS description,
       t.ifc_name, t.ifc_storey, te.full_name AS technician_name,
       t.created_at, t.updated_at, t.closed_at,
       date_part('day', now() - t.created_at)::int AS age_days
  FROM f, tickets t
  LEFT JOIN technicians te ON te.id = t.technician_id
 WHERE (f.status IS NULL OR t.status = f.status)
   AND (f.technician IS NULL
        OR te.full_name ILIKE '%' || f.technician || '%'
        OR te.email     ILIKE '%' || f.technician || '%')
   AND (f.element IS NULL
        OR t.ifc_name      ILIKE '%' || f.element || '%'
        OR t.ifc_storey    ILIKE '%' || f.element || '%'
        OR t.ifc_global_id = f.element)
   AND (f.q IS NULL
        OR t.description ILIKE '%' || f.q || '%'
        OR t.category    ILIKE '%' || f.q || '%')
   AND (f.opened_after  IS NULL OR t.created_at >= f.opened_after)
   AND (f.opened_before IS NULL OR t.created_at <  f.opened_before)
   AND (NOT f.open_only OR t.status NOT IN ('CLOSED', 'DUPLICATE', 'REJECTED'))
 ORDER BY t.created_at DESC
 LIMIT (SELECT max_rows FROM f);"""

TICKET_COUNTS_SQL = """WITH v AS (SELECT $1::jsonb AS p)
SELECT t.status,
       count(*)::int AS tickets,
       count(*) FILTER (WHERE t.created_at >= now() - interval '7 days')::int
         AS opened_last_7_days,
       count(*) FILTER (WHERE t.created_at < now() - interval '30 days'
                          AND t.status NOT IN ('CLOSED', 'DUPLICATE', 'REJECTED'))::int
         AS open_over_30_days,
       min(t.created_at) AS oldest,
       max(t.updated_at) AS last_activity
  FROM v, tickets t
 GROUP BY t.status
 ORDER BY tickets DESC;"""

TICKET_HISTORY_SQL = """WITH v AS (SELECT $1::jsonb AS p),
     f AS (SELECT (v.p->>'ticketId')::int AS ticket_id,
                  LEAST(COALESCE(NULLIF(v.p->>'limit', '')::int, 50), 200) AS max_rows
             FROM v)
SELECT e.created_at, e.event,
       e.payload->>'from' AS status_from,
       e.payload->>'to'   AS status_to,
       left(e.payload::text, 400) AS payload
  FROM f, ticket_events e
 WHERE e.ticket_id = f.ticket_id
 ORDER BY e.created_at DESC, e.id DESC
 LIMIT (SELECT max_rows FROM f);"""

OVERDUE_SQL = """WITH v AS (SELECT $1::jsonb AS p),
     f AS (SELECT LEAST(GREATEST(COALESCE(NULLIF(v.p->>'olderThanDays', '')::int, 30), 1), 365)
                    AS stale_days
             FROM v)
SELECT t.id, t.status, left(t.description, 200) AS description,
       t.ifc_name, t.ifc_storey,
       te.full_name AS technician_name, te.email AS technician_email,
       t.created_at, t.updated_at,
       date_part('day', now() - t.created_at)::int AS age_days,
       date_part('day', now() - t.updated_at)::int AS days_since_last_change
  FROM f, tickets t
  LEFT JOIN technicians te ON te.id = t.technician_id
 WHERE t.status NOT IN ('CLOSED', 'DUPLICATE', 'REJECTED')
   AND t.created_at < now() - make_interval(days => f.stale_days)
 ORDER BY t.created_at
 LIMIT 200;"""

WORKLOAD_SQL = """WITH v AS (SELECT $1::jsonb AS p)
SELECT te.full_name, te.email, te.zone, te.active, te.rating, te.jobs_completed,
       count(t.id) FILTER (WHERE t.status NOT IN ('CLOSED', 'DUPLICATE', 'REJECTED'))::int
         AS open_tickets,
       count(t.id) FILTER (WHERE t.status = 'CLOSED')::int AS closed_tickets,
       count(t.id) FILTER (WHERE t.status NOT IN ('CLOSED', 'DUPLICATE', 'REJECTED')
                             AND t.created_at < now() - interval '30 days')::int
         AS open_over_30_days,
       round(avg(date_part('epoch', t.closed_at - t.created_at) / 86400.0)
             FILTER (WHERE t.closed_at IS NOT NULL)::numeric, 1) AS avg_days_to_close,
       te.last_assigned_at
  FROM v, technicians te
  LEFT JOIN tickets t ON t.technician_id = te.id
 GROUP BY te.id, te.full_name, te.email, te.zone, te.active, te.rating,
          te.jobs_completed, te.last_assigned_at
 ORDER BY open_tickets DESC, te.full_name;"""

THROUGHPUT_SQL = """WITH v AS (SELECT $1::jsonb AS p),
     g AS (SELECT CASE WHEN lower(COALESCE(NULLIF(v.p->>'bucket', ''), 'week')) = 'month'
                       THEN 'month' ELSE 'week' END AS unit,
                  LEAST(GREATEST(COALESCE(NULLIF(v.p->>'buckets', '')::int, 12), 1), 52) AS n
             FROM v),
     span AS (SELECT g.unit,
                     date_trunc(g.unit, now()) - (g.n::text || ' ' || g.unit)::interval
                       AS from_ts
                FROM g),
     opened AS (SELECT date_trunc(s.unit, t.created_at) AS bucket, count(*)::int AS opened
                  FROM span s, tickets t
                 WHERE t.created_at >= s.from_ts
                 GROUP BY 1),
     closed AS (SELECT date_trunc(s.unit, t.closed_at) AS bucket, count(*)::int AS closed
                  FROM span s, tickets t
                 WHERE t.closed_at >= s.from_ts
                 GROUP BY 1)
SELECT to_char(COALESCE(o.bucket, c.bucket), 'YYYY-MM-DD') AS period_start,
       (SELECT unit FROM span) AS period,
       COALESCE(o.opened, 0) AS opened,
       COALESCE(c.closed, 0) AS closed
  FROM opened o
  FULL JOIN closed c ON c.bucket = o.bucket
 ORDER BY 1 DESC;"""

INSPECT_SCHEMA_SQL = """WITH v AS (SELECT $1::jsonb AS p)
SELECT c.table_name, c.column_name, c.data_type, c.is_nullable
  FROM v, information_schema.columns c
 WHERE c.table_schema = 'public'
   AND c.table_name IN ('tickets', 'technicians', 'ticket_events')
 ORDER BY c.table_name, c.ordinal_position;"""

# --- the weekly report, as one document ------------------------------------
# One query, one row, one JSON object. Three separate query nodes would each
# re-run per input item and would then need merging; this returns everything the
# formatter needs in a single execution.
WEEKLY_SQL = """WITH v AS (SELECT $1::jsonb AS p),
     w AS (SELECT (v.p->>'periodStart')::timestamptz AS from_ts,
                  (v.p->>'periodEnd')::timestamptz   AS to_ts,
                  LEAST(GREATEST(COALESCE(NULLIF(v.p->>'staleDays', '')::int, 30), 1), 365)
                    AS stale_days
             FROM v),
     changes AS (
       SELECT e.ticket_id, e.created_at AS changed_at,
              e.payload->>'from' AS status_from,
              e.payload->>'to'   AS status_to,
              t.status AS current_status,
              left(t.description, 200) AS description,
              t.ifc_name, t.ifc_storey,
              te.full_name AS technician_name,
              date_part('day', now() - t.created_at)::int AS age_days
         FROM w, ticket_events e
         JOIN tickets t ON t.id = e.ticket_id
         LEFT JOIN technicians te ON te.id = t.technician_id
        WHERE e.event = 'CBM_STATUS_CHANGED'
          AND e.created_at >= w.from_ts
          AND e.created_at <  w.to_ts
        ORDER BY e.created_at ASC, e.id ASC
        LIMIT 500),
     stale AS (
       SELECT t.id, t.status, left(t.description, 200) AS description,
              t.ifc_name, t.ifc_storey,
              te.full_name AS technician_name, te.email AS technician_email,
              t.created_at, t.updated_at,
              date_part('day', now() - t.created_at)::int AS age_days,
              date_part('day', now() - t.updated_at)::int AS days_since_last_change
         FROM w, tickets t
         LEFT JOIN technicians te ON te.id = t.technician_id
        WHERE t.status NOT IN ('CLOSED', 'DUPLICATE', 'REJECTED')
          AND t.created_at < now() - make_interval(days => w.stale_days)
        ORDER BY t.created_at ASC, t.id ASC
        LIMIT 200),
     by_status AS (SELECT t.status, count(*)::int AS tickets
                     FROM v, tickets t
                    GROUP BY t.status),
     totals AS (
       SELECT (SELECT count(*) FROM tickets)::int AS tickets_all_time,
              (SELECT count(*) FROM tickets t
                WHERE t.status NOT IN ('CLOSED', 'DUPLICATE', 'REJECTED'))::int AS open_now,
              (SELECT count(*) FROM w, tickets t
                WHERE t.created_at >= w.from_ts AND t.created_at < w.to_ts)::int
                AS opened_in_window,
              (SELECT count(*) FROM w, tickets t
                WHERE t.closed_at >= w.from_ts AND t.closed_at < w.to_ts)::int
                AS closed_in_window,
              (SELECT count(*) FROM w, tickets t
                WHERE t.status NOT IN ('CLOSED', 'DUPLICATE', 'REJECTED')
                  AND t.created_at < now() - make_interval(days => w.stale_days))::int
                AS stale_now)
SELECT jsonb_build_object(
         'period_start', (SELECT from_ts FROM w),
         'period_end',   (SELECT to_ts FROM w),
         'stale_days',   (SELECT stale_days FROM w),
         'totals',       (SELECT to_jsonb(totals) FROM totals),
         'by_status',    COALESCE((SELECT jsonb_agg(to_jsonb(by_status)
                                            ORDER BY by_status.tickets DESC)
                                     FROM by_status), '[]'::jsonb),
         'changes',      COALESCE((SELECT jsonb_agg(to_jsonb(changes)
                                            ORDER BY changes.changed_at)
                                     FROM changes), '[]'::jsonb),
         'stale',        COALESCE((SELECT jsonb_agg(to_jsonb(stale)
                                            ORDER BY stale.age_days DESC)
                                     FROM stale), '[]'::jsonb)
       ) AS report;"""

# --- the dashboard's own audit rows ----------------------------------------
# ticket_events.ticket_id is nullable, so a dashboard event that belongs to no
# single ticket needs no new table and no schema change.
LOG_QUESTION_SQL = """INSERT INTO ticket_events (ticket_id, event, payload)
VALUES (NULL, 'CBM_WF3_QUERY',
        jsonb_build_object('session', $1::text,
                           'question', $2::text,
                           'answer_chars', ($3::text)::int))
RETURNING id;"""

RECORD_REPORT_SQL = """INSERT INTO ticket_events (ticket_id, event, payload)
VALUES (NULL, 'CBM_WF3_REPORT', $1::jsonb)
RETURNING id;"""


# ==========================================================================
# Code node source
# ==========================================================================

CHAT_CONTEXT_JS = r"""// Normalise the chat turn, and fix the date anchors once.
//
// The agent must not work out what "this week" or "a month" means for itself:
// the chat and the weekly report have to agree, and a model that computes dates
// from a system prompt will not agree with SQL that computes them from now().
// Everything time-relative is decided here and handed over as an ISO string.
const t = $input.first().json;

const raw = String(t.chatInput != null ? t.chatInput : (t.question || ''))
  .replace(/\s+/g, ' ')
  .trim();
const question = raw.slice(0, 1500);
const sessionId = String(t.sessionId || t.sessionid || 'fm-default').slice(0, 120);

const now = new Date();
const iso = (d) => d.toISOString();
const back = (days) => iso(new Date(now.getTime() - days * 86400000));

return [{
  json: {
    sessionId,
    question,
    asked: question.length > 0,
    truncated: raw.length > 1500,
    now: iso(now),
    today: new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Rome',year:'numeric',month:'2-digit',day:'2-digit'}).format(now),
    timezone: 'Europe/Rome',
    week_start: back(7),
    month_start: back(30),
    stale_days: 30,
  },
}];"""

EMPTY_QUESTION_JS = r"""// An empty turn should not cost a model call.
return [{
  json: {
    output: [
      'Ask me anything about the maintenance tickets. For example:',
      '',
      '- what is the status of ticket 42?',
      '- which tickets are still open after a month?',
      '- how many tickets did we close last week?',
      '- what is Mario Rossi working on?',
      '- show me everything ever raised on the second-floor radiators',
    ].join('\n'),
  },
}];"""

CHAT_RESPONSE_JS = r"""// The chat trigger returns whatever the last node emits, so the answer is
// shaped here rather than left to depend on the logging node's output.
//
// The agent runs with continueRegularOutput: a tool failure it could not recover
// from produces no `output` rather than an error page in the chat window. Say so
// plainly instead of returning an empty bubble.
const ctx = $('FM Chat Context').first().json;

let answer = '';
try {
  answer = String($('FM Dashboard Agent').first().json.output || '').trim();
} catch (e) {
  answer = '';
}

if (!answer) {
  answer = 'I could not complete that lookup. The database or the model did not '
    + 'answer. Nothing was changed - this dashboard only reads. Please try again, '
    + 'or ask a narrower question.';
}

if (ctx.truncated) {
  answer += '\n\n_(Your question was longer than 1500 characters; only the first '
    + '1500 were used.)_';
}

return [{ json: { output: answer, sessionId: ctx.sessionId } }];"""

REPORT_WINDOW_JS = r"""// The reporting window: the seven days ending at the moment the schedule fires.
//
// Fixed rather than derived from the previous run, so a report can be re-run by
// hand and produce the same figures. The window is recorded with the report, so
// a skipped week is visible in ticket_events rather than silently absorbed.
const now = new Date();
const start = new Date(now.getTime() - 7 * 86400000);
const iso = (d) => d.toISOString();
const day = (d) => new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Rome',dateStyle:'medium',timeStyle:'short'}).format(d);

return [{
  json: {
    periodStart: iso(start),
    periodEnd: iso(now),
    periodLabel: day(start) + ' to ' + day(now) + ' (Europe/Rome)',
    staleDays: 30,
    generatedAt: iso(now),
  },
}];"""

BUILD_REPORT_JS = open(os.path.join(ROOT, "wf3", "build-weekly-report.js"), encoding="utf-8").read()

COMPOSE_EMAIL_JS = open(os.path.join(ROOT, "wf3", "compose-weekly-email.js"), encoding="utf-8").read()


AGENT_SYSTEM = """You are the CBM facility manager's dashboard. You answer questions about \
maintenance tickets for the facility manager, who is the only person who reaches you.

WHAT YOU CAN SEE
You read the maintenance database through the tools attached to you. They cover the whole \
history of tickets, not a recent window. You have no other source of truth: if a tool did \
not return it, you do not know it.

WHAT YOU MUST NOT DO
- Never state a ticket number, status, date, name or count that did not come from a tool \
result in this conversation. If you are unsure, run the lookup again rather than recalling it.
- Never say you have changed, closed, assigned, scheduled or escalated anything. You cannot: \
every tool you hold is read-only. If asked to act on a ticket, say plainly that this dashboard \
only reads, and that closures go through the approval workflow.
- Never guess at a ticket the manager referred to loosely. Search for it and show what you found.

HOW TO ANSWER
- Answer the question asked, then stop. A count is a sentence, not a table.
- Quote ticket numbers as #id so they can be looked up.
- When you list tickets, give id, status, age in days, element and technician, and order by \
whatever the question implies - usually oldest first for problems.
- When a result set is empty, say so explicitly. Do not fill the silence.
- If a search was capped by its row limit, say that the list is partial and how it was ordered.
- Use markdown tables only for five rows or more.

DATES
Every message carries today's date and ISO timestamps for one week and one month ago. Use those \
anchors. When you need a date filter, pass a full ISO timestamp; never pass words like \
"last week" to a tool. 'A month' means 30 days throughout this system, matching the weekly report.

TOOLS
- ticket_lookup: everything about one ticket, by number. Use it whenever a specific ticket is named.
- ticket_search: filter the full history by status, technician, element, free text or date range. \
Leave an argument out to not filter on it. Prefer one search with several filters over several \
searches.
- ticket_counts: how many tickets sit in each status, across the whole history.
- ticket_history: the audit trail of one ticket, newest first - who did what and when the status \
moved.
- overdue_tickets: tickets still open after a given number of days, default 30. This is the same \
definition the weekly report uses.
- technician_workload: open and closed counts, average days to close, and current load per technician.
- throughput_stats: tickets opened and closed per week or per month, for trend questions.
- inspect_schema: read-only column listing. Call it only when a tool fails with an error naming a \
missing column or an unknown relation, then retry the failed call with corrected arguments. Try any \
one failing operation at most 3 times, then explain what failed.

STATUS VOCABULARY
RECEIVED, NEEDS_TRIAGE, PENDING_AUTHORIZATION, REJECTED, LOCALIZED, DUPLICATE, DISPATCHING, ASSIGNED, ESCALATED, WORK_DONE, \
PENDING_APPROVAL, REWORK, CLOSED. A ticket is open unless it is CLOSED, DUPLICATE or REJECTED. Statuses are \
uppercase; pass them that way."""

NARRATIVE_NOTE = """Writes the opening paragraph of the weekly email from figures that are \
already final. It is given no database access and no ticket text it could quote from - only the \
counts computed by the query above."""


# ==========================================================================
# Node builders
# ==========================================================================

def node(name, ntype, params, x, y, version, extra=None):
    n = {"parameters": params, "name": name, "type": ntype, "typeVersion": version,
         "position": [x, y]}
    if extra:
        n.update(extra)
    return n


def pg_tool(name, description, sql, replacement, x, y):
    """A read-only tool: fixed SQL, one JSON bind parameter, no SQL from the model."""
    params = {
        "operation": "executeQuery",
        "query": sql,
        "options": {"queryReplacement": replacement},
        "descriptionType": "manual",
        "toolDescription": description,
    }
    return node(name, "n8n-nodes-base.postgresTool", params, x, y, 2.6,
                {"credentials": PG_CRED, "onError": "continueRegularOutput"})


def sticky(content, x, y, w, h, colour):
    return node("Sticky - " + content.split("\n")[0].lstrip("# ").strip(),
                "n8n-nodes-base.stickyNote",
                {"content": content, "width": w, "height": h, "color": colour},
                x, y, 1)


def serialize(wf):
    return json.dumps(wf, indent=2, ensure_ascii=False).encode("utf-8")


# ==========================================================================
# Build
# ==========================================================================

def main():
    nodes = []

    # ---- 1. the chat dashboard ------------------------------------------
    nodes += [
        node("FM Chat", "@n8n/n8n-nodes-langchain.chatTrigger", {
            "public": True,
            "mode": "hostedChat",
            "authentication": "basicAuth",
            "initialMessages": ("Facility manager dashboard.\n"
                                "Ask about any ticket, at any point in its history."),
            "options": {
                "responseMode": "lastNode",
                "title": "CBM - Facility Manager",
                "subtitle": "Maintenance tickets, full history",
                "allowFileUploads": False,
            },
        }, -720, -260, 1.1,
            {"credentials": CHAT_CRED, "webhookId": CHAT_WEBHOOK_ID}),

        node("FM Chat Context", "n8n-nodes-base.code",
             {"jsCode": CHAT_CONTEXT_JS}, -500, -260, 2),

        node("Question Asked?", "n8n-nodes-base.if", {
            "conditions": {
                "options": {"caseSensitive": True, "leftValue": "",
                            "typeValidation": "loose", "version": 2},
                "conditions": [{
                    "id": "wf3-question-asked",
                    "leftValue": "={{ $json.asked }}",
                    "rightValue": True,
                    "operator": {"type": "boolean", "operation": "true", "singleValue": True},
                }],
                "combinator": "and",
            },
            "options": {},
        }, -280, -260, 2.2),

        node("FM Dashboard Agent", "@n8n/n8n-nodes-langchain.agent", {
            "promptType": "define",
            "text": ('={{ "Facility manager question: " + $json.question '
                     '+ "\\n\\nToday is " + $json.today '
                     '+ ". Use these anchors for any date filter: now=" + $json.now '
                     '+ ", one week ago=" + $json.week_start '
                     '+ ", one month ago=" + $json.month_start + "." }}'),
            "options": {"systemMessage": AGENT_SYSTEM, "maxIterations": 12,
                        "returnIntermediateSteps": False},
        }, -40, -340, 2, {"onError": "continueRegularOutput"}),

        node("Empty Question Reply", "n8n-nodes-base.code",
             {"jsCode": EMPTY_QUESTION_JS}, -40, -140, 2),

        node("FM Chat Model", "@n8n/n8n-nodes-langchain.lmChatAnthropic", {
            "model": {"__rl": True, "mode": "id", "value": MODEL},
            "options": {"temperature": 0, "maxTokensToSample": 3000},
        }, -240, -80, 1.3, {"credentials": ANTHROPIC_CRED}),

        node("FM Chat Memory", "@n8n/n8n-nodes-langchain.memoryBufferWindow", {
            "sessionIdType": "customKey",
            "sessionKey": "={{ $('FM Chat Context').first().json.sessionId }}",
            "contextWindowLength": HISTORY_TURNS,
        }, -60, -80, 1.3),
    ]

    # The read-only tool belt. Two rows so the canvas stays legible.
    tools = [
        pg_tool("ticket_lookup",
                "Everything recorded about ONE ticket, including its report text, IFC element, "
                "technician, timestamps and age in days. Use whenever a specific ticket number is "
                "mentioned. Returns no rows if that ticket does not exist.",
                TICKET_LOOKUP_SQL,
                '={{ [JSON.stringify({ ticketId: $fromAI("ticket_id", '
                '"The numeric id of the ticket to look up", "number") })] }}',
                140, -80),

        pg_tool("ticket_search",
                "Search the FULL ticket history. Every argument is optional and omitting one "
                "means do not filter on it: status (exact, uppercase), technician (name or email "
                "fragment), element (IFC name, storey, or exact GlobalId), text (matched against "
                "description and category), opened_after / opened_before (ISO timestamps), "
                "open_only (true excludes CLOSED, DUPLICATE and REJECTED), limit (default 25, max 100). "
                "Newest first. Prefer one call with several filters over several calls.",
                TICKET_SEARCH_SQL,
                '={{ [JSON.stringify({ '
                'status: $fromAI("status", "Exact ticket status, uppercase, e.g. ASSIGNED or '
                'CLOSED. Omit to search all statuses", "string"), '
                'technician: $fromAI("technician", "Part of the technician name or email. Omit '
                'for any technician", "string"), '
                'element: $fromAI("element", "Part of the IFC element name or storey, or an exact '
                'IFC GlobalId. Omit for any element", "string"), '
                'text: $fromAI("text", "Words to look for in the fault description or category. '
                'Omit for any subject", "string"), '
                'openedAfter: $fromAI("opened_after", "Only tickets raised at or after this ISO '
                'timestamp. Omit for no lower bound", "string"), '
                'openedBefore: $fromAI("opened_before", "Only tickets raised before this ISO '
                'timestamp. Omit for no upper bound", "string"), '
                'openOnly: $fromAI("open_only", "true to exclude CLOSED, DUPLICATE and REJECTED tickets", '
                '"boolean"), '
                'limit: $fromAI("limit", "Maximum rows, default 25, capped at 100", "number") '
                '})] }}',
                360, -80),

        pg_tool("ticket_counts",
                "How many tickets are in each status across the whole history, with how many were "
                "opened in the last 7 days and how many in that status have been open more than "
                "30 days. Takes no arguments. Use for 'how many' questions rather than counting "
                "search results yourself.",
                TICKET_COUNTS_SQL,
                '={{ [JSON.stringify({ scope: "all" })] }}',
                580, -80),

        pg_tool("ticket_history",
                "The audit trail of ONE ticket, newest first: every recorded event, and for status "
                "changes the status it moved from and to. Use for 'what happened to', 'when was it "
                "assigned', 'how long has it been in this status'. limit defaults to 50, max 200.",
                TICKET_HISTORY_SQL,
                '={{ [JSON.stringify({ ticketId: $fromAI("ticket_id", '
                '"The numeric id of the ticket whose history is wanted", "number"), '
                'limit: $fromAI("limit", "Maximum events, default 50, capped at 200", "number") '
                '})] }}',
                800, -80),

        pg_tool("overdue_tickets",
                "Tickets still open after a given age, oldest first, with age in days and days "
                "since anything last changed on them. older_than_days defaults to 30, which is the "
                "same threshold the weekly report marks. Excludes CLOSED, DUPLICATE and REJECTED.",
                OVERDUE_SQL,
                '={{ [JSON.stringify({ olderThanDays: $fromAI("older_than_days", '
                '"Age threshold in days, default 30", "number") })] }}',
                140, 100),

        pg_tool("technician_workload",
                "Per technician: open tickets, closed tickets, how many of their open tickets are "
                "over 30 days, average days to close, rating, zone and when they were last "
                "assigned. Takes no arguments. Use for 'who is busiest', 'what is X working on' "
                "(then follow with ticket_search), and workload balance questions.",
                WORKLOAD_SQL,
                '={{ [JSON.stringify({ scope: "all" })] }}',
                360, 100),

        pg_tool("throughput_stats",
                "Tickets opened and closed per period, newest period first, for trend questions "
                "('are we keeping up', 'is the backlog growing'). bucket is 'week' or 'month' "
                "(default week); buckets is how many periods back, default 12, max 52.",
                THROUGHPUT_SQL,
                '={{ [JSON.stringify({ bucket: $fromAI("bucket", '
                '"Either week or month; default week", "string"), '
                'buckets: $fromAI("buckets", "How many periods back, default 12, max 52", '
                '"number") })] }}',
                580, 100),

        pg_tool("inspect_schema",
                "Read-only. The columns and types that actually exist on tickets, technicians and "
                "ticket_events. Call this only when another tool failed with an error naming a "
                "missing column or an unknown relation, then retry that call with corrected "
                "arguments. Cannot modify anything.",
                INSPECT_SCHEMA_SQL,
                '={{ [JSON.stringify({ scope: "all" })] }}',
                800, 100),
    ]
    nodes += tools

    nodes += [
        node("Log FM Question", "n8n-nodes-base.postgres", {
            "operation": "executeQuery",
            "query": LOG_QUESTION_SQL,
            "options": {"queryReplacement":
                        '={{ [$("FM Chat Context").first().json.sessionId, '
                        '$("FM Chat Context").first().json.question, '
                        'String(String($json.output || "").length)] }}'},
        }, 180, -340, 2.6,
            {"credentials": PG_CRED, "onError": "continueRegularOutput"}),

        node("Chat Response", "n8n-nodes-base.code",
             {"jsCode": CHAT_RESPONSE_JS}, 400, -340, 2),
    ]

    # ---- 2. the weekly report -------------------------------------------
    nodes += [
        node("Weekly Report Schedule", "n8n-nodes-base.scheduleTrigger", {
            "rule": {"interval": [{"field": "weeks", "triggerAtDay": [1],
                                   "triggerAtHour": 7, "triggerAtMinute": 0}]},
        }, -720, 420, 1.2),

        node("Report Window", "n8n-nodes-base.code",
             {"jsCode": REPORT_WINDOW_JS}, -500, 420, 2),

        node("Collect Weekly Data", "n8n-nodes-base.postgres", {
            "operation": "executeQuery",
            "query": WEEKLY_SQL,
            "options": {"queryReplacement": '={{ [JSON.stringify($json)] }}'},
        }, -280, 420, 2.6, {"credentials": PG_CRED, "alwaysOutputData": True}),

        node("Build Weekly Report", "n8n-nodes-base.code",
             {"jsCode": BUILD_REPORT_JS}, -60, 420, 2),

        node("Weekly Narrative", "@n8n/n8n-nodes-langchain.chainLlm", {
            "promptType": "define",
            "text": "={{ $json.narrative_prompt }}",
        }, 160, 420, 1.5, {"onError": "continueRegularOutput"}),

        node("Narrative Model", "@n8n/n8n-nodes-langchain.lmChatAnthropic", {
            "model": {"__rl": True, "mode": "id", "value": MODEL},
            "options": {"temperature": 0.2, "maxTokensToSample": 600},
        }, 140, 620, 1.3, {"credentials": ANTHROPIC_CRED}),

        node("Compose Weekly Email", "n8n-nodes-base.code",
             {"jsCode": COMPOSE_EMAIL_JS}, 380, 420, 2),

        node("Email Weekly Report", "n8n-nodes-base.gmail", {
            "sendTo": FM_EMAIL,
            "subject": "={{ $json.subject }}",
            "emailType": "html",
            "message": "={{ $json.html }}",
            "options": {"appendAttribution": False},
        }, 600, 420, 2.1, {"credentials": GMAIL_CRED}),

        node("Record Weekly Report", "n8n-nodes-base.postgres", {
            "operation": "executeQuery",
            "query": RECORD_REPORT_SQL,
            "options": {"queryReplacement":
                        '={{ [JSON.stringify($("Compose Weekly Email").first().json.record)] }}'},
        }, 820, 420, 2.6, {"credentials": PG_CRED, "onError": "continueRegularOutput"}),
    ]

    # ---- 3. canvas notes -------------------------------------------------
    nodes += [
        sticky("## 1 - Chat dashboard\n"
               "Hosted chat, Basic Auth. The facility manager asks in plain language; the agent "
               "answers **only** from tool results and **cannot write** - every tool is a SELECT "
               "with fixed SQL and typed `$fromAI` arguments.\n\n"
               "Questions are logged as `CBM_WF3_QUERY` events.",
               -760, -480, 460, 190, 4),

        sticky("## 2 - Read-only tool belt\n"
               "Eight tools over the **full** ticket history. `inspect_schema` exists so a tool "
               "failure naming a missing column can be diagnosed and retried rather than reported "
               "as 'I don't know'.\n\n"
               "No tool accepts SQL from the model.",
               140, -220, 880, 120, 7),

        sticky("## 3 - Weekly report\n"
               "Mondays 07:00, covering the previous 7 days.\n\n"
               "`Collect Weekly Data` returns the whole report as one JSON document in one "
               "execution. Status changes come from the `CBM_STATUS_CHANGED` trigger installed by "
               "`schema_wf3_dashboard.sql`, not from `updated_at`.\n\n"
               "Tickets open longer than **30 days** are listed and marked. The model writes only "
               "the covering paragraph; if it fails the email still goes out complete.",
               -760, 180, 560, 210, 5),
    ]

    # ---- 4. connections --------------------------------------------------
    def main_conn(*branches):
        return {"main": [[{"node": t, "type": "main", "index": 0} for t in br] for br in branches]}

    conns = {
        "FM Chat": main_conn(["FM Chat Context"]),
        "FM Chat Context": main_conn(["Question Asked?"]),
        "Question Asked?": main_conn(["FM Dashboard Agent"], ["Empty Question Reply"]),
        "FM Dashboard Agent": main_conn(["Log FM Question"]),
        "Log FM Question": main_conn(["Chat Response"]),

        "Weekly Report Schedule": main_conn(["Report Window"]),
        "Report Window": main_conn(["Collect Weekly Data"]),
        "Collect Weekly Data": main_conn(["Build Weekly Report"]),
        "Build Weekly Report": main_conn(["Weekly Narrative"]),
        "Weekly Narrative": main_conn(["Compose Weekly Email"]),
        "Compose Weekly Email": main_conn(["Email Weekly Report"]),
        "Email Weekly Report": main_conn(["Record Weekly Report"]),

        "FM Chat Model": {"ai_languageModel": [[
            {"node": "FM Dashboard Agent", "type": "ai_languageModel", "index": 0}]]},
        "FM Chat Memory": {"ai_memory": [[
            {"node": "FM Dashboard Agent", "type": "ai_memory", "index": 0}]]},
        "Narrative Model": {"ai_languageModel": [[
            {"node": "Weekly Narrative", "type": "ai_languageModel", "index": 0}]]},
    }
    for t in tools:
        conns[t["name"]] = {"ai_tool": [[
            {"node": "FM Dashboard Agent", "type": "ai_tool", "index": 0}]]}

    wf = {
        "name": "CBM - 3. Facility Manager Dashboard",
        "nodes": nodes,
        "connections": conns,
        "settings": {"executionOrder": "v1", "timezone": "Europe/Rome"},
        "pinData": {},
        "meta": {"templateCredsSetupCompleted": False},
    }

    from ifc_inspection import extend
    extend(wf)
    from actions.build_actions import extend as extend_actions, save_helpers
    action_workflows = extend_actions(wf)
    save_helpers(action_workflows[1:])
    out = serialize(wf)
    open(WF3, "wb").write(out)
    digest = hashlib.sha256(out).hexdigest().upper()

    # ---- 5. pin ----------------------------------------------------------
    # WF3 joins the fixtures test-dispatch.js refuses to let drift unnoticed.
    js = open(TESTS, encoding="utf-8").read()
    key = "'n8n_wf3_fm_dashboard.json'"
    existing = re.search(key + r":'([0-9A-F]{64})'", js)
    if existing:
        if existing.group(1) != digest:
            js = js.replace(existing.group(1), digest)
            open(TESTS, "w", encoding="utf-8", newline="\n").write(js)
        pinned = "updated"
    else:
        anchor = re.search(r"('n8n_wf2_completion_approval_ifc_update\.json':'[0-9A-F]{64}')", js)
        if not anchor:
            pinned = "NOT PINNED - WF2 anchor not found in test-dispatch.js"
        else:
            js = js.replace(anchor.group(1),
                            anchor.group(1) + "," + key + ":'" + digest + "'", 1)
            open(TESTS, "w", encoding="utf-8", newline="\n").write(js)
            pinned = "added"

    tool_names = [t["name"] for t in tools]
    print("WF3 built")
    print("  nodes                      :", len(nodes))
    print("  read-only tools            : {}  ({})".format(len(tool_names), ", ".join(tool_names)))
    print("  connection entries         :", len(conns))
    print("  sha256                     :", digest[:16] + "…")
    print("  test-dispatch.js pin       :", pinned)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
