"""A second clean build must leave every generated workflow byte-identical."""
from pathlib import Path
import subprocess
import sys
import hashlib
ROOT=Path(__file__).resolve().parents[1]
paths=[*ROOT.glob('*workflow*.json'),ROOT/'wf1_ticket_intake_and_dispatch.json',*ROOT.glob('n8n_*.json'),
       *ROOT.glob('phase_b/workflows/*.json'),ROOT/'phase_b/workflow-manifest.json',ROOT/'phase_b/test-dispatch.js',
       *ROOT.glob('knowledge/*workflow.json'),*ROOT.glob('wf2/workflows/*.json')]
before={p:hashlib.sha256(p.read_bytes()).hexdigest() for p in set(paths)}
for command in [['node','demo_ingestion/build.js'],[sys.executable,'wf2/build_wf2.py'],[sys.executable,'wf3/build_wf3.py']]:
    subprocess.run(command,cwd=ROOT,check=True,capture_output=True)
changed=[str(p.relative_to(ROOT)) for p,digest in before.items() if hashlib.sha256(p.read_bytes()).hexdigest()!=digest]
if changed:raise AssertionError('Non-reproducible build: '+', '.join(changed))
print(f'PASS Rebuild reproduces all {len(before)} workflow exports and pins byte for byte')
