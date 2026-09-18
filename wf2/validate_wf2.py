"""Structural checks on the rebuilt WF2.

Catches the failure modes that only surface at runtime in n8n: a connection or an
expression naming a node that no longer exists, a node stranded with no inbound
edge, a tool not attached to the agent, and an agent with no model.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WF2 = sys.argv[1] if len(sys.argv)>1 else os.path.join(ROOT, "n8n_wf2_completion_approval_ifc_update.json")

wf = json.load(open(WF2, encoding="utf-8"))
names = {n["name"] for n in wf["nodes"]}
by_name = {n["name"]: n for n in wf["nodes"]}
conns = wf["connections"]

failures = []
def check(label, ok, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + (("\n          " + detail) if detail and not ok else ""))
    if not ok:
        failures.append(label)

print("WF2 structure\n")
print("  nodes: {}   connection entries: {}".format(len(wf["nodes"]), len(conns)))
print()

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

# 3. reachability from the trigger
TRIGGER = "Completed Upload (Drive Trigger)"
check("trigger exists", TRIGGER in names)
seen, stack = set(), [TRIGGER]
while stack:
    cur = stack.pop()
    if cur in seen:
        continue
    seen.add(cur)
    for br in conns.get(cur, {}).get("main", []):
        for e in br or []:
            stack.append(e["node"])
aux = {n["name"] for n in wf["nodes"]
       if n["type"].endswith(("stickyNote",)) or "Tool" in n["type"]
       or '.lmChat' in n["type"] or n["type"].endswith("toolWorkflow")}
unreachable = names - seen - aux
check("every main-flow node is reachable from the trigger", not unreachable,
      "unreachable: " + ", ".join(sorted(unreachable)))

# 4. agent wiring
AGENT = "Closure Supervisor"
tools = [src for src, spec in conns.items()
         if any(e["node"] == AGENT for br in spec.get("ai_tool", []) for e in br or [])]
models = [src for src, spec in conns.items()
          if any(e["node"] == AGENT for br in spec.get("ai_languageModel", []) for e in br or [])]
check("supervisor has a language model", len(models) == 1, str(models))
check("supervisor has its 9 tools", len(tools) == 9, "{}: {}".format(len(tools), sorted(tools)))
check("no tool executes free-form SQL",
      all("$fromAI(\"sql" not in json.dumps(by_name[t].get("parameters", {})) and
          "queryReplacement" in json.dumps(by_name[t].get("parameters", {})) or
          by_name[t]["type"] != "n8n-nodes-base.postgresTool" for t in tools))

# 5. Each reachable chain has a model; vision and assessment may use different providers.
chains = {n['name'] for n in wf['nodes'] if n['type'].endswith('.chainLlm') and n['name'] in seen}
chain_targets = [e['node'] for spec in conns.values() for br in spec.get('ai_languageModel',[]) for e in br or []]
check("both LLM chains are attached to a model", len(chains)==2 and all(chain_targets.count(n)==1 for n in chains), str(chain_targets))

# 6. the replaced chain is gone
gone = ["IFC Service - Log Maintenance", "Close Ticket", "Update Technician Stats",
        "Notify Technician - Closed", "Notify FM - Ticket Closed", "Reopen for Rework",
        "Notify Technician - Rework Required"]
check("the seven replaced closure nodes are removed", not (names & set(gone)),
      str(sorted(names & set(gone))))

# 7. the supervisor's attempt budget is stated
sys_msg = by_name[AGENT]["parameters"]["options"]["systemMessage"]
check("attempt budget of 3 is stated to the supervisor", "at most 3 times" in sys_msg)
check("closure context binds attemptBudget 3",
      bool(re.search(r"attemptBudget:\s*3", by_name["Closure Context"]["parameters"]["jsCode"])))

# 8. verification is independent of the agent's own claim
check("closure is verified from committed database state",
      "SELECT" in by_name["Verify Closure Outcome"]["parameters"]["query"]
      and conns["Closure Supervisor"]["main"][0][0]["node"] == "Verify Closure Outcome")

# 9. email and chat share committed decisions; settled work bypasses the agent.
check("approval waits on the database instead of a private email callback",
      'FM Approval (Email + Wait)' not in names and
      conns['Wait for FM Decision']['main'][0][0]['node']=='Read FM Review State')
check("settled decisions bypass the supervisor",
      conns['Closure Already Handled?']['main'][0][0]['node']=='Verify Closure Outcome' and
      conns['Closure Already Handled?']['main'][1][0]['node']=='Closure Supervisor')

print("\nStructural validation " + ('FAILED' if failures else 'passed'))
sys.exit(1 if failures else 0)
