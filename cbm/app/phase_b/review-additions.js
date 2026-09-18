'use strict';
const fs=require('node:fs'),path=require('node:path');
module.exports=function({w,config,node,code,pg,condition,connect,id}) {
 const c=w.connections,add=n=>w.nodes.push(n);
 add(condition('Triage Valid?','={{ $json.triageValid === true }}',1980,-280));
 connect(c,'Triage Valid?','Create Ticket');connect(c,'Triage Valid?','Create Triage Ticket',1);
 add(condition('IFC Element Found?','={{ $json.found === true && !!$json.global_id }}',1050,-280));
 connect(c,'IFC Element Found?','Check Duplicate');connect(c,'IFC Element Found?','Create Triage Ticket',1);
 add(node('Notify Reporter - Duplicate','n8n-nodes-base.gmail',{
  operation:'send',sendTo:'={{ /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test($("Prepare Image & Metadata").first().json.reporterEmail) ? $("Prepare Image & Metadata").first().json.reporterEmail : "'+config.fmEmail+'" }}',
  subject:'=[CBM] Report linked to existing ticket #{{ $("Check Duplicate").first().json.id }}',emailType:'text',
  message:'=Your report was recorded as duplicate #{{ $json.id }}. Open ticket #{{ $("Check Duplicate").first().json.id }} already covers this element; its maintenance dispatch continues.',options:{appendAttribution:false}
 },1820,100,2.1,{credentials:{gmailOAuth2:{id:config.gmailCredentialId,name:config.gmailCredentialName}}}));
 // FM-only recovery: no public action and no mutation on GET. Old audit is retained.
 add(node('FM Resume Ticket','n8n-nodes-base.webhook',{httpMethod:'POST',path:'cbm-wf1-resume',authentication:'headerAuth',responseMode:'responseNode',options:{}},2040,1850,2,
  {webhookId:id('fm-resume'),credentials:{httpHeaderAuth:(()=>{if(!config.fmResumeCredential?.id)throw new Error('Legacy FM Resume requires config.fmResumeCredential before rebuilding this retired route.');return config.fmResumeCredential;})()}}));
 add(code('Validate FM Resume',`const b=$json.body||{};
if(!Number.isSafeInteger(b.ticketId)||b.ticketId<1||!/[0-3][0-9A-Za-z_$]{21}/.test(b.globalId||'')||String(b.globalId).length!==22
 || !['carpentry','plumbing','electrical','hvac','general'].includes(b.skill)||!Number.isInteger(b.severity)||b.severity<1||b.severity>5
 || typeof b.description!=='string'||!b.description.trim()||b.description.length>4000)throw new Error('Provide ticketId, IFC globalId, skill, severity 1–5, and description.');
return [{json:{ticketId:b.ticketId,globalId:b.globalId,skill:b.skill,severity:b.severity,description:b.description.trim()}}];`,2260,1850));
 add(node('Verify Resume Element','n8n-nodes-base.httpRequest',{url:'={{ $env.IFC_SERVICE_URL.replace(/\\/+$/, "") + "/elements/" + $("Validate FM Resume").first().json.globalId }}',options:{timeout:30000}},2480,1850,4.2));
 add(pg('Read Resume Ticket',`SELECT jsonb_build_object('now',clock_timestamp(),'ticket',(SELECT to_jsonb(t) FROM tickets t WHERE id=$1),
 'revision',(SELECT updated_at::text FROM tickets WHERE id=$1),
 'candidates',coalesce((SELECT jsonb_agg(to_jsonb(q) ORDER BY open_jobs,last_assigned_at ASC NULLS FIRST,rating DESC,technician_id)
 FROM (SELECT x.id AS technician_id,x.full_name,x.email,x.rating,x.last_assigned_at,
 (SELECT count(*) FROM tickets j WHERE j.technician_id=x.id AND j.status IN ('ASSIGNED','WORK_DONE','PENDING_APPROVAL','REWORK')) AS open_jobs
 FROM technicians x WHERE x.active AND x.zone='building-A' AND $2=ANY(x.skills))q),'[]'::jsonb)) AS context;`,
 '={{ [$("Validate FM Resume").first().json.ticketId,$("Validate FM Resume").first().json.skill] }}',2700,1850));
 add(code('Prepare Resume State',require('./operations').operationSource('initialize')+`
const row=$json.context,b=$('Validate FM Resume').first().json,el=$('Verify Resume Element').first().json;
if(!row.ticket||!['NEEDS_TRIAGE','ESCALATED'].includes(row.ticket.status))throw new Error('Only NEEDS_TRIAGE or ESCALATED tickets can resume.');
if(el.global_id!==b.globalId)throw new Error('IFC element identity mismatch.');
row.ticket={...row.ticket,status:'LOCALIZED',created_at:row.now,ifc_global_id:el.global_id,ifc_class:el.ifc_class,ifc_name:el.name,severity:b.severity,required_skill:b.skill,description:b.description};
row.state=null;
const result=runOperation({operation:'initialize',ticketId:b.ticketId,config:${JSON.stringify(config)}},row);
return [{json:{ticketId:b.ticketId,revision:row.revision,fields:row.ticket,state:result.state}}];`,2920,1850));
 add(pg('Commit FM Resume',`WITH changed AS (
 UPDATE tickets SET status='LOCALIZED',ifc_global_id=$3::jsonb->>'ifc_global_id',ifc_class=$3::jsonb->>'ifc_class',
 ifc_name=$3::jsonb->>'ifc_name',required_skill=$3::jsonb->>'required_skill',severity=($3::jsonb->>'severity')::int,
 description=$3::jsonb->>'description',updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond')
 WHERE id=$1 AND updated_at=$2::timestamptz AND status IN ('NEEDS_TRIAGE','ESCALATED') RETURNING id
), audit AS (INSERT INTO ticket_events(ticket_id,event,payload) SELECT id,'CBM_FM_RESUMED',$3::jsonb FROM changed RETURNING id),
 state AS (INSERT INTO ticket_events(ticket_id,event,payload) SELECT id,'CBM_DISPATCH_STATE',$4::jsonb FROM changed RETURNING id)
 SELECT $1::int AS "ticketId",exists(SELECT 1 FROM changed) AS resumed;`,
 '={{ [$json.ticketId,$json.revision,JSON.stringify($json.fields),JSON.stringify($json.state)] }}',3140,1850));
 add(node('Resume Receipt','n8n-nodes-base.respondToWebhook',{respondWith:'json',responseBody:'={{ $json }}',options:{responseCode:'={{ $json.resumed ? 200 : 409 }}'}},3360,1850,1.4));
 add(condition('Resume Committed?','={{ $json.resumed === true }}',3580,1850));
 for(const [a,b] of [['FM Resume Ticket','Validate FM Resume'],['Validate FM Resume','Verify Resume Element'],['Verify Resume Element','Read Resume Ticket'],['Read Resume Ticket','Prepare Resume State'],['Prepare Resume State','Commit FM Resume'],['Commit FM Resume','Resume Receipt'],['Resume Receipt','Resume Committed?'],['Resume Committed?','Phase B Context']])connect(c,a,b);
 const errors={id:id('knowledge-errors'),name:'CBM - Knowledge Error Notification',active:false,nodes:[
  node('Knowledge Error','n8n-nodes-base.errorTrigger',{},0,0,1),
  node('Notify Knowledge Operator','n8n-nodes-base.gmail',{operation:'send',sendTo:config.fmEmail,emailType:'text',subject:'[CBM] Technical knowledge synchronization failed',message:'={{ "Workflow: " + ($json.workflow?.name || "knowledge sync") + "\\nExecution: " + ($json.execution?.url || $json.execution?.id || "unavailable") + "\\nError: " + ($json.execution?.error?.message || $json.trigger?.error?.message || "Inspect n8n execution") + "\\nThe last published generation remains available within its freshness policy. Inspect loader serialization, provider limits and snapshot consistency before retrying." }}',options:{appendAttribution:false}},240,0,2.1,{credentials:{gmailOAuth2:{id:config.gmailCredentialId,name:config.gmailCredentialName}}})
 ],connections:{'Knowledge Error':{main:[[{node:'Notify Knowledge Operator',type:'main',index:0}]]}},settings:{executionOrder:'v1',timezone:'Europe/Rome'}};
 fs.writeFileSync(path.join(__dirname,'../knowledge/error_workflow.json'),JSON.stringify(errors,null,2)+'\n');
};
