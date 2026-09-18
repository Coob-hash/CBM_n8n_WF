'use strict';
const fs=require('node:fs'),path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,name),'utf8');
const edges=(...branches)=>({main:branches.map(b=>b.map(node=>({node,type:'main',index:0})))});
const context='$("Closure Context").first().json';
function apply(main,ifc,notices){
 const n=name=>main.nodes.find(n=>n.name===name);
 n('Closure Supervisor').parameters.options.systemMessage=read('closure-system-message.txt');
 n('close_ticket').parameters.query='SELECT cbm_wf2_close_ticket($1::jsonb) AS result;';
 n('close_ticket').parameters.toolDescription='Close only with current FM approval and a persisted successful IFC result matching the model version. Returns BLOCKED if any prerequisite is missing. CLOSED is idempotent.';
 n('log_ifc_maintenance').parameters.description='Write the approved IFC maintenance operation and persist the actual service result. Require SUCCEEDED with a version before closure. Failure, skip or missing element blocks closure. Retries use the same operation key.';
 n('record_attempt').parameters.toolDescription='Record a diagnostic operation attempt for the bound approval. This cannot create an email send receipt or authorize closure.';
 n('record_attempt').parameters.query=`INSERT INTO ticket_events(ticket_id,event,payload)
 SELECT ($1::jsonb->>'ticketId')::int,'CBM_WF2_ATTEMPT',
 jsonb_build_object('approval_id',$1::jsonb->>'approvalId','operation_key',$1::jsonb->>'operationKey',
 'operation',$1::jsonb->>'operation','outcome',$1::jsonb->>'outcome','detail',$1::jsonb->>'detail') RETURNING id,event;`;
 n('record_attempt').parameters.options.queryReplacement='={{ [JSON.stringify({ticketId:'+context+'.ticketId,approvalId:'+context+'.approvalId,operationKey:'+context+'.operationKey,operation:$fromAI("operation","Failed tool or objective","string"),outcome:$fromAI("outcome","FAILED or BLOCKED","string"),detail:$fromAI("detail","Observed error or reason","string")})] }}';
 n('check_notice').parameters.query=`SELECT event,payload->>'notice_key' AS notice_key,payload->>'outcome' AS outcome,
 payload->>'message_id' AS message_id,payload->>'recipient' AS recipient,payload->>'error' AS error,created_at
 FROM ticket_events WHERE ticket_id=($1::jsonb->>'ticketId')::int
 AND payload->>'approval_id'=$1::jsonb->>'approvalId'
 AND event IN ('CBM_WF2_NOTICE','CBM_WF2_NOTICE_CLAIM','CBM_WF2_NOTICE_FAILED','CBM_WF2_FM_NOTICE_CLAIM') ORDER BY id;`;
 n('check_notice').parameters.toolDescription='Read current-approval send claims, Gmail receipts and failures. A claim without a successful receipt is UNCONFIRMED and must not be blindly resent.';
 for(const [name,recipient] of [['notify_technician','technician'],['notify_fm','fm']]){
  const node=n(name),p=structuredClone(n('log_ifc_maintenance').parameters);
  node.type='@n8n/n8n-nodes-langchain.toolWorkflow';node.typeVersion=2.1;
  delete node.credentials;delete node.webhookId;node.retryOnFail=false;node.onError='continueRegularOutput';
  p.name=name;p.description='Send the '+recipient+' notice through the guarded helper. It checks committed state, prevents duplicate attempts and records Gmail message IDs. SENT confirms provider acceptance; UNCONFIRMED requires reconciliation.';
  p.workflowId={__rl:true,mode:'id',value:notices.id};
  p.workflowInputs.value.context='={{ JSON.stringify({...'+context+',noticeRecipient:"'+recipient+'"}) }}';node.parameters=p;
 }
 n('Verify Closure Outcome').parameters={operation:'executeQuery',query:`SELECT result.*, (result.settled IS TRUE) AS verified
 FROM jsonb_to_record(cbm_wf2_closure_outcome($1::jsonb)) AS result
 (id int,status text,approval_id uuid,closed_at timestamptz,ifc_new_version text,settled boolean,missing_operations jsonb);`,options:{queryReplacement:'={{ [JSON.stringify('+context+')] }}'}};
 n('Closure Settled?').parameters.conditions.conditions[0].leftValue='={{ $json.settled === true }}';
 n('Closure Settled?').parameters.conditions.options.typeValidation='strict';
 const attention=n('Notify FM - Closure Needs Attention');
 attention.parameters.subject='=[CBM] Ticket {{ '+context+'.ticketId }} - closure objectives incomplete';
 attention.parameters.message='=Ticket {{ '+context+'.ticketId }}: decision {{ '+context+'.decision }}, state {{ $json.status }}. Missing objectives: {{ JSON.stringify($json.missing_operations) }}. Inspect the current approval’s IFC and notification events. A sent email requires a Gmail receipt; resolve uncertain sends before retrying.';
 if(!n('Record Incomplete Closure')){
  const node=structuredClone(n('Verify Closure Outcome'));
  Object.assign(node,{name:'Record Incomplete Closure',id:'cbm-wf2-record-incomplete-closure',position:[1024,496]});
  node.parameters={operation:'executeQuery',query:`WITH audit AS (INSERT INTO ticket_events(ticket_id,event,payload)
 VALUES($1,'CBM_WF2_INCOMPLETE',$2::jsonb) RETURNING id)
 SELECT $2::jsonb->>'status' AS status,$2::jsonb->'missing_operations' AS missing_operations FROM audit;`,
   options:{queryReplacement:'={{ ['+context+'.ticketId,JSON.stringify({...$json,approval_id:'+context+'.approvalId,execution_id:String($execution.id)})] }}'}};
  main.nodes.push(node);
 }
 main.connections['Closure Settled?'].main[1]=edges(['Record Incomplete Closure']).main[0];
 main.connections['Record Incomplete Closure']=edges(['Notify FM - Closure Needs Attention']);
 const ii=name=>ifc.nodes.find(n=>n.name===name);
 ii('Read Approved Ticket').parameters.query=`SELECT t.*, $1::jsonb AS context,cbm_wf2_ifc_succeeded(t.id,t.approval_id) AS ifc_recorded
 FROM tickets t WHERE t.id=($1::jsonb->>'ticketId')::int AND t.status IN ('PENDING_APPROVAL','CLOSED')
 AND t.approval_id=($1::jsonb->>'approvalId')::uuid
 AND EXISTS(SELECT 1 FROM ticket_events WHERE ticket_id=t.id AND event='CBM_WF2_APPROVAL'
 AND payload->>'approval_id'=t.approval_id::text AND payload->>'decision'='APPROVED');`;
 if(!ii('IFC Already Recorded?')){
  const gate=structuredClone(ii('Element Available?'));
  Object.assign(gate,{name:'IFC Already Recorded?',id:'cbm-wf2-ifc-already-recorded',position:[-288,-112]});
  gate.parameters.conditions.conditions[0].leftValue='={{ $json.ifc_recorded === true }}';
  ifc.nodes.push(gate,{name:'Return Recorded IFC Result',id:'cbm-wf2-ifc-recorded-result',type:'n8n-nodes-base.code',typeVersion:2,position:[0,-240],parameters:{jsCode:'return [{json:{status:"SUCCEEDED",version_file:$json.ifc_new_version,already_recorded:true}}];'}});
 }
 ifc.connections['Read Approved Ticket']=edges(['IFC Already Recorded?']);
 ifc.connections['IFC Already Recorded?']=edges(['Return Recorded IFC Result'],['Element Available?']);
 ii('Skip Missing Element').parameters.jsCode='return [{json:{skipped:true,detail:"Missing IFC GlobalId: update and ticket closure are blocked"}}];';
 ii('Normalize IFC Result').parameters.jsCode=`const x=$json,t=$('Read Approved Ticket').first().json,c=t.context;
 const version=!x.error&&x.global_id===t.ifc_global_id&&typeof x.version_file==='string'&&/^[A-Za-z0-9_. -]+\\.ifc$/i.test(x.version_file)?x.version_file:null;
 return [{json:{...c,version,status:version?'SUCCEEDED':'FAILED',detail:version?'IFC write persisted':String(x.detail||x.error?.message||x.error||'Missing or mismatched IFC result')}}];`;
 ii('Persist IFC Result').parameters.query=`WITH updated AS (
 UPDATE tickets SET ifc_new_version=CASE WHEN $4='SUCCEEDED' THEN $3 ELSE ifc_new_version END
 WHERE id=$1 AND approval_id=$2::uuid AND status='PENDING_APPROVAL'
 AND $5='wf2:'||id||':'||approval_id
 AND EXISTS(SELECT 1 FROM ticket_events e WHERE e.ticket_id=tickets.id AND e.event='CBM_WF2_APPROVAL'
 AND e.payload->>'approval_id'=$2::text AND e.payload->>'decision'='APPROVED') RETURNING id),
 audit AS (INSERT INTO ticket_events(ticket_id,event,payload) SELECT id,
 CASE WHEN $4='SUCCEEDED' THEN 'CBM_WF2_IFC_RESULT' ELSE 'CBM_WF2_ATTEMPT' END,
 jsonb_build_object('approval_id',$2::text,'operation_key',$5::text,'operation','log_ifc_maintenance','outcome',$4::text,'detail',$6::text,'version_file',$3::text)
 FROM updated RETURNING id)
 SELECT CASE WHEN EXISTS(SELECT 1 FROM audit) THEN $4::text ELSE 'BLOCKED' END AS status,
 CASE WHEN EXISTS(SELECT 1 FROM audit) AND $4='SUCCEEDED' THEN $3::text END AS version_file;`;
 // Reuse the existing notification helper for both recipients; no extra workflow.
 const old=Object.fromEntries(notices.nodes.map(n=>[n.name,n]));
 const get=(name,legacy)=>structuredClone(old[name]||old[legacy]);
 const start=get('Bound Context'),parse=get('Parse Context');
 const claim=get('Claim Closure Notice','Claim FM Closure Notice');claim.name='Claim Closure Notice';
 claim.parameters={operation:'executeQuery',query:`SELECT r.* FROM jsonb_to_record(cbm_wf2_claim_notice($1::jsonb)) AS r
 (send_status text,ticket_id int,approval_id uuid,notice_key text,claim_id uuid,recipient text,ifc_new_version text,reason text,already_sent boolean);`,options:{queryReplacement:'={{ [JSON.stringify($json)] }}'}};
 const send=get('Send Closure Notice','Send FM Closure Notice');send.name='Send Closure Notice';
 send.parameters={operation:'send',sendTo:'={{ $json.recipient }}',emailType:'text',
  subject:'={{ "[CBM] Ticket #"+$json.ticket_id+($json.notice_key === "technician:rework" ? " - rework required" : " - closed, IFC updated") }}',
  message:'={{ $json.notice_key === "technician:rework" ? "Ticket #"+$json.ticket_id+": "+$json.reason+" Upload a revised TICKET-"+$json.ticket_id+".pdf after the required work." : "Ticket #"+$json.ticket_id+" is closed following FM approval. IFC version: "+$json.ifc_new_version }}',options:{appendAttribution:false}};
 send.onError='continueRegularOutput';send.alwaysOutputData=true;send.retryOnFail=false;send.position=[896,0];
 const record=get('Record Notice Result','Record FM Notice Delivery');record.name='Record Notice Result';record.position=[1344,0];
 record.parameters={operation:'executeQuery',query:'SELECT cbm_wf2_record_notice($1::jsonb) AS result;',options:{queryReplacement:'={{ [JSON.stringify($json)] }}'}};
 const gate={name:'Send Required?',id:'cbm-wf2-send-required',type:'n8n-nodes-base.if',typeVersion:2,position:[672,0],parameters:{conditions:{options:{typeValidation:'strict'},conditions:[{leftValue:'={{ $json.send_status === "SEND" }}',rightValue:true,operator:{type:'boolean',operation:'true',singleValue:true}}],combinator:'and'},options:{}}};
 const normalize={name:'Validate Gmail Receipt',id:'cbm-wf2-gmail-receipt',type:'n8n-nodes-base.code',typeVersion:2,position:[1120,0],parameters:{jsCode:read('normalize-notice-result.js')}};
 const result={name:'Notice Result',id:'cbm-wf2-notice-result',type:'n8n-nodes-base.noOp',typeVersion:1,position:[1568,144],parameters:{}};
 notices.nodes=[start,parse,claim,gate,send,normalize,record,result];
 notices.connections={'Bound Context':edges(['Parse Context']),'Parse Context':edges(['Claim Closure Notice']),
 'Claim Closure Notice':edges(['Send Required?']),'Send Required?':edges(['Send Closure Notice'],['Notice Result']),
 'Send Closure Notice':edges(['Validate Gmail Receipt']),'Validate Gmail Receipt':edges(['Record Notice Result']),'Record Notice Result':edges(['Notice Result'])};
 return [main,ifc,notices];
}
module.exports={apply};
if(require.main===module){
 const files=process.argv.slice(2),ws=files.map(f=>JSON.parse(fs.readFileSync(f,'utf8')));
 if(ws.length!==3)throw Error('Pass main WF2, IFC helper and notification helper paths');
 apply(...ws).forEach((w,i)=>fs.writeFileSync(files[i],JSON.stringify(w,null,2)+'\n'));
}
