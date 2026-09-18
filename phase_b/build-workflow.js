'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sql = require('./queries');
const root = path.resolve(__dirname, '..');
const workflowPath = path.join(root,'wf1_ticket_intake_and_dispatch.json');
const backupPath = path.join(__dirname,'original_wf1.json');
const originalHash = '7E983D13825F60005D6822F0BCD766D29369EAD21B817AEB3A43487BE6F640CB';
if (!fs.existsSync(backupPath)) {
  const bytes = fs.readFileSync(workflowPath);
  if (crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase() !== originalHash) throw new Error('WF1 differs from reviewed source; refusing to overwrite it.');
  fs.writeFileSync(backupPath,bytes);
}
if (crypto.createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex').toUpperCase() !== originalHash) throw new Error('Original backup fingerprint mismatch.');
const original = JSON.parse(fs.readFileSync(backupPath,'utf8'));
const current = JSON.parse(fs.readFileSync(workflowPath,'utf8'));
for (const n of original.nodes.slice(0,15)) {
  if (JSON.stringify(current.nodes.find(x=>x.name===n.name))!==JSON.stringify(n)
    || JSON.stringify(current.connections[n.name])!==JSON.stringify(original.connections[n.name])) {
    throw new Error('A preserved Phase A node/connection changed; refusing to overwrite: '+n.name);
  }
}
const deploymentPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname,'deployment.example.json');
const config = JSON.parse(fs.readFileSync(deploymentPath,'utf8'));
for(const [key,value] of Object.entries(config)) {
  if(key.endsWith('CredentialId') && typeof value==='string' && value.endsWith('.apps.googleusercontent.com'))
    throw new Error(key+' must be an internal n8n credential ID, not a Google OAuth client ID.');
}
// Preserve old private deployment files; merge current credential references without rewriting them.
config.knowledge={...JSON.parse(fs.readFileSync(path.join(__dirname,'deployment.example.json'),'utf8')).knowledge,...config.knowledge};
const systemMessage = fs.readFileSync(path.join(__dirname,'system-message.txt'),'utf8');
const id = name => crypto.createHash('sha256').update(`cbm-phase-b:${name}`).digest('hex').slice(0,32);
const pgCred = {postgres:{id:config.postgresCredentialId,name:config.postgresCredentialName}};
const gmailCred = {gmailOAuth2:{id:config.gmailCredentialId,name:config.gmailCredentialName}};
function node(name,type,parameters,x=0,y=0,version=1,extra={}) { return {parameters,id:id(name),name,type,typeVersion:version,position:[x,y],...extra}; }
function code(name,jsCode,x=0,y=0) {return node(name,'n8n-nodes-base.code',{jsCode},x,y,2);}
function pg(name,query,params,x=0,y=0,transaction=false) {return node(name,'n8n-nodes-base.postgres',{operation:'executeQuery',query,options:{queryReplacement:params,queryBatching:transaction?'transaction':'single'}},x,y,2.6,{credentials:pgCred});}
function condition(name,expression,x=0,y=0) {return node(name,'n8n-nodes-base.if',{conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict'},conditions:[{id:id(name+':condition'),leftValue:expression,rightValue:true,operator:{type:'boolean',operation:'true',singleValue:true}}],combinator:'and'},options:{}},x,y,2);}
function connect(connections,from,to,output=0,type='main') {
  connections[from] ||= {}; connections[from][type] ||= [];
  while(connections[from][type].length<=output) connections[from][type].push([]);
  connections[from][type][output].push({node:to,type,index:0});
}
const knowledge = require('../knowledge/nodes').knowledgeNodes({config,node,code,pg,condition,connect,id});
const saved = require('./saved-workflows').buildSavedWorkflows({config,node,code,pg,condition,connect,id,knowledge});
const execute=saved.execute;
const w = structuredClone(original);
const preserved = new Set(original.nodes.slice(0,15).map(n=>n.name));
w.nodes = original.nodes.slice(0,15);
w.connections = Object.fromEntries(Object.entries(original.connections).filter(([name])=>preserved.has(name)));
const c=w.connections;
const add=n=>w.nodes.push(n);
add(code('Create Ticket',"const triage=$input.first().json;\nconst sourceKey=String($('Drive Trigger - New Snapshot').first().json.id || '');\nif(!sourceKey) throw new Error('Drive source ID is required for idempotent ticket creation.');\nif(!triage.element?.global_id || !triage.position || ![triage.position.x,triage.position.y,triage.position.z,triage.confidence].every(Number.isFinite)) throw new Error('Phase B requires valid localization.');\nif(!Number.isInteger(triage.severity) || triage.severity<1 || triage.severity>5 || !['carpentry','plumbing','electrical','hvac','general'].includes(triage.required_skill)) throw new Error('Invalid Phase A triage contract.');\nreturn [{json:{sourceKey,triage,ticketId:null}}];",2040,-280));
add(code('Phase B Context',`const config=${JSON.stringify(config,null,2)};\nif(!config.callbackBase.startsWith('https://') || config.callbackBase.includes('REPLACE') || config.fmEmail.includes('REPLACE')) throw new Error('Configure Phase B deployment values before activating WF1.');\nconst input=$input.first().json;\nreturn [{json:{sourceKey:input.sourceKey||null,ticketId:input.ticketId||null,triage:input.triage||null,config}}];`,2260,-280));
add(pg('Read Dispatch Memory',sql.PUBLIC_CONTEXT,'={{ [JSON.stringify($("Phase B Context").first().json)] }}',2480,-280));
add(node('Dispatch Agent','@n8n/n8n-nodes-langchain.agent',{promptType:'define',text:'={{ "Process this maintenance dispatch event. Current ticket facts follow. Decide which tools to use to complete the dispatch objectives. " + JSON.stringify($json.context) }}',options:{systemMessage,maxIterations:24,returnIntermediateSteps:false,passthroughBinaryImages:false}},2700,-280,2,{onError:'continueRegularOutput'}));
add(node('Dispatch Claude Model','@n8n/n8n-nodes-langchain.lmChatAnthropic',{model:{__rl:true,value:config.model,mode:'id'},options:{temperature:0,maxTokensToSample:2000}},2640,-20,1.3,{credentials:{anthropicApi:{id:config.anthropicCredentialId,name:config.anthropicCredentialName}}}));
add(pg('Verify Committed Outcome',sql.PUBLIC_CONTEXT,'={{ [JSON.stringify($("Phase B Context").first().json)] }}',3000,-280));
add(condition('Dispatch Settled?','={{ ["WAITING","ASSIGNED","ESCALATED"].includes($json.context.outcome) }}',3220,-280));
add(execute('Record Incomplete Execution','failure',3440,-60));
add(condition('Operator Alert Needed?','={{ ["OPERATOR_ACTION_REQUIRED","NO_TICKET","UNINITIALIZED"].includes($json.context.outcome) }}',3660,-60));
add(node('Notify FM - Dispatch Error','n8n-nodes-base.gmail',{resource:'message',operation:'send',sendTo:config.fmEmail,subject:'={{ "[CBM] Dispatch requires attention - ticket " + ($json.context?.ticket_id || "not yet initialized") }}',emailType:'text',message:'={{ "Automatic dispatch needs operator attention. Inspect the failed WF1 execution and its tool receipts before retrying any email. " + JSON.stringify($json) }}',options:{appendAttribution:false}},3880,100,2.1,{credentials:gmailCred,onError:'continueRegularOutput',retryOnFail:false}));
add(node('Phase B Needs Attention','n8n-nodes-base.stopAndError',{errorType:'errorMessage',errorMessage:'={{ "Phase B incomplete: " + JSON.stringify($("Record Incomplete Execution").first().json) + ". Persisted dispatches retry up to three times; uninitialized tickets and uncertain Gmail delivery require operator action." }}'},4100,-60,1));
add(pg('Read Knowledge Identity',require('../knowledge/nodes').IDENTITY,'={{ [JSON.stringify($("Phase B Context").first().json),JSON.stringify($json.context)] }}',2580,-400));
add(knowledge.tool);add(knowledge.embedding);
connect(c,'OpenAI Embeddings - Retrieval','Radiator Technical Knowledge',0,'ai_embedding');
connect(c,'Radiator Technical Knowledge','Dispatch Agent',0,'ai_tool');
connect(c,'Create Ticket','Phase B Context');connect(c,'Phase B Context','Read Dispatch Memory');connect(c,'Read Dispatch Memory','Read Knowledge Identity');connect(c,'Read Knowledge Identity','Dispatch Agent');
connect(c,'Dispatch Claude Model','Dispatch Agent',0,'ai_languageModel');connect(c,'Dispatch Agent','Verify Committed Outcome');connect(c,'Verify Committed Outcome','Dispatch Settled?');
connect(c,'Dispatch Settled?','Record Incomplete Execution',1);connect(c,'Record Incomplete Execution','Operator Alert Needed?');
connect(c,'Operator Alert Needed?','Notify FM - Dispatch Error');connect(c,'Operator Alert Needed?','Phase B Needs Attention',1);connect(c,'Notify FM - Dispatch Error','Phase B Needs Attention');
// Simple operations use native Postgres AI tools directly.
for(const [name,query,description,x] of [
  ['create_ticket',sql.CREATE,'Create or recover the current ticket using fixed parameterized SQL. Returns its ID. Source identity and validated triage are bound by WF1. If dispatch is uninitialized, initialize it using the separate tool.',2200],
  ['get_context',sql.PUBLIC_CONTEXT,'Read authoritative ticket facts, shortlist order, offers, deadlines, response counts and pending notice keys. No chat history, secret tokens, email bodies or prescribed tool sequence is returned.',2380]
]) {
  const tool=pg(name,query,'={{ [JSON.stringify($("Phase B Context").first().json)] }}',x,280,name==='create_ticket');
  tool.type='n8n-nodes-base.postgresTool';
  tool.parameters.descriptionType='manual';tool.parameters.toolDescription=description;
  add(tool);connect(c,name,'Dispatch Agent',0,'ai_tool');
}
for(const tool of saved.tools){add(tool);connect(c,tool.name,'Dispatch Agent',0,'ai_tool');}
add(node('Phase B Recovery Tick','n8n-nodes-base.scheduleTrigger',{rule:{interval:[{field:'minutes',minutesInterval:1}]}},2040,700,1.2));
add(pg('Find Due Dispatch',sql.DUE,'={{ [] }}',2260,700));
add(code('Recovery Ticket Context','return [{json:{ticketId:$json.ticket_id}}];',2480,700));
connect(c,'Phase B Recovery Tick','Find Due Dispatch');connect(c,'Find Due Dispatch','Recovery Ticket Context');connect(c,'Recovery Ticket Context','Phase B Context');

// GET renders a confirmation form. POST records a response before any LLM invocation.
for(const method of ['GET','POST']) {
  const title=method==='GET'?'Offer Confirmation Page':'Offer Response Submission';
  add(node(title,'n8n-nodes-base.webhook',{httpMethod:method,path:'cbm-wf1-offer',responseMode:'responseNode',options:{}},2040,method==='GET'?1060:1480,2,{webhookId:id(title+':webhook')}));
  const normalize=title+' Input';
  add(code(normalize,`const p=$json.${method==='GET'?'query':'body'}||{};\nconst valid=/^[1-9][0-9]{0,8}$/.test(String(p.ticket||'')) && /^[a-f0-9-]{36}$/.test(String(p.offer||'')) && /^[a-f0-9]{64}$/.test(String(p.token||'')) && ['accept','deny'].includes(p.decision);\nreturn [{json:{valid,ticket:valid?Number(p.ticket):0,offer:valid?p.offer:'',token:valid?p.token:'',decision:valid?p.decision:'invalid'}}];`,2260,method==='GET'?1060:1480));
  connect(c,title,normalize);
  const queryName=method==='GET'?'Check Offer Link':'Record Offer Response';
  add(pg(queryName,method==='GET'?sql.CHECK_OFFER:sql.RECORD_RESPONSE,'={{ [$json.ticket,$json.offer,$json.token,$json.decision] }}',2480,method==='GET'?1060:1480,method==='POST'));
  connect(c,normalize,queryName);
  if(method==='GET') {
    add(code('Build Confirmation Form',`const p=$('${normalize}').first().json;\nconst valid=$json.check_result?.valid===true;\nconst html=valid ? '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Confirm maintenance response</title></head><body><h1>Confirm '+p.decision+'</h1><p>Ticket #'+p.ticket+'. No assignment is made until your acceptance is processed.</p><form method="post"><input type="hidden" name="ticket" value="'+p.ticket+'"><input type="hidden" name="offer" value="'+p.offer+'"><input type="hidden" name="token" value="'+p.token+'"><input type="hidden" name="decision" value="'+p.decision+'"><button type="submit">Confirm '+p.decision+'</button></form></body></html>' : '<h1>Offer unavailable</h1><p>This link is invalid, expired, or the job has already been assigned.</p>';\nreturn [{json:{html,statusCode:valid?200:410}}];`,2700,1060));
    add(node('Show Confirmation','n8n-nodes-base.respondToWebhook',{respondWith:'text',responseBody:'={{ $json.html }}',options:{responseCode:'={{ $json.statusCode }}',responseHeaders:{entries:[{name:'Content-Type',value:'text/html; charset=utf-8'},{name:'Cache-Control',value:'no-store'},{name:'Referrer-Policy',value:'no-referrer'}]}}},2920,1060,1.4));
    connect(c,queryName,'Build Confirmation Form');connect(c,'Build Confirmation Form','Show Confirmation');
  } else {
    add(code('Response Receipt',"const result=$input.all().map(i=>i.json.response_result).find(Boolean);\nif(!result) throw new Error('Response receipt missing');\nreturn [{json:{...result,message:result.recorded?'Response received. Assignment is confirmed separately by email.':'This response is already recorded, invalid, or expired.'}}];",2700,1480));
    add(node('Acknowledge Response','n8n-nodes-base.respondToWebhook',{respondWith:'text',responseBody:'={{ $json.message }}',options:{responseCode:200,responseHeaders:{entries:[{name:'Cache-Control',value:'no-store'}]}}},2920,1480,1.4));
    add(condition('New Response?','={{ $json.recorded === true }}',3140,1480));
    add(code('Response Ticket Context','return [{json:{ticketId:$json.ticket_id}}];',3360,1480));
    connect(c,queryName,'Response Receipt');connect(c,'Response Receipt','Acknowledge Response');connect(c,'Acknowledge Response','New Response?');connect(c,'New Response?','Response Ticket Context');connect(c,'Response Ticket Context','Phase B Context');
  }
}
add(node('Note 2260x-120','n8n-nodes-base.stickyNote',{content:'## Phase B — Agent Dispatch\nNative Postgres tools plus saved dispatch sub-workflows. No embedded workflow JSON. The agent chooses calls from current facts; policy guards enforce dispatch rules.\nOrdinary: one live offer, 48 hours. Urgent (severity ≥4): up to two live offers, expiry=min(48 hours, appointment start). First valid acceptance wins.\nResponses are confirmed by POST and persisted before the agent runs. Recovery checks run every minute without LLM calls while nothing is due.\nImport and publish helpers from phase_b/workflows, bind their IDs, then import WF1. See phase_b/README.md. Phase A is preserved.',width:1100,height:230,color:4},2260,-650));
// n8n serves HTML in a sandboxed iframe; a form needs an absolute action URL.
const formNode=w.nodes.find(n=>n.name==='Build Confirmation Form');
const action=new URL(config.callbackBase.replace(/\/$/,'')+'/cbm-wf1-offer').href;
formNode.parameters.jsCode=formNode.parameters.jsCode.replace('<form method="post">','<form method="post" action="'+action+'">');
require('./review-additions')({w,config,node,code,pg,condition,connect,id});
fs.writeFileSync(workflowPath,JSON.stringify(w,null,2)+'\n');
require('../demo_ingestion/build');
fs.writeFileSync(path.join(root,'knowledge','sync_workflow.json'),JSON.stringify(knowledge.workflow,null,2)+'\n');
const helpersPath=path.join(__dirname,'workflows');
fs.mkdirSync(helpersPath,{recursive:true});
for(const [operation,workflow] of Object.keys(saved.definitions).map((op,i)=>[op,saved.workflows[i]])) {
  if(fs.existsSync(path.join(root,'technician_portal/apply.cjs')))require('../technician_portal/apply.cjs').apply(workflow);
  fs.writeFileSync(path.join(helpersPath,operation+'.json'),JSON.stringify(workflow,null,2)+'\n');
}
fs.writeFileSync(path.join(__dirname,'workflow-manifest.json'),JSON.stringify({
  main:'../wf1_ticket_intake_and_dispatch.json',
  knowledgeSync:'../knowledge/sync_workflow.json',
  workflowIds:saved.workflowIds,
  helpers:Object.entries(saved.definitions).map(([operation,[name]])=>({operation,name,id:saved.workflowIds[operation],file:'workflows/'+operation+'.json'})),
  production:'Import helpers first; verify or rebind IDs and publish them. Then import/review/publish WF1.'
},null,2)+'\n');
console.log(`Updated WF1: ${preserved.size} Phase A nodes preserved; native Supabase knowledge tool, 2 Postgres tools and 5 saved-workflow tools. Generated ${saved.workflows.length} helpers and the knowledge sync workflow.`);
module.exports={workflow:w,helpers:saved.workflows};
