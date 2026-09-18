import fs from 'node:fs';
import assert from 'node:assert/strict';
import dispatch from '../app/phase_b/operations.js';
const workflow=JSON.parse(fs.readFileSync(new URL('../app/wf1_ticket_intake_and_dispatch.json',import.meta.url),'utf8'));
const nodes=Object.fromEntries(workflow.nodes.map(n=>[n.name,n]));
assert.equal(new Set(workflow.nodes.map(n=>n.id)).size,workflow.nodes.length);
assert.ok(workflow.nodes.every(n=>n.id));
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const run=async(name,input,prior={})=>new AsyncFunction('$input','$','$json',nodes[name].parameters.jsCode)(
 {first:()=>({json:input})},name=>({first:()=>({json:prior[name]})}),input);
for(const n of workflow.nodes){
 if(n.type==='n8n-nodes-base.code')new AsyncFunction(n.parameters.jsCode);
 for(const outputs of Object.values(workflow.connections[n.name]||{}))for(const edges of outputs)for(const e of edges)assert.ok(nodes[e.node],e.node);
}
assert.ok(!nodes['FM Resume Ticket']);assert.ok(!nodes['Create Triage Ticket']);
assert.equal(nodes['Process Each Drive Capture'].parameters.mode,'each');
assert.equal(workflow.connections['Create Ticket'].main[0][0].node,'Submit Ticket for FM Authorization');
const uuid='12345678-1234-1234-1234-123456789abc';
let r=await run('Capture Input',{id:'driveA',name:`report_user@test.invalid_${uuid}_IMG_7911.jpg`});
assert.equal(r[0].json.report_id,uuid);
await assert.rejects(run('Capture Input',{id:'A',name:'badfilename.jpg'}));
const candidate={global_id:'3kcZF9AH16IwPfuL_CGFlR',name:'radiator',ifc_class:'IfcBuildingElementProxy'};
const prior={'MultiSet - Localize Snapshot':{position:{x:0,y:0,z:0},confidence:0.9,mapCodes:['MAP_J964JX6MGEGO']},
 'Find IFC Element':{candidates:[candidate]},'Prepare Image & Metadata':{reporterEmail:'user@test.invalid',photoUrl:'https://drive.test.invalid/A'}};
const triage={identified:true,ambiguous:false,global_id:candidate.global_id,identification_confidence:0.9,
 identification_evidence:'Visible radiator matches the only radiator candidate',category:'heating',severity:2,description:'Visible radiator, no invented fault',required_skill:'hvac'};
const parse=async v=>(await run('Parse Triage JSON',{content:[{type:'text',text:JSON.stringify(v)}]},prior))[0].json;
assert.equal((await parse(triage)).triageValid,true);
for(const change of [{global_id:'invented'},{identified:false},{ambiguous:true},{identification_confidence:0.79},{identification_confidence:1.1},{identification_evidence:''},{severity:0},{required_skill:'invented'}])
 assert.equal((await parse({...triage,...change})).triageValid,false,JSON.stringify(change));
const input={ticket:'1',authorization:uuid,token:'a'.repeat(64)};
let page=await run('Build Intervention Authorization Form',{authorization:{ticket_id:1,ifc_name:'<script>alert(1)</script>',description:'<img src=x onerror=x>',severity:3}},
 {'View Intervention Authorization Input':input});
assert.ok(!page[0].json.html.includes('<script>'));assert.ok(!page[0].json.html.includes('<img '));
assert.ok(page[0].json.html.includes('method="post"'));
assert.ok(!nodes['Read Intervention Authorization'].parameters.query.match(/\b(UPDATE|INSERT|DELETE)\b/));
r=await run('Submit Intervention Authorization Input',{body:{...input,decision:'approve',globalId:'attempted-override'}});
assert.equal(r[0].json.ticket,0);
const initialized=dispatch.dispatchPolicy({operation:'initialize',config:{fmEmail:'fm@test.invalid'}},{
 now:'2026-09-15T09:00:00Z',state:null,candidates:[],ticket:{id:1,status:'LOCALIZED',severity:3,
 created_at:'2020-01-01T09:00:00Z',dispatch_authorized_at:'2026-09-15T09:00:00Z'}});
assert.equal(initialized.state.original_date,'2026-09-17');
console.log('PASS: workflow graph and Code syntax, capture correlation, automatic asset validation, approval form escaping, GET read-only, no FM asset override.');
