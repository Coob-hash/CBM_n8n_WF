const fs=require('fs'),path=require('path'),crypto=require('crypto');
const base='https://bonanza-progress-hangover.ngrok-free.dev/webhook/cbm-technician-report';
const oldText='After completing the work, upload your written report to <b>02_completed_snapshots</b> as <b>TICKET-${c.ticket.id}.pdf</b>. A photo named <b>TICKET-${c.ticket.id}.jpg</b> is optional; upload it before the PDF to include it in the assessment.';
const newText='After completing the work, open the technician report link in this email. Complete the bilingual form and add an optional intervention photo. The form uploads one PDF for FM review.';
const add=(w,n)=>{const i=w.nodes.findIndex(x=>x.name===n.name);if(i<0)w.nodes.push(n);else w.nodes[i]={...w.nodes[i],...n,position:w.nodes[i].position};};
const connect=(w,a,b)=>{w.connections[a]={main:[[{node:b,type:'main',index:0}]]};};
const node=(name,type,parameters,position,typeVersion,extra={})=>({id:crypto.createHash('sha256').update('portal-link:'+name).digest('hex').slice(0,32),name,type,parameters,position,typeVersion,...extra});
function apply(w){
 for(const n of w.nodes)if(n.parameters.jsCode)n.parameters.jsCode=n.parameters.jsCode.replaceAll(oldText,newText);
 const notice=w.nodes.find(n=>n.name==='Claim Selected Notice');
 const closure=w.nodes.find(n=>n.name==='Claim Closure Notice');
 if(!notice&&!closure)return w;
 const claim=notice||closure,gate=notice?'Email Claimed?':'Send Required?',send=notice?'Gmail - Send Claimed Email':'Send Closure Notice';
 const pg=w.nodes.find(n=>n.type==='n8n-nodes-base.postgres').credentials;
 const expr=notice?'={{ [$("Claim Selected Notice").item.json.mail?.key === "assigned:technician" ? $("Claim Selected Notice").item.json.ticketId : null] }}':'={{ [$("Claim Closure Notice").first().json.notice_key === "technician:rework" ? $("Claim Closure Notice").first().json.ticket_id : null] }}';
 add(w,node('Prepare Technician Report Link','n8n-nodes-base.postgres',{operation:'executeQuery',query:'SELECT CASE WHEN $1::integer IS NOT NULL THEN cbm_issue_technician_report_link($1::integer) ELSE NULL END AS report_link;',options:{queryReplacement:expr}},[claim.position[0]+224,claim.position[1]+380],2.6,{credentials:pg}));
 const code=notice?`const d=JSON.parse(JSON.stringify($('${claim.name}').item.json)),link=$json.report_link;
 if(d.mail?.key==='assigned:technician'){
  if(!link?.token)throw new Error('Cannot issue a report link for the assigned technician');
  const url=${JSON.stringify(base)}+'?ticketId='+link.ticketId+'&token='+encodeURIComponent(link.token);
  d.mail.html+='<p><a href="'+url.replace(/&/g,'&amp;')+'">Compila il rapporto / Complete technician report</a></p><p>Personal link, valid for 30 days. The form includes the intervention photo in the PDF.</p>';
 }
 return [{json:d}];`:`const d=$('${claim.name}').first().json,link=$json.report_link;
 if(d.notice_key==='technician:rework'&&!link?.token)throw new Error('Cannot issue a revised report link');
 return [{json:{...d,report_url:link?.token?${JSON.stringify(base)}+'?ticketId='+link.ticketId+'&token='+encodeURIComponent(link.token):null}}];`;
 add(w,node('Attach Technician Report Link','n8n-nodes-base.code',{jsCode:code},[claim.position[0]+480,claim.position[1]+380],2));
 w.connections[gate].main[0]=[{node:'Prepare Technician Report Link',type:'main',index:0}];
 connect(w,'Prepare Technician Report Link','Attach Technician Report Link');connect(w,'Attach Technician Report Link',send);
 const gmail=w.nodes.find(n=>n.name===send);
 if(notice)gmail.parameters.message='={{ $json.mail.html }}';
 else gmail.parameters.message='={{ $json.notice_key === "technician:rework" ? "Ticket #"+$json.ticket_id+": "+$json.reason+" Complete a revised report after the required work: "+$json.report_url : "Ticket #"+$json.ticket_id+" is closed following FM approval. IFC version: "+$json.ifc_new_version }}';
 return w;
}
module.exports={apply,oldText,newText};
if(require.main===module){
 const app=path.resolve(__dirname,'..');
 for(const rel of ['phase_b/workflows/process_events.json','phase_b/workflows/send_notices.json','wf2/workflows/notify_fm.json']){
  const p=path.join(app,rel);if(fs.existsSync(p))fs.writeFileSync(p,JSON.stringify(apply(JSON.parse(fs.readFileSync(p))),null,2));
 }
 const p=path.join(app,'phase_b/operations.js');fs.writeFileSync(p,fs.readFileSync(p,'utf8').replaceAll(oldText,newText));
 console.log('Applied technician report links to assignment and rework helpers.');
}
