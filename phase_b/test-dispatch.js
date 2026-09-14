'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {PGlite}=require('./.test-runtime/pglite/dist/index.cjs');
const {dispatchPolicy}=require('./operations');
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
  if(operation==='offer_next'&&r.technicianId===undefined)r.technicianId=dispatchPolicy({...r,operation:'read'},row).result.available_candidate_ids?.[0];
  if(operation==='send_notices'&&r.noticeKey===undefined)r.noticeKey=Object.values(row.state.messages).find(m=>m.status==='PENDING'&&m.key!=='opening'&&!m.key.startsWith('offer:'))?.key;
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
async function drainNotices(r){for(let n=0;n<10;n++){const d=await operation(r,'read');if(!d.result.notices.some(m=>m.status==='PENDING'&&m.key!=='opening'&&!m.key.startsWith('offer:')))return;await send(r,'send_notices');}throw new Error('notice loop');}
async function embeddedTool(name,request,failMail=false,conflictOnce=false,provided={}) {
  const w=JSON.parse(fs.readFileSync(path.join(root,'wf1_ticket_intake_and_dispatch.json'),'utf8'));
  const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'workflow-manifest.json'),'utf8'));
  const helpers=new Map(manifest.helpers.map(h=>[h.id,JSON.parse(fs.readFileSync(path.join(__dirname,h.file),'utf8'))]));
  const aliases={offer_next:'send_offer',send_notices:'send_notice'};
  const tool=w.nodes.find(n=>n.name===(aliases[name]||name));
  const row=await load(request),ctx=dispatchPolicy({...request,operation:'read'},row).result;
  const inputs={technician_id:ctx.available_candidate_ids?.[0],notice_key:ctx.notices?.find(m=>m.status==='PENDING'&&m.key!=='opening'&&!m.key.startsWith('offer:'))?.key,...provided};
  const mail=[];let conflicting=conflictOnce;
  const fromAI=key=>inputs[key];
  const evaluate=(v,dollar,input)=>typeof v==='string'&&v.startsWith('={{')?new Function('$','$json','$fromAI','return ('+v.slice(3,-2).trim()+');')(dollar,input,fromAI):v;
  const params=(n,dollar,input)=>evaluate(n.parameters.options.queryReplacement,dollar,input);
  async function postgres(n,values){
    const query=n.parameters.query;
    // Supabase is a separate connection. Policy regression tests simulate no knowledge;
    // knowledge/test_knowledge.js exercises the real vector SQL independently.
    if(query===require('../knowledge/nodes').OFFER)return [{knowledge:{status:'UNAVAILABLE',chunks:[]}}];
    if(query===sql.CREATE)return db.transaction(async tx=>{await tx.exec('LOCK TABLE tickets IN SHARE ROW EXCLUSIVE MODE');return (await tx.query(query.slice(query.indexOf(';')+1),values)).rows;});
    if(query===sql.COMMIT&&conflicting){conflicting=false;return [{applied:false}];}
    return (await db.query(query,values)).rows;
  }
  async function execute(workflow,initial){
    const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
    const outputs={},counts={};let current=workflow.nodes.find(n=>n.type==='n8n-nodes-base.executeWorkflowTrigger').name,items=[{json:initial}];
    const dollar=name=>({first:()=>outputs[name]?.[0],item:outputs[name]?.[0]});
    for(let step=0;step<120;step++){
      const n=workflow.nodes.find(x=>x.name===current),input=items[0]?.json,index=counts[current]||0;counts[current]=index+1;let branch=0;
      if(n.type==='n8n-nodes-base.code')items=await new AsyncFunction('$json','$input','$','$runIndex',n.parameters.jsCode)(input,{first:()=>items[0],all:()=>items},dollar,index);
      else if(n.type==='n8n-nodes-base.if')branch=evaluate(n.parameters.conditions.conditions[0].leftValue,dollar,input)?0:1;
      else if(n.type==='n8n-nodes-base.postgres')items=(await postgres(n,params(n,dollar,input))).map(json=>({json}));
      else if(n.type==='n8n-nodes-base.gmail'){
        mail.push({to:evaluate(n.parameters.sendTo,dollar,input),subject:evaluate(n.parameters.subject,dollar,input)});
        items=[{json:failMail?{error:'simulated timeout'}:{id:'mock-gmail-'+crypto.randomUUID()}}];
      }else if(n.type==='n8n-nodes-base.executeWorkflow'){
        const values=Object.fromEntries(Object.entries(n.parameters.workflowInputs.value).map(([k,v])=>[k,evaluate(v,dollar,input)]));
        assert.equal(n.parameters.source,'database');items=await execute(helpers.get(n.parameters.workflowId.value),values);
      }
      outputs[current]=items;const edge=workflow.connections[current]?.main?.[branch]?.[0];if(!edge)return items;current=edge.node;
    }throw new Error('Saved workflow exceeded execution bound');
  }
  const dollar=()=>({first:()=>({json:request})});let items;
  if(tool.type==='n8n-nodes-base.postgresTool')items=(await postgres(tool,params(tool,dollar,request))).map(json=>({json}));
  else {
    assert.equal(tool.parameters.source,'database');
    const values=Object.fromEntries(Object.entries(tool.parameters.workflowInputs.value).map(([k,v])=>[k,evaluate(v,dollar,request)]));
    items=await execute(helpers.get(tool.parameters.workflowId.value),values);
  }
  return {result:items[0].json.context||items[0].json,mail};
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
    for(const [f,hash] of Object.entries({'n8n_wf2_completion_approval_ifc_update.json':'DAE5A93101E8CF236036D63C6688E7E9B316F8A493B426E2671AE00CC46A1006','schema.sql':'EF8220CFEB2978E3AAF088253C6A74E02CE2B3C4CA9860F61148C49A7FE3AE3D'}))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex').toUpperCase(),hash);
  });
  await run('Idempotent creation, element deduplication, bound existing ticket',async()=>{
    const r=await fixture();const id=r.ticketId;
    assert.equal((await create(r)).ticket_id,id);
    assert.equal((await create({...r,ticketId:null,sourceKey:'different-source'})).ticket_id,id);
    assert.equal((await create({ticketId:id,config:cfg,sourceKey:null,triage:null})).ticket_id,id);
    assert.equal((await db.query('SELECT count(*) AS n FROM tickets WHERE ifc_global_id=$1',[r.triage.element.global_id])).rows[0].n,1);
  });
  await run('Native Postgres creation and saved initialization work with a bound source before an ID exists',async()=>{
    const seed=await fixture(3),key=crypto.randomUUID();
    const r={...seed,ticketId:null,sourceKey:key,triage:{...seed.triage,element:{...seed.triage.element,global_id:key}}};
    assert.equal((await embeddedTool('get_context',r)).result.outcome,'NO_TICKET');
    const created=await embeddedTool('create_ticket',r);assert.ok(created.result.ticket_id);
    assert.equal((await embeddedTool('create_ticket',r)).result.ticket_id,created.result.ticket_id);
    assert.equal((await embeddedTool('get_context',r)).result.outcome,'UNINITIALIZED');
    const initialized=await embeddedTool('initialize_dispatch',r);assert.equal(initialized.result.initialized,true);
    assert.equal(initialized.result.opening_status,'PENDING');
    const sent=await embeddedTool('send_notice',r,false,false,{notice_key:'opening'});assert.equal(sent.mail.length,1);
    assert.equal(sent.result.opening_status,'SENT');
  });
  await run('Native context exposes facts without operation scripts, bearer tokens, bodies or config',async()=>{
    const r=await fixture(3);await send(r);const row=await load(r);
    const result=(await embeddedTool('get_context',r)).result;
    assert.equal(result.next_actions,undefined);assert.equal(result.active_offer_count,1);
    assert.ok(!j(result).includes(row.state.offers[0].token));assert.ok(!j(result).includes('callbackBase'));
    assert.ok(!j(result).includes('<h3>'));assert.equal(result.candidates.length,5);
    assert.deepEqual(result.available_candidate_ids,dispatchPolicy({...r,operation:'read'},row).result.available_candidate_ids);
  });
  await run('Agent-supplied technician and notice inputs are used and rejected when invalid',async()=>{
    const r=await fixture(5),initial=await load(r),wrong=initial.state.shortlist[1];
    const rejected=await embeddedTool('send_offer',r,false,false,{technician_id:wrong});
    assert.equal(rejected.mail.length,0);assert.equal(rejected.result.operation_result.reason,'TECHNICIAN_MUST_BE_NEXT_RANKED_ELIGIBLE_CANDIDATE');
    assert.equal((await embeddedTool('send_notice',r,false,false,{notice_key:'invented'})).mail.length,0);
    const allowed=await embeddedTool('send_offer',r,false,false,{technician_id:initial.state.shortlist[0]});assert.equal(allowed.mail.length,1);
    assert.equal((await embeddedTool('send_offer',r,false,false,{technician_id:initial.state.shortlist[0]})).mail.length,0);
  });
  await run('Native read detects a lost receipt and the fixed failure workflow persists the halt',async()=>{
    const r=await fixture(3);await operation(r,'offer_next');let row=await load(r);
    const m=Object.values(row.state.messages).find(m=>m.status==='SENDING');
    m.claimed_at=new Date(Date.now()-310000).toISOString();row.state.next_wake=new Date(Date.now()-10000).toISOString();
    assert.equal(await commit(row,{state:row.state}),true);
    assert.equal((await embeddedTool('get_context',r)).result.outcome,'OPERATOR_ACTION_REQUIRED');
    assert.equal((await embeddedTool('Record Incomplete Execution',r)).result.outcome,'OPERATOR_ACTION_REQUIRED');
    row=await load(r);assert.equal(row.state.halted,true);assert.equal(Object.values(row.state.messages).find(x=>x.key===m.key).status,'UNCERTAIN');
  });
  await run('Tickets created before initialization have bounded recovery and failure auditing',async()=>{
    const seed=await fixture(3),key=crypto.randomUUID();
    const r={...seed,ticketId:null,sourceKey:key,triage:{...seed.triage,element:{...seed.triage.element,global_id:key}}};
    const previousDb=db;db=new PGlite();
    try {
      await db.exec(fs.readFileSync(path.join(root,'schema.sql'),'utf8'));
      await embeddedTool('create_ticket',r);
      const ticketId=(await load(r)).ticket.id;
      await db.query("UPDATE tickets SET created_at=clock_timestamp()-interval '2 minutes' WHERE id=$1",[ticketId]);
      assert.deepEqual((await db.query(sql.DUE)).rows,[{ticket_id:ticketId}]);
      for(let i=0;i<2;i++){
        assert.equal((await embeddedTool('Record Incomplete Execution',r)).result.outcome,'UNINITIALIZED');
        assert.deepEqual((await db.query(sql.DUE)).rows,[]);
        await db.query("UPDATE ticket_events SET created_at=clock_timestamp()-interval '2 minutes' WHERE ticket_id=$1 AND event='CBM_INIT_FAILURE'",[ticketId]);
        assert.deepEqual((await db.query(sql.DUE)).rows,[{ticket_id:ticketId}]);
      }
      assert.equal((await embeddedTool('Record Incomplete Execution',r)).result.outcome,'OPERATOR_ACTION_REQUIRED');
      assert.equal((await load(r)).init_failures,3);
      await db.query("UPDATE ticket_events SET created_at=clock_timestamp()-interval '2 minutes' WHERE ticket_id=$1 AND event='CBM_INIT_FAILURE'",[ticketId]);
      assert.deepEqual((await db.query(sql.DUE)).rows,[]);
    }finally{await db.close();db=previousDb;}
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
    const a=dispatchPolicy({...r,operation:'offer_next',technicianId:first.state.shortlist[0]},first),b=dispatchPolicy({...r,operation:'offer_next',technicianId:second.state.shortlist[0]},second);
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
  await run('Saved workflows and nested receipt workflow execute Code/SQL/If paths with mocked Gmail',async()=>{
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
        assert.equal(n.parameters.workflowJson,undefined,'No embedded workflow JSON is allowed');
      }
    }
    const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'workflow-manifest.json'),'utf8'));
    validate(w);for(const helper of manifest.helpers)validate(JSON.parse(fs.readFileSync(path.join(__dirname,helper.file),'utf8')));assert.ok(compiled>15);
    assert.equal(w.nodes.filter(n=>n.type==='n8n-nodes-base.postgresTool').length,2);
    assert.ok(!JSON.stringify(w).includes('next_actions'));
    assert.equal(w.nodes.filter(n=>n.type==='@n8n/n8n-nodes-langchain.agent').length,1);
    assert.equal(w.nodes.filter(n=>n.type==='@n8n/n8n-nodes-langchain.toolWorkflow').length,5);
    const byId=new Map(manifest.helpers.map(h=>[h.id,JSON.parse(fs.readFileSync(path.join(__dirname,h.file),'utf8'))]));
    for(const graph of [w,...byId.values()])for(const n of graph.nodes){
      if(!n.parameters.workflowId)continue;
      const child=byId.get(n.parameters.workflowId.value);assert.ok(child,'Every saved reference resolves in the package');
      const inputFields=child.nodes[0].parameters.workflowInputs.values;
      assert.deepEqual(Object.keys(n.parameters.workflowInputs.value).sort(),inputFields.map(f=>f.name).sort());
      assert.equal(n.parameters.source,'database');
    }
    assert.ok(w.nodes.find(n=>n.name==='send_offer').parameters.workflowInputs.value.technicianId.includes('$fromAI'));
    assert.ok(!w.nodes.find(n=>n.name==='send_offer').parameters.workflowInputs.value.ticketId.includes('$fromAI'));
    assert.ok(!w.nodes.some(n=>n.name==='ack'));
  });
  await db.close();
  const report={passed:results.length,tests:results,sql_runtime:'PGlite 0.5.8 (PostgreSQL WASM)',live_n8n_import_tested:false,live_gmail_or_llm_called:false,source_phase_a_preserved:true};
  fs.writeFileSync(path.join(__dirname,'validation-report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(`\n${results.length} tests passed. No live email or model calls.`);
}
main().catch(async error=>{console.error(error);if(db)await db.close();process.exitCode=1;});
