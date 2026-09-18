"""Reviewed WF2 contract. Applied by build_wf2.py before serialization."""
import copy
import hashlib
import json
from pathlib import Path

BINDINGS=json.loads((Path(__file__).resolve().parent.parent/'runtime-bindings.json').read_text(encoding='utf-8'))
PG={'postgres':BINDINGS['credentials']['ticketPostgres']}
MAIL={'gmailOAuth2':BINDINGS['credentials']['gmail']}
FM=BINDINGS['fmEmail']
CTX='$("Closure Context").first().json'

def edges(*branches):
    return {'main':[[{'node':n,'type':'main','index':0} for n in br] for br in branches]}

def new(name,kind,params,xy=(0,0),version=2,**extra):
    return dict(name=name,id=hashlib.sha256(('cbm-wf2-review:'+name).encode()).hexdigest()[:32],
                type='n8n-nodes-base.'+kind,typeVersion=version,position=list(xy),parameters=params,**extra)

def gate(name,expression,xy):
    return new(name,'if',{'conditions':{'options':{'typeValidation':'strict'},'conditions':[
        {'leftValue':expression,'rightValue':True,'operator':{'type':'boolean','operation':'true','singleValue':True}}],
        'combinator':'and'},'options':{}},xy)

def pg(name,sql,params,xy):
    return new(name,'postgres',{'operation':'executeQuery','query':sql,'options':{'queryReplacement':params}},xy,2.6,credentials=PG)

