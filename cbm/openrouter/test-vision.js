'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {validateObservations,validateTriage}=require('./validators');
const {patch,visionBody,triageBody,models}=require('./patch-workflows');
const clone=x=>JSON.parse(JSON.stringify(x));
const result=value=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]});
const seen={image_quality:'good',room_summary:'An office wall with a close-up of a radiator.',target_ambiguous:false,primary_target_object_id:'o1',objects:[{id:'o1',object_type:'radiator',label:'white wall radiator',confidence:0.97,bbox:[0.2,0.1,0.85,0.9],visible_features:['White vertical fins','Two wall pipes'],readable_text:[],maintenance_evidence:[]}]};
const spatial={candidates:[{global_id:'EXACT-IFC-ID',ifc_class:'IfcBuildingElementProxy',name:'Radiator family'}]};
const loc={position:{x:1,y:2,z:3},confidence:0.93,mapCodes:['DEMO-MAP']};
const meta={reporterEmail:'reporter@example.com',photoUrl:'https://example.com/photo'};
const triage={identified:true,global_id:'EXACT-IFC-ID',visual_object_id:'o1',identification_confidence:0.94,identification_evidence:'Vertical finned radiator matches the sole radiator candidate.',ambiguous:false,fault_observed:false,category:'Radiator inspection',severity:1,description:'A wall radiator is visible.',required_skill:'plumbing'};
const passed=[];function test(name,fn){fn();passed.push(name);console.log('PASS '+name);}
test('Valid observations retain object type, bounded geometry and evidence',()=>{assert.equal(validateObservations(result(seen)).visionClear,true);});
test('Malformed, truncated, refused and failed provider results fail closed',()=>{
 for(const value of [{error:{message:'mock'}},{choices:[{finish_reason:'length',message:{content:'{}'}}]},{choices:[{finish_reason:'stop',message:{content:'{}',refusal:'refused'}}]},{choices:[{finish_reason:'stop',message:{content:'```json\n{}\n```'}}]}])assert.equal(validateObservations(value).visionClear,false);
});
test('Invalid bounding boxes, duplicate IDs and oversized lists are rejected',()=>{
 for(const mutate of [v=>v.objects[0].bbox=[0.8,0.1,0.2,0.9],v=>v.objects.push(clone(v.objects[0])),v=>v.objects[0].bbox[0]=-0.1,v=>v.objects[0].visible_features=Array(7).fill('x'),v=>v.untrusted_extra='override']){const v=clone(seen);mutate(v);assert.equal(validateObservations(result(v)).visionValid,false);}
});
test('Unclear target, unusable image and low confidence require another photo',()=>{
 for(const mutate of [v=>{v.target_ambiguous=true;v.primary_target_object_id=null;},v=>v.image_quality='unusable',v=>v.objects[0].confidence=0.84]){const v=clone(seen);mutate(v);const r=validateObservations(result(v));assert.equal(r.visionClear,false);}
});
test('Several objects in a wide room cannot be accepted merely on model confidence',()=>{
 const v=clone(seen);v.objects[0].bbox=[0.5,0.3,0.76,0.76];
 v.objects.push({...clone(v.objects[0]),id:'o2',object_type:'chair',bbox:[0,0.5,0.34,0.9]},{...clone(v.objects[0]),id:'o3',object_type:'electrical_outlet',bbox:[0.39,0.63,0.44,0.67]});
 const r=validateObservations(result(v));assert.equal(r.visionValid,true);assert.equal(r.visionClear,false);assert.equal(r.reason,'TARGET_FRAMING_UNCLEAR');
});
test('Exact IFC candidate and visual object resolve without inventing a fault',()=>{
 const r=validateTriage(result(triage),seen,spatial,loc,meta);assert.equal(r.triageValid,true);assert.equal(r.element.global_id,'EXACT-IFC-ID');assert.equal(r.category,'Inspection requested');assert.equal(r.severity,1);assert.match(r.description,/No fault can be established/);
});
test('Invented IDs, wrong visual targets, ambiguity and insufficient evidence are rejected',()=>{
 for(const mutate of [t=>t.global_id='INVENTED',t=>t.visual_object_id='o2',t=>t.ambiguous=true,t=>t.identification_confidence=0.69,t=>t.identification_evidence='yes']){const t=clone(triage);mutate(t);assert.equal(validateTriage(result(t),seen,spatial,loc,meta).triageValid,false);}
});
test('Identification confidence accepts the 70 percent boundary',()=>{
 assert.equal(validateTriage(result({...triage,identification_confidence:0.70}),seen,spatial,loc,meta).triageValid,true);
});
test('Multiple matches, IFC/visual type mismatch and invalid VPS pose fail validation',()=>{
 assert.equal(validateTriage(result(triage),seen,{candidates:[...spatial.candidates,...spatial.candidates]},loc,meta).triageValid,false);
 assert.equal(validateTriage(result(triage),seen,{candidates:[{...spatial.candidates[0],ifc_class:'IfcDoor'}]},loc,meta).reason,'IFC_VISUAL_TYPE_MISMATCH');
 assert.equal(validateTriage(result(triage),seen,spatial,{position:{x:'1',y:2,z:3},confidence:1},meta).triageValid,false);
});
test('Text reasoning cannot introduce a fault unsupported by the observation evidence',()=>{
 assert.equal(validateTriage(result({...triage,fault_observed:true,description:'Broken leaking radiator',severity:5}),seen,spatial,loc,meta).reason,'UNSUPPORTED_FAULT_CLAIM');
});
test('Workflow metadata cannot be replaced by extra model output fields',()=>{
 assert.equal(validateTriage(result({...triage,reporterEmail:'attacker@example.com'}),seen,spatial,loc,meta).triageValid,false);
});
test('Vision and resolution requests use strict JSON schemas and separate image/text inputs',()=>{
 const dollar=name=>({first:()=>({json:name==='Prepare Image & Metadata'?{imageB64:'SYNTHETIC'}:name==='Validate Room Observations'?{vision:seen}:spatial})});
 const evaluate=expression=>JSON.parse(new Function('$','return ('+expression.slice(3,-2).trim()+')')(dollar));
 const v=evaluate(visionBody(models.vision)),t=evaluate(triageBody());
 assert.equal(v.messages[1].content[1].image_url.url,'data:image/jpeg;base64,SYNTHETIC');assert.equal(t.response_format.json_schema.strict,true);assert.ok(!JSON.stringify(t).includes('base64'));assert.ok(JSON.parse(t.messages[1].content).observations);
});
test('Overlay is idempotent; unclear vision goes directly to capture failure without a second image call',()=>{
 const original=JSON.parse(fs.readFileSync(path.join(__dirname,'../app/wf1_ticket_intake_and_dispatch.json'),'utf8'));
 const once=patch(clone(original)),twice=patch(clone(once));assert.deepEqual(twice,once);
 const names=new Set(once.nodes.map(n=>n.name));assert.equal(names.size,once.nodes.length);
 for(const [from,out] of Object.entries(once.connections)){assert.ok(names.has(from));for(const channels of Object.values(out))for(const list of channels)for(const edge of list)assert.ok(names.has(edge.node),edge.node);}
 assert.equal(once.connections['Vision Clear?'].main[1][0].node,'Classify Capture Failure');
 assert.equal(once.connections['Vision Clear?'].main[0][0].node,'Match IFC Asset and Describe Issue');
 for(const name of ['Review Room Image','Validate Reviewed Observations','Review Clear?','Visual Evidence','Resolve IFC and Triage'])assert.ok(!names.has(name));
 const httpImages=once.nodes.filter(n=>n.parameters.jsonBody?.includes('image_url')).length;
 const chainImages=once.nodes.filter(n=>n.parameters.messages?.messageValues?.some(m=>m.messageType==='imageUrl')).length;
 assert.equal(httpImages+chainImages,1);
 const observe=once.nodes.find(n=>n.name==='Observe Room Image');
 if(observe)assert.equal(observe.retryOnFail,false);else assert.ok(once.nodes.find(n=>n.name==='Inspect the Asset'));
 assert.ok(once.nodes.find(n=>n.name==='Parse Triage JSON').parameters.jsCode.includes("$('Validate Room Observations')"));
 const model=once.nodes.find(n=>n.name==='Dispatch OpenRouter Model')||once.nodes.find(n=>n.name==='Vision');
 assert.equal(model.type,'@n8n/n8n-nodes-langchain.lmChatOpenRouter');
 for(const n of once.nodes)if(n.parameters.jsCode)new (Object.getPrototypeOf(async function(){}).constructor)(n.parameters.jsCode);
});
fs.writeFileSync(path.join(__dirname,'../../validation-single-ticket/vision-tests.json'),JSON.stringify({passed,liveModelCalls:0,notes:'Deterministic contract/graph tests; these do not guarantee visual accuracy.'},null,2)+'\n');
console.log(passed.length+' vision/model tests passed.');
