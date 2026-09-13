"""Rebuild WF2 for the report-first completion contract.

What changes, and why
---------------------
1. The technician's **report is mandatory, the photograph optional**. The Drive
   trigger now keys on `TICKET-<id>.pdf`; an image uploaded on its own is ignored
   rather than treated as a completion, and the workflow looks for a matching
   photograph only once the report has arrived.

2. **Vision verification becomes optional, the report assessment mandatory.** The
   before/after vision chain runs only when a photograph exists. The decision
   itself is always made by an LLM chain reading the report text, optionally
   informed by the vision verdict.

   A *chain*, not an agent: this is one call with no tools and no multi-step
   reasoning, so an agent would add latency and nondeterminism for nothing. The
   chain proposes a status from a fixed vocabulary; `Parse Completion Assessment`
   validates it against the allowed set, so an invented status can never reach
   the database.

3. **The post-approval chain becomes a supervised agent.** The seven nodes that
   followed `FM Approved?` are replaced by one agent with typed tools that
   perform the same operations. When an operation fails it may inspect the live
   schema, correct its arguments and retry, up to ATTEMPT_BUDGET attempts per
   operation. Committed database state, not the agent's final message, decides
   whether the closure settled.

Run:  python wf2/build_wf2.py
"""
from __future__ import annotations

import hashlib
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WF2 = os.path.join(ROOT, "n8n_wf2_completion_approval_ifc_update.json")
TESTS = os.path.join(ROOT, "phase_b", "test-dispatch.js")

ATTEMPT_BUDGET = 3
IFC_SERVICE = "http://ifc-service:8000"
PG_CRED = {"postgres": {"id": "REPLACE_POSTGRES_CREDENTIAL_ID", "name": "CBM Postgres"}}
GMAIL_CRED = {"gmailOAuth2": {"id": "REPLACE_GMAIL_CREDENTIAL_ID", "name": "CBM Gmail"}}
ANTHROPIC_CRED = {"anthropicApi": {"id": "REPLACE_ANTHROPIC_CREDENTIAL_ID", "name": "CBM Anthropic"}}
DRIVE_CRED = {"googleDriveOAuth2Api": {"id": "REPLACE_DRIVE_CRED_ID", "name": "CBM Google Drive"}}
FM_EMAIL = "facility.manager@example.com"

# Statuses the chain is allowed to propose. Validated in code, never trusted raw.
ALLOWED_STATUS = ["PENDING_APPROVAL", "REWORK", "NEEDS_TRIAGE"]


# --------------------------------------------------------------------------
# Node source
# --------------------------------------------------------------------------

EXTRACT_TICKET_JS = r"""// Link the upload to its ticket and classify what was uploaded.
//
// The completion contract is report-first: TICKET-<id>.pdf is the mandatory
// report. An image on its own is NOT a completion - the technician may upload
// the photograph before or after the report, and either way the run that matters
// is the one carrying the report. Returning no items ends this execution quietly
// rather than emailing the FM about every stray file.
const f = $input.first().json;
const name = String(f.name || '');
const m = name.match(/TICKET[-_ ]?(\d+)/i);
const ext = (name.match(/\.([A-Za-z0-9]+)$/) || [, ''])[1].toLowerCase();

const isReport = ext === 'pdf';
const isPhoto = ['jpg', 'jpeg', 'png', 'webp', 'heic'].includes(ext);

// A recognised photograph with no report is not an error: it will be picked up
// by Find AFTER Photo when the report arrives.
if (!isReport) {
  return [];
}

return [{
  json: {
    matched: !!m,
    ticket_id: m ? parseInt(m[1], 10) : null,
    report_file_id: f.id,
    report_file_name: name,
    report_link: f.webViewLink || '',
    upload_kind: isReport ? 'REPORT' : (isPhoto ? 'PHOTO' : 'OTHER'),
  },
}];"""

EXTRACT_REPORT_TEXT_JS = r"""// Extract the technician's report text from the uploaded PDF.
//
// pdf-parse is the one external module this n8n deployment allowlists
// (NODE_FUNCTION_ALLOW_EXTERNAL). It is a pure-JS parser, so it reads a text PDF
// but cannot read a scan: a photographed or scanned report yields little or no
// text, which is reported as EMPTY rather than passed off as a completion.
const pdf = require('pdf-parse');

const buf = await this.helpers.getBinaryDataBuffer(0, 'data');
const x = $('Extract Ticket ID').first().json;

let text = '';
let pages = 0;
let parseError = null;
try {
  const parsed = await pdf(buf);
  text = String(parsed.text || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  pages = parsed.numpages || 0;
} catch (e) {
  parseError = (e && e.message) || String(e);
}

// A report that yields no words cannot be assessed. Downstream this becomes a
// REWORK proposal with an explicit reason, never a silent pass.
const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
const quality = parseError ? 'PARSE_ERROR' : (words < 5 ? 'EMPTY' : 'OK');

return [{
  json: {
    ...x,
    report_text: text,
    report_words: words,
    report_pages: pages,
    report_quality: quality,
    report_parse_error: parseError,
  },
}];"""

