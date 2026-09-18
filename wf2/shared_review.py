"""Replace the private Gmail waiter with the shared FM decision and a persistent wait."""
import copy,json,sys,uuid
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent
sys.path.insert(0,str(HERE.parent/'wf3'))

def _workflow_api():
    from actions.build_actions import Flow,node,inputs,MAIL
    return Flow,node,inputs,MAIL

def extend_email(w,Flow=None,node=None,MAIL=None):
    if Flow is None or node is None or MAIL is None:
        Flow,node,_,MAIL=_workflow_api()
    w=copy.deepcopy(w);by={n['name']:n for n in w['nodes']}
    if 'WF2 Report Request?' in by:return w
    f=Flow(w['id'],w['name'],by['Claim Approval Email']['credentials']['postgres']);f.w=w
    f.code('Approval Request Source',"const p=typeof $json.context==='string'?JSON.parse($json.context):$json.context;if(!p||typeof p!=='object')throw new Error('Missing approval request');return [{json:{context:JSON.stringify(p),source:p.source||'FM_CHAT',request:p}}];",[-720,-200])
    f.gate('WF2 Report Request?',"$json.source === 'WF2_REPORT'",[-480,-200])
    f.pgq('Claim WF2 Review Email','SELECT cbm_wf2_prepare_review_email($1::jsonb) AS result;','$json.request',[480,-200])
    f.gate('WF2 Email Result?',"$('Approval Request Source').first().json.source === 'WF2_REPORT'",[2160,-200])
    f.code('Return WF2 Email Receipt','return [{json:$json}];',[2400,-200])
    w['connections']['Email Request']={'main':[[{'node':'Approval Request Source','type':'main','index':0}]]}
    f.link('Approval Request Source','WF2 Report Request?')
    f.link('WF2 Report Request?','Claim WF2 Review Email')
    f.link('WF2 Report Request?','Validate Resend Action',1)
    f.link('Claim WF2 Review Email','New Email Claim?')
    w['connections']['Return Email Result']={'main':[[{'node':'WF2 Email Result?','type':'main','index':0}]]}
    f.link('WF2 Email Result?','Return WF2 Email Receipt')
    f.link('WF2 Email Result?','Read Resend Outcome',1)
    return w

