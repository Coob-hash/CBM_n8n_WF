'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sql=require('../app/phase_b/queries'),{operationSource}=require('../app/phase_b/operations');
const prompt=fs.readFileSync(path.join(__dirname,'system-message.txt'),'utf8');
const copy=x=>JSON.parse(JSON.stringify(x));
function rename(w,from,to){
 const n=w.nodes.find(n=>n.name===from),existing=w.nodes.find(n=>n.name===to);
 if(n&&existing){existing.parameters=n.parameters;w.nodes=w.nodes.filter(x=>x!==n);}else if(n)n.name=to;
 if(w.connections[from]){w.connections[to]=w.connections[from];delete w.connections[from];}
 for(const out of Object.values(w.connections))for(const channels of Object.values(out))for(const a of channels)for(const e of a)if(e.node===from)e.node=to;
 for(const n of w.nodes)n.parameters=JSON.parse(JSON.stringify(n.parameters).split(from).join(to));
}
function patch(w){
 const get=name=>w.nodes.find(n=>n.name===name);
 const wf1=!!get('Dispatch Agent');
 if(wf1){
  w.nodes=w.nodes.filter(n=>n.name!=='create_ticket'&&n.name!=='Recovery Ticket Context');
  delete w.connections.create_ticket;delete w.connections['Recovery Ticket Context'];
  rename(w,'Radiator Technical Knowledge','Approved Asset Knowledge');
  rename(w,'Create Ticket','Prepare Ticket Request');
  rename(w,'Find Due Dispatch','Claim One Dispatch Ticket');
  rename(w,'Select Up to Five Tickets','Claim One Dispatch Ticket');
  const removed=new Set(['Dispatch Batch Loop','Process One Dispatch Ticket','Batch Finished','Dispatch Work Item?','Start Dispatch Work','Dispatch Claim Accepted?','Bound Dispatch Ticket']);
  w.nodes=w.nodes.filter(n=>!removed.has(n.name));
  for(const name of removed)delete w.connections[name];
  for(const out of Object.values(w.connections))for(const channels of Object.values(out))for(let i=0;i<channels.length;i++)channels[i]=channels[i].filter(e=>!removed.has(e.node));
  const agent=get('Dispatch Agent');agent.parameters.options.systemMessage=prompt;
  agent.parameters.text='={{ "Handle only the bound ticket using these database facts. The portfolio is awareness, not permission to modify other tickets. " + JSON.stringify($json.context) }}';
  const knowledge=get('Approved Asset Knowledge');knowledge.parameters.topK=4;knowledge.parameters.includeDocumentMetadata=true;
  for(const name of ['Read Dispatch Memory','get_context','Verify Committed Outcome'])get(name).parameters.query=sql.PUBLIC_CONTEXT;
  get('get_context').parameters.options.queryReplacement='={{ [JSON.stringify({...$("Phase B Context").first().json,overviewPage:Math.max(0,Math.min(100000,Math.floor(Number($fromAI("overview_page","Zero-based overview page, five non-closed tickets per page. Use 0 unless another page is needed. Does not change the bound ticket.","number",0))||0)))})] }}';
  get('get_context').parameters.toolDescription='Read fresh facts for the workflow-bound ticket: issue, asset, authorization, shortlist, offers, responses and notices; plus a five-item page and counts of all non-closed tickets. Optional overview_page changes only the overview page. No ticket-ID input, secrets or email bodies.';
  get('Claim One Dispatch Ticket').parameters.query=sql.DUE;
  get('Claim One Dispatch Ticket').parameters.options.queryReplacement='={{ [$json.ticketId ?? null,String($execution.id)] }}';
  get('Claim One Dispatch Ticket').alwaysOutputData=false;
  const credentials=copy(get('Read Dispatch Memory').credentials);
  function add(name,type,parameters,position,extra={}){
   if(get(name)){Object.assign(get(name),{parameters,...extra});return get(name);}
   const n={name,id:crypto.createHash('md5').update('cbm-dispatch-queue:'+name).digest('hex'),type,typeVersion:type==='n8n-nodes-base.postgres'?2.6:type==='n8n-nodes-base.code'?2:1,parameters,position,...extra};w.nodes.push(n);return n;
  }
  function pg(name,query,replacement,x,y){return add(name,'n8n-nodes-base.postgres',{operation:'executeQuery',query,options:{queryReplacement:replacement,queryBatching:'single'}},[x,y],{credentials});}
  function connect(from,to,branch=0){w.connections[from]||={};w.connections[from].main||=[];while(w.connections[from].main.length<=branch)w.connections[from].main.push([]);w.connections[from].main[branch]=to?[{node:to,type:'main',index:0}]:[];}
  connect('Claim One Dispatch Ticket','Phase B Context');
  for(const name of ['Authorized Ticket Context','Response Ticket Context'])connect(name,'Claim One Dispatch Ticket');
  connect('One Capture Input','Capture Input');
  const releaseQuery='SELECT cbm_finish_dispatch_work($1::int,$2::uuid,$3::text,$4::jsonb->>\'outcome\') AS queue_result, $4::jsonb AS context;';
  const releaseInput='={{ [$("Claim One Dispatch Ticket").first().json.ticketId,$("Claim One Dispatch Ticket").first().json.leaseToken,String($execution.id),JSON.stringify($json.context)] }}';
  pg('Release Dispatch Claim',releaseQuery,releaseInput,3680,-300);
  pg('Release Incomplete Claim',releaseQuery,releaseInput,3680,-60);
  get('Dispatch Settled?').parameters.conditions.conditions[0].leftValue='={{ ["WAITING","ASSIGNED","ESCALATED","CLOSED","REJECTED","DUPLICATE","AWAITING_FM_AUTHORIZATION","WORK_DONE","PENDING_APPROVAL","REWORK"].includes($json.context.outcome) }}';
  connect('Dispatch Settled?','Release Dispatch Claim',0);
  connect('Record Incomplete Execution','Release Incomplete Claim');connect('Release Incomplete Claim','Operator Alert Needed?');
  rename(w,'Dispatch Queue Guide','Single Ticket Dispatch Guide');
  add('Single Ticket Dispatch Guide','n8n-nodes-base.stickyNote',{content:'## One ticket per execution\nFM approval and technician response events claim their exact ticket. The recovery timer claims one eligible ticket, least recently handled first (oldest creation time breaks ties). No batch, loop or dispatch self-call.\n\nThe database claim prevents overlapping dispatch for the same ticket. A busy ticket resumes through recovery. Each action tool remains bound to the claimed ticket.\n\nThe five-entry portfolio is a read-only overview, not a work batch. One Capture Input handles photos only.',height:330,width:560},[740,5300]);
  w.settings={...w.settings,executionTimeout:3600};
 }
 const operations={'Prepare Initial Dispatch':'initialize','Reserve Technician Offer':'offer_next','Claim Selected Notice':'send_notices','Apply Responses and Expiry':'process_events','Prepare Escalation':'escalate','Apply Gmail Receipt':'ack','Record Failure':'failure'};
 for(const n of w.nodes){
  if(n.name==='Return Current Context')n.parameters.query=sql.PUBLIC_RESULT;
  if(operations[n.name]){
   const i=n.parameters.jsCode.indexOf('\nconst input=');if(i<0)throw new Error('Unexpected operation source: '+n.name);
   n.parameters.jsCode=operationSource(operations[n.name])+n.parameters.jsCode.slice(i);
  }
  if(n.parameters.workflowId)n.parameters.source='database';
  n.parameters=JSON.parse(JSON.stringify(n.parameters).split('Radiator Technical Knowledge').join('Approved Asset Knowledge'));
 }
 return w;
}
module.exports={patch};
if(require.main===module){
 const app=path.resolve(process.argv[2]||path.join(__dirname,'../app'));
 const files=['wf1_ticket_intake_and_dispatch.json',...fs.readdirSync(path.join(app,'phase_b/workflows')).filter(x=>x.endsWith('.json')).map(x=>'phase_b/workflows/'+x)];
 for(const file of files){const p=path.join(app,file);fs.writeFileSync(p,JSON.stringify(patch(JSON.parse(fs.readFileSync(p,'utf8'))),null,2)+'\n');}
 console.log('Applied single-ticket dispatch, compact context and matching agent tools.');
}