BUILD_ASSESSMENT_INPUT_JS = r"""// Assemble everything the completion assessment needs, from whichever branch ran.
//
// The vision nodes execute only when a photograph accompanied the report, so the
// vision verdict is looked up defensively: referencing a node that did not run in
// this execution throws, and that throw is the normal no-photo case.
const report = $('Extract Report Text').first().json;
const ticket = $('Fetch Ticket').first().json;

let vision = null;
try {
  const v = $('Parse Verification').first().json;
  vision = {
    repair_verified: v.repair_verified,
    confidence: v.ai_confidence,
    observations: v.observations,
    after_file_id: v.after_file_id,
    after_link: v.after_link,
  };
} catch (e) {
  vision = null;   // no photograph was supplied - the report stands alone
}

return [{
  json: {
    ticket_id: ticket.id,
    object_type: ticket.object_type || ticket.ifc_name || 'unspecified object',
    damage_description: ticket.damage_description || ticket.description || '',
    technician_name: ticket.technician_name || '',
    technician_email: ticket.technician_email || '',
    report_text: report.report_text,
    report_quality: report.report_quality,
    report_words: report.report_words,
    report_file_id: report.report_file_id,
    report_link: report.report_link,
    photo_supplied: vision !== null,
    vision,
    vision_summary: vision
      ? `A photograph was supplied. Image comparison verdict: repair_verified=${vision.repair_verified}, confidence=${vision.confidence}. ${vision.observations || ''}`
      : 'No photograph was supplied. Judge the completion from the written report alone.',
  },
}];"""

ASSESS_COMPLETION_PROMPT = (
    "=You are the completion-assessment engine of a facility-maintenance system. "
    "Decide whether a technician's written report credibly shows the work is finished.\n\n"
    "TICKET {{ $json.ticket_id }} - object: {{ $json.object_type }}\n"
    "Originally reported issue: {{ $json.damage_description }}\n"
    "Technician: {{ $json.technician_name }}\n\n"
    "TECHNICIAN'S REPORT (extraction quality: {{ $json.report_quality }}, "
    "{{ $json.report_words }} words):\n---\n{{ $json.report_text }}\n---\n\n"
    "PHOTOGRAPHIC EVIDENCE: {{ $json.vision_summary }}\n\n"
    "The photograph is optional; the report is the evidence of record. Judge the report on "
    "whether it describes what was actually done to resolve the reported issue. A report that "
    "is empty, unreadable, generic, or describes work unrelated to the reported issue is not a "
    "completion.\n\n"
    "Respond with ONLY a minified JSON object, no markdown fences:\n"
    '{"work_complete": true or false, "confidence": number between 0 and 1, '
    '"recommended_status": one of "PENDING_APPROVAL" or "REWORK" or "NEEDS_TRIAGE", '
    '"summary": one short factual sentence for the facility manager, '
    '"concerns": short string, empty if none}\n\n'
    "Use PENDING_APPROVAL when the report credibly describes the completed repair. "
    "Use REWORK when the work appears incomplete, unrelated, or the report is unusable. "
    "Use NEEDS_TRIAGE only when the report indicates the original diagnosis was wrong."
)

