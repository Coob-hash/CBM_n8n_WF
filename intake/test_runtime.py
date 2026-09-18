"""Exercise the actual n8n workflow using isolated HTTP provider/mail simulators."""
import json,time,uuid,urllib.request,urllib.error,urllib.parse,subprocess,os
from pathlib import Path
import psycopg
BASE='http://127.0.0.1:5689'
DSN='host=127.0.0.1 port=55439 dbname=cbm_demo user=cbm_app password=disposable-postgres-test-password'
db=psycopg.connect(DSN,autocommit=True)
def one(q,args=()):return db.execute(q,args).fetchone()[0]
def http(path,body=None,form=False):
    data=None if body is None else (urllib.parse.urlencode(body).encode() if form else json.dumps(body).encode())
    req=urllib.request.Request(BASE+path,data=data,headers={'Content-Type':'application/x-www-form-urlencoded' if form else 'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=15) as response:return response.status,response.read().decode()
    except urllib.error.HTTPError as e:return e.code,e.read().decode()
def wait(check,label):
    for _ in range(100):
        if check():return
        time.sleep(.2)
    raise AssertionError('Timed out: '+label)
def photo(fid,rid,email='reporter@test.invalid'):
    return {'id':fid,'name':f'report_{email}_{rid}_photo.jpg','webViewLink':'https://drive.test.invalid/'+fid}
def capture(items):assert http('/webhook/intake-test-captures',{'captures':items})[0]==200
def state(rid):return one('SELECT state FROM cbm_intake_reports WHERE id=%s',(rid,))
def recorded(rid):return one("SELECT count(*) FROM cbm_intake_reports WHERE id=%s AND state<>'PROCESSING'",(rid,))>0
db.execute('TRUNCATE cbm_intake_outbox,cbm_it_issues,cbm_capture_attempts,cbm_intake_reports,ticket_events,tickets RESTART IDENTITY CASCADE')
rid=str(uuid.uuid4())
for i in range(1,5):
    capture([photo('bad'+str(i),rid)])
    wait(lambda:one('SELECT count(*) FROM cbm_capture_attempts WHERE report_id=%s AND attempt=%s AND status=%s',(rid,i,'FAILED'))==1,'failed capture '+str(i))
    assert state(rid)==('AWAITING_PHOTO' if i<4 else 'IT_ISSUE')
    if i==2:
        db.close()
        subprocess.run(['docker','restart','cbm-intake-validation-cbm-postgres-1'],check=True,capture_output=True,
         creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        for attempt in range(100):
            try:db=psycopg.connect(DSN,autocommit=True);break
            except psycopg.OperationalError:time.sleep(.2)
        assert one('SELECT attempts FROM cbm_intake_reports WHERE id=%s',(rid,))==2
assert one('SELECT count(*) FROM tickets')==0
assert one('SELECT count(*) FROM cbm_it_issues')==1
capture([photo('bad4',rid),photo('bad5',rid)])
time.sleep(.6)
assert one('SELECT attempts FROM cbm_intake_reports WHERE id=%s',(rid,))==4
print('PASS n8n: four failed captures, durable count across PostgreSQL restart, one IT bug, no ticket, duplicate/extra uploads bounded.',flush=True)

heat=str(uuid.uuid4());outlet=str(uuid.uuid4())
capture([photo('okHeat',heat,'heat@test.invalid'),photo('ok_outlet',outlet,'outlet@test.invalid')])
wait(lambda:one('SELECT count(*) FROM tickets')==2,'two reports in one Drive batch')
assert one("SELECT count(*) FROM tickets WHERE status='PENDING_AUTHORIZATION' AND technician_id IS NULL")==2
assert one("SELECT count(*) FROM ticket_events WHERE event='CBM_TEST_DISPATCH_ENTERED'")==0
for rid,email,guid in [(heat,'heat@test.invalid','3kcZF9AH16IwPfuL_CGFlR'),(outlet,'outlet@test.invalid','1qMgWWNHzE3egAZbWFbgXF')]:
    t=one('SELECT to_jsonb(t) FROM tickets t WHERE intake_report_id=%s',(rid,))
    assert (t['reporter_email'],t['ifc_global_id'])==(email,guid)
    fields={'ticket':str(t['id']),'authorization':t['dispatch_authorization_id'],'token':t['dispatch_authorization_token']}
    status,page=http('/webhook/cbm-wf1-authorize?'+urllib.parse.urlencode(fields))
    assert status==200 and '<img src=x' not in page and '&lt;img' in page
    assert one('SELECT status FROM tickets WHERE id=%s',(t['id'],))=='PENDING_AUTHORIZATION'
    fields['decision']='reject' if rid==heat else 'approve'
    status,receipt=http('/webhook/cbm-wf1-authorize',fields,form=True)
    assert status==200,(status,receipt)
    if rid==outlet:
        wait(lambda:one("SELECT count(*) FROM ticket_events WHERE event='CBM_TEST_DISPATCH_ENTERED'")==1,'approved branch enters dispatch')
    else:assert one('SELECT status FROM tickets WHERE id=%s',(t['id'],))=='REJECTED'
    assert http('/webhook/cbm-wf1-authorize',fields,form=True)[0]==409
assert one("SELECT count(*) FROM ticket_events WHERE event='CBM_TEST_DISPATCH_ENTERED'")==1
print('PASS n8n: batch isolation, automatic radiator/outlet matching, pending FM gate, read-only GET, escaped form, explicit approve/reject and replay protection.',flush=True)

for prefix,reason in [('ambiguous','ASSET_IDENTIFICATION_UNRESOLVED'),('invented','ASSET_IDENTIFICATION_UNRESOLVED'),('error','PROVIDER_OR_SERVICE_ERROR')]:
    rid=str(uuid.uuid4());capture([photo(prefix+'Photo',rid)])
    wait(lambda:one('SELECT count(*) FROM cbm_capture_attempts WHERE report_id=%s AND status=%s',(rid,'FAILED'))==1,prefix)
    assert one('SELECT reason FROM cbm_capture_attempts WHERE report_id=%s',(rid,))==reason
assert one('SELECT count(*) FROM tickets')==2
print('PASS n8n: ambiguity, invented GUID and provider outage request another photo; none creates a ticket.',flush=True)

# The test export sends to an HTTP simulator instead of Gmail.
pending=one("SELECT count(*) FROM cbm_intake_outbox WHERE status='PENDING'")
for _ in range(pending):
    before=one("SELECT count(*) FROM cbm_intake_outbox WHERE status='SENT'")
    assert http('/webhook/intake-test-tick',{})[0]==200
    wait(lambda:one("SELECT count(*) FROM cbm_intake_outbox WHERE status='SENT'")>before,'notification receipt')
messages=json.load(urllib.request.urlopen('http://127.0.0.1:58010/messages'))
assert len([m for m in messages if m['to']=='it@test.invalid'])==1
assert len([m for m in messages if m['to']=='fm@test.invalid'])==2
assert all(m['to'].endswith('@test.invalid') for m in messages)
assert one("SELECT count(*) FROM cbm_intake_outbox WHERE status IN ('SENDING','UNCERTAIN')")==0
print('PASS n8n: reporter retries, IT bug, FM authorization and rejection notices delivered only to the local mail simulator with persisted receipts.',flush=True)
report={'status':'passed','providers':'local simulated providers; no real emails or provider calls',
 'checks':['three retries after original','PostgreSQL restart persistence','idempotent uploads','Drive batch isolation',
 'automatic proxy selection','ambiguity/invented GUID/outage fail closed','GET read only','HTML escaping','approval/rejection/replay',
 'dispatch entry only after approval','durable notifications'],'real_provider_localization_verified':False}
out=Path(__file__).resolve().parents[1]/'case-study/validation/intake-runtime.json';out.parent.mkdir(parents=True,exist_ok=True)
out.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
