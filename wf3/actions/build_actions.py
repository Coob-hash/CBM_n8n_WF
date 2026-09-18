"""Add WF3 tools to a fresh live export. Never import or rewrite WF1/WF2/helpers."""
import copy
import json
from pathlib import Path
import sys
import uuid

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
EVIDENCE = ROOT / 'validation-wf3-actions'
MAIN = '658IWGwRtDMsPri7'
ACTION = 'cbmWf3TicketAction'
MAIL = 'cbmWf3ApprovalMail'
IFC = 'eqrcZZLPvsjRgCUR'
NOTICE = '3sdjXyXedBKiDGXD'
FM = 'gruppo1isteagiovani@gmail.com'
PUBLIC = 'https://bonanza-progress-hangover.ngrok-free.dev'
SCHEMA = [dict(id='context',displayName='context',type='string',required=True,defaultMatch=False,display=True,canBeUsedToMatch=True)]

def node(name, kind, params, pos, version=2, **extra):
    return dict(id=str(uuid.uuid5(uuid.NAMESPACE_URL,'cbm-wf3-actions/'+name)),name=name,
                type=kind if kind.startswith('@') else 'n8n-nodes-base.'+kind,
                typeVersion=version,parameters=params,position=pos,**extra)

def inputs(expr):
    return dict(mappingMode='defineBelow',value={'context':expr},schema=copy.deepcopy(SCHEMA),
                matchingColumns=[],attemptToConvertTypes=False,convertFieldsToString=False)

class Flow:
    def __init__(self, ident, name, pg):
        self.w = dict(id=ident,name=name,active=False,nodes=[],connections={},settings={'executionOrder':'v1','callerPolicy':'workflowsFromSameOwner'},pinData={})
        self.pg=pg
    def add(self,n):
        self.w['nodes'].append(n); return n
    def link(self,a,b,branch=0):
        branches=self.w['connections'].setdefault(a,{}).setdefault('main',[])
        while len(branches)<=branch: branches.append([])
        branches[branch].append({'node':b,'type':'main','index':0})
    def code(self,name,code,pos): return self.add(node(name,'code',{'jsCode':code},pos))
    def pgq(self,name,query,expr,pos,continuable=False):
        return self.add(node(name,'postgres',{'operation':'executeQuery','query':query,'options':{'queryReplacement':'={{ [JSON.stringify('+expr+')] }}'}},pos,2.6,
                             credentials={'postgres':copy.deepcopy(self.pg)},alwaysOutputData=True,
                             **({'onError':'continueRegularOutput'} if continuable else {})))
    def gate(self,name,expr,pos):
        return self.add(node(name,'if',{'conditions':{'options':{'caseSensitive':True,'leftValue':'','typeValidation':'strict','version':2},'combinator':'and',
            'conditions':[{'id':name,'leftValue':'={{ '+expr+' }}','rightValue':True,'operator':{'type':'boolean','operation':'true','singleValue':True}}]},'options':{}},pos,2.2))
    def call(self,name,wid,expr,pos):
        return self.add(node(name,'executeWorkflow',{'workflowId':{'__rl':True,'mode':'id','value':wid},'workflowInputs':inputs('={{ JSON.stringify('+expr+') }}'),
            'options':{'waitForSubWorkflow':True}},pos,1.3,alwaysOutputData=True,onError='continueRegularOutput'))
    def trigger(self,name='Action Input',pos=(0,0)):
        return self.add(node(name,'executeWorkflowTrigger',{'workflowInputs':{'values':[{'name':'context'}]}},list(pos),1.1))

