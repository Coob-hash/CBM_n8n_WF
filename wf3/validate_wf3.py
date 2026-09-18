"""Structural checks on WF3.

Catches what only surfaces at run time in n8n - a connection or an expression
naming a node that no longer exists, a node stranded with no inbound edge, a
tool not attached to the agent, an agent with no model - and the two properties
this workflow is built around:

  * read tools are read-only; action tools call a guarded shared workflow, and
  * no tool takes SQL from the model.

The chat is authenticated. Action functions recheck current ticket state.
"""
import json
import os
import re
import sys
import ast

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WF3 = os.path.join(ROOT, "n8n_wf3_fm_dashboard.json")
if len(sys.argv)>1:
    WF3=sys.argv[1]

# Validation needs policy constants, not live credentials loaded by the builder.
_policy = ast.parse(open(os.path.join(HERE, 'build_wf3.py'), encoding='utf-8').read())
for _assignment in _policy.body:
    if isinstance(_assignment, ast.Assign):
        for _target in _assignment.targets:
            if isinstance(_target, ast.Name) and _target.id in {
                'STALE_DAYS', 'WINDOW_DAYS', 'MAX_QUESTION_CHARS', 'HISTORY_TURNS'
            }:
                globals()[_target.id] = ast.literal_eval(_assignment.value)

wf = json.load(open(WF3, encoding="utf-8"))
names = {n["name"] for n in wf["nodes"]}
by_name = {n["name"]: n for n in wf["nodes"]}
conns = wf["connections"]

failures = []


def check(label, ok, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label
          + (("\n          " + str(detail)) if detail and not ok else ""))
    if not ok:
        failures.append(label)


print("WF3 structure\n")
print("  nodes: {}   connection entries: {}".format(len(wf["nodes"]), len(conns)))
print()

AGENT = "FM Dashboard Agent"
CHAT_TRIGGER = "FM Chat"
CRON_TRIGGER = "Weekly Report Schedule"

# 1. every connection endpoint exists
dangling = []
for src, spec in conns.items():
    if src not in names:
        dangling.append("source " + src)
    for kind, branches in spec.items():
        for br in branches:
            for edge in br or []:
                if edge["node"] not in names:
                    dangling.append("{} -{}-> {}".format(src, kind, edge["node"]))
check("every connection endpoint resolves", not dangling, "; ".join(dangling))

# 2. every $('Node') expression resolves
bad_refs = set()
for n in wf["nodes"]:
    blob = json.dumps(n.get("parameters", {}))
    for ref in re.findall(r"\$\(\\?['\"]([^'\"\\]+)\\?['\"]\)", blob):
        if ref not in names:
            bad_refs.add("{} references {}".format(n["name"], ref))
check("every $('Node') expression resolves", not bad_refs, "; ".join(sorted(bad_refs)))

# 3. reachability from both triggers
aux = {n["name"] for n in wf["nodes"]
       if n["type"].endswith("stickyNote") or "Tool" in n["type"] or n["type"].endswith('.toolWorkflow')
       or '.lmChat' in n["type"] or n["type"].endswith("memoryBufferWindow")}
seen, stack = set(), [CHAT_TRIGGER, CRON_TRIGGER]
while stack:
    cur = stack.pop()
    if cur in seen:
        continue
    seen.add(cur)
    for br in conns.get(cur, {}).get("main", []):
        for e in br or []:
            stack.append(e["node"])
check("both triggers exist", CHAT_TRIGGER in names and CRON_TRIGGER in names)
unreachable = names - seen - aux
check("every main-flow node is reachable from a trigger", not unreachable,
      "unreachable: " + ", ".join(sorted(unreachable)))

# 4. agent wiring
def sources(target, kind):
    return [src for src, spec in conns.items()
            if any(e["node"] == target for br in spec.get(kind, []) for e in br or [])]


tools = sources(AGENT, "ai_tool")
check("the agent has exactly one language model", len(sources(AGENT, "ai_languageModel")) == 1)
check("the agent has conversation memory", len(sources(AGENT, "ai_memory")) == 1)
check("the agent has 9 read tools and 5 guarded action tools", len(tools) == 14,
      "{}: {}".format(len(tools), sorted(tools)))
