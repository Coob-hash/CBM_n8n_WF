"""Prepare a TEST-ONLY n8n export with local provider and mail simulators."""
import hashlib,json
from pathlib import Path
root=Path(__file__).resolve().parents[1]
w=json.loads((root/'app/wf1_ticket_intake_and_dispatch.json').read_text(encoding='utf-8'))
w.update(id='cbmIntakeRuntimeTest',name='ISOLATED intake approval runtime test',active=False)
w['settings'].pop('errorWorkflow',None)
nodes={n['name']:n for n in w['nodes']}
for name in ['Phase B Recovery Tick','Drive Trigger - New Snapshot']:
    n=nodes[name];n['type']='n8n-nodes-base.webhook';n['typeVersion']=2;n.pop('credentials',None)
    n['parameters']={'httpMethod':'POST','path':'intake-test-tick' if name=='Phase B Recovery Tick' else 'intake-test-captures','responseMode':'onReceived','options':{}}
    n['webhookId']='isolated-'+hashlib.sha256(name.encode()).hexdigest()[:24]
batch=dict(name='Test Capture Batch',id='test-capture-batch',type='n8n-nodes-base.code',typeVersion=2,position=[0,0],
 parameters={'jsCode':'return $json.body.captures.map(json=>({json}));'})
nodes[batch['name']]=batch
w['connections']['Drive Trigger - New Snapshot']={'main':[[{'node':batch['name'],'type':'main','index':0}]]}
w['connections'][batch['name']]={'main':[[{'node':'Process Each Drive Capture','type':'main','index':0}]]}
for name,path in [('MultiSet - Get Token','token'),('MultiSet - Localize Snapshot','localize'),('Find IFC Element','resolve'),('Vision Triage (Claude)','vision')]:
    n=nodes[name];n.pop('credentials',None)
    p=n['parameters'];p['url']='http://mock-provider:8010/'+path
    if path in ['localize','vision']:p['url']="={{ 'http://mock-provider:8010/"+path+"?file='+encodeURIComponent($('Capture Input').first().json.id) }}"
    for key in ['authentication','genericAuthType','nodeCredentialType','headerParameters','sendHeaders']:p.pop(key,None)
n=nodes['Download Snapshot'];n['type']='n8n-nodes-base.httpRequest';n['typeVersion']=4.2;n.pop('credentials',None)
n['parameters']={'url':'http://mock-provider:8010/photo','options':{'response':{'response':{'responseFormat':'file','outputPropertyName':'data'}}}}
n=nodes['Send Intake Notification'];n['type']='n8n-nodes-base.httpRequest';n['typeVersion']=4.2;n.pop('credentials',None)
n['parameters']={'method':'POST','url':'http://mock-provider:8010/send','sendBody':True,'specifyBody':'json',
 'jsonBody':'={{ JSON.stringify({to:$json.to,subject:$json.subject,text:$json.text}) }}','options':{}}
# Record entry to the unchanged dispatch subsystem without calling its LLM or contacting technicians.
marker=dict(name='Test Dispatch Entered',id='test-dispatch-entry',type='n8n-nodes-base.postgres',typeVersion=2.6,position=[0,0],
 parameters={'operation':'executeQuery','query':"INSERT INTO ticket_events(ticket_id,event,payload) VALUES($1,'CBM_TEST_DISPATCH_ENTERED','{}') RETURNING ticket_id;",
 'options':{'queryReplacement':'={{ [$json.ticketId] }}'}},credentials={'postgres':{'id':'intakeTestPg','name':'Isolated PostgreSQL'}})
nodes[marker['name']]=marker
w['connections']['Phase B Context']={'main':[[{'node':marker['name'],'type':'main','index':0}]]}
for n in nodes.values():
    if n['type'] in ['n8n-nodes-base.postgres','n8n-nodes-base.postgresTool']:
        n['credentials']={'postgres':{'id':'intakeTestPg','name':'Isolated PostgreSQL'}}
    n.setdefault('id',hashlib.sha256(n['name'].encode()).hexdigest()[:32])
w['nodes']=list(nodes.values())
text=json.dumps(w).replace('REPLACE_N8N_HOST','cbm.validation.invalid').replace('REPLACE_FM_EMAIL@example.com','fm@test.invalid').replace('REPLACE_IT_EMAIL@example.com','it@test.invalid')
(root/'tests/intake-runtime-workflow.json').write_text(text,encoding='utf-8')
(root/'tests/intake-runtime-credentials.json').write_text(json.dumps([{'id':'intakeTestPg','name':'Isolated PostgreSQL','type':'postgres','data':
 {'host':'cbm-postgres','port':5432,'database':'cbm_demo','user':'cbm_app','password':'disposable-postgres-test-password','ssl':'disable'}}]),encoding='utf-8')
print('Prepared isolated test workflow; every provider and email call uses mock-provider.')
