"""Isolated database integration tests; no external email/model/IFC requests."""
from pathlib import Path
import json, subprocess, uuid
DB='cbm_wf2_chat_test_20260918'
assert DB.startswith('cbm_wf2_chat_test_')
COUNT=0
def sql(q):
    p=subprocess.run(['docker','exec','-i','n8n_deploy-cbm-postgres-1','psql','-U','cbm_app','-d',DB,'-Atq','-v','ON_ERROR_STOP=1'],input=q,text=True,encoding='utf-8',capture_output=True)
    if p.returncode:raise RuntimeError(p.stderr)
    return p.stdout.strip()
def arg(p):return "'"+json.dumps(p).replace("'","''")+"'::jsonb"
def fn(n,p):return json.loads(sql('SELECT '+n+'('+arg(p)+');'))
def check(v,label):
    global COUNT
    assert v,label
    COUNT+=1
def event(t,n,p):sql(f"INSERT INTO ticket_events(ticket_id,event,payload) VALUES({t},'{n}',{arg(p)});")
def create():
    return json.loads(sql("INSERT INTO tickets(status,technician_id,ifc_global_id,description,approval_id,report_file_id,dispatch_authorized_at) VALUES('PENDING_APPROVAL',1,'synthetic-"+str(uuid.uuid4())+"','Synthetic test only',gen_random_uuid(),'synthetic-report',now()) RETURNING jsonb_build_object('ticketId',id,'approvalId',approval_id,'source','WF2_REPORT');"))
def route(p):return fn('cbm_wf2_review_status',p)['route']
def request(p,action='approve_completion'):
    c=json.loads(sql(f"SELECT cbm_wf3_action_context({p['ticketId']});"))
    return dict(action=action,ticketId=p['ticketId'],approvalId=c['approval_id'],expectedUpdatedAt=c['expected_updated_at'],reason='Synthetic FM decision',actor='FM_CHAT',truncated=False,sessionId='isolated',question='Approve synthetic report',requestId=str(uuid.uuid4()))
sql("TRUNCATE tickets,technicians,cbm_intake_outbox RESTART IDENTITY CASCADE; INSERT INTO technicians(full_name,email,skills) VALUES('Synthetic Technician','technician@example.test',ARRAY['plumbing']);")
p=create();check(route(p)=='NEEDS_EMAIL','new report needs email')
e=fn('cbm_wf2_prepare_review_email',p);check(e['outcome']=='SEND','claim initial email');check(route(p)=='WAIT','claimed email waits')
check(fn('cbm_wf2_prepare_review_email',p)['outcome']=='UNCONFIRMED','repeat claim cannot duplicate send')
check(fn('cbm_wf2_prepare_review_email',{**p,'approvalId':str(uuid.uuid4())})['outcome']=='BLOCKED','stale cycle blocked')
check(fn('cbm_wf2_prepare_review_email',{**p,'source':'unknown'})['outcome']=='BLOCKED','untrusted source blocked')
link=dict(emailId=e['email_id'],token=e['token'])
check(fn('cbm_wf3_email_access',link)['valid'],'existing signed form accepts WF2 token')
check(route(p)=='WAIT','GET does not decide')
fn('cbm_wf3_record_email',dict(email_id=e['email_id'],send_status='SENT',message_id='synthetic'))
check(fn('cbm_wf2_prepare_review_email',p)['outcome']=='SENT','confirmed claim not resent')
ctx=fn('cbm_wf3_begin_action',request(p))['context'];ctx['fmEmail']='gruppo1isteagiovani@gmail.com'
check(route(p)=='PROCESSING','wait for running chat closure')
check(fn('cbm_wf2_prepare_review_email',p)['outcome']=='ALREADY_DECIDED','no email after decision')
check(fn('cbm_wf2_close_ticket',ctx)['status']=='BLOCKED','no IFC success blocks closure')
check(fn('cbm_wf3_finish_action',ctx)['outcome']=='INCOMPLETE','incomplete receipt')
check(route(p)=='DECIDED','finished incomplete action can enter supervisor')
t=p['ticketId'];aid=p['approvalId']
sql(f"UPDATE tickets SET ifc_new_version='synthetic.ifc' WHERE id={t};")
event(t,'CBM_WF2_IFC_RESULT',dict(operation_key=ctx['operationKey'],outcome='SUCCEEDED',version_file='synthetic.ifc'))
check(fn('cbm_wf2_close_ticket',ctx)['status']=='CLOSED','IFC success permits guarded close')
check(route(p)!='SETTLED','closed without notifications is incomplete')
event(t,'CBM_WF2_STATS',dict(approval_id=aid))
for key,recipient in [('fm:closed',ctx['fmEmail']),('technician:closed','technician@example.test')]:
    event(t,'CBM_WF2_NOTICE',dict(approval_id=aid,notice_key=key,source='GMAIL_API',outcome='SENT',message_id='synthetic-'+key,recipient=recipient))
check(route(p)=='SETTLED','all committed receipts settle WF2')
check(route({**p,'approvalId':str(uuid.uuid4())})=='SUPERSEDED','old report stops')
p=create();e=fn('cbm_wf2_prepare_review_email',p)
sql("UPDATE cbm_wf3_approval_emails SET expires_at=now()-interval '1 second' WHERE id='"+e['email_id']+"';")
check(route(p)=='NEEDS_EMAIL','expired request renews')
check(fn('cbm_wf2_prepare_review_email',p)['outcome']=='SEND','renewal creates new token')
fn('cbm_wf2_prepare_review_email',p)
check(sql(f"SELECT count(*) FROM ticket_events WHERE ticket_id={p['ticketId']} AND event='CBM_WF2_APPROVAL_EXPIRED';")=='1','expiry audit once')
ctx=fn('cbm_wf3_begin_action',request(p,'request_rework'))['context'];ctx['fmEmail']='grupppo1isteagiovani@gmail.com'
check(route(p)=='PROCESSING','rework also waits for executor')
sql(f"UPDATE ticket_events SET created_at=now()-interval '11 minutes' WHERE ticket_id={p['ticketId']} AND event='CBM_WF2_APPROVAL';")
check(route(p)=='ATTENTION','hung action never launches competing closure')
sql(f"UPDATE tickets SET status='REWORK',closed_at=NULL WHERE id={p['ticketId']};")
event(p['ticketId'],'CBM_WF2_NOTICE',dict(approval_id=p['approvalId'],notice_key='technician:rework',source='GMAIL_API',outcome='SENT',message_id='synthetic-rework',recipient='technician@example.test'))
check(route(p)=='SETTLED','rework settles')
p=create();e=fn('cbm_wf2_prepare_review_email',p)
c=fn('cbm_wf3_email_access',dict(emailId=e['email_id'],token=e['token'],decision='approve'))['context']
check(fn('cbm_wf3_begin_action',c)['outcome']=='READY','email approval uses same guarded executor')
check(route(p)=='PROCESSING','email and chat share poll route')
print(json.dumps(dict(assertions_passed=COUNT,database=DB,external_calls=0)))