check("memory is keyed on the normalised session id",
      "$('FM Chat Context').first().json.sessionId"
      in by_name["FM Chat Memory"]["parameters"].get("sessionKey", ""))

# 5. every tool is read-only
WRITE = re.compile(r"\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE"
                   r"|COPY|MERGE|CALL|DO|VACUUM|SET|LOCK)\b", re.I)
not_select, writes, unbound = [], [], []
for t in sorted(tools):
    n = by_name[t]
    from actions.build_actions import ACTION, MAIL, DESCS
    if t in DESCS:
        params=n['parameters']
        check(t + " calls the shared guarded WF3 helper",
              n['type']=='@n8n/n8n-nodes-langchain.toolWorkflow'
              and params['workflowId']['value']==(MAIL if t=='resend_approval_email' else ACTION))
        value=params['workflowInputs']['value']['context']
        check(t + " binds source to the current FM turn",
              "actor:'FM_CHAT'" in value and "requestId:String($execution.id)" in value
              and "$('FM Chat Context').first().json.question" in value
              and 'expectedUpdatedAt:' in value and 'approvalId:' in value)
        continue
    if t == "inspect_ifc_maintenance":
        params = n['parameters']
        from ifc_inspection import HELPER_FILE, HELPER_ID, LEGACY_NODES, build_helper
        helper = json.load(open(HELPER_FILE, encoding='utf-8'))
        check("IFC inspection is a saved workflow tool",
              n['type'] == '@n8n/n8n-nodes-langchain.toolWorkflow'
              and params['workflowId']['value'] == HELPER_ID == helper['id'])
        check("standalone manual inspection branch is removed", not (LEGACY_NODES & names))
        check("inspection helper matches the reviewed read-only definition",
              helper == build_helper(by_name['ticket_lookup']['credentials']['postgres']))
        hnodes = {h['name']: h for h in helper['nodes']}
        hp = hnodes['Read IFC Maintenance']['parameters']
        check("helper reads only the fixed IFC endpoint", hp['method'] == 'GET'
              and hp['url'] == "={{ ($env.IFC_SERVICE_URL || '').replace(/\\/+$/, '') + '/maintenance' }}")
        hq = hnodes['Read Matched Technician Reports']['parameters']
        check("helper uses a fixed parameterized SELECT", hq['query'].startswith('WITH ')
              and not WRITE.search(hq['query']) and '{{' not in hq['query']
              and '$1' in hq['query'] and 'JSON.stringify($json.assets)' in hq['options']['queryReplacement'])
        continue
    if n["type"] != "n8n-nodes-base.postgresTool":
        # Only Postgres tools are attached today; anything else must be reviewed
        # against these rules explicitly before it is added.
        not_select.append(t + " is " + n["type"])
        continue
    q = n["parameters"]["query"]
    if not q.lstrip().upper().startswith(("SELECT", "WITH")):
        not_select.append(t)
    if WRITE.search(q):
        writes.append(t + ": " + WRITE.search(q).group(0))
    if "$1" not in q:
        unbound.append(t)
check("every direct database tool is a SELECT", not not_select, "; ".join(not_select))
check("no direct database tool contains a writing statement", not writes, "; ".join(writes))
check("every direct database tool binds its $1 replacement", not unbound, "; ".join(unbound))

# 6. no tool takes SQL from the model
sql_from_model = []
for t in sorted(tools):
    if t == "inspect_ifc_maintenance" or t in DESCS:
        continue
    repl = json.dumps(by_name[t]["parameters"]["options"].get("queryReplacement", ""))
    if not repl.strip('"'):
        sql_from_model.append(t + " has no queryReplacement")
    for arg in re.findall(r'\$fromAI\(\\"([^"\\]+)', repl):
        if arg.lower() in ("sql", "query", "statement", "where", "filter", "condition"):
            sql_from_model.append("{} accepts $fromAI({})".format(t, arg))
