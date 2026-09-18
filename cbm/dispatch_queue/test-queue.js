'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require(process.env.CBM_PGLITE_MODULE||'../../../14_09_2026 release CBM/phase_b/.test-runtime/pglite/dist/index.cjs');
const sql=require('../app/phase_b/queries'),{dispatchPolicy}=require('../app/phase_b/operations');
const out=path.resolve(__dirname,'../../validation-single-ticket');let db;const passed=[],trace=[];
const cfg={fmEmail:'fm@example.com',callbackBase:'https://demo.example.com/webhook'};
const q=async(s,p=[])=>(await db.query(s,p)).rows;
async function test(name,fn){await fn();passed.push(name);console.log('PASS '+name);}
async function seed(status='LOCALIZED',minutes=0){
 const r=(await q("INSERT INTO tickets(status,ifc_global_id,ifc_name,ifc_class,ifc_storey,description,category,severity,required_skill,created_at) VALUES('LOCALIZED',gen_random_uuid()::text,'Office door','IfcDoor','Ground floor','Door scrapes against the frame and does not close fully.','Door alignment',2,'carpentry',clock_timestamp()-$1*interval '1 minute') RETURNING *",[minutes]))[0];
 if(status!=='PENDING_AUTHORIZATION')await q('UPDATE tickets SET status=$2,dispatch_authorized_at=clock_timestamp() WHERE id=$1',[r.id,status]);
 return r.id;
}
async function context(id,page=0){return (await q(sql.PUBLIC_CONTEXT,[JSON.stringify({ticketId:id,overviewPage:page})]))[0].context;}
async function op(id,operation,extra={}){
 const request={ticketId:id,operation,config:cfg,...extra};
 const row=(await q(sql.LOAD,[JSON.stringify(request)]))[0].context;
 const result=dispatchPolicy(request,row);
 if(result.write)assert.equal((await q(sql.COMMIT,[id,row.revision,JSON.stringify(result.state),row.ticket.status!=='ASSIGNED'&&result.state.status==='ASSIGNED']))[0].applied,true);
 if(result.mail){await op(id,'ack',{receipt:{key:result.mail.key,claim:result.mail.claim,message_id:'mock-receipt-'+trace.length}});}
 const c=await context(id);trace.push({operation,outcome:c.outcome,status:c.status,active_offer_count:c.active_offer_count,pending_notices:c.notices.filter(n=>n.status==='PENDING').map(n=>n.key)});return c;
}
async function main(){
 db=new PGlite();fs.mkdirSync(out,{recursive:true});
 for(const f of ['../../database/schema.sql','../../database/schema_dispatch_functions.sql','../../database/intake/schema_intake.sql','../../database/dispatch_queue/schema_queue.sql','../../database/dispatch_queue/schema_context.sql'])await db.exec(fs.readFileSync(path.join(__dirname,f),'utf8'));
 // Reapplying these additive migrations is supported.
 for(const f of ['../../database/dispatch_queue/schema_queue.sql','../../database/dispatch_queue/schema_context.sql'])await db.exec(fs.readFileSync(path.join(__dirname,f),'utf8'));
 const ids=[];for(let i=8;i>=1;i--)ids.push(await seed('LOCALIZED',i));
 const waiting=await seed('PENDING_AUTHORIZATION'),closed=await seed('CLOSED'),assigned=await seed('ASSIGNED'),rework=await seed('REWORK'),rejected=await seed('REJECTED');
 const halted=await seed('DISPATCHING');await q("INSERT INTO ticket_events(ticket_id,event,payload) VALUES($1,'CBM_DISPATCH_STATE',$2::jsonb)",[halted,JSON.stringify({halted:true,offers:[],messages:{},shortlist:[],response_cursor:0,error:'Mock uncertain delivery'})]);
 await test('All non-closed statuses remain visible across bounded overview pages',async()=>{
  const seen=[];for(let p=0;;p++){const c=await context(ids[0],p);assert.ok(c.portfolio.tickets.length<=5);seen.push(...c.portfolio.tickets.map(t=>t.ticket_id));if(!c.portfolio.has_more)break;}
  assert.equal(seen.length,ids.length+5);assert.equal(new Set(seen).size,seen.length);
  for(const id of [waiting,assigned,rework,rejected,halted])assert.ok(seen.includes(id));assert.ok(!seen.includes(closed));
  const c=await context(ids[0]);assert.equal(c.portfolio.operator_required,1);assert.equal(c.portfolio.actionable,8);
 });
 await test('FM authorization is visible and blocks initialization and selection',async()=>{
  const c=await context(waiting);assert.equal(c.authorization.required,true);assert.equal(c.authorization.approved,false);assert.equal(c.outcome,'AWAITING_FM_AUTHORIZATION');
  const row=(await q(sql.LOAD,[JSON.stringify({ticketId:waiting})]))[0].context;
  assert.equal(dispatchPolicy({ticketId:waiting,operation:'initialize',config:cfg},row).feedback.reason,'AWAITING_FM_AUTHORIZATION');
 });
 let first;
 const claim=(id,execution)=>q(sql.DUE,[id,execution]);
 const finish=async(a,execution)=>(await q('SELECT cbm_finish_dispatch_work($1,$2,$3,$4) AS r',[a.ticketId,a.leaseToken,execution,'WAITING']))[0].r;
 await test('Recovery claims only one eligible ticket, oldest unserved ticket first',async()=>{
  first=await claim(null,'recovery-1');assert.deepEqual(first.map(x=>Number(x.ticketId)),[ids[0]]);
  assert.equal(first[0].selectionReason,'RECOVERY_OLDEST_UNFINISHED');
  assert.equal((await q('SELECT worker_execution_id FROM cbm_dispatch_queue_visits WHERE ticket_id=$1',[ids[0]]))[0].worker_execution_id,'recovery-1');
 });
 await test('Approval and response callbacks select only their exact ticket',async()=>{
  const event=await claim(ids[7],'event-1');assert.equal(event.length,1);assert.equal(Number(event[0].ticketId),ids[7]);assert.equal(event[0].selectionReason,'EVENT_TICKET');
  for(const id of [waiting,closed,assigned,rework,rejected,halted,999999])assert.equal((await claim(id,'ignored-event')).length,0);
  assert.equal((await claim(ids[7],'event-2')).length,0);
  assert.equal((await finish(event[0],'event-1')).released,true);
 });
 await test('Overlapping recovery and duplicate callbacks cannot claim an already owned ticket',async()=>{
  const second=await claim(null,'recovery-2');assert.equal(second.length,1);assert.notEqual(second[0].ticketId,first[0].ticketId);
  assert.equal((await claim(ids[0],'recovery-1')).length,0);
  assert.equal((await claim(ids[0],'other-worker')).length,0);
  assert.equal((await finish(first[0],'other-worker')).released,false);
  assert.equal((await finish(first[0],'recovery-1')).released,true);
  assert.equal((await finish(second[0],'recovery-2')).released,true);
 });
 await test('Recovery gives older unfinished tickets a turn before reselecting previously handled work',async()=>{
  await q('UPDATE cbm_dispatch_queue_visits SET lease_until=NULL,lease_token=NULL,last_selected_at=NULL');
  const selected=[];for(let i=0;i<ids.length+1;i++){const b=await claim(null,'fair-'+i);selected.push(Number(b[0].ticketId));assert.equal((await finish(b[0],'fair-'+i)).released,true);}
  assert.deepEqual(selected,[...ids,ids[0]]);
 });
 await test('Expired claims are recoverable and stale tokens cannot finish newer work',async()=>{
  const a=(await claim(ids[0],'expired-worker'))[0];await q("UPDATE cbm_dispatch_queue_visits SET lease_until=clock_timestamp()-interval '1 second' WHERE ticket_id=$1",[a.ticketId]);
  const b=(await claim(ids[0],'replacement-worker'))[0];assert.ok(b);assert.notEqual(a.leaseToken,b.leaseToken);
  assert.equal((await finish(a,'expired-worker')).released,false);
  assert.equal((await finish(b,'replacement-worker')).released,true);
 });
 await test('No eligible ticket returns zero rows and a missing execution ID is rejected',async()=>{
  for(let i=0;i<ids.length;i++)assert.equal((await claim(null,'occupy-'+i)).length,1);
  assert.equal((await claim(null,'empty-recovery')).length,0);
  await assert.rejects(()=>claim(null,''),/Execution ID is required/);
  await q('UPDATE cbm_dispatch_queue_visits SET lease_until=NULL,lease_token=NULL');
 });
 await test('Bound context includes issue, exact asset, severity, skill and authorization',async()=>{
  const c=await context(ids[0]);assert.equal(c.ticket.id,ids[0]);assert.equal(c.ticket.description,'Door scrapes against the frame and does not close fully.');assert.equal(c.ticket.asset.class,'IfcDoor');assert.equal(c.ticket.severity,2);assert.equal(c.authorization.approved,true);
  fs.writeFileSync(path.join(out,'get-context-example.json'),JSON.stringify(c,null,2)+'\n');
  fs.writeFileSync(path.join(out,'get-context-tool-output.json'),JSON.stringify([{context:c}],null,2)+'\n');
 });
 await test('Approved ticket runs through offering, later POST acceptance and assignment notices',async()=>{
  const id=ids[0];await op(id,'initialize');await op(id,'send_notices',{noticeKey:'opening'});
  let c=await context(id);c=await op(id,'offer_next',{technicianId:c.available_candidate_ids[0],knowledgeChunkIds:'[]'});
  assert.equal(c.outcome,'WAITING');assert.equal(c.active_offer_count,1);
  fs.writeFileSync(path.join(out,'get-context-waiting-example.json'),JSON.stringify(c,null,2)+'\n');
  const row=(await q(sql.LOAD,[JSON.stringify({ticketId:id})]))[0].context,offer=row.state.offers[0];
  assert.equal((await q(sql.RECORD_RESPONSE,[id,offer.id,offer.token,'accept']))[0].response_result.recorded,true);
  c=await op(id,'process_events');assert.equal(c.status,'ASSIGNED');
  for(const n of c.notices.filter(n=>n.status==='PENDING'))c=await op(id,'send_notices',{noticeKey:n.key});
  assert.equal(c.outcome,'ASSIGNED');assert.ok(!c.notices.some(n=>n.status==='PENDING'));
  fs.writeFileSync(path.join(out,'dispatch-example-trace.json'),JSON.stringify(trace,null,2)+'\n');
 });
 await test('Context does not repeat saved excerpts, private tokens or email bodies',async()=>{
  const id=ids[0],row=(await q(sql.LOAD,[JSON.stringify({ticketId:id})]))[0].context;
  const baseline=JSON.stringify(await context(id)).length;
  row.state.offers[0].technical_knowledge={status:'VERIFIED',chunks:Array.from({length:3},(_,i)=>({content:'PRIVATE_EXCERPT'.repeat(200),metadata:{chunk_id:'chunk-'+i}}))};
  await q(sql.COMMIT,[id,row.revision,JSON.stringify(row.state),false]);
  const c=await context(id),text=JSON.stringify(c);assert.ok(!text.includes('PRIVATE_EXCERPT'));assert.ok(!text.includes(row.state.offers[0].token));assert.ok(!text.includes('<h3>'));assert.ok(text.length-baseline<200);assert.equal(c.offers[0].knowledge.chunk_ids.length,3);
  fs.writeFileSync(path.join(out,'context-size.json'),JSON.stringify({initial_example_pretty_characters:fs.readFileSync(path.join(out,'get-context-example.json'),'utf8').length,compact_waiting_characters:JSON.stringify(JSON.parse(fs.readFileSync(path.join(out,'get-context-waiting-example.json'),'utf8'))).length,compact_assigned_characters:baseline,assigned_with_saved_excerpts_characters:text.length,note:'Character sizes, not measured provider token counts. Saved excerpts remain available in the DB/email snapshot.'},null,2)+'\n');
 });
 fs.writeFileSync(path.join(out,'queue-validation.json'),JSON.stringify({passed,realEmailsSent:0,modelCalls:0},null,2)+'\n');await db.close();console.log(passed.length+' queue/context tests passed.');
}
main().catch(async e=>{console.error(e);if(db)await db.close();process.exitCode=1;});
