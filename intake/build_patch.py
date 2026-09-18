"""Generate the small, repeatable WF1 overlay; no services or providers are called."""
import copy
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
w = json.loads((HERE/'wf1-before-intake.json').read_text(encoding='utf-8'))
baseline = copy.deepcopy(w)
nodes = {n['name']:n for n in w['nodes']}
c = w['connections']
pg_credentials = nodes['Create Triage Ticket']['credentials']
gmail_credentials = nodes['Notify FM - Manual Triage Needed']['credentials']

def node(name, typ, parameters, version=1, **extra):
    n = dict(name=name, id=hashlib.sha256(('cbm-intake:'+name).encode()).hexdigest()[:32],
             type='n8n-nodes-base.'+typ, typeVersion=version, parameters=parameters,
             position=[600+(len(nodes)%6)*260, 2300+(len(nodes)//6)*180], **extra)
    nodes[name]=n
    return n

def code(name, source): return node(name,'code',{'jsCode':source},2)
def pg(name, query, values='={{ [] }}'):
    return node(name,'postgres',{'operation':'executeQuery','query':query,
        'options':{'queryReplacement':values}},2.6,credentials=pg_credentials)
def condition(name, expr):
    return node(name,'if',{'conditions':{'options':{'typeValidation':'strict'},'combinator':'and',
        'conditions':[{'leftValue':expr,'rightValue':True,'operator':{'type':'boolean','operation':'true','singleValue':True}}]},'options':{}},2)
def connect(a,b,output=0):
    links=c.setdefault(a,{}).setdefault('main',[])
    while len(links)<=output: links.append([])
    links[output].append({'node':b,'type':'main','index':0})
def replace_edges(a,*targets):
    c[a]={'main':[[{'node':b,'type':'main','index':0}] if b else [] for b in targets]}

# Remove only the obsolete manual-localization/duplicate branches. Deduplication
# is committed atomically by the existing create-ticket routine plus intake SQL.
removed=['Create Triage Ticket','Notify FM - Manual Triage Needed','FM Resume Ticket','Validate FM Resume',
 'Verify Resume Element','Read Resume Ticket','Prepare Resume State','Commit FM Resume','Resume Receipt','Resume Committed?',
 'Check Duplicate','Is Duplicate?','Log Duplicate Report','Notify Reporter - Duplicate']
for name in removed:
    nodes.pop(name,None); c.pop(name,None)
for links in c.values():
    for kind, outputs in links.items():
        for i, edges in enumerate(outputs): outputs[i]=[e for e in edges if e['node'] not in removed]

# A Drive poll can return multiple files. Isolate each report in one child execution
# so existing .first() references and dispatch memory cannot mix reporters.
node('Process Each Drive Capture','executeWorkflow',{'source':'database',
 'workflowId':{'__rl':True,'value':'={{ $workflow.id }}','mode':'id'},
 'mode':'each','options':{'waitForSubWorkflow':True}},1.3)
node('One Capture Input','executeWorkflowTrigger',{'inputSource':'passthrough'},1.1)
code('Capture Input',r'''const src=$input.first().json;
const parts=String(src.name||'').replace(/\.[^.]+$/,'').split('_');
const email=parts[1]||'';
if(parts[0]!=='report'||!/^[^\s<>"@]+@[^\s<>"@]+\.[^\s<>"@]+$/.test(email)||!/^.+\.(jpe?g|png)$/i.test(src.name||''))
 throw new Error('Use report_<reporter-email>_<report-UUID>_<photo>.jpg; a first photo may omit the UUID.');
if(!/^[A-Za-z0-9_-]{1,200}$/.test(src.id||''))throw new Error('Missing Drive file id');
const reportId=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[2]||'')?parts[2]:null;
return [{json:{...src,report_id:reportId,reporter_email:email.toLowerCase()}}];''')
pg('Claim Capture Attempt','SELECT cbm_capture_begin($1::jsonb) AS capture;',
 '''={{ [JSON.stringify({file_id:$json.id,report_id:$json.report_id,reporter_email:$json.reporter_email,photo_url:$json.webViewLink||'',execution_id:String($execution.id)})] }}''')
condition('Capture Accepted?','={{ $json.capture.process === true }}')
replace_edges('Drive Trigger - New Snapshot','Process Each Drive Capture')
replace_edges('One Capture Input','Capture Input')
replace_edges('Capture Input','Claim Capture Attempt')
replace_edges('Claim Capture Attempt','Capture Accepted?')
replace_edges('Capture Accepted?','Download Snapshot')
nodes['Download Snapshot']['parameters']['fileId']['value']='={{ $("Capture Input").first().json.id }}'
nodes['Download Snapshot']['onError']='continueErrorOutput'
replace_edges('Download Snapshot','Prepare Image & Metadata','Classify Capture Failure')

for n in nodes.values():
    n['parameters']=json.loads(json.dumps(n['parameters']).replace('Drive Trigger - New Snapshot','Capture Input'))
prepare=nodes['Prepare Image & Metadata']['parameters']['jsCode']
prepare=prepare.replace('manual triage','a new-photo request').replace('so the report still reaches a human','so the retry state can be recorded')
nodes['Prepare Image & Metadata']['parameters']['jsCode']=prepare
condition('Capture Normalized?','={{ $json.intrinsicsTrusted === true && !$json.normalizeError }}')
replace_edges('Prepare Image & Metadata','Capture Normalized?')
replace_edges('Capture Normalized?','MultiSet - Get Token','Classify Capture Failure')
for name in ['MultiSet - Get Token','MultiSet - Localize Snapshot','Find IFC Element','Vision Triage (Claude)']:
    while len(c[name]['main'])<2:c[name]['main'].append([])
    c[name]['main'][1]=[{'node':'Classify Capture Failure','type':'main','index':0}]
replace_edges('Confidence Gate','Find IFC Element','Classify Capture Failure')
nodes['IFC Element Found?']['name']='IFC Candidates Available?'
nodes['IFC Candidates Available?']=nodes.pop('IFC Element Found?')
nodes['IFC Candidates Available?']['parameters']=condition('Temporary Candidate Condition',
 "={{ $json.reason === 'AUTOMATIC_IDENTIFICATION_REQUIRED' && Array.isArray($json.candidates) && $json.candidates.length > 0 }}")['parameters']
nodes.pop('Temporary Candidate Condition')
c.pop('IFC Element Found?',None)
replace_edges('Find IFC Element','IFC Candidates Available?','Classify Capture Failure')
replace_edges('IFC Candidates Available?','Vision Triage (Claude)','Classify Capture Failure')

# Keep the same image-model call: combine target selection and issue assessment.
# A proxy's family name is useful semantic evidence, not grounds for mandatory FM selection.
nodes['Vision Triage (Claude)']['parameters']['jsonBody']=r'''={{ JSON.stringify({model:'claude-sonnet-4-6',max_tokens:1000,messages:[{role:'user',content:[
 {type:'image',source:{type:'base64',media_type:'image/jpeg',data:$('Prepare Image & Metadata').first().json.imageB64} },
 {type:'text',text:'Identify the main intended maintenance target in this photo using ONLY these nearby IFC candidates: '+JSON.stringify($('Find IFC Element').first().json.candidates)+'. The list comes from a registered VPS camera pose. Camera distance is NOT object identity. Match visible object type and distinguishing features to the IFC names/classes. If multiple candidates or visible targets remain plausible, do not guess. Generic IfcBuildingElementProxy can represent a radiator or outlet; use the family name and visible evidence. Never invent a GUID or a fault. A model/family name does not prove an installed product model. Return ONLY JSON: {"identified":boolean,"global_id":string|null,"identification_confidence":number 0-1,"identification_evidence":string,"ambiguous":boolean,"category":string,"severity":integer 1-5,"description":string,"required_skill":"carpentry|plumbing|electrical|hvac|general"}. Use identified=false and ambiguous=true when unresolved. Describe only visible or explicitly reported maintenance evidence; absence of visible damage is not evidence of a fault.'}
 ]}]}) }}'''
nodes['Vision Triage (Claude)']['parameters']['options']={'timeout':90000}
nodes['Parse Triage JSON']['parameters']['jsCode']=r'''const loc=$('MultiSet - Localize Snapshot').first().json;
const spatial=$('Find IFC Element').first().json;
const meta=$('Prepare Image & Metadata').first().json;
let triage={},triageValid=false,element=null,reason='TRIAGE_INVALID';
try {
 triage=JSON.parse(String($json.content?.find(x=>x.type==='text'||x.text)?.text||'').replace(/```json|```/g,'').trim());
 const matches=(spatial.candidates||[]).filter(x=>x.global_id===triage.global_id);
 const identified=triage.identified===true && triage.ambiguous===false && matches.length===1
  && Number.isFinite(triage.identification_confidence) && triage.identification_confidence>=0.8 && triage.identification_confidence<=1
  && typeof triage.identification_evidence==='string' && triage.identification_evidence.trim().length>=10;
 if(!identified)reason='ASSET_IDENTIFICATION_UNRESOLVED';
 if(identified)element={...matches[0],found:true,identification_evidence:triage.identification_evidence,identification_confidence:triage.identification_confidence};
 triageValid=identified && Number.isInteger(triage.severity)&&triage.severity>=1&&triage.severity<=5
 && ['carpentry','plumbing','electrical','hvac','general'].includes(triage.required_skill)
 && typeof triage.category==='string'&&triage.category.trim().length>0&&triage.category.length<=200
 && typeof triage.description==='string'&&triage.description.trim().length>0&&triage.description.length<=4000
 && !!loc.position && [loc.position.x,loc.position.y,loc.position.z,loc.confidence].every(Number.isFinite);
}catch{}
const map=Array.isArray(loc.mapCodes)?loc.mapCodes[0]:null;
return [{json:{...triage,triageValid,reason,position:loc.position,confidence:loc.confidence,mapCode:map,
element,reporterEmail:meta.reporterEmail,photoUrl:meta.photoUrl}}];'''
replace_edges('Triage Valid?','Create Ticket','Classify Capture Failure')
pg('Submit Ticket for FM Authorization',
 'SELECT cbm_capture_identified($1::uuid,$2::text,$3::jsonb) AS result;',
 '''={{ [$('Claim Capture Attempt').first().json.capture.report_id,$('Capture Input').first().json.id,JSON.stringify($json)] }}''')
replace_edges('Create Ticket','Submit Ticket for FM Authorization')

code('Classify Capture Failure',r'''const input=$input.first().json;
let reason='VPS_POSE_UNRESOLVED';
if(input.error)reason='PROVIDER_OR_SERVICE_ERROR';
else if(typeof input.reason==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(input.reason))reason=input.reason;
else if(input.normalizeError||input.intrinsicsTrusted===false)reason='CAPTURE_NORMALIZATION_FAILED';
return [{json:{report_id:$('Claim Capture Attempt').first().json.capture.report_id,file_id:$('Capture Input').first().json.id,reason}}];''')
pg('Record Capture Failure','SELECT cbm_capture_failed($1::uuid,$2::text,$3::text) AS result;',
 '={{ [$json.report_id,$json.file_id,$json.reason] }}')
connect('Classify Capture Failure','Record Capture Failure')

# Persisted notifications are delivered only after the capture/approval transaction commits.
pg('Recover Intake State','SELECT cbm_intake_recover() AS recovered;')
pg('Claim Intake Notification','SELECT * FROM cbm_intake_claim_notice();')
connect('Phase B Recovery Tick','Recover Intake State')
connect('Recover Intake State','Claim Intake Notification')
code('Prepare Intake Notification',r'''const row=$input.first().json,p=row.payload||{};
const base='https://REPLACE_N8N_HOST/webhook';
const fm='REPLACE_FM_EMAIL@example.com',it='REPLACE_IT_EMAIL@example.com';
let to=row.reporter_email,subject='[CBM] Report update',text='';
switch(row.kind){
 case 'RETRY':subject='[CBM] Please retry with a new photo';text='We could not identify the IFC asset. Report '+p.report_id+'. Capture '+p.attempts+' of 4. You have '+p.retries_remaining+' replacement photo(s) left.\nTake a clearer photo, include the surrounding area, and make the intended target unambiguous.\nDrive demo: upload a NEW file named report_'+to+'_'+p.report_id+'_<photo>.jpg. Keep this report ID for every retry.\nDiagnostic: '+p.reason+'. If a service is unavailable, a new photo may also fail; after the third replacement the report is escalated to IT. No maintenance job has been dispatched.';break;
 case 'BUG_RECEIPT':subject='[CBM] Identification problem reported to IT';text='Report '+p.report_id+' could not be identified after four captures (the original and three replacements). Bug issue '+p.issue_id+' has been recorded and an IT notification queued. Stop uploading retries for this report. No maintenance ticket was commissioned.';break;
 case 'IT_BUG':to=it;subject='[CBM BUG] IFC identification exhausted three retries';text='Issue '+p.issue_id+'\nReport '+p.report_id+'\nMap MAP_J964JX6MGEGO\nInspect the capture execution IDs, provider availability, camera metadata, map-to-IFC registration and automatic target identification. The FM is not responsible for this failure.\n'+JSON.stringify(p.diagnostics,null,2);break;
 case 'AUTHORIZATION':to=fm;subject='[CBM] Authorize intervention - ticket #'+p.ticket_id;text='A new maintenance request awaits your authorization. No technician has been contacted.\nTicket #'+p.ticket_id+'\nAsset: '+p.ifc_name+'\nIFC GlobalId: '+p.ifc_global_id+'\nIssue: '+p.description+'\nSeverity: '+p.severity+'/5\nPhoto: '+(p.photo_url||'see stored capture')+'\nReview and explicitly approve or reject the INTERVENTION:\n'+base+'/cbm-wf1-authorize?ticket='+p.ticket_id+'&authorization='+encodeURIComponent(p.authorization_id)+'&token='+encodeURIComponent(p.token)+'\nThis link expires at '+p.expires_at+'. Expiry leaves the request pending and a fresh link is issued. Asset identification is automatic; this is a maintenance-authorization decision. Completion acceptance happens separately in WF2.';break;
 case 'RECEIVED':subject='[CBM] Request awaiting FM authorization';text='Your report '+p.report_id+' identified an IFC asset. Ticket #'+p.ticket_id+' now awaits FM authorization before any technician is contacted.';break;
 case 'DUPLICATE':text='Your report '+p.report_id+' was linked to existing ticket #'+p.ticket_id+'. No additional job was created.';break;
 case 'REJECTED':subject='[CBM] Maintenance request rejected';text='The FM rejected the proposed intervention for ticket #'+p.ticket_id+'. No technician was dispatched for this request.';break;
 case 'BUSY':text='Report '+p.report_id+' is still processing its previous photo. Wait for the result. This upload did not consume a retry. If another photo is requested, upload it as a new Drive file with the same report ID.';break;
 case 'FINISHED':text='Report '+p.report_id+' is already '+p.state+'. This extra upload did not start another job or reset the retry counter.';break;
 default:throw new Error('Unknown intake notification kind');
}
if(!/^[^\s<>"@]+@[^\s<>"@]+\.[^\s<>"@]+$/.test(to||'')||to.includes('REPLACE'))throw new Error('Configure the notification recipient before publishing');
return [{json:{...row,to,subject,text}}];''')
node('Send Intake Notification','gmail',{'operation':'send','sendTo':'={{ $json.to }}',
 'subject':'={{ $json.subject }}','emailType':'text','message':'={{ $json.text }}','options':{'appendAttribution':False}},
 2.1,credentials=gmail_credentials,onError='continueRegularOutput',retryOnFail=False)
pg('Record Intake Notification Receipt',
 '''UPDATE cbm_intake_outbox SET status=CASE WHEN nullif($3::text,'') IS NOT NULL THEN 'SENT' ELSE 'UNCERTAIN' END,
 message_id=nullif($3::text,''),sent_at=CASE WHEN nullif($3::text,'') IS NOT NULL THEN clock_timestamp() END
 WHERE id=$1::bigint AND claim=$2::uuid AND status IN ('SENDING','UNCERTAIN') RETURNING id,status;''',
 '''={{ [$('Claim Intake Notification').first().json.id,$('Claim Intake Notification').first().json.claim,typeof $json.id === 'string' ? $json.id : null] }}''')
for a,b in [('Claim Intake Notification','Prepare Intake Notification'),('Prepare Intake Notification','Send Intake Notification'),
 ('Send Intake Notification','Record Intake Notification Receipt')]:connect(a,b)

# Email bearer links follow the existing offer-link pattern: GET only displays;
# only an explicit POST can authorize a job. No asset-editing inputs exist.
for method in ['GET','POST']:
    name='View Intervention Authorization' if method=='GET' else 'Submit Intervention Authorization'
    node(name,'webhook',{'httpMethod':method,'path':'cbm-wf1-authorize','responseMode':'responseNode','options':{}},2,
         webhookId=hashlib.sha256(name.encode()).hexdigest()[:32])
    code(name+' Input',r'''const p=$json.SOURCE||{};
const valid=/^[1-9][0-9]{0,8}$/.test(String(p.ticket||''))&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p.authorization||'')&&/^[a-f0-9]{64}$/.test(p.token||'')
 && Object.keys(p).every(k=>['ticket','authorization','token','decision'].includes(k));
return [{json:{ticket:valid?Number(p.ticket):0,authorization:valid?p.authorization:'00000000-0000-0000-0000-000000000000',token:valid?p.token:'',decision:['approve','reject'].includes(p.decision)?p.decision:'invalid'}}];'''.replace('SOURCE','query' if method=='GET' else 'body'))
    connect(name,name+' Input')
pg('Read Intervention Authorization',
 '''SELECT (SELECT jsonb_build_object('ticket_id',id,'ifc_name',ifc_name,'ifc_global_id',ifc_global_id,
 'description',description,'severity',severity,'photo_url',photo_before_url)
 FROM tickets WHERE id=$1 AND status='PENDING_AUTHORIZATION' AND dispatch_authorization_id=$2::uuid
 AND dispatch_authorization_token=$3 AND clock_timestamp()<dispatch_authorization_expires_at) AS authorization;''',
 '={{ [$json.ticket,$json.authorization,$json.token] }}')
code('Build Intervention Authorization Form',r'''const p=$('View Intervention Authorization Input').first().json,t=$json.authorization;
const e=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const valid=!!t;
const html='<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Authorize intervention</title></head><body>'+(valid?
 '<h1>Authorize intervention for ticket #'+e(t.ticket_id)+'</h1><p><strong>Asset:</strong> '+e(t.ifc_name)+' ('+e(t.ifc_global_id)+')</p><p><strong>Reported issue:</strong> '+e(t.description)+'</p><p><strong>Severity:</strong> '+e(t.severity)+'/5</p>'+
 (/^https:\/\//.test(t.photo_url||'')?'<p><a rel="noreferrer" href="'+e(t.photo_url)+'">View submitted photo</a></p>':'')+
 '<p>Your decision authorizes or rejects the maintenance intervention. The asset has been identified automatically. No technician is contacted before approval. Completion acceptance is separate.</p><form method="post" action="https://REPLACE_N8N_HOST/webhook/cbm-wf1-authorize"><input type="hidden" name="ticket" value="'+p.ticket+'"><input type="hidden" name="authorization" value="'+p.authorization+'"><input type="hidden" name="token" value="'+p.token+'"><button name="decision" value="approve">Approve intervention</button> <button name="decision" value="reject">Reject intervention</button></form>'
 :'<h1>Authorization unavailable</h1><p>This link is invalid, expired or already used. Use the newest approval email.</p>')+'</body></html>';
return [{json:{html,statusCode:valid?200:410}}];''')
node('Show Intervention Authorization','respondToWebhook',{'respondWith':'text','responseBody':'={{ $json.html }}',
 'options':{'responseCode':'={{ $json.statusCode }}','responseHeaders':{'entries':[{'name':'Content-Type','value':'text/html; charset=utf-8'},{'name':'Cache-Control','value':'no-store'}]}}},1.4)
pg('Persist Intervention Authorization','SELECT cbm_authorize_dispatch($1::integer,$2::uuid,$3::text,$4::text) AS decision;',
 '={{ [$json.ticket,$json.authorization,$json.token,$json.decision] }}')
node('Intervention Authorization Receipt','respondToWebhook',{'respondWith':'json','responseBody':'={{ $json.decision }}',
 'options':{'responseCode':'={{ $json.decision.applied ? 200 : 409 }}'}},1.4)
condition('Intervention Authorized?','={{ $json.decision.applied === true && $json.decision.approved === true }}')
code('Authorized Ticket Context','return [{json:{ticketId:$json.decision.ticketId}}];')
for a,b in [('View Intervention Authorization Input','Read Intervention Authorization'),('Read Intervention Authorization','Build Intervention Authorization Form'),
 ('Build Intervention Authorization Form','Show Intervention Authorization'),('Submit Intervention Authorization Input','Persist Intervention Authorization'),
 ('Persist Intervention Authorization','Intervention Authorization Receipt'),('Intervention Authorization Receipt','Intervention Authorized?'),
 ('Intervention Authorized?','Authorized Ticket Context'),('Authorized Ticket Context','Phase B Context')]:connect(a,b)

nodes['Note -380x-260']['parameters']['content']='## Maddaloni intake and authorization\nInitial photo + at most 3 replacement photos, correlated by report UUID. Unresolved identification creates a persistent IT bug after capture 4; no FM asset-selection step. Automatic VPS + vision identification precedes a pending maintenance ticket. Explicit FM authorization is mandatory BEFORE dispatch. WF2 completion acceptance remains separate. See INTAKE_APPROVAL_GUIDE.md.'
nodes['Note -380x-260']['parameters']['height']=300
for n in nodes.values():
    n.setdefault('id',hashlib.sha256(n['name'].encode()).hexdigest()[:32])
w['nodes']=list(nodes.values())
w['settings']['callerPolicy']='workflowsFromSameOwner'
original_nodes={n['name']:n for n in baseline['nodes']}
overlay={'remove':removed+['IFC Element Found?'],'upsert':[n for n in w['nodes'] if original_nodes.get(n['name'])!=n],
 'connections':w['connections'],'settings':w['settings']}
(HERE/'workflow-patch.json').write_text(json.dumps(overlay,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
(HERE.parent/'app/wf1_ticket_intake_and_dispatch.json').write_text(json.dumps(w,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
print(f'WF1: {len(baseline["nodes"])} -> {len(w["nodes"])} nodes; {len(overlay["upsert"])} added/changed nodes.')