def apply_review_fixes(wf):
    n={x['name']:x for x in wf['nodes']}; c=wf['connections']
    def add(x): wf['nodes'].append(x);n[x['name']]=x;return x
    wf['active']=False
    wf.setdefault('settings',{}).update(timezone='Europe/Rome')
    # Canonical credentials throughout inherited and added nodes.
    for x in wf['nodes']:
        for key in x.get('credentials',{}):
            binding={'postgres':'ticketPostgres','gmailOAuth2':'gmail',
                     'googleDriveOAuth2Api':'drive','anthropicApi':'anthropic'}.get(key)
            if binding:x['credentials'][key]=copy.deepcopy(BINDINGS['credentials'][binding])
        x['parameters']=json.loads(json.dumps(x['parameters']).replace('facility.manager@example.com',FM).replace('REPLACE_WITH_COMPLETED_FOLDER_ID',BINDINGS['completedFolderId']).replace('REPLACE_COMPLETED_FOLDER_ID',BINDINGS['completedFolderId']))
        if x['type'].endswith('stickyNote'):
            x['parameters']['content']='## WF2 · report-first completion\nUpload TICKET-<id>.pdf. An optional TICKET-<id>.jpg must arrive first to be included. A lone photo prompts a report reminder. Explicit FM approval closes the ticket; rejection requests rework. A 72-hour timeout leaves PENDING_APPROVAL and sends a renewed approval request. IFC writes use an operation key; failures retain NULL and are audited. See wf2/README.md.'

    n['Extract Ticket ID']['parameters']['jsCode']=r"""const f=$input.first().json,name=String(f.name||'');
const m=name.match(/^TICKET[-_ ]?(\d+)(?:_after)?\.(pdf|jpg|jpeg|png|webp|heic)$/i);
const ext=(name.match(/\.([a-z0-9]+)$/i)||[])[1]?.toLowerCase();
const isReport=ext==='pdf',isPhoto=['jpg','jpeg','png','webp','heic'].includes(ext);
if(!isReport&&!isPhoto)return [];
return [{json:{matched:!!m,ticket_id:m?Number(m[1]):null,upload_kind:isReport?'REPORT':'PHOTO',
report_file_id:isReport?f.id:null,report_file_name:isReport?name:null,report_link:isReport?(f.webViewLink||''):'',
photo_file_id:isPhoto?f.id:null}}];"""
    n['Fetch Ticket']['parameters']={'operation':'executeQuery','query':r"""SELECT t.*,
 t.description AS damage_description,t.ifc_name AS object_type,t.photo_before_url AS photo_url,
 te.full_name AS technician_name,te.email AS technician_email,
 coalesce(substring(t.photo_before_url from '/d/([A-Za-z0-9_-]+)'),substring(t.photo_before_url from '[?&]id=([A-Za-z0-9_-]+)')) AS before_file_id
 FROM tickets t LEFT JOIN technicians te ON te.id=t.technician_id WHERE t.id=$1 LIMIT 1;""",
 'options':{'queryReplacement':'={{ [$json.ticket_id] }}'}}
    n['Fetch Ticket']['alwaysOutputData']=True
    n['Ticket Open and Assigned?']['parameters']=gate('x','={{ !!$json.id && !!$json.technician_id && ["ASSIGNED","WORK_DONE","REWORK"].includes($json.status) }}',(0,0))['parameters']
    add(gate('Report Upload?','={{ $("Extract Ticket ID").first().json.upload_kind === "REPORT" }}',(-100,180)))
    add(gate('Report Reminder Needed?','={{ ["ASSIGNED","REWORK"].includes($json.status) && !$json.report_file_id && !!$json.technician_email }}',(120,180)))
    add(new('Remind Technician - Report Required','gmail',{'operation':'send','sendTo':'={{ $("Fetch Ticket").first().json.technician_email }}',
        'subject':'=[CBM] Written report required for ticket #{{ $("Fetch Ticket").first().json.id }}','emailType':'text',
        'message':'=Your photo was received. To submit completion, upload your written report as TICKET-{{ $("Fetch Ticket").first().json.id }}.pdf to the completed folder. The photo alone does not request approval.',
        'options':{'appendAttribution':False}},(350,180),2.1,credentials=MAIL))
    c['Ticket Open and Assigned?']=edges(['Report Upload?'],['Notify FM - Photo Problem'])
    c['Report Upload?']=edges(['Download Report PDF'],['Report Reminder Needed?'])
    c['Report Reminder Needed?']=edges(['Remind Technician - Report Required'],[])
    p=n['Notify FM - Photo Problem']['parameters'];p.update(emailType='text',subject='[CBM] Unmatched or ineligible completion upload',message='=Upload {{ $("Completed Upload (Drive Trigger)").first().json.name }} could not be matched to an assigned ticket in ASSIGNED, WORK_DONE or REWORK. Expected TICKET-<id>.pdf and optional TICKET-<id>.jpg. Review: {{ $("Completed Upload (Drive Trigger)").first().json.webViewLink || "no link" }}')
    # Exact Drive query avoids confusing ticket 12 with ticket 123.
    p=n['Find AFTER Photo']['parameters'];p['searchMethod']='query';p['queryString']="={{ \"trashed = false and (\" + ['jpg','jpeg','png','webp'].flatMap(ext => [\"name = 'TICKET-\" + $('Extract Ticket ID').first().json.ticket_id + \".\" + ext + \"'\", \"name = 'TICKET-\" + $('Extract Ticket ID').first().json.ticket_id + \"_after.\" + ext + \"'\"]).join(' or ') + \")\" }}"
    p['filter'].pop('fileTypes',None);p['options']={'fields':['id','name','webViewLink','modifiedTime']};p['returnAll']=False;p['limit']=1
    n['Photo Available?']['parameters']=gate('x','={{ !!$json.id && !!$("Fetch Ticket").first().json.before_file_id }}',(0,0))['parameters']
    n['Download BEFORE Photo']['parameters']['fileId']={'__rl':True,'mode':'id','value':'={{ $("Fetch Ticket").first().json.before_file_id }}'}
    src=n['Parse Verification']['parameters']['jsCode'].replace("const x = $('Extract Ticket ID').first().json;","const x = $('Find AFTER Photo').first().json;").replace('after_file_id: x.file_id','after_file_id: x.id').replace('after_link: x.after_link',"after_link: x.webViewLink || ''")
    n['Parse Verification']['parameters']['jsCode']=src
    # Preserve available AFTER evidence even when no comparable BEFORE exists.
    src=n['Build Assessment Input']['parameters']['jsCode']
    src=src.replace("let vision = null;","let vision = null;\nlet after = {}; try { after = $('Find AFTER Photo').first().json; } catch {}")
    src=src.replace('photo_supplied: vision !== null,','photo_supplied: !!after.id,\n    after_file_id: after.id || null, after_link: after.webViewLink || "",')
    n['Build Assessment Input']['parameters']['jsCode']=src
    src=n['Parse Completion Assessment']['parameters']['jsCode'].replace('(input.vision && input.vision.after_file_id) || null','input.after_file_id || (input.vision && input.vision.after_file_id) || null').replace("(input.vision && input.vision.after_link) || ''","input.after_link || (input.vision && input.vision.after_link) || ''")
    n['Parse Completion Assessment']['parameters']['jsCode']=src
    # Every submission obtains a distinct approval identity. The FM decides even
    # when the assessment recommends rework; that recommendation is only evidence.
    n['Set Pending Approval']['parameters']={'operation':'executeQuery','query':"""UPDATE tickets SET status='PENDING_APPROVAL',report_text=$2,report_file_id=$3,after_file_id=$4,
 verification=$5::jsonb,approval_id=gen_random_uuid(),ifc_new_version=NULL,updated_at=clock_timestamp()
 WHERE id=$1 AND status IN ('ASSIGNED','WORK_DONE','REWORK') AND technician_id IS NOT NULL
 RETURNING id,status,approval_id;""",'options':{'queryReplacement':'={{ [$json.id,$json.report_text || "",$json.report_file_id,$json.after_file_id || null,JSON.stringify({source:"REPORT",photo_supplied:$json.photo_supplied,work_complete:$json.work_complete,confidence:$json.ai_confidence,summary:$json.observations,concerns:$json.concerns,recommended_status:$json.resolved_status})] }}'}}
    p=n['FM Approval (Email + Wait)']['parameters'];p['subject']='=[CBM] Approval requested / reminder - ticket {{ $("Parse Completion Assessment").first().json.id }}'
    p['message']='=Ticket {{ $("Parse Completion Assessment").first().json.id }} awaits your decision. Written report: {{ $("Parse Completion Assessment").first().json.report_link }}<br/>Optional AFTER photo: {{ $("Parse Completion Assessment").first().json.after_link || "not supplied" }}<br/>Assessment recommends: {{ $("Parse Completion Assessment").first().json.resolved_status }}. Timeout does not reject this work. This renewed request has current approval links.'
    add(gate('Explicit FM Decision?','={{ typeof $json.data?.approved === "boolean" }}',(2540,-120)))
    add(pg('Record Approval Expired',"""INSERT INTO ticket_events(ticket_id,event,payload)
 SELECT id,'CBM_WF2_APPROVAL_EXPIRED',jsonb_build_object('approval_id',approval_id,'status','PENDING_APPROVAL')
 FROM tickets WHERE id=$1 AND status='PENDING_APPROVAL' AND approval_id=$2::uuid
 RETURNING ticket_id;""",'={{ [$("Set Pending Approval").first().json.id,$("Set Pending Approval").first().json.approval_id] }}',(2760,-200)))
    c['FM Approval (Email + Wait)']=edges(['Explicit FM Decision?'])
    c['Explicit FM Decision?']=edges(['FM Approved?'],['Record Approval Expired'])
    c['Record Approval Expired']=edges(['FM Approval (Email + Wait)'])
    n['Closure Context']['parameters']['jsCode']=r"""const raw=$input.first().json;
const decision=typeof raw.data?.approved==='boolean'?(raw.data.approved?'APPROVED':'REJECTED'):'EXPIRED';
const a=$('Parse Completion Assessment').first().json;
const receipt=$('Set Pending Approval').first().json;
return [{json:{ticketId:a.id,approvalId:receipt.approval_id,operationKey:'wf2:'+a.id+':'+receipt.approval_id,
decision,attemptBudget:3,ifcGlobalId:a.ifc_global_id||null,
ifcServiceUrl:$env.IFC_SERVICE_URL,technicianId:a.technician_id??null,technicianName:a.technician_name||'',
technicianEmail:a.technician_email||'',objectType:a.object_type||'',damageDescription:a.damage_description||'',
fmEmail:__FM_EMAIL_JSON__,observations:a.observations||'',reportLink:a.report_link||'',afterLink:a.after_link||'',photoSupplied:a.photo_supplied===true,
rejectionReason:decision==='REJECTED'?'The facility manager explicitly rejected this completion. No detailed reason was supplied.':null,
objectives:decision==='APPROVED'?['log_ifc_maintenance','close_ticket','update_technician_stats','notify_technician_closed','notify_fm_closed']:
decision==='REJECTED'?['reopen_for_rework','notify_technician_rework']:[]}}];""".replace('__FM_EMAIL_JSON__',json.dumps(FM))
    add(pg('Persist FM Decision',"""INSERT INTO ticket_events(ticket_id,event,payload)
 SELECT id,'CBM_WF2_APPROVAL',jsonb_build_object('approval_id',approval_id,'decision',$3::text)
 FROM tickets WHERE id=$1 AND approval_id=$2::uuid AND status='PENDING_APPROVAL'
 AND $3 IN ('APPROVED','REJECTED')
 AND NOT EXISTS(SELECT 1 FROM ticket_events WHERE ticket_id=$1 AND event='CBM_WF2_APPROVAL' AND payload->>'approval_id'=$2::text)
 RETURNING ticket_id;""",'={{ [$json.ticketId,$json.approvalId,$json.decision] }}',(2760,120)))
    c['Closure Context']=edges(['Persist FM Decision']);c['Persist FM Decision']=edges(['Closure Supervisor'])
    n['Closure Supervisor']['parameters']['text']='={{ "Carry out the persisted FM decision. Bound context: " + JSON.stringify($("Closure Context").first().json) }}'
    system=n['Closure Supervisor']['parameters']['options']['systemMessage']
    system+='\nApproval timeout never authorizes rework. Rejection reasons are fixed by context; never invent one. log_ifc_maintenance uses a guarded helper and persists the real service result before close_ticket. An absent element is recorded as SKIPPED. On service failure the helper records CBM_WF2_ATTEMPT; close_ticket retains NULL. FM notifications read committed database state; never claim IFC updated without a successful result. All ticket mutations require the same persisted approval identity.'
    n['Closure Supervisor']['parameters']['options']['systemMessage']=system
    # Authoritative IFC result is persisted by a fixed helper, not supplied by AI.
    helper_id='cbmWf2IfcReview1'
    n['log_ifc_maintenance'].update(type='@n8n/n8n-nodes-langchain.toolWorkflow',typeVersion=2.1)
    n['log_ifc_maintenance'].pop('credentials',None)
    n['log_ifc_maintenance']['parameters']={'name':'log_ifc_maintenance','source':'database','description':'Apply the approved IFC write using the bound operation key. Skips missing elements. Persists the real success/failure. Safe to retry the same operation key.',
        'workflowId':{'__rl':True,'mode':'id','value':helper_id},'workflowInputs':{'mappingMode':'defineBelow','value':{'context':'={{ JSON.stringify('+CTX+') }}'},'schema':[{'id':'context','displayName':'context','type':'string','required':True,'defaultMatch':False,'display':True,'canBeUsedToMatch':True}],'matchingColumns':[],'attemptToConvertTypes':False,'convertFieldsToString':False}}
    approval_guard="""tickets.approval_id=(v.p->>'approvalId')::uuid AND EXISTS(SELECT 1 FROM ticket_events e WHERE e.ticket_id=tickets.id AND e.event='CBM_WF2_APPROVAL' AND e.payload->>'approval_id'=v.p->>'approvalId' AND e.payload->>'decision'=%s)"""
    n['close_ticket']['parameters']['query']="WITH v AS (SELECT $1::jsonb AS p) UPDATE tickets SET status='CLOSED',closed_at=clock_timestamp(),updated_at=clock_timestamp() FROM v WHERE tickets.id=(v.p->>'ticketId')::int AND tickets.status='PENDING_APPROVAL' AND "+(approval_guard%"'APPROVED'")+" AND EXISTS(SELECT 1 FROM ticket_events e WHERE e.ticket_id=tickets.id AND e.event IN ('CBM_WF2_IFC_RESULT','CBM_WF2_ATTEMPT') AND e.payload->>'operation_key'=v.p->>'operationKey') RETURNING tickets.id,tickets.status,tickets.closed_at,tickets.ifc_new_version;"
    n['close_ticket']['parameters']['options']['queryReplacement']='={{ [JSON.stringify('+CTX+')] }}'
    n['close_ticket']['parameters']['toolDescription']='Close after the guarded IFC helper recorded success, failure or skip. The database retains its verified model version; failure stays NULL. Requires the current persisted APPROVED decision.'
    n['reopen_for_rework']['parameters']['query']="WITH v AS (SELECT $1::jsonb AS p) UPDATE tickets SET status='REWORK',closed_at=NULL,fm_reject_reason=v.p->>'rejectionReason',updated_at=clock_timestamp() FROM v WHERE tickets.id=(v.p->>'ticketId')::int AND tickets.status='PENDING_APPROVAL' AND "+(approval_guard%"'REJECTED'")+" RETURNING tickets.id,tickets.status;"
    n['reopen_for_rework']['parameters']['options']['queryReplacement']='={{ [JSON.stringify('+CTX+')] }}'
    n['notify_technician']['parameters'].update(emailType='text',message='={{ "Ticket #" + '+CTX+'.ticketId + ": " + ('+CTX+'.decision === "APPROVED" ? "The facility manager approved your completion." : '+CTX+'.rejectionReason + " Contact the facility manager for details, then upload a revised TICKET-" + '+CTX+'.ticketId + ".pdf.") }}')
    # Idempotent throughput accounting, guarded by the closed ticket.
    n['update_technician_stats']['parameters']['query']="""WITH receipt AS (
 INSERT INTO ticket_events(ticket_id,event,payload) SELECT id,'CBM_WF2_STATS',jsonb_build_object('approval_id',approval_id)
 FROM tickets WHERE id=($1::jsonb->>'ticketId')::int AND status='CLOSED' AND approval_id=($1::jsonb->>'approvalId')::uuid
 ON CONFLICT DO NOTHING RETURNING ticket_id)
 UPDATE technicians SET jobs_completed=jobs_completed+1 WHERE id IN (SELECT technician_id FROM tickets WHERE id IN (SELECT ticket_id FROM receipt)) RETURNING id,jobs_completed;"""
    # FM mail is a helper reading the committed outcome; its text cannot invent IFC success.
    mail_id='cbmWf2FmNotice1'
    n['notify_fm'].update(type='@n8n/n8n-nodes-langchain.toolWorkflow',typeVersion=2.1)
    n['notify_fm'].pop('credentials',None)
    n['notify_fm']['parameters']=copy.deepcopy(n['log_ifc_maintenance']['parameters'])
    n['notify_fm']['parameters'].update(name='notify_fm',description='Notify the FM from the committed CLOSED ticket. Subject and model result are fixed by database state. Records delivery; stops for manual reconciliation if a delivery result is uncertain.')
    n['notify_fm']['parameters']['workflowId']['value']=mail_id
    n['Verify Closure Outcome']['parameters']['query']="SELECT id,status,closed_at,ifc_new_version,(SELECT count(*) FROM ticket_events WHERE ticket_id=t.id AND event='CBM_WF2_NOTICE') AS notices_recorded,(SELECT count(*) FROM ticket_events WHERE ticket_id=t.id AND event='CBM_WF2_ATTEMPT') AS attempts_recorded FROM tickets t WHERE id=$1;"
    n['Verify Closure Outcome']['parameters']['options']={'queryReplacement':'={{ ['+CTX+'.ticketId] }}'}
    build_helpers(helper_id,mail_id)