check("no tool accepts SQL, a WHERE clause or a raw filter from the model",
      not sql_from_model, "; ".join(sql_from_model))

# 7. the two writing nodes parameterize instead of interpolating
for w in ("Log FM Question", "Record Weekly Report", "Collect Weekly Data"):
    p = by_name[w]["parameters"]
    check(w + " parameterizes its query",
          "{{" not in p["query"] and "queryReplacement" in p["options"],
          p["query"][:80])

# 8. the weekly report does not depend on the model succeeding
check("the narrative chain is attached to a model",
      len(sources("Weekly Narrative", "ai_languageModel")) == 1)
check("a narrative failure does not stop the report",
      by_name["Weekly Narrative"].get("onError") == "continueRegularOutput")
check("an agent failure does not stop the chat reply",
      by_name[AGENT].get("onError") == "continueRegularOutput")
check("the email is sent before the run is recorded",
      conns["Email Weekly Report"]["main"][0][0]["node"] == "Record Weekly Report")
check("the report is composed from figures, not from the model's prose",
      "$('Build Weekly Report')" in by_name["Compose Weekly Email"]["parameters"]["jsCode"])

# 9. one definition of "a month", everywhere
month = {
    "chat context JS": str(STALE_DAYS) in by_name["FM Chat Context"]["parameters"]["jsCode"],
    "report window JS": "staleDays: {}".format(STALE_DAYS)
                        in by_name["Report Window"]["parameters"]["jsCode"],
    "overdue_tickets default": "::int, {}), 1), 365)".format(STALE_DAYS)
                               in by_name["overdue_tickets"]["parameters"]["query"],
    "weekly query default": "::int, {}), 1), 365)".format(STALE_DAYS)
                            in by_name["Collect Weekly Data"]["parameters"]["query"],
    "agent system message": "'A month' means {} days".format(STALE_DAYS)
                            in by_name[AGENT]["parameters"]["options"]["systemMessage"],
}
check("every place that means 'a month' says {} days".format(STALE_DAYS), all(month.values()),
      ", ".join(k for k, v in month.items() if not v))
check("the reporting window is {} days".format(WINDOW_DAYS),
      "{} * 86400000".format(WINDOW_DAYS)
      in by_name["Report Window"]["parameters"]["jsCode"])
check("the question length cap is stated once and enforced",
      by_name["FM Chat Context"]["parameters"]["jsCode"].count(str(MAX_QUESTION_CHARS)) >= 2)
check("the agent remembers {} turns".format(HISTORY_TURNS),
      by_name["FM Chat Memory"]["parameters"]["contextWindowLength"] == HISTORY_TURNS)

# 10. the chat surface itself
ct = by_name[CHAT_TRIGGER]["parameters"]
check("the hosted chat requires authentication",
      ct.get("authentication") not in (None, "none"), ct.get("authentication"))
check("the chat returns the last node's output",
      ct["options"].get("responseMode") == "lastNode")
check("the chat trigger has a fixed webhook id",
      bool(by_name[CHAT_TRIGGER].get("webhookId")))
for terminal in ("Chat Response", "Empty Question Reply"):
    check(terminal + " emits an `output` field",
          "output:" in by_name[terminal]["parameters"]["jsCode"])
check("an empty question never reaches the model",
      conns["Question Asked?"]["main"][1][0]["node"] == "Empty Question Reply")

# 11. Configured exports reference credentials by ID; never embed secret values.
blob = json.dumps(wf)
refs = [c for n in wf['nodes'] for c in n.get('credentials', {}).values()]
check("configured credential references have IDs and names",
      all(c.get('id') and c.get('name') and not c['id'].startswith('REPLACE_') for c in refs))
check("no literal API key or bearer token is embedded",
      not re.search(r'sk-or-v1-[a-f0-9]{32,}|Bearer\s+[A-Za-z0-9._-]{24,}', blob))

total = len(failures)
print("\n{} check(s) failed".format(total) if total else "\nall checks passed")
sys.exit(1 if failures else 0)