PARSE_COMPLETION_JS = r"""// Validate the chain's verdict and decide the ticket status.
//
// The model proposes a status; this node decides it. An unparseable response or a
// status outside the allowed vocabulary becomes REWORK with an explicit reason -
// never a silent PENDING_APPROVAL, and never an invented status reaching SQL.
const ALLOWED = %ALLOWED%;

const raw = ($input.first().json.text || '').trim()
  .replace(/^```(json)?/i, '').replace(/```$/, '').trim();

let v;
let parseError = null;
try {
  v = JSON.parse(raw);
} catch (e) {
  parseError = 'Could not parse the assessment. Raw output: ' + raw.slice(0, 200);
  v = {};
}

const input = $('Build Assessment Input').first().json;
const ticket = $('Fetch Ticket').first().json;

let status = String(v.recommended_status || '').toUpperCase();
let statusReason = null;
if (!ALLOWED.includes(status)) {
  statusReason = parseError || ('Model proposed an unrecognised status: ' + (v.recommended_status ?? 'none'));
  status = 'REWORK';
}
// A report we could not read is never a completion, whatever the model concluded.
if (input.report_quality !== 'OK' && status === 'PENDING_APPROVAL') {
  status = 'REWORK';
  statusReason = 'Report text could not be read (' + input.report_quality + ').';
}

// When the node overrides the model, the override reason leads: the facility
// manager must not read a confident model summary next to a status that
// contradicts it and have no idea why.
const summary = statusReason
  ? statusReason + (v.summary ? ' (model reported: ' + v.summary + ')' : '')
  : (v.summary || '');

const verification = {
  source: 'REPORT',
  photo_supplied: input.photo_supplied,
  work_complete: v.work_complete === true,
  confidence: typeof v.confidence === 'number' ? v.confidence : 0,
  summary,
  model_summary: v.summary || '',
  status_overridden: statusReason !== null,
  concerns: v.concerns || '',
  report_quality: input.report_quality,
  report_words: input.report_words,
  vision: input.vision,
  status_reason: statusReason,
};

const sql = (s) => String(s ?? '').replace(/'/g, "''");

return [{
  json: {
    ...ticket,
    ticket_id: input.ticket_id,
    id: input.ticket_id,
    resolved_status: status,
    work_complete: verification.work_complete,
    ai_confidence: verification.confidence,
    observations: verification.summary,
    concerns: verification.concerns,
    photo_supplied: input.photo_supplied,
    report_text: input.report_text,
    report_file_id: input.report_file_id,
    report_link: input.report_link,
    after_file_id: (input.vision && input.vision.after_file_id) || null,
    after_link: (input.vision && input.vision.after_link) || '',
    technician_name: input.technician_name,
    technician_email: input.technician_email,
    object_type: input.object_type,
    damage_description: input.damage_description,
    verification_sql: sql(JSON.stringify(verification)),
    report_text_sql: sql(input.report_text || ''),
  },
}];""".replace("%ALLOWED%", json.dumps(ALLOWED_STATUS))

CLOSURE_CONTEXT_JS = r"""// Bind the closure objectives for the supervisor agent.
//
// Both branches of FM Approved? arrive here, so the agent handles approval and
// rejection through one bounded, auditable path. Everything the agent may act on
// is fixed here by the workflow: it chooses which tools to call and how to
// recover from a failure, never which ticket to act on.
const decisionRaw = (() => {
  try { return $('FM Approval (Email + Wait)').first().json; } catch (e) { return {}; }
})();
const approved = decisionRaw && decisionRaw.data ? decisionRaw.data.approved === true : false;
const a = $('Parse Completion Assessment').first().json;

return [{
  json: {
    ticketId: a.id,
    decision: approved ? 'APPROVED' : 'REJECTED',
    attemptBudget: %BUDGET%,
    ifcGlobalId: a.ifc_global_id || null,
    ifcServiceUrl: '%IFC%',
    technicianId: a.technician_id ?? null,
    technicianName: a.technician_name || '',
    technicianEmail: a.technician_email || '',
    objectType: a.object_type || '',
    damageDescription: a.damage_description || '',
    fmEmail: '%FM%',
    observations: a.observations || '',
    reportLink: a.report_link || '',
    afterLink: a.after_link || '',
    photoSupplied: a.photo_supplied === true,
    objectives: approved
      ? ['log_ifc_maintenance', 'close_ticket', 'update_technician_stats',
         'notify_technician_closed', 'notify_fm_closed']
      : ['reopen_for_rework', 'notify_technician_rework'],
  },
}];""".replace("%BUDGET%", str(ATTEMPT_BUDGET)).replace("%IFC%", IFC_SERVICE).replace("%FM%", FM_EMAIL)

SUPERVISOR_SYSTEM = (
    "You are the closure supervisor for WF2. The facility manager has already decided; your "
    "job is to carry that decision out against the database, the IFC service and email, and to "
    "recover from failures that a fixed node chain could not.\n\n"
    "Complete every objective listed in the bound context, in a sensible order. For an APPROVED "
    "decision: write the maintenance record to the IFC model, close the ticket recording the "
    "returned model version, increment the technician's completed-jobs count, then notify the "
    "technician and the facility manager. For a REJECTED decision: reopen the ticket for rework "
    "and notify the technician what is required.\n\n"
    f"ATTEMPT BUDGET: you may attempt any single operation at most {ATTEMPT_BUDGET} times. When a "
    "tool returns an error, do not simply repeat the identical call. Read the error. If it names "
    "a missing column, a type mismatch or an unknown relation, call inspect_schema to see the "
    "columns that actually exist, then retry with corrected arguments. If the error is a timeout "
    "or a transient connection failure, one plain retry is reasonable. If an operation still "
    f"fails after {ATTEMPT_BUDGET} attempts, stop attempting it, continue with the remaining "
    "objectives that do not depend on it, and report precisely which objective failed and why.\n\n"
    "The database tools run fixed parameterized statements and are idempotent: closing an already "
    "closed ticket, or reopening an already reopened one, is safe and reports no rows changed. "
    "Email is NOT idempotent. Send each notification once. Before re-sending after an uncertain "
    "result, call check_notice to see whether that notice was already recorded as sent.\n\n"
    "You cannot execute free-form SQL and you cannot choose a different ticket: the workflow binds "
    "the ticket identity. inspect_schema is read-only and exists solely to diagnose a failure.\n\n"
    "Finish with a short structured summary naming each objective and whether it succeeded, the "
    "number of attempts it took, and the exact error for anything that failed. Your summary is a "
    "report, not proof: the workflow verifies committed database state independently."
)

