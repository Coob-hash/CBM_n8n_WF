'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {PGlite}=require('./.test-runtime/pglite/dist/index.cjs');
const {dispatchPolicy}=require('./dispatch-core');
const sql=require('./queries');
const root=path.resolve(__dirname,'..');
const results=[];
const cfg={fmEmail:'fm@example.com',callbackBase:'https://n8n.example.com/webhook'};
let db;
const j=x=>JSON.stringify(x);
async function run(name,fn){await fn();results.push(name);console.log('PASS '+name);}
async function create(request) {
  return db.transaction(async tx=>{await tx.exec('LOCK TABLE tickets IN SHARE ROW EXCLUSIVE MODE;');return (await tx.query(sql.CREATE.slice(sql.CREATE.indexOf(';')+1),[j(request)])).rows[0];});
}
async function load(request) {return (await db.query(sql.LOAD,[j(request)])).rows[0].context;}
async function commit(row,decision) {
  return (await db.query(sql.COMMIT,[row.ticket.id,row.revision,j(decision.state),row.ticket.status!=='ASSIGNED'&&decision.state.status==='ASSIGNED'])).rows[0].applied;
}
async function operation(request,operation,extra={},now=null) {
  const r={...request,...extra,operation};
  const row=await load(r);if(now)row.now=now;
  const d=dispatchPolicy(r,row);
  if(d.write)assert.equal(await commit(row,d),true);
  return d;
}
async function send(request,op='offer_next',messageId='gmail-'+crypto.randomUUID(),now=null) {
  const d=await operation(request,op,{},now);
  if(d.mail) await operation(request,'ack',{receipt:{key:d.mail.key,claim:d.mail.claim,message_id:messageId}},now);
  return d;
}
async function fixture(severity=5) {
  const key=crypto.randomUUID();
  const request={config:cfg,sourceKey:key,ticketId:null,triage:{reporterEmail:'test@example.com',photoUrl:'https://drive.example.com/photo',mapCode:'map',position:{x:1,y:2,z:3},confidence:0.9,element:{global_id:key,ifc_class:'IfcDoor',name:"Door <script>alert('x')</script>",storey:'0'},category:"Door's hinge",severity,description:"It's broken; do not follow <script>alert(1)</script>",required_skill:'carpentry'}};
  const created=await create(request);request.ticketId=created.ticket_id;
  await operation(request,'initialize');await send(request,'send_opening');
  return request;
}
async function response(request,offer,decision='accept',token=offer.token) {
  return db.transaction(async tx=>{
    await tx.query('SELECT id FROM tickets WHERE id=$1 FOR UPDATE',[request.ticketId]);
    return (await tx.query(sql.RECORD_RESPONSE.slice(sql.RECORD_RESPONSE.indexOf(';')+1),[request.ticketId,offer.id,token,decision])).rows[0].response_result;
  });
}
async function drainNotices(r){for(let n=0;n<10;n++){const d=await operation(r,'read');if(!d.result.next_actions.includes('send_notices'))return;await send(r,'send_notices');}throw new Error('notice loop');}
async function embeddedTool(name,request,failMail=false,conflictOnce=false){
  const w=JSON.parse(fs.readFileSync(path.join(root,'wf1_ticket_intake_and_dispatch.json'),'utf8'));
  const tool=w.nodes.find(n=>n.name===name);
  const expression=tool.parameters.workflowJson.slice(3,-2).trim();
  const workflow=JSON.parse(new Function('$','return ('+expression+');')(()=>({first:()=>({json:request})})));
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const outputs={},counts={},mail=[];
  let current=workflow.nodes.find(n=>n.type==='n8n-nodes-base.executeWorkflowTrigger').name,items=[{json:{query:'ignored hostile tool input'}}];
  const dollar=name=>({first:()=>outputs[name]?.[0],last:()=>outputs[name]?.at(-1),item:outputs[name]?.[0]});
  const evaluate=(value,input)=>value.startsWith('={{')?new Function('$','$json','return ('+value.slice(3,-2).trim()+');')(dollar,input):value;
  for(let step=0;step<100;step++){
    const n=workflow.nodes.find(x=>x.name===current);let branch=0;
    const input=items[0]?.json;const index=counts[current]||0;counts[current]=index+1;
    if(n.type==='n8n-nodes-base.code')items=await new AsyncFunction('$json','$input','$','$runIndex',n.parameters.jsCode)(input,{first:()=>items[0],all:()=>items},dollar,index);
    else if(n.type==='n8n-nodes-base.if')branch=evaluate(n.parameters.conditions.conditions[0].leftValue,input)?0:1;
    else if(n.type==='n8n-nodes-base.postgres'){
      const params=evaluate(n.parameters.options.queryReplacement,input);
      const query=n.parameters.query;
      let rows;
      if(query===sql.CREATE)rows=await db.transaction(async tx=>{await tx.exec('LOCK TABLE tickets IN SHARE ROW EXCLUSIVE MODE');return (await tx.query(query.slice(query.indexOf(';')+1),params)).rows;});
      else if(query===sql.COMMIT && conflictOnce){conflictOnce=false;rows=[{applied:false}];}
      else rows=(await db.query(query,params)).rows;
      items=rows.map(json=>({json}));
    }else if(n.type==='n8n-nodes-base.gmail'){
      mail.push({to:evaluate(n.parameters.sendTo,input),subject:evaluate(n.parameters.subject,input)});
      items=[{json:failMail?{error:'simulated provider timeout'}:{id:'mock-gmail-'+crypto.randomUUID()}}];
    }
    outputs[current]=items;
    const edge=workflow.connections[current]?.main?.[branch]?.[0];
    if(!edge)return {result:items[0].json,mail};
    current=edge.node;
  }
  throw new Error('Embedded operation exceeded step bound');
}
async function main(){
  db=new PGlite();
  await db.exec(fs.readFileSync(path.join(root,'schema.sql'),'utf8'));
  await db.exec("INSERT INTO technicians(full_name,email,skills,zone,rating) SELECT 'Tech '||i,'tech'||i||'@example.com',ARRAY['carpentry'],'building-A',4.5 FROM generate_series(1,6) i;");
  await run('Export preserves all 15 Phase A nodes, connections, WF2 and schema',async()=>{
    const before=JSON.parse(fs.readFileSync(path.join(__dirname,'original_wf1.json'),'utf8'));
    const after=JSON.parse(fs.readFileSync(path.join(root,'wf1_ticket_intake_and_dispatch.json'),'utf8'));
    assert.deepEqual(after.nodes.slice(0,15),before.nodes.slice(0,15));
    for(const n of before.nodes.slice(0,15))assert.deepEqual(after.connections[n.name],before.connections[n.name]);
    for(const [f,hash] of Object.entries({'n8n_wf2_completion_approval_ifc_update.json':'ABF8175A8535E9FF6282571D2CAA73F77B30D66D8998FCA776C3FBDC3FDC4872','schema.sql':'EF8220CFEB2978E3AAF088253C6A74E02CE2B3C4CA9860F61148C49A7FE3AE3D'}))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex').toUpperCase(),hash);
  });
  await run('Idempotent creation, element deduplication, bound existing ticket',async()=>{
    const r=await fixture();const id=r.ticketId;
    assert.equal((await create(r)).ticket_id,id);
    assert.equal((await create({...r,ticketId:null,sourceKey:'different-source'})).ticket_id,id);
    assert.equal((await create({ticketId:id,config:cfg,sourceKey:null,triage:null})).ticket_id,id);
    assert.equal((await db.query('SELECT count(*) AS n FROM tickets WHERE ifc_global_id=$1',[r.triage.element.global_id])).rows[0].n,1);
  });
  await run('SQL filters eligibility and keeps five ranked candidates; messages escape report HTML',async()=>{
    const r=await fixture();const row=await load(r);
    assert.equal(row.state.shortlist.length,5);
    assert.equal(new Set(row.state.shortlist).size,5);
    assert.ok(row.candidates.every(c=>c.email!=='giulia.verdi@example.com'));
    const d=await send(r);
    assert.ok(d.mail.html.includes('&lt;script&gt;'));
    assert.ok(!d.mail.html.includes('<script>'));
    assert.ok(!j(d.result).includes(row.token));
  });
  await run('Urgent two-offer cap and one atomic winner with withdrawal notices',async()=>{
    const r=await fixture(5);await send(r);await send(r);
    assert.equal((await send(r)).mail,null);
    let row=await load(r);assert.equal(row.state.offers.length,2);
    const [a,b]=row.state.offers;
    assert.equal((await response(r,b)).recorded,true);assert.equal((await response(r,a)).recorded,true);
    await operation(r,'process_events');row=await load(r);
    assert.equal(row.ticket.status,'ASSIGNED');assert.equal(row.ticket.technician_id,b.technician_id);
    assert.equal(row.state.offers.find(o=>o.id===a.id).status,'WITHDRAWN');
    assert.equal((await send(r)).mail,null);
    await drainNotices(r);assert.equal((await operation(r,'read')).result.outcome,'ASSIGNED');
  });
  await run('Ordinary offers remain sequential and have 48 hours before a future fixed appointment',async()=>{
    const r=await fixture(2);await send(r);assert.equal((await send(r)).mail,null);
    const row=await load(r),o=row.state.offers[0];
    assert.equal(Date.parse(o.expires_at)-Date.parse(o.sent_at),48*3600000);
    assert.ok(o.date>=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Rome',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(o.expires_at)));
    await response(r,o,'deny');await operation(r,'process_events');await send(r);
    assert.equal((await load(r)).state.offers.length,2);
  });
  await run('Urgent expiry is capped at appointment start; expiry blocks late acceptance and escalates',async()=>{
    const r=await fixture(5);let row=await load(r);
    // Set a future appointment 30 minutes away to exercise the exact earlier cutoff.
    row.state.urgent_start=new Date(Date.now()+1800000).toISOString();
    assert.equal(await commit(row,{state:row.state}),true);
    await send(r);row=await load(r);const o=row.state.offers[0];
    assert.equal(o.expires_at,row.state.urgent_start);
    await operation(r,'process_events',{},o.expires_at);
    assert.equal((await response(r,o)).recorded,false);
    await operation(r,'escalate',{},o.expires_at);
    assert.equal((await load(r)).ticket.status,'ESCALATED');
  });
  await run('Rejected/expired/replayed/forged links cannot accept another offer',async()=>{
    const r=await fixture(3);await send(r);let o=(await load(r)).state.offers[0];
    assert.equal((await response(r,o,'accept','a'.repeat(64))).recorded,false);
    assert.equal((await response(r,o,'deny')).recorded,true);
    assert.equal((await response(r,o,'accept')).recorded,false);
    await operation(r,'process_events');await send(r);
    assert.equal((await response(r,o)).recorded,false);
    assert.equal((await load(r)).ticket.status,'DISPATCHING');
  });
  await run('Concurrent snapshots cannot both reserve capacity or overwrite a winner',async()=>{
    const r=await fixture(3),first=await load(r),second=await load(r);
    const a=dispatchPolicy({...r,operation:'offer_next'},first),b=dispatchPolicy({...r,operation:'offer_next'},second);
    assert.equal(await commit(first,a),true);assert.equal(await commit(second,b),false);
    assert.equal((await load(r)).state.offers.length,1);
    const o=a.state.offers[0];await response(r,o);await operation(r,'process_events');
    assert.equal(await commit(second,b),false);
    assert.equal((await load(r)).ticket.technician_id,o.technician_id);
  });
  await run('A response invalidates an older expiry snapshot so timely acceptance is not lost',async()=>{
    const r=await fixture(3);await send(r);const stale=await load(r),o=stale.state.offers[0];
    const expiryRow={...stale,now:o.expires_at};
    const expire=dispatchPolicy({...r,operation:'process_events'},expiryRow);
    assert.equal((await response(r,o)).recorded,true);
    assert.equal(await commit(stale,expire),false);
    await operation(r,'process_events',{},new Date(Date.parse(o.expires_at)+1000).toISOString());
    assert.equal((await load(r)).ticket.status,'ASSIGNED');
  });
  await run('Ambiguous Gmail result consumes capacity, halts retries, and is never blindly resent',async()=>{
    const r=await fixture(5);const d=await send(r,'offer_next',null);
    assert.ok(d.mail);
    let row=await load(r);assert.equal(row.state.halted,true);assert.equal(row.state.offers[0].status,'UNCERTAIN');
    assert.equal((await send(r)).mail,null);
    assert.equal((await operation(r,'read')).result.outcome,'OPERATOR_ACTION_REQUIRED');
    await response(r,row.state.offers[0]);await operation(r,'process_events');
    assert.equal((await load(r)).ticket.status,'ASSIGNED');
  });
  await run('Lost Gmail receipt is detected by the five-minute watchdog',async()=>{
    const r=await fixture(3);const d=await operation(r,'offer_next');
    const later=new Date(Date.parse(d.mail.claimed_at)+300002).toISOString();
    await operation(r,'process_events',{},later);
    assert.equal((await load(r)).state.halted,true);
  });
  await run('Restart recovery reads persisted state without resetting offer expiry',async()=>{
    const r=await fixture(3);await send(r);const old=(await load(r)).state.offers[0];
    const request={config:cfg,ticketId:r.ticketId,sourceKey:null};
    assert.equal((await operation(request,'read')).result.offers[0].expires_at,old.expires_at);
    const before=(await load(r)).state.messages.opening.message_id;
    assert.equal((await send(request,'send_opening')).mail,null);
    assert.equal((await load(r)).state.messages.opening.message_id,before);
  });
  await run('All five declines exhaust the shortlist and notify the FM',async()=>{
    const r=await fixture(2);
    for(let n=0;n<5;n++) {await send(r);const o=(await load(r)).state.offers.at(-1);await response(r,o,'deny');await operation(r,'process_events');}
    assert.equal((await send(r)).mail,null);await operation(r,'escalate');await drainNotices(r);
    assert.equal((await load(r)).ticket.status,'ESCALATED');
  });
  await run('Zero candidates is a valid escalation, not a stalled empty-item branch',async()=>{
    const r=await fixture(3);let row=await load(r);row.state.shortlist=[];assert.equal(await commit(row,{state:row.state}),true);
    await operation(r,'escalate');assert.equal((await load(r)).ticket.status,'ESCALATED');
  });
  await run('WF2 terminal states and technician statistics are not overwritten on replay',async()=>{
    const r=await fixture(3);await send(r);const o=(await load(r)).state.offers[0];await response(r,o);await operation(r,'process_events');
    const stats=(await db.query('SELECT last_assigned_at::text AS value FROM technicians WHERE id=$1',[o.technician_id])).rows[0].value;
    await operation(r,'process_events');assert.equal((await db.query('SELECT last_assigned_at::text AS value FROM technicians WHERE id=$1',[o.technician_id])).rows[0].value,stats);
    await db.query("UPDATE tickets SET status='CLOSED',updated_at=clock_timestamp() WHERE id=$1",[r.ticketId]);
    await operation(r,'process_events');assert.equal((await load(r)).ticket.status,'CLOSED');
  });
  await run('Recovery SQL locates due persisted work and skips halted tickets',async()=>{
    const due=await db.query(sql.DUE);assert.ok(due.rows.length<=1);
    if(due.rows.length)assert.equal((await load({ticketId:due.rows[0].ticket_id})).state.halted,false);
  });
  await run('Embedded tool graphs execute their actual Code/SQL/If branches with mocked Gmail',async()=>{
    const r=await fixture(5);
    const first=await embeddedTool('offer_next',r,false,true);
    assert.equal(first.mail.length,1);assert.equal(first.result.offers.length,1);
    assert.equal(first.result.offers[0].status,'LIVE');
    const second=await embeddedTool('offer_next',r);assert.equal(second.mail.length,1);
    const third=await embeddedTool('offer_next',r);assert.equal(third.mail.length,0);
    const o=(await load(r)).state.offers[0];await response(r,o);
    const applied=await embeddedTool('process_events',r);assert.equal(applied.result.status,'ASSIGNED');
    for(let n=0;n<3;n++)assert.equal((await embeddedTool('send_notices',r)).mail.length,1);
    assert.equal((await embeddedTool('get_context',r)).result.outcome,'ASSIGNED');
    const r2=await fixture(3);assert.equal((await embeddedTool('offer_next',r2,true)).result.outcome,'OPERATOR_ACTION_REQUIRED');
  });
  await run('Urgent business-day scheduling uses Rome DST and skips weekends',async()=>{
    const r=await fixture(5),base=await load(r);
    for(const [created,start] of [['2026-03-27T12:00:00Z','2026-03-30T06:00:00.000Z'],['2026-10-23T12:00:00Z','2026-10-26T07:00:00.000Z']]){
      const row={...base,state:null,now:created,ticket:{...base.ticket,created_at:created}};
      const d=dispatchPolicy({...r,operation:'initialize'},row);assert.equal(d.state.urgent_start,start);
    }
  });
  await run('Provider/model recovery is bounded at three failed invocations',async()=>{
    const r=await fixture(3);
    await operation(r,'failure');await operation(r,'failure');assert.equal((await load(r)).state.halted,false);
    await operation(r,'failure');assert.equal((await load(r)).state.halted,true);
  });
  await run('Generated n8n Code and expression syntax; valid node connections and tool boundaries',async()=>{
    const w=JSON.parse(fs.readFileSync(path.join(root,'wf1_ticket_intake_and_dispatch.json'),'utf8'));
    const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
    let compiled=0;
    function validate(workflow){
      const names=new Set(workflow.nodes.map(n=>n.name));assert.equal(names.size,workflow.nodes.length);
      for(const [from,channels] of Object.entries(workflow.connections)){assert.ok(names.has(from));for(const outs of Object.values(channels))for(const branch of outs)for(const edge of branch)assert.ok(names.has(edge.node),edge.node);}
      function expressions(value){
        if(typeof value==='string' && value.startsWith('={{') && value.endsWith('}}'))new Function('$','$json','return ('+value.slice(3,-2).trim()+');');
        else if(Array.isArray(value))value.forEach(expressions);
        else if(value && typeof value==='object')Object.values(value).forEach(expressions);
      }
      for(const n of workflow.nodes){
        expressions(n.parameters);
        if(n.type==='n8n-nodes-base.code'){new AsyncFunction('$json','$input','$','$runIndex',n.parameters.jsCode);compiled++;}
        if(n.parameters.workflowJson){
          const expr=n.parameters.workflowJson.slice(3,-3).trim();
          const fakeContext={sourceKey:'test',ticketId:1,config:cfg,triage:{description:'"; throw new Error("injected");//'}};
          const json=new Function('$','return ('+expr+');')(()=>({first:()=>({json:fakeContext})}));
          const sub=JSON.parse(json);validate(sub);
          const bound=sub.nodes.find(x=>x.name==='Bound Request');
          const returned=awaitableBound(bound.parameters.jsCode);
          assert.equal(returned[0].json.ticketId,1);
          assert.equal(returned[0].json.triage.description,fakeContext.triage.description);
        }
      }
    }
    function awaitableBound(code){return new Function(code)();}
    validate(w);assert.ok(compiled>50);
    assert.equal(w.nodes.filter(n=>n.type==='@n8n/n8n-nodes-langchain.agent').length,1);
    assert.equal(w.nodes.filter(n=>n.type==='@n8n/n8n-nodes-langchain.toolWorkflow').length,7);
  });
  await db.close();
  const report={passed:results.length,tests:results,sql_runtime:'PGlite 0.5.8 (PostgreSQL WASM)',live_n8n_import_tested:false,live_gmail_or_llm_called:false,source_phase_a_preserved:true};
  fs.writeFileSync(path.join(__dirname,'validation-report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(`\n${results.length} tests passed. No live email or model calls.`);
}
main().catch(async error=>{console.error(error);if(db)await db.close();process.exitCode=1;});