def action_flow(pg,wf2):
    f=Flow(ACTION,'[CBM] WF3 - Guarded FM Ticket Action',pg)
    f.trigger()
    f.code('Validate FM Action',(HERE/'normalize-action.js').read_text(),[240,0])
    f.pgq('Begin Guarded Action','SELECT cbm_wf3_begin_action($1::jsonb) AS result;','$json',[480,0])
    f.code('Stored Action Context',"const r=$json.result; return [{json:{...r,context:r.context?{...r.context,fmEmail:"+json.dumps(FM)+",ifcServiceUrl:String($env.IFC_SERVICE_URL||'').replace(/\\/+$/,'')}:null}}];",[720,0])
    f.gate('Action Ready?',"$json.outcome === 'READY'",[960,0])
    f.code('Return Immediate Result',"const {context,...result}=$json; return [{json:result}];",[1200,360])
    f.gate('Completion Approval?',"$json.route === 'completion_approve'",[1200,0])
    ctx="$('Stored Action Context').first().json.context"
    f.call('Reuse Guarded IFC Write',IFC,ctx,[1440,-240])
    f.gate('IFC Update Succeeded?',"$json.status === 'SUCCEEDED' && typeof $json.version_file === 'string' && $json.version_file.trim().length > 0",[1680,-240])
    f.pgq('Close with Existing IFC Guard','SELECT cbm_wf2_close_ticket($1::jsonb) AS result;',ctx,[1920,-240],True)
    f.gate('Ticket Closed?',"$json.result?.status === 'CLOSED'",[2160,-240])
    by={n['name']:n for n in wf2['nodes']}
    f.pgq('Reuse Technician Statistics',by['update_technician_stats']['parameters']['query'],ctx,[2400,-240],True)
    f.call('Reuse Technician Closure Notice',NOTICE,'{...'+ctx+',noticeRecipient:"technician"}',[2640,-240])
    f.call('Reuse FM Closure Notice',NOTICE,'{...'+ctx+',noticeRecipient:"fm"}',[2880,-240])
    f.gate('Rework Request?',"$json.route === 'completion_rework'",[1440,180])
    f.pgq('Reuse Rework Transition',by['reopen_for_rework']['parameters']['query'],ctx,[1680,180],True)
    f.call('Reuse Technician Rework Notice',NOTICE,'{...'+ctx+',noticeRecipient:"technician"}',[1920,180])
    f.code('Return Email Plan','return [{json:$json}];',[1680,540])
    f.pgq('Read Committed Action Outcome','SELECT cbm_wf3_finish_action($1::jsonb) AS result;',ctx,[3120,0])
    f.code('Return Action Result','return [{json:$json.result || {outcome:"INCOMPLETE",reason:"Could not read the committed result"}}];',[3360,0])
    for a,b in [('Action Input','Validate FM Action'),('Validate FM Action','Begin Guarded Action'),('Begin Guarded Action','Stored Action Context'),('Stored Action Context','Action Ready?'),('Action Ready?','Completion Approval?'),('Completion Approval?','Reuse Guarded IFC Write'),('Reuse Guarded IFC Write','IFC Update Succeeded?'),('IFC Update Succeeded?','Close with Existing IFC Guard'),('Close with Existing IFC Guard','Ticket Closed?'),('Ticket Closed?','Reuse Technician Statistics'),('Reuse Technician Statistics','Reuse Technician Closure Notice'),('Reuse Technician Closure Notice','Reuse FM Closure Notice'),('Reuse FM Closure Notice','Read Committed Action Outcome'),('Rework Request?','Reuse Rework Transition'),('Reuse Rework Transition','Reuse Technician Rework Notice'),('Reuse Technician Rework Notice','Read Committed Action Outcome'),('Read Committed Action Outcome','Return Action Result')]: f.link(a,b)
    for a,b in [('Action Ready?','Return Immediate Result'),('Completion Approval?','Rework Request?'),('Rework Request?','Return Email Plan'),('IFC Update Succeeded?','Read Committed Action Outcome'),('Ticket Closed?','Read Committed Action Outcome')]: f.link(a,b,1)
    f.add(node('Action helper notes','stickyNote',{'content':'## WF3 actions only\nInitial decisions reuse cbm_authorize_dispatch. LOCALIZED is picked up by WF1.\nCompletion reuses the existing IFC + Gmail helpers unchanged. No CLOSED state before durable IFC success.\nEvery request is bound to an approval ID and the timestamp read by ticket_lookup.','width':900,'height':180},[0,-300],1))
    return f.w

