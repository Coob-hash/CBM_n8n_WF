'use strict';
const crypto=require('node:crypto');
const {triageSchema,resolvePrompt}=require('./contracts');
const {triageCode}=require('./validators');
const chainType='@n8n/n8n-nodes-langchain.chainLlm';
const stageName='Match IFC Asset and Describe Issue';
function nativeVision(w){
 return w.nodes.find(n=>n.type===chainType&&n.parameters.messages?.messageValues?.some(m=>['imageUrl','imageBinary'].includes(m.messageType)));
}
function patch(w,credential){
 const get=name=>w.nodes.find(n=>n.name===name);
 const vision=nativeVision(w);if(!vision)throw Error('Native observation chain not found');
 const rename=(node,name)=>{
  const old=node.name;if(old===name)return;
  if(get(name))throw Error('Duplicate node name: '+name);
  node.name=name;
  if(w.connections[old]){w.connections[name]=w.connections[old];delete w.connections[old];}
  for(const out of Object.values(w.connections))for(const lists of Object.values(out))for(const edges of lists)for(const e of edges)if(e.node===old)e.node=name;
 };
 let stage=get(stageName);
 const draft=get('Basic LLM Chain1');
 if(stage?.type!==chainType&&draft?.type===chainType){
  // Reuse the second chain the user already placed on the canvas.
  w.nodes=w.nodes.filter(n=>n!==stage);delete w.connections[stageName];
  stage=draft;rename(stage,stageName);
 }
 if(!stage)throw Error('IFC matching stage not found');
 const oldCredential=stage.credentials?.openRouterApi||credential;
 stage.type=chainType;stage.typeVersion=1.9;
 stage.parameters={promptType:'define',
  text:'={{ JSON.stringify({observations:$("Validate Room Observations").first().json.vision,candidates:$("Find IFC Element").first().json.candidates}) }}',
  hasOutputParser:true,messages:{messageValues:[{type:'SystemMessagePromptTemplate',message:resolvePrompt}]},batching:{batchSize:1}};
 stage.onError='continueRegularOutput';stage.retryOnFail=false;delete stage.credentials;
 function attached(type){return w.nodes.filter(n=>w.connections[n.name]?.[type]?.some(list=>list.some(e=>e.node===stageName)));}
 function add(name,type,typeVersion,parameters,offset,extra={}){
  const n={name,id:crypto.createHash('md5').update('cbm-native-triage:'+name).digest('hex'),type,typeVersion,parameters,
   position:[stage.position[0]+offset[0],stage.position[1]+offset[1]],...extra};w.nodes.push(n);return n;
 }
 const models=attached('ai_languageModel');if(models.length>1)throw Error('More than one triage model is attached');
 const model=models[0]||add('OpenRouter Triage Model','@n8n/n8n-nodes-langchain.lmChatOpenRouter',1,
  {model:'google/gemini-3.8-flash',options:{temperature:1,responseFormat:'text',maxTokens:4096,timeout:90000,maxRetries:0}},[0,208],{credentials:{openRouterApi:oldCredential}});
 const parsers=attached('ai_outputParser');if(parsers.length>1)throw Error('More than one triage parser is attached');
 const parser=parsers[0]||add('Triage Output Parser','@n8n/n8n-nodes-langchain.outputParserStructured',1.3,{},[224,208]);
 rename(parser,'Triage Output Parser');
 parser.type='@n8n/n8n-nodes-langchain.outputParserStructured';parser.typeVersion=1.3;
 parser.parameters={schemaType:'manual',inputSchema:JSON.stringify(triageSchema,null,2),autoFix:false};
 parser.notes='Triage JSON schema: the output contract for IFC matching and issue classification. This differs from the observation schema on the image chain.';
 const edge=(from,to,type='main',branch=0)=>{
  w.connections[from]||={};w.connections[from][type]||=[];
  while(w.connections[from][type].length<=branch)w.connections[from][type].push([]);
  w.connections[from][type][branch]=[{node:to,type,index:0}];
 };
 edge(model.name,stageName,'ai_languageModel');edge(parser.name,stageName,'ai_outputParser');
 edge('IFC Candidates Available?',vision.name);edge(vision.name,'Validate Room Observations');
 edge('Validate Room Observations','Vision Clear?');edge('Vision Clear?',stageName);edge('Vision Clear?','Classify Capture Failure','main',1);
 edge(stageName,'Parse Triage JSON');edge('Parse Triage JSON','Triage Valid?');
 get('Parse Triage JSON').parameters.jsCode=triageCode({chain:true});
 return w;
}
module.exports={patch,nativeVision};
