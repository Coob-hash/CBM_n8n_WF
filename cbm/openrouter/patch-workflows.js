'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {observationSchema,triageSchema,visionPrompt,resolvePrompt,providerSchema}=require('./contracts');
const {observationCode,triageCode}=require('./validators');
const models={vision:'google/gemini-3.1-flash-lite',reasoning:'google/gemini-3.8-flash'};
const defaultCredential={id:'cbmOpenRouterIstea20260916',name:'CBM OpenRouter - New Account'};
const knowledgePostgres={id:'cbmSupabasePgIsteaGroup1',name:'CBM Supabase Postgres - ISTEA_Group1'};
const knowledgeNodes=new Set(['Verify Selected Technical Sources','Demo - Check Existing Import','Demo - Publish Complete Document','Begin Knowledge Generation','Publish Complete Generation']);
function bindKnowledge(w){
 for(const n of w.nodes){
  if(knowledgeNodes.has(n.name))n.credentials={...n.credentials,postgres:knowledgePostgres};
  if(n.type==='@n8n/n8n-nodes-langchain.vectorStoreSupabase')n.credentials={...n.credentials,supabaseApi:{id:'vwpdbfFtXMR4D7Nh',name:'Supabase account 3'}};
 }
 return w;
}
function rename(w,from,to){
 const old=w.nodes.find(n=>n.name===from),existing=w.nodes.find(n=>n.name===to);
 if(old&&existing)w.nodes=w.nodes.filter(n=>n!==old);else if(old)old.name=to;
 if(w.connections[from]){w.connections[to]=w.connections[from];delete w.connections[from];}
 for(const out of Object.values(w.connections))for(const branches of Object.values(out))for(const branch of branches)for(const e of branch)if(e.node===from)e.node=to;
 for(const n of w.nodes)n.parameters=JSON.parse(JSON.stringify(n.parameters).split(from).join(to));
}
function visionBody(model){
 const template={model,temperature:1,max_tokens:4096,reasoning:{effort:'minimal',exclude:true},provider:{require_parameters:true},
  response_format:{type:'json_schema',json_schema:{name:'room_observations',strict:true,schema:providerSchema(observationSchema)}},
  messages:[{role:'system',content:visionPrompt}]};
 return '={{ JSON.stringify({...'+JSON.stringify(template)+',messages:[...'+JSON.stringify(template.messages)+', {role:"user",content:[{type:"text",text:"Describe this maintenance-report photograph."},{type:"image_url",image_url:{url:"data:image/jpeg;base64,"+$("Prepare Image & Metadata").first().json.imageB64,detail:"high"}}]}]}) }}';
}
function triageBody(){
 const template={model:models.reasoning,temperature:1,max_tokens:4096,reasoning:{effort:'low',exclude:true},provider:{require_parameters:true},
  response_format:{type:'json_schema',json_schema:{name:'asset_triage',strict:true,schema:providerSchema(triageSchema)}},messages:[{role:'system',content:resolvePrompt}]};
 return '={{ JSON.stringify({...'+JSON.stringify(template)+',messages:[...'+JSON.stringify(template.messages)+',{role:"user",content:JSON.stringify({observations:$("Validate Room Observations").first().json.vision,candidates:$("Find IFC Element").first().json.candidates})}]}) }}';
}
function patch(w,credential=defaultCredential){
 bindKnowledge(w);
 if(!w.nodes.some(n=>n.name==='Dispatch Agent'))return w;
 const native=require('./patch-native-triage');
 if(native.nativeVision(w)){
  rename(w,'Vision Triage (Claude)','Observe Room Image');rename(w,'Dispatch Claude Model','Dispatch OpenRouter Model');
  rename(w,'Resolve IFC and Triage','Match IFC Asset and Describe Issue');
  return native.patch(w,credential);
 }
 const get=name=>w.nodes.find(n=>n.name===name);
 rename(w,'Vision Triage (Claude)','Observe Room Image');rename(w,'Dispatch Claude Model','Dispatch OpenRouter Model');
 rename(w,'Resolve IFC and Triage','Match IFC Asset and Describe Issue');
 const removed=new Set(['Review Room Image','Validate Reviewed Observations','Review Clear?','Visual Evidence']);
 w.nodes=w.nodes.filter(n=>!removed.has(n.name));
 for(const name of removed)delete w.connections[name];
 for(const out of Object.values(w.connections))for(const channels of Object.values(out))for(let i=0;i<channels.length;i++)channels[i]=channels[i].filter(e=>!removed.has(e.node));
 const model=get('Dispatch OpenRouter Model');model.type='@n8n/n8n-nodes-langchain.lmChatOpenRouter';model.typeVersion=1;
 model.parameters={model:models.reasoning,options:{temperature:1,maxTokens:4096,timeout:90000,maxRetries:1}};
 model.credentials={openRouterApi:credential};
 const anchor=get('Observe Room Image').position;
 function upsert(name,type,parameters,offset,typeVersion=2,extra={}){
  let n=get(name);if(!n){n={id:crypto.createHash('md5').update('cbm-openrouter:'+name).digest('hex'),name,position:[anchor[0]+offset[0],anchor[1]+offset[1]]};w.nodes.push(n);}
  Object.assign(n,{type,typeVersion,parameters,...extra});return n;
 }
 function http(name,body,offset){return upsert(name,'n8n-nodes-base.httpRequest',{
  method:'POST',url:'https://openrouter.ai/api/v1/chat/completions',authentication:'predefinedCredentialType',nodeCredentialType:'openRouterApi',
  sendHeaders:true,headerParameters:{parameters:[{name:'Content-Type',value:'application/json'},{name:'X-Title',value:'ISTEA CBM room identification'}]},
  sendBody:true,specifyBody:'json',jsonBody:body,options:{timeout:90000}
 },offset,4.2,{credentials:{openRouterApi:credential},onError:'continueRegularOutput',retryOnFail:false});}
 function condition(name,offset){return upsert(name,'n8n-nodes-base.if',{conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict',version:1},combinator:'and',conditions:[{leftValue:'={{ $json.visionClear === true }}',rightValue:true,operator:{type:'boolean',operation:'true',singleValue:true}}]},options:{}},offset);}
 http('Observe Room Image',visionBody(models.vision),[0,0]);
 upsert('Validate Room Observations','n8n-nodes-base.code',{jsCode:observationCode()},[230,0]);
 condition('Vision Clear?',[460,0]);
 http('Match IFC Asset and Describe Issue',triageBody(),[690,0]);
 get('Parse Triage JSON').parameters.jsCode=triageCode();
 // Keep the familiar final validation and ticket-creation branches.
 function connect(from,to,branch=0){w.connections[from]||={};w.connections[from].main||=[];while(w.connections[from].main.length<=branch)w.connections[from].main.push([]);w.connections[from].main[branch]=[{node:to,type:'main',index:0}];}
 delete w.connections['Observe Room Image'];
 connect('IFC Candidates Available?','Observe Room Image');connect('Observe Room Image','Validate Room Observations');
 connect('Validate Room Observations','Vision Clear?');connect('Vision Clear?','Match IFC Asset and Describe Issue',0);connect('Vision Clear?','Classify Capture Failure',1);
 connect('Match IFC Asset and Describe Issue','Parse Triage JSON');
 upsert('Vision and Reasoning Guide','n8n-nodes-base.stickyNote',{content:'## Observe → validate → match and describe\nFlash-Lite reads the photo once. An unclear target or invalid output goes directly to the replacement-photo / IT escalation path. There is no second image model.\n\nA text-only Flash call matches clear observations to nearby IFC candidates and describes the visible issue. Code rejects invented IDs, inconsistent object types, unsupported faults and identification confidence below 0.70.\n\nSimilar assets without distinguishing evidence remain unresolved. Issue severity and technician skill are provisional; FM authorization is still required.',height:360,width:570},[0,-430],1);
 return w;
}
module.exports={patch,bindKnowledge,models,visionBody,triageBody,defaultCredential};
if(require.main===module){
 const app=path.resolve(process.argv[2]||path.join(__dirname,'../app'));
 const targets=fs.statSync(app).isFile()?[app]:Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname,'../imported-workflow-ids.json'),'utf8'))).map(f=>path.join(app,f));
 for(const target of targets)fs.writeFileSync(target,JSON.stringify(patch(JSON.parse(fs.readFileSync(target,'utf8'))),null,2)+'\n');
 console.log('Applied OpenRouter vision, text reasoning, output validation and ISTEA_Group1 knowledge bindings.');
}