def extend_wf2(w,Flow=None,node=None,MAIL=None):
    if Flow is None or node is None or MAIL is None:
        Flow,node,_,MAIL=_workflow_api()
    w=copy.deepcopy(w);by={n['name']:n for n in w['nodes']}
    if 'Approval Cycle' in by:return w
    removed={'FM Approval (Email + Wait)','Explicit FM Decision?','FM Approved?','Persist FM Decision','Record Approval Expired'}
    w['nodes']=[n for n in w['nodes'] if n['name'] not in removed]
    for n in w['nodes']:
        if n['position'][0]>=0:n['position'][0]+=900
    w['connections']={k:v for k,v in w['connections'].items() if k not in removed}
    for spec in w['connections'].values():
        for kind,branches in spec.items():spec[kind]=[[e for e in b if e['node'] not in removed] for b in branches]
    pg=by['Set Pending Approval']['credentials']['postgres']
    f=Flow(w.get('id','cbmWf2Template'),w['name'],pg);f.w=w
    f.code('Approval Cycle',"const r=$json;if(!Number.isInteger(r.id)||!r.approval_id)return [];return [{json:{ticketId:r.id,approvalId:r.approval_id}}];",[-720,304])
    cycle="$('Approval Cycle').first().json"
    f.pgq('Read FM Review State','SELECT cbm_wf2_review_status($1::jsonb) AS result;',cycle,[-480,304])
    f.code('FM Review State','return [{json:$json.result}];',[-240,304])
    f.add(node('Route FM Review','switch',{'rules':{'values':[
        {'conditions':{'options':{'caseSensitive':True,'leftValue':'','typeValidation':'strict','version':2},'combinator':'and','conditions':[
            {'leftValue':'={{ $json.route }}','rightValue':route,'operator':{'type':'string','operation':'equals'}}]},'renameOutput':True,'outputKey':label}
        for route,label in [('SETTLED','Already settled'),('DECIDED','Finish recorded decision'),('ATTENTION','Closure needs attention'),('NEEDS_EMAIL','Send approval request'),('SUPERSEDED','Approval replaced')]]},
        'options':{'fallbackOutput':'extra'}},[0,304],3.2))
    f.call('Send FM Approval Request',MAIL,'{...'+cycle+",source:'WF2_REPORT',executionId:String($execution.id)}",[240,640])
    f.add(node('Wait for FM Decision','wait',{'resume':'timeInterval','amount':1,'unit':'minutes'},[480,800],1.1,
        webhookId=str(uuid.uuid5(uuid.NAMESPACE_URL,'cbm-wf2-shared-review-wait'))))
    f.add(node('Approval Replaced','noOp',{},[240,960],1))
    f.gate('Closure Already Handled?',"['SETTLED','ATTENTION'].includes($json.reviewRoute)",[480,160])
    ctx=by['Closure Context'];ctx['position']=[240,160]
    code=ctx['parameters']['jsCode']
    code=code.replace("const decision=typeof raw.data?.approved==='boolean'?(raw.data.approved?'APPROVED':'REJECTED'):'EXPIRED';","const decision=raw.decision;if(!['APPROVED','REJECTED'].includes(decision))throw new Error('A stored FM decision is required');")
    code=code.replace('decision,attemptBudget:3','decision,reviewRoute:raw.route,attemptBudget:3')
    code=code.replace("rejectionReason:decision==='REJECTED'?'The facility manager explicitly rejected this completion. No detailed reason was supplied.':null,","rejectionReason:decision==='REJECTED'?(raw.rejection_reason||'The facility manager explicitly rejected this completion. No detailed reason was supplied.'):null,")
    ctx['parameters']['jsCode']=code
    w['connections']['Set Pending Approval']={'main':[[{'node':'Approval Cycle','type':'main','index':0}]]}
    w['connections']['Closure Context']={'main':[[{'node':'Closure Already Handled?','type':'main','index':0}]]}
    for a,b in [('Approval Cycle','Read FM Review State'),('Read FM Review State','FM Review State'),('FM Review State','Route FM Review'),('Send FM Approval Request','Wait for FM Decision'),('Wait for FM Decision','Read FM Review State'),('Closure Already Handled?','Verify Closure Outcome')]:f.link(a,b)
    f.link('Closure Already Handled?','Closure Supervisor',1)
    for branch,target in enumerate(['Closure Context','Closure Context','Closure Context','Send FM Approval Request','Approval Replaced','Wait for FM Decision']):f.link('Route FM Review',target,branch)
    # Keep the existing supervisor and all its tools. Its role is to finish a
    # recorded decision only after the shared executor has returned incomplete.
    for n in w['nodes']:
        if n['type'].endswith('stickyNote'):
            n['parameters']['content']=n['parameters'].get('content','').replace('FM Approval (Email + Wait)','Send FM Approval Request → Wait for FM Decision → Read FM Review State')
    f.add(node('Shared FM review notes','stickyNote',{'content':'## One FM decision, email or chat\nA normal email links to the existing shared approval form. Its guarded helper records and executes the decision.\nWF2 checks PostgreSQL every minute. Already settled: finish. Shared action still running: wait. Recorded incomplete result: Closure Supervisor finishes missing work.\nAfter 10 minutes without an action result, report attention instead of running a competing closure. Approval replacement ends this review.','width':850,'height':240},[-720,-32],1))
    return w

if __name__=='__main__':
    evidence=ROOT/'validation-wf2-chat-approval'
    main=json.loads((evidence/'5quLJucpa0K4jWZS.before.json').read_text(encoding='utf-8'))
    mail=json.loads((evidence/'cbmWf3ApprovalMail.before.json').read_text(encoding='utf-8'))
    flows=[extend_wf2(main),extend_email(mail)]
    for w in flows:(evidence/(w['id']+'.updated.json')).write_text(json.dumps(w,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    (evidence/'import.json').write_text(json.dumps(flows,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print('Prepared WF2 and the shared approval-email helper. No other workflows changed.')