VERIFY_CLOSURE_SQL = (
    "=SELECT t.id, t.status, t.closed_at, t.ifc_new_version,\n"
    "       (SELECT count(*) FROM ticket_events e\n"
    "         WHERE e.ticket_id = t.id AND e.event = 'CBM_WF2_NOTICE') AS notices_recorded,\n"
    "       (SELECT count(*) FROM ticket_events e\n"
    "         WHERE e.ticket_id = t.id AND e.event = 'CBM_WF2_ATTEMPT') AS attempts_recorded\n"
    "  FROM tickets t WHERE t.id = {{ $('Closure Context').first().json.ticketId }};"
)


# --------------------------------------------------------------------------
# Node builders
# --------------------------------------------------------------------------

def node(name, ntype, params, x, y, version, extra=None):
    n = {"parameters": params, "name": name, "type": ntype, "typeVersion": version,
         "position": [x, y]}
    if extra:
        n.update(extra)
    return n


def pg_tool(name, description, sql, x, y, replacement=None):
    params = {
        "operation": "executeQuery",
        "query": sql,
        "options": {
            "queryReplacement": replacement or
            '={{ [JSON.stringify($("Closure Context").first().json)] }}',
            "queryBatching": "transaction",
        },
        "descriptionType": "manual",
        "toolDescription": description,
    }
    return node(name, "n8n-nodes-base.postgresTool", params, x, y, 2.6,
                {"credentials": PG_CRED})


def gmail_tool(name, description, to, subject, message, x, y):
    params = {
        "sendTo": to,
        "subject": subject,
        "emailType": "html",
        "message": message,
        "options": {"appendAttribution": False},
        "descriptionType": "manual",
        "toolDescription": description,
    }
    return node(name, "n8n-nodes-base.gmailTool", params, x, y, 2.1,
                {"credentials": GMAIL_CRED, "onError": "continueRegularOutput",
                 "retryOnFail": False})


# --------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------

def serialize(wf):
    return json.dumps(wf, indent=2, ensure_ascii=False).encode("utf-8")