def email_flow(pg,gmail):
    f=Flow(MAIL,'[CBM] WF3 - Completion Approval Email',pg)
    f.trigger('Email Request',(-720,0))
    f.call('Validate Resend Action',ACTION,'JSON.parse($json.context)',[-480,0])
    f.gate('Resend Ready?',"$json.outcome === 'READY' && $json.route === 'completion_resend'",[-240,0])
    f.code('Return Immediate Resend Result','return [{json:$json}];',[-240,240])
    f.code('Read Email Context','return [{json:$json.context}];',[240,0])
    f.pgq('Claim Approval Email','SELECT cbm_wf3_prepare_email($1::jsonb) AS result;','$json',[480,0])
    f.gate('New Email Claim?',"$json.result?.outcome === 'SEND'",[720,0])
    f.code('Compose Approval Email',"""const p=$json.result;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const url=PUBLIC+'/webhook/cbm-wf3-completion-approval?emailId='+encodeURIComponent(p.email_id)+'&token='+encodeURIComponent(p.token);
const report=/^[A-Za-z0-9_-]+$/.test(p.report_file_id||'')?'<p><a href="https://drive.google.com/file/d/'+esc(p.report_file_id)+'/view">Technician report / Rapporto tecnico</a></p>':'';
return [{json:{email_id:p.email_id,subject:'[CBM] Ticket #'+p.ticketId+' — completion approval',
html:'<div style="font:16px Arial;max-width:650px;color:#172033"><h2>Completion approval / Approvazione completamento</h2><p>Ticket #'+p.ticketId+' · '+esc(p.ifc_name)+'</p><p>'+esc(p.description)+'</p>'+report+'<p style="white-space:pre-wrap">'+esc(p.report_text)+'</p><p><a style="background:#12594c;color:white;padding:14px;text-decoration:none;display:inline-block" href="'+esc(url)+'">Review and decide / Esamina e decidi</a></p><p>Opening the link makes no change. Confirm approval or request rework on the page. Closure requires a successful IFC update.</p><p>Expires / Scadenza: '+esc(p.expires_at)+'</p></div>'}}];""".replace('PUBLIC',json.dumps(PUBLIC)),[960,0])
    f.add(node('Send FM Approval Email','gmail',{'sendTo':FM,'subject':'={{ $json.subject }}','emailType':'html','message':'={{ $json.html }}','options':{'appendAttribution':False}},[1200,0],2.1,
               credentials={'gmailOAuth2':gmail},retryOnFail=False,alwaysOutputData=True,onError='continueRegularOutput'))
    f.code('Capture Gmail Receipt',"const r=$json;const id=typeof r.id==='string'&&r.id?r.id:null;return [{json:{email_id:$('Compose Approval Email').first().json.email_id,send_status:id?'SENT':'UNCONFIRMED',message_id:id,error:id?null:String(r.error?.message||r.error||'Gmail did not return a message ID').slice(0,1000)}}];",[1440,0])
    f.pgq('Record Approval Email Receipt','SELECT cbm_wf3_record_email($1::jsonb) AS result;','$json',[1680,0])
    f.code('Return Email Result','return [{json:$json.result}];',[1920,0])
    f.pgq('Read Resend Outcome','SELECT cbm_wf3_finish_action($1::jsonb) AS result;',"{...$('Read Email Context').first().json,emailResult:$json}",[2160,0])
    f.code('Return Resend Outcome','return [{json:$json.result}];',[2400,0])
    for a,b in [('Email Request','Validate Resend Action'),('Validate Resend Action','Resend Ready?'),('Resend Ready?','Read Email Context'),('Read Email Context','Claim Approval Email'),('Claim Approval Email','New Email Claim?'),('New Email Claim?','Compose Approval Email'),('Compose Approval Email','Send FM Approval Email'),('Send FM Approval Email','Capture Gmail Receipt'),('Capture Gmail Receipt','Record Approval Email Receipt'),('Record Approval Email Receipt','Return Email Result'),('Return Email Result','Read Resend Outcome'),('Read Resend Outcome','Return Resend Outcome')]: f.link(a,b)
    f.link('Resend Ready?','Return Immediate Resend Result',1)
    f.link('New Email Claim?','Return Email Result',1)
    for method,y in [('GET',540),('POST',1080)]:
        label='View Approval' if method=='GET' else 'Confirm Approval'
        f.add(node(label,'webhook',{'httpMethod':method,'path':'cbm-wf3-completion-approval','responseMode':'responseNode','options':{}},[0,y],2,
                   webhookId=str(uuid.uuid5(uuid.NAMESPACE_URL,'cbm-wf3-completion-approval/'+method))))
        name='Read Link' if method=='GET' else 'Read Decision'
        expr="{emailId:$json.query?.emailId,token:$json.query?.token}" if method=='GET' else "{emailId:$json.body?.emailId,token:$json.body?.token,decision:$json.body?.decision||'missing',reason:$json.body?.reason||''}"
        f.pgq(name,'SELECT cbm_wf3_email_access($1::jsonb) AS result;',expr,[240,y])
        render='Render Confirmation' if method=='GET' else 'Render Decision Result'
        f.code(render,(HERE/'email-page.js').read_text().replace('action="/webhook/cbm-wf3-completion-approval"','action="'+PUBLIC+'/webhook/cbm-wf3-completion-approval"'),[1200,y])
        respond='Respond with Form' if method=='GET' else 'Respond with Result'
        f.add(node(respond,'respondToWebhook',{'respondWith':'text','responseBody':'={{ $json.html }}','options':{'responseCode':'={{ $json.statusCode }}',
            'responseHeaders':{'entries':[{'name':'Content-Type','value':'text/html; charset=utf-8'},{'name':'Cache-Control','value':'no-store'},{'name':'Referrer-Policy','value':'no-referrer'}]}}},[1440,y],1.4))
        f.link(label,name); f.link(render,respond)
        if method=='GET': f.link(name,render)
        else:
            f.gate('Current Decision Link?',"$json.result?.valid === true",[480,y])
            f.call('Apply Confirmed FM Decision',ACTION,"$json.result.context",[720,y])
            f.code('Shape Decision Result',"return [{json:{result:$json.outcome?$json:{outcome:'INCOMPLETE',reason:String($json.error?.message||$json.error||'Could not confirm the action result. Inspect the ticket in FM chat.')}}}];",[960,y])
            f.link(name,'Current Decision Link?'); f.link('Current Decision Link?','Apply Confirmed FM Decision')
            f.link('Current Decision Link?',render,1); f.link('Apply Confirmed FM Decision','Shape Decision Result');f.link('Shape Decision Result',render)
    # WF2's report path and WF3 chat must use the same signed approval form.
    # Pass this module's constructors to avoid importing a second builder when
    # this file is executed as a script.
    sys.path.insert(0,str(HERE.parents[1]/'wf2'))
    from shared_review import extend_email
    return extend_email(f.w,Flow,node,MAIL)