def build_helpers(helper_id,mail_id):
    start=new('Bound Context','executeWorkflowTrigger',{'workflowInputs':{'values':[{'name':'context','type':'string'}]}},(0,0),1.1)
    parse=new('Parse Context','code',{'jsCode':'return [{json:JSON.parse($json.context)}];'},(220,0))
    authorized=pg('Read Approved Ticket',"""SELECT t.*, $1::jsonb AS context FROM tickets t WHERE t.id=($1::jsonb->>'ticketId')::int
 AND t.status='PENDING_APPROVAL' AND t.approval_id=($1::jsonb->>'approvalId')::uuid
 AND EXISTS(SELECT 1 FROM ticket_events WHERE ticket_id=t.id AND event='CBM_WF2_APPROVAL'
 AND payload->>'approval_id'=t.approval_id::text AND payload->>'decision'='APPROVED');""",'={{ [JSON.stringify($json)] }}',(440,0))
    has=gate('Element Available?','={{ !!$json.ifc_global_id }}',(660,0))
    call=new('Write IFC','httpRequest',{'method':'POST','url':'={{ $("Read Approved Ticket").first().json.context.ifcServiceUrl.replace(/\\/+$/, "") + "/elements/" + $("Read Approved Ticket").first().json.ifc_global_id + "/maintenance" }}',
        'sendBody':True,'specifyBody':'json','jsonBody':'={{ JSON.stringify({ticket_id:$("Read Approved Ticket").first().json.id,operation_key:$("Read Approved Ticket").first().json.context.operationKey,technician:$("Read Approved Ticket").first().json.context.technicianName,description:$("Read Approved Ticket").first().json.description,condition:"Repaired",approved_by:"Facility Manager"}) }}',
        'options':{'timeout':60000}},(880,-100),4.2,onError='continueRegularOutput')
    skipped=new('Skip Missing Element','code',{'jsCode':'return [{json:{skipped:true,detail:"No IFC GlobalId; maintenance synchronization skipped"}}];'},(880,100))
    result=new('Normalize IFC Result','code',{'jsCode':r"""const x=$json,c=$('Read Approved Ticket').first().json.context;
const version=typeof x.version_file==='string'&&/^[A-Za-z0-9_. -]+\.ifc$/i.test(x.version_file)?x.version_file:null;
return [{json:{...c,version,status:version?'SUCCEEDED':x.skipped?'SKIPPED':'FAILED',detail:version?'IFC write persisted':String(x.detail||x.error?.message||x.error||'IFC result missing')}}];"""},(1100,0))
    persist=pg('Persist IFC Result',"""WITH updated AS (UPDATE tickets SET ifc_new_version=coalesce($3,ifc_new_version)
 WHERE id=$1 AND approval_id=$2::uuid AND status='PENDING_APPROVAL' RETURNING id),
 audit AS (INSERT INTO ticket_events(ticket_id,event,payload) SELECT id,
 CASE WHEN $4='FAILED' THEN 'CBM_WF2_ATTEMPT' ELSE 'CBM_WF2_IFC_RESULT' END,
 jsonb_build_object('operation_key',$5::text,'operation','log_ifc_maintenance','outcome',$4::text,'detail',$6::text,'version_file',$3::text)
 FROM updated RETURNING id) SELECT $4::text AS status,$3::text AS version_file;""",'={{ [$json.ticketId,$json.approvalId,$json.version,$json.status,$json.operationKey,$json.detail] }}',(1320,0))
    wf={'id':helper_id,'name':'CBM - WF2 Guarded IFC Write','active':False,'nodes':[start,parse,authorized,has,call,skipped,result,persist],
        'connections':{'Bound Context':edges(['Parse Context']),'Parse Context':edges(['Read Approved Ticket']),'Read Approved Ticket':edges(['Element Available?']),
            'Element Available?':edges(['Write IFC'],['Skip Missing Element']),'Write IFC':edges(['Normalize IFC Result']),'Skip Missing Element':edges(['Normalize IFC Result']),'Normalize IFC Result':edges(['Persist IFC Result'])},
        'settings':{'executionOrder':'v1','timezone':'Europe/Rome'}}
    folder=Path(__file__).parent/'workflows';folder.mkdir(exist_ok=True)
    (folder/'log_ifc_maintenance.json').write_text(json.dumps(wf,indent=2)+'\n',encoding='utf-8')
    claim=pg('Claim FM Closure Notice',"""WITH claimed AS (
 INSERT INTO ticket_events(ticket_id,event,payload) SELECT id,'CBM_WF2_FM_NOTICE_CLAIM',jsonb_build_object('approval_id',approval_id)
 FROM tickets WHERE id=($1::jsonb->>'ticketId')::int AND status='CLOSED' AND approval_id=($1::jsonb->>'approvalId')::uuid
 ON CONFLICT DO NOTHING RETURNING ticket_id)
 SELECT t.*, $1::jsonb->>'fmEmail' AS fm_email FROM tickets t JOIN claimed c ON c.ticket_id=t.id;""",'={{ [JSON.stringify($json)] }}',(440,0))
    send=new('Send FM Closure Notice','gmail',{'operation':'send','sendTo':'={{ $json.fm_email }}','emailType':'text',
        'subject':'={{ "[CBM] Ticket #"+$json.id+" closed - "+($json.ifc_new_version ? "IFC updated" : "IFC update pending or skipped") }}',
        'message':'={{ "Ticket #"+$json.id+" is closed following FM approval. IFC result: "+($json.ifc_new_version || "No new IFC version recorded. Review CBM_WF2_ATTEMPT / CBM_WF2_IFC_RESULT events.") }}',
        'options':{'appendAttribution':False}},(660,0),2.1,credentials=MAIL,retryOnFail=False)
    receipt=pg('Record FM Notice Delivery',"INSERT INTO ticket_events(ticket_id,event,payload) VALUES($1,'CBM_WF2_NOTICE',jsonb_build_object('notice_key','fm:closed','message_id',$2::text,'approval_id',$3::text)) RETURNING id;",'={{ [$("Claim FM Closure Notice").first().json.id,$json.id,$("Claim FM Closure Notice").first().json.approval_id] }}',(880,0))
    mail={'id':mail_id,'name':'CBM - WF2 Notify FM from Stored Result','active':False,'nodes':[start,parse,claim,send,receipt],
        'connections':{'Bound Context':edges(['Parse Context']),'Parse Context':edges(['Claim FM Closure Notice']),'Claim FM Closure Notice':edges(['Send FM Closure Notice']),'Send FM Closure Notice':edges(['Record FM Notice Delivery'])},'settings':wf['settings']}
    (folder/'notify_fm.json').write_text(json.dumps(mail,indent=2)+'\n',encoding='utf-8')
