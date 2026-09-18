"""Integration tests in an isolated schema copy. No Gmail, IFC service or LLM calls."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import uuid

HERE=Path(__file__).resolve().parent
DB='cbm_wf3_actions_test_20260918'
assert DB.startswith('cbm_wf3_actions_test_')
COUNT=0
def sql(q,expect_error=False):
    p=subprocess.run(['docker','exec','-i','n8n_deploy-cbm-postgres-1','psql','-U','cbm_app','-d',DB,'-Atq','-v','ON_ERROR_STOP=1'],input=q,text=True,encoding='utf-8',capture_output=True)
    if expect_error:
        assert p.returncode!=0; return p.stderr
    if p.returncode: raise RuntimeError(p.stderr)
    return p.stdout.strip()
def arg(p):return "'"+json.dumps(p).replace("'","''")+"'::jsonb"
def fn(name,p):return json.loads(sql('SELECT '+name+'('+arg(p)+');'))
def check(test,label):
    global COUNT
    assert test,label
    COUNT+=1
def create(status='PENDING_AUTHORIZATION'):
    authorized='NULL' if status=='PENDING_AUTHORIZATION' else 'now()'
    return int(sql("INSERT INTO tickets(status,technician_id,ifc_global_id,ifc_name,description,approval_id,dispatch_authorization_id,dispatch_authorization_token,dispatch_authorization_expires_at,dispatch_authorized_at) VALUES ('"+status+"',1,'test-"+str(uuid.uuid4())+"','Synthetic valve','Synthetic test only',gen_random_uuid(),gen_random_uuid(),repeat('a',64),now()+interval '1 day',"+authorized+") RETURNING id;"))
def request(tid,action,**kw):
    c=json.loads(sql(f'SELECT cbm_wf3_action_context({tid});'))
    return dict(action=action,ticketId=tid,approvalId=c['approval_id'],expectedUpdatedAt=c['expected_updated_at'],reason='Synthetic FM reason',actor='FM_CHAT',truncated=False,sessionId='isolated-test',question='Synthetic explicit FM action',requestId=str(uuid.uuid4()),**kw)
def begin(p):return fn('cbm_wf3_begin_action',p)
def state(tid):return sql(f'SELECT status FROM tickets WHERE id={tid};')
def context(p):
    r=begin(p);check(r['outcome']=='READY','ready completion');return {**r['context'],'fmEmail':'fm@example.test','ifcServiceUrl':'http://not-called'}
def event(tid,name,p):sql(f"INSERT INTO ticket_events(ticket_id,event,payload) VALUES({tid},'{name}',{arg(p)});")

sql("TRUNCATE tickets,technicians,cbm_intake_outbox RESTART IDENTITY CASCADE; INSERT INTO technicians(full_name,email,skills) VALUES('Synthetic Technician','technician@example.test',ARRAY['plumbing']);")
t=create(); p=request(t,'approve_intervention'); r=begin(p)
check(r['outcome']=='APPLIED' and state(t)=='LOCALIZED','initial approval localized')
check(begin(p)['already_processed'],'same request idempotent')
check(sql(f"SELECT count(*) FROM ticket_events WHERE ticket_id={t} AND event='CBM_DISPATCH_AUTHORIZATION'")=='1','one authorization')
check(sql(f"SELECT payload->>'actor' FROM ticket_events WHERE ticket_id={t} AND event='CBM_DISPATCH_AUTHORIZATION'")=='FM_CHAT','actor audit')
t=create();p=request(t,'reject_intervention');p['reason']='';check(begin(p)['outcome']=='BLOCKED','reason required')
p['reason']='Duplicate issue';check(begin(p)['outcome']=='APPLIED' and state(t)=='REJECTED','reject initial')
t=create();p=request(t,'approve_intervention');p['expectedUpdatedAt']='2000-01-01T00:00:00Z';check(begin(p)['outcome']=='BLOCKED','stale timestamp')
p=request(t,'approve_intervention');p['approvalId']=str(uuid.uuid4());check(begin(p)['outcome']=='BLOCKED','stale approval')
p=request(t,'approve_intervention');p['truncated']=True;check(begin(p)['outcome']=='BLOCKED','truncated turn')
sql(f"UPDATE tickets SET dispatch_authorization_expires_at=now()-interval '1 day' WHERE id={t};")
p=request(t,'approve_intervention');check(begin(p)['outcome']=='APPLIED','expired email still approvable in authenticated chat')
t=create();p=request(t,'resend_approval_email');r=begin(p);check(r['outcome']=='QUEUED' and state(t)=='PENDING_AUTHORIZATION','resend no status change')
begin(p);check(sql(f"SELECT count(*) FROM cbm_intake_outbox WHERE payload->>'ticket_id'='{t}' AND event_key LIKE 'wf3-resend:%'")=='1','one resend per request')
t=create('PENDING_APPROVAL');p=request(t,'approve_completion');c=context(p)
check(fn('cbm_wf2_close_ticket',c)['status']=='BLOCKED','no IFC means no closure')
check(fn('cbm_wf3_finish_action',c)['outcome']=='INCOMPLETE','missing operations reported')
sql(f"UPDATE tickets SET status='CLOSED',closed_at=now() WHERE id={t};",expect_error=True);check(state(t)=='PENDING_APPROVAL','DB trigger prevents bypass')
event(t,'CBM_WF2_IFC_RESULT',{'operation_key':c['operationKey'],'outcome':'FAILED','version_file':'synthetic.ifc'})
check(fn('cbm_wf2_close_ticket',c)['status']=='BLOCKED','IFC failure blocks')
check(begin(request(t,'request_rework'))['outcome']=='BLOCKED','opposing decision blocked')
sql(f"UPDATE tickets SET ifc_new_version='synthetic.ifc' WHERE id={t};")
event(t,'CBM_WF2_IFC_RESULT',{'operation_key':c['operationKey'],'outcome':'SUCCEEDED','version_file':'synthetic.ifc'})
check(fn('cbm_wf2_close_ticket',c)['status']=='CLOSED','successful IFC permits close')
check(fn('cbm_wf2_close_ticket',c)['changed'] is False,'close idempotent')
f=json.loads((HERE/'workflows/cbmWf3TicketAction.json').read_text(encoding='utf-8'));nodes={n['name']:n for n in f['nodes']}
stats=nodes['Reuse Technician Statistics']['parameters']['query'].replace('$1',arg(c))
sql(stats);sql(stats);check(sql('SELECT jobs_completed FROM technicians WHERE id=1')=='1','stats once')
r=fn('cbm_wf3_finish_action',c);check(r['outcome']=='INCOMPLETE' and 'notify_fm_closed' in r['missing_operations'],'closed with missing email is incomplete')
for key,recipient in [('fm:closed','fm@example.test'),('technician:closed','technician@example.test')]:
    event(t,'CBM_WF2_NOTICE',{'approval_id':c['approvalId'],'notice_key':key,'source':'GMAIL_API','outcome':'SENT','message_id':'synthetic-'+key,'recipient':recipient})
check(fn('cbm_wf3_finish_action',c)['outcome']=='APPLIED','all receipts settle')
check(begin(p)['outcome']=='READY','same request resumes stored closure')
t=create('PENDING_APPROVAL');c=context(request(t,'request_rework'))
sql(nodes['Reuse Rework Transition']['parameters']['query'].replace('$1',arg(c)));check(state(t)=='REWORK','reuse rework transition')
check(fn('cbm_wf3_finish_action',c)['outcome']=='INCOMPLETE','rework waits for notification')
event(t,'CBM_WF2_NOTICE',{'approval_id':c['approvalId'],'notice_key':'technician:rework','source':'GMAIL_API','outcome':'SENT','message_id':'synthetic-rework','recipient':'technician@example.test'})
check(fn('cbm_wf3_finish_action',c)['outcome']=='APPLIED','rework settled')
t=create('PENDING_APPROVAL');c=context(request(t,'resend_approval_email'));e=fn('cbm_wf3_prepare_email',c)
check(e['outcome']=='SEND','completion email claimed')
check(fn('cbm_wf3_prepare_email',c)['outcome']=='UNCONFIRMED','no double send')
link={'emailId':e['email_id'],'token':e['token']};before=sql('SELECT count(*) FROM ticket_events')
check(fn('cbm_wf3_email_access',link)['valid'],'valid email GET')
check(sql('SELECT count(*) FROM ticket_events')==before and state(t)=='PENDING_APPROVAL','GET has no mutation')
check(not fn('cbm_wf3_email_access',{**link,'token':'b'*64})['valid'],'wrong token rejected')
check(not fn('cbm_wf3_email_access',{'emailId':'bad','token':'bad'})['valid'],'malformed token rejected')
check(not fn('cbm_wf3_email_access',{**link,'decision':'reject','reason':''})['valid'],'email rework reason required')
check(fn('cbm_wf3_record_email',{'email_id':e['email_id'],'send_status':'SENT','message_id':'synthetic-gmail'})['outcome']=='SENT','Gmail receipt recorded')
check(fn('cbm_wf3_prepare_email',c)['outcome']=='SENT','confirmed resend not duplicated')
posted=fn('cbm_wf3_email_access',{**link,'decision':'approve'})['context']
check(begin(posted)['outcome']=='READY','email decision uses same guarded action')
check(not fn('cbm_wf3_email_access',link)['valid'],'decided link blocked')
t=create('PENDING_APPROVAL');c=context(request(t,'resend_approval_email'));e=fn('cbm_wf3_prepare_email',c)
sql("UPDATE cbm_wf3_approval_emails SET expires_at=now()-interval '1 second' WHERE id='"+e['email_id']+"';")
check(not fn('cbm_wf3_email_access',{'emailId':e['email_id'],'token':e['token']})['valid'],'expired link blocked')
t=create('PENDING_APPROVAL');a=request(t,'approve_completion');b=request(t,'request_rework')
with ThreadPoolExecutor(2) as pool: results=list(pool.map(begin,[a,b]))
check(sorted(r['outcome'] for r in results)==['BLOCKED','READY'],'concurrent opposite decisions serialized')
check(sql(f"SELECT count(*) FROM ticket_events WHERE ticket_id={t} AND event='CBM_WF2_APPROVAL'")=='1','single persisted race winner')
print(json.dumps({'database':DB,'assertions_passed':COUNT,'external_calls':0}))