DESCS={
 'approve_intervention':'Approve initial intervention only: PENDING_AUTHORIZATION -> LOCALIZED; WF1 then dispatches automatically.',
 'reject_intervention':'Reject initial intervention only: PENDING_AUTHORIZATION -> REJECTED. The FM must provide the reason.',
 'resend_approval_email':'Resend the current undecided initial/completion approval email. No status change. Initial email is QUEUED for WF1; completion email returns SENT only with a Gmail receipt.',
 'approve_completion':'Approve completed work: current PENDING_APPROVAL, existing IFC helper, then CLOSED only after successful IFC update. Reuses stats and closure notices; can resume an incomplete recorded approval.',
 'request_rework':'Reject completed work and request rework: PENDING_APPROVAL -> REWORK, with the FM reason and existing technician notice. Can resume notices for the same recorded decision.'}

def extend(w, wf2=None):
    if wf2 is None:
        wf2=json.loads((ROOT/'n8n_wf2_completion_approval_ifc_update.json').read_text(encoding='utf-8-sig'))
    by={n['name']:n for n in w['nodes']}
    pg=by['ticket_lookup']['credentials']['postgres']
    gmail=by['Email Weekly Report']['credentials']['gmailOAuth2']
    for action,description in DESCS.items():
        if action in by: raise ValueError('Actions already present; use the fresh pre-change snapshot')
        expr="JSON.stringify({action:"+json.dumps(action)+",ticketId:$fromAI('ticket_id','Exact ticket ID from fresh ticket_lookup','number'),approvalId:$fromAI('approval_id','Current action_context.approval_id from ticket_lookup','string'),expectedUpdatedAt:$fromAI('expected_updated_at','Exact action_context.expected_updated_at including fractional seconds','string'),reason:$fromAI('reason','FM supplied rejection or rework reason; empty for approval/resend','string',''),actor:'FM_CHAT',requestId:String($execution.id),sessionId:$('FM Chat Context').first().json.sessionId,question:$('FM Chat Context').first().json.question,truncated:$('FM Chat Context').first().json.truncated})"
        w['nodes'].append(node(action,'@n8n/n8n-nodes-langchain.toolWorkflow',{'name':action,'description':description+' Use only on explicit current-turn FM instruction after a fresh ticket_lookup. Never invent approval IDs or timestamps.',
             'workflowId':{'__rl':True,'mode':'id','value':MAIL if action=='resend_approval_email' else ACTION},'workflowInputs':inputs('={{ '+expr+' }}')},[1600+240*(list(DESCS).index(action)%3),240+240*(list(DESCS).index(action)//3)],2.1))
        w['connections'][action]={'ai_tool':[[{'node':'FM Dashboard Agent','type':'ai_tool','index':0}]]}
    by['ticket_lookup']['parameters']['query']=by['ticket_lookup']['parameters']['query'].replace('SELECT t.id, t.status,','SELECT cbm_wf3_action_context(t.id) AS action_context, t.id, t.status,')
    by['ticket_search']['parameters']['query']=by['ticket_search']['parameters']['query'].replace('ORDER BY t.created_at DESC','ORDER BY t.created_at DESC, t.id DESC')
    prompt=by['FM Dashboard Agent']['parameters']['options']['systemMessage']
    old='- Never say you have changed, closed, assigned, scheduled or escalated anything. You cannot: every tool you hold is read-only. If asked to act on a ticket, say plainly that this dashboard only reads, and that closures go through the approval workflow.'
    assert old in prompt
    prompt=prompt.replace(old,'- Never claim a change without the action tool returning its committed outcome. Never claim you assigned, scheduled or escalated a ticket; you have no such tools.')
    by['FM Dashboard Agent']['parameters']['options']['systemMessage']=prompt+(HERE/'agent-instructions.txt').read_text()
    by['Chat Response']['parameters']['jsCode']=by['Chat Response']['parameters']['jsCode'].replace("I could not complete that lookup. The database or the model did not ","I could not complete that request. The database or the model did not ").replace("answer. Nothing was changed - this dashboard only reads. Please try again, ","answer. An action may have been recorded. Check the ticket status and history before retrying, ")
    for n in w['nodes']:
        if n['type'].endswith('stickyNote'):
            content=n['parameters'].get('content','')
            if n['name']=='Sticky - 1 - Chat dashboard':
                content='## FM chat — investigate and act\nAnswers use current tool results. Five guarded action tools support explicit FM requests.\nRead-only questions never change tickets. Every action records its source and outcome in ticket history.'
            if n['name']=='Sticky - 2 - Read-only tool belt':
                content=content.replace('It cannot assign, close or modify tickets. Its tools only read; the separate logging node writes the audit record.','These nine tools only read. The five action tools on the right call the shared guarded helper; they cannot assign or escalate tickets.')
            n['parameters']['content']=content
    w['nodes'].append(node('Sticky - WF3 FM actions','stickyNote',{'content':'## FM action tools\nApprove intervention -> LOCALIZED; WF1 dispatches. Reject intervention -> REJECTED.\nResend approval email -> same state.\nApprove completion -> IFC success -> CLOSED. Request rework -> REWORK.\nAll five call one guarded helper. Existing IFC and notification helpers are reused.\nRead current ticket before action; receipt records the actual outcome.','width':760,'height':220},[1536,-32],1))
    return [w,action_flow(pg,wf2),email_flow(pg,gmail)]

def save_helpers(workflows):
    out=HERE/'workflows';out.mkdir(exist_ok=True)
    for flow in workflows:
        (out/(flow['id']+'.json')).write_text(json.dumps(flow,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')

if __name__=='__main__':
    source=Path(sys.argv[1]) if len(sys.argv)>1 else EVIDENCE/(MAIN+'.before.json')
    w=json.loads(source.read_text(encoding='utf-8-sig'))
    if isinstance(w,list): w=w[0]
    assert w['id']==MAIN
    wf2=json.loads((EVIDENCE/'5quLJucpa0K4jWZS.before.json').read_text(encoding='utf-8-sig'))
    workflows=extend(w,wf2)
    save_helpers(workflows)
    (EVIDENCE/'wf3-actions-import.json').write_text(json.dumps(workflows,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    print('Built WF3 with five action tools and two WF3-only helpers. No other workflow modified.')