def main():
    # Always build from the pristine export so the script is re-runnable and the
    # result does not depend on how many times it has been run.
    baseline = os.path.join(os.path.dirname(os.path.abspath(__file__)), "original_wf2.json")
    raw = open(baseline, "rb").read()
    before = hashlib.sha256(raw).hexdigest().upper()
    wf = json.loads(raw.decode("utf-8"))
    fmt_ok = serialize(wf) == raw

    nodes = {n["name"]: n for n in wf["nodes"]}
    conns = wf["connections"]

    # ---- 1. intake -------------------------------------------------------
    # The trigger no longer keys on a photograph, so it is renamed. Every
    # expression naming it must follow, or the reference silently breaks at run
    # time rather than at import.
    OLD_TRIGGER, NEW_TRIGGER = "Completed Photo (Drive Trigger)", "Completed Upload (Drive Trigger)"
    nodes[OLD_TRIGGER]["name"] = NEW_TRIGGER
    conns[NEW_TRIGGER] = conns.pop(OLD_TRIGGER)
    for n in wf["nodes"]:
        if "parameters" in n:
            n["parameters"] = json.loads(
                json.dumps(n["parameters"]).replace(OLD_TRIGGER, NEW_TRIGGER))

    nodes["Extract Ticket ID"]["parameters"]["jsCode"] = EXTRACT_TICKET_JS

    # Give the emails real technician values and stable aliases. Previously the
    # workflow read damage_description / object_type / technician_name off a bare
    # SELECT * FROM tickets, where none of them exist.
    nodes["Fetch Ticket"]["parameters"]["query"] = (
        "=SELECT t.*,\n"
        "       t.description      AS damage_description,\n"
        "       t.ifc_name         AS object_type,\n"
        "       t.photo_before_url AS photo_url,\n"
        "       te.full_name       AS technician_name,\n"
        "       te.email           AS technician_email\n"
        "  FROM tickets t\n"
        "  LEFT JOIN technicians te ON te.id = t.technician_id\n"
        " WHERE t.id = {{ $json.ticket_id }} LIMIT 1;"
    )

    folder = "={{ $('Completed Upload (Drive Trigger)').first().json.parents ? "
    new_nodes = [
        node("Download Report PDF", "n8n-nodes-base.googleDrive", {
            "operation": "download",
            "fileId": {"__rl": True, "mode": "id",
                       "value": "={{ $('Extract Ticket ID').first().json.report_file_id }}"},
            "options": {"binaryPropertyName": "data"},
        }, -120, -40, 3, {"credentials": DRIVE_CRED}),

        node("Extract Report Text", "n8n-nodes-base.code",
             {"jsCode": EXTRACT_REPORT_TEXT_JS}, 100, -40, 2),

        node("Find AFTER Photo", "n8n-nodes-base.googleDrive", {
            "resource": "fileFolder",
            "searchMethod": "query",
            "queryString": "=TICKET-{{ $('Extract Ticket ID').first().json.ticket_id }}",
            "filter": {
                "folderId": {"__rl": True, "mode": "id",
                             "value": "REPLACE_WITH_COMPLETED_FOLDER_ID"},
                "whatToSearch": "files",
                "fileTypes": ["application/vnd.google-apps.photo", "image/jpeg", "image/png"],
            },
            "options": {},
        }, 320, -40, 3, {"credentials": DRIVE_CRED, "onError": "continueRegularOutput",
                         "alwaysOutputData": True}),

        node("Photo Available?", "n8n-nodes-base.if", {
            "conditions": {
                "options": {"caseSensitive": True, "leftValue": "",
                            "typeValidation": "loose", "version": 2},
                "conditions": [{
                    "id": "wf2-photo-present",
                    "leftValue": "={{ $json.id }}",
                    "rightValue": "",
                    "operator": {"type": "string", "operation": "exists", "singleValue": True},
                }],
                "combinator": "and",
            },
            "options": {},
        }, 540, -40, 2.2),

        node("Build Assessment Input", "n8n-nodes-base.code",
             {"jsCode": BUILD_ASSESSMENT_INPUT_JS}, 1420, -40, 2),

        node("Assess Completion (Report)", "@n8n/n8n-nodes-langchain.chainLlm", {
            "promptType": "define",
            "text": ASSESS_COMPLETION_PROMPT,
        }, 1640, -40, 1.5),

        node("Parse Completion Assessment", "n8n-nodes-base.code",
             {"jsCode": PARSE_COMPLETION_JS}, 1860, -40, 2),
    ]

    # ---- 2. closure supervisor ------------------------------------------
    new_nodes += [
        node("Closure Context", "n8n-nodes-base.code",
             {"jsCode": CLOSURE_CONTEXT_JS}, 2660, 120, 2),

        node("Closure Supervisor", "@n8n/n8n-nodes-langchain.agent", {
            "promptType": "define",
            "text": ('={{ "Carry out this approved facility-maintenance closure. '
                     'Bound context follows; complete every listed objective. " '
                     '+ JSON.stringify($json) }}'),
            "options": {"systemMessage": SUPERVISOR_SYSTEM, "maxIterations": 25,
                        "returnIntermediateSteps": False},
        }, 2880, 120, 2, {"onError": "continueRegularOutput"}),

        node("Closure Claude Model", "@n8n/n8n-nodes-langchain.lmChatAnthropic", {
            "model": {"__rl": True, "mode": "id", "value": "claude-sonnet-4-6"},
            "options": {"temperature": 0, "maxTokensToSample": 2000},
        }, 2820, 340, 1.3, {"credentials": ANTHROPIC_CRED}),

        pg_tool("inspect_schema",
                "Read-only. Returns the columns and types that actually exist on the tickets, "
                "technicians and ticket_events tables. Call this when a tool error names a "
                "missing column, an unknown relation or a type mismatch, then retry the failed "
                "operation with corrected arguments. Cannot modify anything.",
                "SELECT table_name, column_name, data_type, is_nullable\n"
                "  FROM information_schema.columns\n"
                " WHERE table_schema = 'public'\n"
                "   AND table_name IN ('tickets','technicians','ticket_events')\n"
                " ORDER BY table_name, ordinal_position;",
                3100, 340),

        node("log_ifc_maintenance", "n8n-nodes-base.httpRequestTool", {
            "method": "POST",
            "url": ("={{ $('Closure Context').first().json.ifcServiceUrl }}/elements/"
                    "{{ $('Closure Context').first().json.ifcGlobalId }}/maintenance"),
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": ('={{ JSON.stringify({ ticket_id: $(\"Closure Context\").first().json.ticketId,'
                         ' maintenance_date: $now.toISO(),'
                         ' technician: $(\"Closure Context\").first().json.technicianName,'
                         ' description: "Repair completed and approved. Original issue: "'
                         ' + $(\"Closure Context\").first().json.damageDescription,'
                         ' condition: "Repaired", approved_by: "Facility Manager" }) }}'),
            "options": {"timeout": 60000},
            "descriptionType": "manual",
            "toolDescription": "Write the maintenance record into the IFC model for the bound "
                               "ticket's element. Returns the new versioned model file name as "
                               "version_file. Call before close_ticket so the version can be "
                               "recorded. Safe to retry: the service versions each write.",
        }, 3320, 340, 4.2, {"onError": "continueRegularOutput"}),

        pg_tool("close_ticket",
                "Close the bound ticket and record the IFC model version returned by "
                "log_ifc_maintenance. Pass version_file exactly as that tool returned it, or "
                "IFC_SYNC_FAILED if the IFC write could not be completed. Idempotent: an "
                "already-closed ticket reports zero rows changed.",
                "WITH v AS (SELECT $1::jsonb AS p)\n"
                "UPDATE tickets SET status='CLOSED', closed_at=COALESCE(closed_at, now()),\n"
                "       ifc_new_version = COALESCE(NULLIF(v.p->>'versionFile',''), ifc_new_version),\n"
                "       updated_at = now()\n"
                "  FROM v WHERE tickets.id = (v.p->>'ticketId')::int AND tickets.status <> 'CLOSED'\n"
                " RETURNING tickets.id, tickets.status, tickets.closed_at, tickets.ifc_new_version;",
                3540, 340,
                replacement='={{ [JSON.stringify({ ticketId: $("Closure Context").first().json.ticketId, '
                            'versionFile: $fromAI("version_file", "The versioned IFC model file name '
                            'returned by log_ifc_maintenance, or IFC_SYNC_FAILED if that write did not '
                            'succeed", "string") })] }}'),

        pg_tool("reopen_for_rework",
                "Reopen the bound ticket for rework after a rejected approval, recording the "
                "facility manager's reason. Idempotent: a ticket already in REWORK reports zero "
                "rows changed.",
                "WITH v AS (SELECT $1::jsonb AS p)\n"
                "UPDATE tickets SET status='REWORK', closed_at=NULL,\n"
                "       fm_reject_reason = COALESCE(NULLIF(v.p->>'reason',''), fm_reject_reason),\n"
                "       updated_at = now()\n"
                "  FROM v WHERE tickets.id = (v.p->>'ticketId')::int AND tickets.status <> 'REWORK'\n"
                " RETURNING tickets.id, tickets.status;",
                3760, 340,
                replacement='={{ [JSON.stringify({ ticketId: $("Closure Context").first().json.ticketId, '
                            'reason: $fromAI("reason", "Short reason the facility manager rejected this '
                            'completion, for the technician to act on", "string") })] }}'),

        pg_tool("update_technician_stats",
                "Increment the assigned technician's completed-jobs counter. Call once, after "
                "close_ticket succeeds. Reports zero rows changed if the ticket has no assigned "
                "technician.",
                "WITH v AS (SELECT $1::jsonb AS p)\n"
                "UPDATE technicians SET jobs_completed = jobs_completed + 1\n"
                "  FROM v WHERE technicians.id = NULLIF(v.p->>'technicianId','')::int\n"
                " RETURNING technicians.id, technicians.jobs_completed;",
                3980, 340),

        pg_tool("check_notice",
                "Return the notices already recorded as sent for the bound ticket. Call this "
                "before re-sending an email whose result was uncertain, so a technician or the "
                "facility manager is not notified twice.",
                "SELECT payload->>'notice_key' AS notice_key, created_at\n"
                "  FROM ticket_events\n"
                " WHERE ticket_id = ($1::jsonb->>'ticketId')::int AND event = 'CBM_WF2_NOTICE'\n"
                " ORDER BY id;",
                4200, 340),

        pg_tool("record_attempt",
                "Record one operation attempt or one delivered notice in the append-only audit "
                "trail. Set kind to NOTICE immediately after an email is sent successfully, using "
                "the notice key you sent; set it to ATTEMPT to record a failed operation and its "
                "error. This is what makes retries auditable.",
                "INSERT INTO ticket_events(ticket_id, event, payload)\n"
                "SELECT ($1::jsonb->>'ticketId')::int,\n"
                "       CASE WHEN upper($1::jsonb->>'kind')='NOTICE'\n"
                "            THEN 'CBM_WF2_NOTICE' ELSE 'CBM_WF2_ATTEMPT' END,\n"
                "       jsonb_build_object('notice_key', $1::jsonb->>'key',\n"
                "                          'operation',  $1::jsonb->>'operation',\n"
                "                          'outcome',    $1::jsonb->>'outcome',\n"
                "                          'detail',     $1::jsonb->>'detail')\n"
                "RETURNING id, event;",
                4420, 340,
                replacement='={{ [JSON.stringify({ ticketId: $("Closure Context").first().json.ticketId, '
                            'kind: $fromAI("kind", "NOTICE for a delivered email, ATTEMPT for an '
                            'operation outcome", "string"), '
                            'key: $fromAI("notice_key", "Stable key of the notice, for example '
                            'technician:closed or fm:closed or technician:rework. Empty for ATTEMPT", "string"), '
                            'operation: $fromAI("operation", "Name of the tool or objective this record '
                            'concerns", "string"), '
                            'outcome: $fromAI("outcome", "SUCCEEDED or FAILED", "string"), '
                            'detail: $fromAI("detail", "Exact error text when it failed, otherwise a short '
                            'note", "string") })] }}'),

        gmail_tool("notify_technician",
                   "Email the assigned technician. Use it once for an approved closure and once "
                   "for a rejected completion; write the body to suit which happened. Record it "
                   "with record_attempt kind=NOTICE afterwards.",
                   '={{ $("Closure Context").first().json.technicianEmail }}',
                   ('={{ "Ticket " + $("Closure Context").first().json.ticketId + " - " + '
                    '($("Closure Context").first().json.decision === "APPROVED" '
                    '? "approved and closed" : "rework required") }}'),
                   ('={{ $fromAI("message_html", "The full HTML email body for the technician. '
                    'Address them by name, state clearly whether the work was approved and closed '
                    'or needs rework, name the object and the original issue, and for rework say '
                    'what to do next including re-uploading TICKET-<id>.pdf", "string") }}'),
                   4640, 340),

        gmail_tool("notify_fm",
                   "Email the facility manager confirming an approved ticket has been closed and "
                   "the IFC model updated. Record it with record_attempt kind=NOTICE afterwards.",
                   '={{ $("Closure Context").first().json.fmEmail }}',
                   ('={{ "Ticket " + $("Closure Context").first().json.ticketId + '
                    '" closed - IFC updated" }}'),
                   ('={{ $fromAI("message_html", "The full HTML email body for the facility manager, '
                    'confirming closure, naming the IFC element and the new model version", "string") }}'),
                   4860, 340),

        node("Verify Closure Outcome", "n8n-nodes-base.postgres", {
            "operation": "executeQuery", "query": VERIFY_CLOSURE_SQL, "options": {},
        }, 3100, 120, 2.5, {"credentials": PG_CRED}),

        node("Closure Settled?", "n8n-nodes-base.if", {
            "conditions": {
                "options": {"caseSensitive": True, "leftValue": "",
                            "typeValidation": "loose", "version": 2},
                "conditions": [{
                    "id": "wf2-closure-settled",
                    "leftValue": ('={{ $json.status === ($("Closure Context").first().json.decision '
                                  '=== "APPROVED" ? "CLOSED" : "REWORK") }}'),
                    "rightValue": True,
                    "operator": {"type": "boolean", "operation": "true", "singleValue": True},
                }],
                "combinator": "and",
            },
            "options": {},
        }, 3320, 120, 2.2),

        node("Closure Recorded", "n8n-nodes-base.noOp", {}, 3540, 20, 1),

        node("Notify FM - Closure Needs Attention", "n8n-nodes-base.gmail", {
            "sendTo": FM_EMAIL,
            "subject": ('=[CBM] Ticket {{ $("Closure Context").first().json.ticketId }} '
                        'did not reach its final state'),
            "emailType": "html",
            "message": (
                '=<p>The closure supervisor finished but ticket '
                '<b>{{ $("Closure Context").first().json.ticketId }}</b> is not in the expected '
                'state.</p><p><b>Decision:</b> {{ $("Closure Context").first().json.decision }}<br/>'
                '<b>Expected status:</b> {{ $("Closure Context").first().json.decision === "APPROVED" '
                '? "CLOSED" : "REWORK" }}<br/><b>Actual status:</b> {{ $json.status }}<br/>'
                '<b>Attempts recorded:</b> {{ $json.attempts_recorded }} &middot; '
                '<b>Notices recorded:</b> {{ $json.notices_recorded }}</p>'
                '<p><b>Supervisor report:</b><br/>'
                '{{ (() => { try { return $("Closure Supervisor").first().json.output } '
                'catch (e) { return "the supervisor produced no report" } })() }}</p>'
                '<p>Inspect the CBM_WF2_ATTEMPT events on this ticket for the exact errors.</p>'),
            "options": {"appendAttribution": False},
        }, 3540, 220, 2.1, {"credentials": GMAIL_CRED}),
    ]

    # ---- 3. remove the replaced closure chain ---------------------------
    replaced = ["IFC Service - Log Maintenance", "Close Ticket", "Update Technician Stats",
                "Notify Technician - Closed", "Notify FM - Ticket Closed",
                "Reopen for Rework", "Notify Technician - Rework Required"]
    wf["nodes"] = [n for n in wf["nodes"] if n["name"] not in replaced]
    for r in replaced:
        conns.pop(r, None)
    wf["nodes"].extend(new_nodes)

    # ---- 4. rewire ------------------------------------------------------
    def main_conn(*targets):
        return {"main": [[{"node": t, "type": "main", "index": 0} for t in br] for br in targets]}

    conns["Ticket Open and Assigned?"] = main_conn(["Download Report PDF"],
                                                   ["Notify FM - Photo Problem"])
    conns["Download Report PDF"] = main_conn(["Extract Report Text"])
    conns["Extract Report Text"] = main_conn(["Find AFTER Photo"])
    conns["Find AFTER Photo"] = main_conn(["Photo Available?"])
    conns["Photo Available?"] = main_conn(
        ["Download AFTER Photo", "Download BEFORE Photo"], ["Build Assessment Input"])
    conns["Parse Verification"] = main_conn(["Build Assessment Input"])
    conns["Build Assessment Input"] = main_conn(["Assess Completion (Report)"])
    conns["Assess Completion (Report)"] = main_conn(["Parse Completion Assessment"])
    conns["Parse Completion Assessment"] = main_conn(["Set Pending Approval"])
    conns["FM Approved?"] = main_conn(["Closure Context"], ["Closure Context"])
    conns["Closure Context"] = main_conn(["Closure Supervisor"])
    conns["Closure Supervisor"] = main_conn(["Verify Closure Outcome"])
    conns["Verify Closure Outcome"] = main_conn(["Closure Settled?"])
    conns["Closure Settled?"] = main_conn(["Closure Recorded"],
                                          ["Notify FM - Closure Needs Attention"])

    # The AFTER photo now comes from the folder search, not the trigger file.
    nodes_now = {n["name"]: n for n in wf["nodes"]}
    nodes_now["Download AFTER Photo"]["parameters"]["fileId"] = {
        "__rl": True, "mode": "id", "value": "={{ $('Find AFTER Photo').first().json.id }}"}

    # Persist the report alongside the verdict.
    nodes_now["Set Pending Approval"]["parameters"]["query"] = (
        "=UPDATE tickets SET status = '{{ $json.resolved_status }}',\n"
        "       report_text = '{{ $json.report_text_sql }}',\n"
        "       report_file_id = '{{ $json.report_file_id }}',\n"
        "       after_file_id = {{ $json.after_file_id ? \"'\" + $json.after_file_id + \"'\" : 'NULL' }},\n"
        "       verification = '{{ $json.verification_sql }}'::jsonb,\n"
        "       updated_at = now()\n"
        " WHERE id = {{ $json.id }} RETURNING id, status;")

    # The chain model serves both LLM nodes.
    ai_lm = wf["connections"].setdefault("Anthropic Chat Model", {})
    ai_lm["ai_languageModel"] = [[
        {"node": "Claude Vision - Verify Repair", "type": "ai_languageModel", "index": 0},
        {"node": "Assess Completion (Report)", "type": "ai_languageModel", "index": 0},
    ]]
    wf["connections"]["Closure Claude Model"] = {"ai_languageModel": [[
        {"node": "Closure Supervisor", "type": "ai_languageModel", "index": 0}]]}
    for tool in ["inspect_schema", "log_ifc_maintenance", "close_ticket", "reopen_for_rework",
                 "update_technician_stats", "check_notice", "record_attempt",
                 "notify_technician", "notify_fm"]:
        wf["connections"][tool] = {"ai_tool": [[
            {"node": "Closure Supervisor", "type": "ai_tool", "index": 0}]]}

    # Downstream references now point at the consolidated assessment.
    for n in wf["nodes"]:
        if n["name"] in ("FM Approval (Email + Wait)", "Set Pending Approval"):
            n["parameters"] = json.loads(json.dumps(n["parameters"]).replace(
                "$('Parse Verification')", "$('Parse Completion Assessment')"))

    out = serialize(wf)
    open(WF2, "wb").write(out)
    after = hashlib.sha256(out).hexdigest().upper()

    # ---- 5. re-pin -------------------------------------------------------
    # Replace whatever WF2 hash is currently pinned, not just the pristine one,
    # so re-running the build leaves the fixture consistent either way.
    js = open(TESTS, encoding="utf-8").read()
    m = re.search(r"'n8n_wf2_completion_approval_ifc_update\.json':'([0-9A-F]{64})'", js)
    repinned = bool(m)
    if repinned and m.group(1) != after:
        open(TESTS, "w", encoding="utf-8", newline="\n").write(js.replace(m.group(1), after))

    print("WF2 rebuilt")
    print("  baseline format reproduced :", fmt_ok)
    print("  nodes                      : {} -> {}".format(len(json.loads(raw)["nodes"]),
                                                           len(wf["nodes"])))
    print("  removed                    :", len(replaced))
    print("  added                      :", len(new_nodes))
    print("  sha256                     : {}… -> {}…".format(before[:12], after[:12]))
    print("  test-dispatch.js re-pinned :", repinned)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
