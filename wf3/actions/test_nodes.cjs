const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const read=f=>fs.readFileSync(path.join(__dirname,f),'utf8');
const flows=['658IWGwRtDMsPri7','cbmWf3TicketAction','cbmWf3ApprovalMail'].map(id=>JSON.parse(read('workflows/'+id+'.json')));
let compiled=0;
for(const w of flows){
 const names=new Set(w.nodes.map(n=>n.name));assert.equal(names.size,w.nodes.length);
 for(const [src,c] of Object.entries(w.connections)){
  assert(names.has(src));for(const branches of Object.values(c))for(const b of branches)for(const e of b)assert(names.has(e.node),e.node);
 }
 for(const n of w.nodes){
  if(n.parameters.jsCode){new Function('$input','$json','$env','$',n.parameters.jsCode);compiled++;}
  const str=JSON.stringify(n.parameters);
  for(const m of str.matchAll(/\$\(['"]([^'"]+)['"]\)/g))assert(names.has(m[1]),`${n.name} references ${m[1]}`);
 }
}
const main=flows[0], tools=Object.keys(main.connections).filter(k=>main.connections[k].ai_tool);
const deps=new Map(flows.map(w=>[w.id,w.nodes.filter(n=>n.parameters.workflowId).map(n=>n.parameters.workflowId.value)]));
function visit(id,stack=[]){assert(!stack.includes(id),'Circular subworkflow dependency: '+[...stack,id].join(' -> '));for(const child of deps.get(id)||[])visit(child,[...stack,id]);}
for(const w of flows)visit(w.id);
assert.equal(tools.length,14);
const validate=new Function('$input',read('normalize-action.js'));
const p={action:'approve_completion',ticketId:3,approvalId:'12345678-1234-1234-1234-123456789abc',expectedUpdatedAt:'2026-09-18T00:00:00.123456+00:00',actor:'FM_CHAT',truncated:false,requestId:'1',sessionId:'s',question:'Approve completed work on ticket 3'};
const run=x=>validate({first:()=>({json:{context:JSON.stringify(x)}})})[0].json;
assert.equal(run(p).expectedUpdatedAt,p.expectedUpdatedAt);
for(const x of [{...p,ticketId:'3'},{...p,action:'set_status'},{...p,truncated:true},{...p,approvalId:'old'},{...p,actor:'model'},{...p,action:'request_rework',reason:''}])assert.throws(()=>run(x));
const render=new Function('$input',read('email-page.js'));
const html=render({first:()=>({json:{result:{valid:true,ticketId:3,emailId:'x',token:'abc',ifc_name:'<script>alert(1)</script>',description:'Valve & pipe'}}})})[0].json.html;
assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));assert(html.includes('method="post"'));
fs.writeFileSync(path.join(__dirname,'../../../../validation-wf3-actions/confirmation-preview.html'),html);
const f=flows[1], by=Object.fromEntries(f.nodes.map(n=>[n.name,n]));
assert.equal(by['Reuse Guarded IFC Write'].parameters.workflowId.value,'eqrcZZLPvsjRgCUR');
assert.equal(by['Reuse FM Closure Notice'].parameters.workflowId.value,'3sdjXyXedBKiDGXD');
assert(f.connections['IFC Update Succeeded?'].main[1][0].node==='Read Committed Action Outcome');
assert(f.connections['Ticket Closed?'].main[1][0].node==='Read Committed Action Outcome');
assert(!JSON.stringify(f.nodes.filter(n=>!n.type.endsWith('stickyNote'))).match(/status='(?:DISPATCHING|ESCALATED)'/));
console.log(JSON.stringify({workflows:flows.length,compiled_code_nodes:compiled,tools:tools.length,validation:'passed'}));
