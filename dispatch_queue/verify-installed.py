import json
from pathlib import Path
import sqlite3

ROOT=Path(__file__).resolve().parents[2]
expected=json.loads((ROOT/'validation/installed-workflows.json').read_text(encoding='utf-8'))
con=sqlite3.connect(Path(r'C:\Users\USER\Desktop\n8n_test\database.sqlite').as_uri()+'?mode=ro',uri=True)
con.execute('PRAGMA query_only=ON')
report=[]
for w in expected:
    row=con.execute('SELECT active,nodes,connections FROM workflow_entity WHERE id=?',(w['id'],)).fetchone()
    assert row and not row[0],w['name']
    assert json.loads(row[1])==w['nodes'],w['name']
    assert json.loads(row[2])==w['connections'],w['name']
    report.append({'id':w['id'],'name':w['name'],'inactive':True,'nodes':len(w['nodes'])})
(ROOT/'validation/installed-verification.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
print(f'Verified {len(report)} saved inactive workflows match the reviewed updates exactly.')

log=(ROOT/'validation/n8n-batch-check.log').read_text(encoding='utf-8-sig')
data=json.loads(log[log.index('{\n'):])
result=data['data']['resultData']['runData']['Assert Batch Result'][0]['data']['main'][0][0]['json']
assert result['passed'] and result['completed']==[1,2,4,5] and result['childExecutions']==5
(ROOT/'validation/n8n-batch-result.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
print('Verified real n8n 2.29.9 self-call/loop test: five children; expected child failure did not stop the batch.')
