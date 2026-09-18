'use strict';
// Run only on explicit setup/validation, with a temporary n8n credential export.
// No emails, tickets, IFC updates or embeddings are produced by this benchmark.
const fs=require('fs'),path=require('path');
const {visionBody,triageBody,models}=require('./patch-workflows');
const {validateObservations,validateTriage}=require('./validators');
const credentialFile=process.argv[2],photoDir=process.argv[3],outputFile=process.argv[4];
if(!credentialFile||!photoDir||!outputFile)throw Error('Usage: benchmark.js credential-export.json photos-directory output.json');
const results={startedAt:new Date().toISOString(),models,calls:[],notes:'Small live smoke test. IFC candidates and pose are synthetic; this does not validate MultiSet registration or overall recognition accuracy.'};
let apiKey;
function expression(body,values){return JSON.parse(new Function('$','return ('+body.slice(3,-2).trim()+')')(name=>({first:()=>({json:values[name]})})));}
async function request(name,body){
 const start=Date.now();
 const response=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json','X-Title':'ISTEA CBM validation'},body:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
 const data=await response.json();
 const row={name,model:body.model,httpStatus:response.status,durationMs:Date.now()-start,usage:data.usage,response:data};results.calls.push(row);
 console.log(JSON.stringify({name,httpStatus:response.status,durationMs:row.durationMs,error:data.error?.message}));
 return {data,row};
}
(async()=>{
 try{
  apiKey=JSON.parse(fs.readFileSync(credentialFile,'utf8'))[0].data.apiKey;
  const visionResults={};
  for(const name of ['IMG_7911.jpg','IMG_7914.jpg','IMG_7918.jpg']){
   const values={'Prepare Image & Metadata':{imageB64:fs.readFileSync(path.join(photoDir,name)).toString('base64')}};
   const r=await request('observe:'+name,expression(visionBody(models.vision),values));
   const v=validateObservations(r.data);r.row.validation=v;
   visionResults[name]=v;
   console.log(JSON.stringify({photo:name,visionValid:v.visionValid,visionClear:v.visionClear,types:v.vision?.objects.map(o=>o.object_type),ambiguous:v.vision?.target_ambiguous}));
  }
  for(const [name,expectedType] of [['IMG_7911.jpg','radiator'],['IMG_7914.jpg','electrical_outlet']]){
   const vision=visionResults[name];if(!vision.visionClear)continue;
   const spatial={candidates:[{global_id:'SYNTHETIC-RADIATOR',ifc_class:'IfcBuildingElementProxy',name:'Wall radiator'},{global_id:'SYNTHETIC-OUTLET',ifc_class:'IfcOutlet',name:'Wall electrical outlet'}]};
   const body=expression(triageBody(),{'Validate Room Observations':{vision:vision.vision},'Find IFC Element':spatial});
   const r=await request('resolve:'+name,body);
   r.row.validation=validateTriage(r.data,vision.vision,spatial,{position:{x:1,y:2,z:3},confidence:0.95,mapCodes:['SYNTHETIC-MAP']},{reporterEmail:'validation@example.com',photoUrl:'synthetic://'+name});
   r.row.expectedType=expectedType;
  }
  const tool=await request('dispatch-tool-call',{model:models.reasoning,temperature:1,max_tokens:1024,messages:[{role:'system',content:'This is an isolated tool compatibility test. Call get_context once with overview_page=0. Do not perform any other action.'},{role:'user',content:'Read the bound ticket context.'}],tools:[{type:'function',function:{name:'get_context',description:'Read one bound maintenance ticket and its overview.',parameters:{type:'object',properties:{overview_page:{type:'integer',minimum:0}},required:['overview_page'],additionalProperties:false}}}],tool_choice:{type:'function',function:{name:'get_context'}}});
  const calls=tool.data.choices?.[0]?.message?.tool_calls||[];
  tool.row.toolCompatible=calls.length===1&&calls[0].function?.name==='get_context'&&JSON.parse(calls[0].function.arguments).overview_page===0;
  results.totalCost=results.calls.reduce((sum,r)=>sum+(r.usage?.cost||0),0);
 }finally{
  fs.writeFileSync(outputFile,JSON.stringify(results,null,2)+'\n');
  fs.rmSync(credentialFile,{force:true});
 }
})().catch(e=>{console.error(e.code||e.name);process.exitCode=1;});
