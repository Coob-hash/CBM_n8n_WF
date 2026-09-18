'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..');
const runtime=process.env.CBM_PGLITE_PATH || path.join(root,'cbm/app/phase_b/.test-runtime/pglite/dist/index.cjs');
if(!fs.existsSync(runtime))throw new Error('Run node phase_b/setup-test-runtime.js or set CBM_PGLITE_PATH to a PGlite 0.5.8 index.cjs.');
const {PGlite}=require(runtime);
const migrations=fs.readdirSync(path.join(root,'database/migrations')).filter(n=>n.endsWith('.sql')).sort();
const results=[];let serial=0,db,base;
const rollback=Symbol('rollback fixture');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
async function one(tx,sql,args=[]){return (await tx.query(sql,args)).rows[0];}
async function id(tx,sql,args=[]){return (await one(tx,sql,args)).id;}
async function reject(tx,sql,args=[],pattern){
 await tx.exec('SAVEPOINT negative_case');let failure;
 try{await tx.query(sql,args);await tx.exec('SET CONSTRAINTS ALL IMMEDIATE');}catch(e){failure=e;}
 await tx.exec('ROLLBACK TO SAVEPOINT negative_case');await tx.exec('RELEASE SAVEPOINT negative_case');
 assert.ok(failure,'Expected database rejection: '+sql);if(pattern)assert.match(failure.message,pattern);
}
async function check(name,fn){
 try{await db.transaction(async tx=>{await tx.query("SELECT set_config('cbm.actor_id',$1,true)",[String(base.system)]);await fn(tx);await tx.exec('SET CONSTRAINTS ALL IMMEDIATE');throw rollback;});}
 catch(e){if(e!==rollback)throw e;}
 results.push(name);console.log('PASS '+name);
}
async function photo(tx,kind='image/jpeg'){
 return id(tx,"INSERT INTO cbm.files(provider,object_id,revision_key,uri,mime_type) VALUES('TEST',$1,'1',$2,$3) RETURNING id",['file-'+(++serial),'https://example.test/file/'+serial,kind]);
}
async function ticket(tx,severity=4){
 const f=await photo(tx);
 const report=await id(tx,"INSERT INTO cbm.reports(source_key,source_file_id) VALUES($1,$2) RETURNING id",['report-'+serial,f]);
 const asset=await id(tx,"INSERT INTO cbm.assets(ifc_global_id,ifc_class,first_seen_version_id,last_seen_version_id) VALUES($1,'IfcDoor',$2,$2) RETURNING id",['guid-'+serial,base.bim]);
 const loc=await id(tx,"INSERT INTO cbm.localization_attempts(report_id,input_file_id,registration_id,observed_map_code,bim_version_id,asset_id,map_x,map_y,map_z,ifc_x,ifc_y,ifc_z,confidence,result) VALUES($1,$2,$3,'map-A',$4,$5,0,0,0,0,0,0,0.95,'MATCHED') RETURNING id",[report,f,base.registration,base.bim,asset]);
 const assessment=await id(tx,"INSERT INTO cbm.assessments(purpose,result_status,report_id,before_file_id,assessor_actor_id,model,prompt_version,category,severity,required_skill_id) VALUES('TRIAGE','SUCCEEDED',$1,$2,$3,'test-model','v1','door',$4,$5) RETURNING id",[report,f,base.agent,severity,base.skill]);
 const tid=await id(tx,"INSERT INTO cbm.tickets(status,asset_id,selected_localization_id,adopted_triage_assessment_id,category,severity,description,required_skill_id,responsible_fm_actor_id) VALUES('LOCALIZED',$1,$2,$3,'door',$4,'Broken door',$5,$6) RETURNING id",[asset,loc,assessment,severity,base.skill,base.fm]);
 await tx.query("UPDATE cbm.reports SET ticket_id=$1,attachment_kind='INITIAL',status='LINKED' WHERE id=$2",[tid,report]);
 return {id:tid,report,asset,file:f,loc,assessment,severity};
}
async function message(tx,t,purpose='FM_OPENING',offer=null){
 const recipient=offer?base.techs[offer.techIndex]:base.fm;
 const email=(await one(tx,'SELECT email FROM cbm.actors WHERE id=$1',[recipient])).email;
 return id(tx,"INSERT INTO cbm.messages(idempotency_key,ticket_id,offer_id,recipient_actor_id,recipient_address,purpose,template_version,subject,body) VALUES($1,$2,$3,$4,$5,$6,'v1','Test','Test body') RETURNING id",['message-'+(++serial),t.id,offer?.id||null,recipient,email,purpose]);
}
async function send(tx,mid){const a=await one(tx,'SELECT * FROM cbm.claim_message($1,\'test-account\')',[mid]);await tx.query('SELECT cbm.record_delivery($1,$2)',[a.id,'receipt-'+(++serial)]);return a;}
async function dispatch(tx,severity=4){const t=await ticket(tx,severity);t.dispatch=(await one(tx,'SELECT cbm.initialize_dispatch($1) AS id',[t.id])).id;await send(tx,await message(tx,t));return t;}
async function offer(tx,t,techIndex=0){
 const token='opaque-test-token-'+(++serial);
 const o=await one(tx,'SELECT * FROM cbm.reserve_offer($1,$2,$3)',[t.dispatch,base.techs[techIndex],hash(token)]);
 o.token=token;o.techIndex=techIndex;const mid=await message(tx,t,'TECHNICIAN_OFFER',o);o.attempt=await send(tx,mid);
 return {...o,...await one(tx,'SELECT * FROM cbm.offers WHERE id=$1',[o.id])};
}
async function assigned(tx,severity=4){const t=await dispatch(tx,severity);t.offer=await offer(tx,t);await tx.query('SELECT cbm.record_offer_response($1,$2,\'ACCEPT\')',[t.offer.public_reference,t.offer.token]);t.assignment=(await one(tx,'SELECT cbm.process_responses($1) AS id',[t.dispatch])).id;return t;}
async function completion(tx,t,prior=null){
 const c=await id(tx,"INSERT INTO cbm.completion_submissions(assignment_id,submission_number,source_key,submitted_by_actor_id,supersedes_completion_id) VALUES($1,$2,$3,$4,$5) RETURNING id",[t.assignment,prior?2:1,'completion-'+(++serial),base.techs[0],prior]);
 const f=await photo(tx);await tx.query('INSERT INTO cbm.completion_files(completion_id,file_id) VALUES($1,$2)',[c,f]);
 const assessment=await id(tx,"INSERT INTO cbm.assessments(purpose,result_status,completion_id,before_file_id,after_file_id,assessor_actor_id,model,prompt_version,repair_verified,confidence) VALUES('REPAIR_VERIFICATION','SUCCEEDED',$1,$2,$3,$4,'test-model','v1',false,0.6) RETURNING id",[c,t.file,f,base.agent]);
 const approval=await id(tx,"INSERT INTO cbm.approval_requests(completion_id,verification_assessment_id,requested_from_actor_id,request_sequence,expires_at,token_digest) VALUES($1,$2,$3,1,clock_timestamp()+interval '72 hours',$4) RETURNING id",[c,assessment,base.fm,hash('review-token')]);
 await tx.query("UPDATE cbm.completion_submissions SET status='PENDING_APPROVAL' WHERE id=$1",[c]);
 await tx.query("UPDATE cbm.tickets SET status='PENDING_APPROVAL' WHERE id=$1",[t.id]);
 return {id:c,file:f,assessment,approval};
}

async function main(){
 db=new PGlite();
 for(const file of migrations)await db.transaction(tx=>tx.exec(fs.readFileSync(path.join(root,'database/migrations',file),'utf8')));
 const tables=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='cbm' ORDER BY tablename")).rows.map(r=>r.tablename);
 const proposed=[...fs.readFileSync(path.join(root,'cbm/app/docs/database_schema_proposal.md'),'utf8').matchAll(/^\| `([a-z_]+)` \|/gm)].map(m=>m[1]).sort();
 assert.deepEqual(tables,proposed);console.log('PASS All 27 approved tables exist');results.push('All 27 approved tables exist');
 base=await db.transaction(async tx=>{
  const system=(await one(tx,"SELECT id FROM cbm.actors WHERE external_identity='cbm.database'")).id;
  await tx.query("SELECT set_config('cbm.actor_id',$1,true)",[String(system)]);
  const fm=await id(tx,"INSERT INTO cbm.actors(kind,name,email) VALUES('HUMAN','FM','fm@example.test') RETURNING id");
  const agent=await id(tx,"INSERT INTO cbm.actors(kind,name,external_identity) VALUES('AGENT','Dispatch agent','test.agent') RETURNING id");
  await tx.query("INSERT INTO cbm.site_settings(building_code,building_name,facility_manager_actor_id) VALUES('building-A','Test building',$1)",[fm]);
  const skill=(await one(tx,"SELECT id FROM cbm.skills WHERE code='carpentry'")).id;
  const techs=[];for(let i=0;i<6;i++){
   const tech=await id(tx,"INSERT INTO cbm.actors(kind,name,email) VALUES('HUMAN',$1,$2) RETURNING id",['Technician '+i,'tech'+i+'@example.test']);techs.push(tech);
   await tx.query("INSERT INTO cbm.technician_profiles(actor_id,rating,rating_source) VALUES($1,$2,'test fixture')",[tech,5-i*.1]);
   await tx.query('INSERT INTO cbm.technician_skills(technician_actor_id,skill_id) VALUES($1,$2)',[tech,skill]);
  }
  const file=await photo(tx,'application/x-step');
  const bim=await id(tx,"INSERT INTO cbm.bim_versions(version_label,file_id,is_current,published_at) VALUES('v1',$1,true,clock_timestamp()) RETURNING id",[file]);
  const registration=await id(tx,"INSERT INTO cbm.map_registrations(map_code,registration_revision,reference_bim_version_id,axis_convention,transform) VALUES('map-A',1,$1,'identity',ARRAY[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]::float8[]) RETURNING id",[bim]);
  return {system,fm,agent,skill,techs,bim,registration};
 });
 await check('Singleton site and human-only FM and technicians',async tx=>{
  await reject(tx,"INSERT INTO cbm.site_settings(id,building_code,building_name,facility_manager_actor_id) VALUES(2,'B','B',$1)",[base.fm]);
  await reject(tx,'INSERT INTO cbm.technician_profiles(actor_id) VALUES($1)',[base.agent],/human/i);
  await reject(tx,'UPDATE cbm.site_settings SET facility_manager_actor_id=$1',[base.agent],/human/i);
 });
 await check('Skill and rating ranges, normalized email uniqueness',async tx=>{
  await reject(tx,'UPDATE cbm.technician_profiles SET rating=7 WHERE actor_id=$1',[base.techs[0]]);
  await reject(tx,"INSERT INTO cbm.actors(kind,name,email) VALUES('HUMAN','Duplicate','FM@EXAMPLE.TEST')");
 });
 await check('Coordinates and registration matrices reject malformed evidence',async tx=>{
  await reject(tx,"INSERT INTO cbm.map_registrations(map_code,registration_revision,reference_bim_version_id,axis_convention,transform) VALUES('x',1,$1,'identity',ARRAY[[1,2],[3,4]]::float8[])",[base.bim]);
  const t=await ticket(tx);await reject(tx,"INSERT INTO cbm.localization_attempts(report_id,input_file_id,result,confidence) VALUES($1,$2,'FAILED','NaN')",[t.report,t.file]);
 });
 await check('Report idempotency and one open case per asset',async tx=>{
  const t=await ticket(tx);await reject(tx,'INSERT INTO cbm.reports(source_key,source_file_id) SELECT source_key,source_file_id FROM cbm.reports WHERE id=$1',[t.report]);
  await reject(tx,"INSERT INTO cbm.tickets(asset_id,responsible_fm_actor_id) VALUES($1,$2)",[t.asset,base.fm]);
 });
 await check('Ticket evidence must belong to that ticket, with an initial report',async tx=>{
  const t=await ticket(tx),other=await ticket(tx);await reject(tx,'UPDATE cbm.tickets SET selected_localization_id=$1 WHERE id=$2',[other.loc,t.id],/localization/i);
  await reject(tx,'INSERT INTO cbm.tickets(responsible_fm_actor_id) VALUES($1)',[base.fm],/initial report/i);
 });
 await check('Failed AI verdict cannot masquerade as a successful repair',async tx=>{
  const t=await ticket(tx);await reject(tx,"UPDATE cbm.assessments SET severity=5 WHERE id=$1",[t.assessment],/immutable/i);
 });
 await check('Initialization is idempotent and freezes five ranked candidates',async tx=>{
  const t=await dispatch(tx);assert.equal((await one(tx,'SELECT cbm.initialize_dispatch($1) AS id',[t.id])).id,t.dispatch);
  const list=(await tx.query('SELECT technician_actor_id,rank FROM cbm.dispatch_candidates WHERE dispatch_id=$1 ORDER BY rank',[t.dispatch])).rows;
  assert.equal(list.length,5);assert.deepEqual(list.map(x=>x.technician_actor_id),base.techs.slice(0,5));
 });
 await check('Opening requires a real send attempt and acknowledgement',async tx=>{
  const t=await ticket(tx);t.dispatch=(await one(tx,'SELECT cbm.initialize_dispatch($1) AS id',[t.id])).id;
  await reject(tx,'SELECT cbm.reserve_offer($1,$2,$3)',[t.dispatch,base.techs[0],hash('x')],/opening/i);
  const m=await message(tx,t);await reject(tx,"UPDATE cbm.messages SET status='ACKNOWLEDGED' WHERE id=$1",[m],/evidence/i);
 });
 await check('Ordinary offers have one slot and 48 elapsed hours',async tx=>{
  const t=await dispatch(tx,2),o=await offer(tx,t);assert.equal(new Date(o.expires_at)-new Date(o.sent_at),48*3600000);
  assert.ok(new Date(o.appointment_start)>new Date(o.expires_at));
  await reject(tx,'SELECT cbm.reserve_offer($1,$2,$3)',[t.dispatch,base.techs[1],hash('other')],/capacity/i);
 });
 await check('Urgent offers share a fixed appointment and cannot exceed two',async tx=>{
  const t=await dispatch(tx,5),a=await offer(tx,t,0),b=await offer(tx,t,1);
  assert.equal(new Date(a.appointment_start).getTime(),new Date(b.appointment_start).getTime());
  assert.ok(new Date(a.expires_at)<=new Date(a.appointment_start));
  await reject(tx,'SELECT cbm.reserve_offer($1,$2,$3)',[t.dispatch,base.techs[2],hash('third')],/capacity/i);
 });
 await check('Candidate order and offer appointment cannot be changed',async tx=>{
  const t=await dispatch(tx);await reject(tx,'SELECT cbm.reserve_offer($1,$2,$3)',[t.dispatch,base.techs[1],hash('skip')],/ranked/i);
  const o=await offer(tx,t);await reject(tx,"UPDATE cbm.offers SET appointment_start=appointment_start+interval '1 hour' WHERE id=$1",[o.id],/immutable/i);
  await reject(tx,"UPDATE cbm.offers SET expires_at=expires_at+interval '1 hour',token_expires_at=token_expires_at+interval '1 hour' WHERE id=$1",[o.id],/extend/i);
 });
 await check('Forged token rejected, repeat decision returns its original receipt',async tx=>{
  const t=await dispatch(tx),o=await offer(tx,t);await reject(tx,'SELECT cbm.record_offer_response($1,$2,\'ACCEPT\')',[o.public_reference,'bad-token'],/token/i);
  const r=await one(tx,'SELECT cbm.record_offer_response($1,$2,\'ACCEPT\') AS id',[o.public_reference,o.token]);
  assert.equal((await one(tx,'SELECT cbm.record_offer_response($1,$2,\'DECLINE\') AS id',[o.public_reference,o.token])).id,r.id);
 });
 await check('First persisted acceptance wins, second offer withdrawn atomically',async tx=>{
  const t=await dispatch(tx),a=await offer(tx,t,0),b=await offer(tx,t,1);
  await tx.query('SELECT cbm.record_offer_response($1,$2,\'ACCEPT\')',[b.public_reference,b.token]);
  await tx.query('SELECT cbm.record_offer_response($1,$2,\'ACCEPT\')',[a.public_reference,a.token]);
  const winner=(await one(tx,'SELECT cbm.process_responses($1) AS id',[t.dispatch])).id;
  assert.equal((await one(tx,'SELECT technician_actor_id FROM cbm.assignments WHERE id=$1',[winner])).technician_actor_id,base.techs[1]);
  assert.equal((await one(tx,'SELECT state FROM cbm.offers WHERE id=$1',[a.id])).state,'WITHDRAWN');
  assert.equal((await one(tx,'SELECT cbm.process_responses($1) AS id',[t.dispatch])).id,winner);
 });
 await check('Later acceptance cannot bypass an earlier unprocessed response',async tx=>{
  const t=await dispatch(tx),a=await offer(tx,t,0),b=await offer(tx,t,1);
  await tx.query('SELECT cbm.record_offer_response($1,$2,\'ACCEPT\')',[a.public_reference,a.token]);
  const r=(await one(tx,'SELECT cbm.record_offer_response($1,$2,\'ACCEPT\') AS id',[b.public_reference,b.token])).id;
  await reject(tx,"INSERT INTO cbm.assignments(ticket_id,technician_actor_id,winning_response_id,origin,assigned_by_actor_id,appointment_start,appointment_end) SELECT $1,$2,$3,'OFFER_ACCEPTANCE',$4,appointment_start,appointment_end FROM cbm.offers WHERE id=$5",[t.id,base.techs[1],r,base.system,b.id],/Earlier/i);
 });
 await check('Decline releases capacity and eligibility is checked again on acceptance',async tx=>{
  const t=await dispatch(tx,2),a=await offer(tx,t,0);await tx.query('SELECT cbm.record_offer_response($1,$2,\'DECLINE\')',[a.public_reference,a.token]);await tx.query('SELECT cbm.process_responses($1)',[t.dispatch]);
  const b=await offer(tx,t,1);await tx.query('SELECT cbm.record_offer_response($1,$2,\'ACCEPT\')',[b.public_reference,b.token]);
  await tx.query('UPDATE cbm.technician_profiles SET dispatch_enabled=false WHERE actor_id=$1',[base.techs[1]]);
  assert.equal((await one(tx,'SELECT cbm.process_responses($1) AS id',[t.dispatch])).id,null);
  assert.equal((await one(tx,'SELECT state FROM cbm.offers WHERE id=$1',[b.id])).state,'INELIGIBLE');
 });
 await check('Missing Gmail receipt halts dispatch and blocks blind retries',async tx=>{
  const t=await dispatch(tx);const m=await message(tx,t,'TEST_NOTICE');const a=await one(tx,"SELECT * FROM cbm.claim_message($1,'test')",[m]);await tx.query('SELECT cbm.record_delivery($1,NULL,\'timeout\')',[a.id]);
  assert.equal((await one(tx,'SELECT halted FROM cbm.dispatch_cases WHERE id=$1',[t.dispatch])).halted,true);
  await reject(tx,"SELECT cbm.claim_message($1,'test')",[m],/halted/i);
  await reject(tx,'UPDATE cbm.dispatch_cases SET halted=false,halt_reason=NULL WHERE id=$1',[t.dispatch],/FM/i);
 });
 await check('Completion ownership and assessed evidence remain immutable',async tx=>{
  const t=await assigned(tx),c=await completion(tx,t);const f=await photo(tx);
  await reject(tx,'INSERT INTO cbm.completion_files(completion_id,file_id,display_order) VALUES($1,$2,2)',[c.id,f],/assessed/i);
  await reject(tx,'UPDATE cbm.completion_submissions SET assignment_id=999 WHERE id=$1',[c.id],/immutable/i);
 });
 await check('AI cannot approve or close a ticket without the FM',async tx=>{
  const t=await assigned(tx),c=await completion(tx,t);await tx.query("SELECT set_config('cbm.actor_id',$1,true)",[String(base.agent)]);
  await reject(tx,'SELECT cbm.decide_approval($1,\'APPROVED\')',[c.approval],/FM/i);
  await reject(tx,"UPDATE cbm.tickets SET status='CLOSED',closed_at=clock_timestamp() WHERE id=$1",[t.id],/approval/i);
 });
 await check('FM approval overrides an advisory negative AI verdict and queues one IFC job',async tx=>{
  const t=await assigned(tx),c=await completion(tx,t);await tx.query("SELECT set_config('cbm.actor_id',$1,true)",[String(base.fm)]);
  await tx.query('SELECT cbm.decide_approval($1,\'APPROVED\')',[c.approval]);await tx.query('SELECT cbm.decide_approval($1,\'APPROVED\')',[c.approval]);
  assert.equal((await one(tx,'SELECT status FROM cbm.tickets WHERE id=$1',[t.id])).status,'CLOSED');
  assert.equal(Number((await one(tx,'SELECT count(*) AS n FROM cbm.ifc_sync_jobs WHERE approval_request_id=$1',[c.approval])).n),1);
  assert.equal(Number((await one(tx,'SELECT jobs_completed FROM cbm.technician_workload WHERE actor_id=$1',[base.techs[0]])).jobs_completed),1);
 });
 await check('Rework keeps the rejected review and creates a new completion cycle',async tx=>{
  const t=await assigned(tx),c=await completion(tx,t);await tx.query("SELECT set_config('cbm.actor_id',$1,true)",[String(base.fm)]);
  await tx.query('SELECT cbm.decide_approval($1,\'REJECTED\',\'Repair incomplete\')',[c.approval]);
  const next=await completion(tx,t,c.id);assert.notEqual(next.id,c.id);
  await reject(tx,'SELECT cbm.decide_approval($1,\'APPROVED\')',[c.approval],/immutable/i);
 });
 await check('Changing FM supersedes pending requests',async tx=>{
  const t=await assigned(tx),c=await completion(tx,t);await tx.query('UPDATE cbm.site_settings SET facility_manager_actor_id=$1',[base.techs[5]]);
  assert.equal((await one(tx,'SELECT status FROM cbm.approval_requests WHERE id=$1',[c.approval])).status,'SUPERSEDED');
 });
 await check('IFC synchronization publishes a successor without duplicate jobs or receipts',async tx=>{
  const t=await assigned(tx),c=await completion(tx,t);await tx.query("SELECT set_config('cbm.actor_id',$1,true)",[String(base.fm)]);await tx.query('SELECT cbm.decide_approval($1,\'APPROVED\')',[c.approval]);
  const job=await one(tx,'SELECT id FROM cbm.ifc_sync_jobs WHERE approval_request_id=$1',[c.approval]);
  const attempt=await one(tx,'SELECT * FROM cbm.start_ifc_sync($1,\'request\')',[job.id]);const f=await photo(tx,'application/x-step');
  const result=await one(tx,'SELECT cbm.finish_ifc_sync($1,$2,$3) AS id',[attempt.id,f,'version-'+serial]);
  assert.equal((await one(tx,'SELECT cbm.finish_ifc_sync($1,$2,$3) AS id',[attempt.id,f,'version-'+serial])).id,result.id);
  assert.equal((await one(tx,'SELECT is_current FROM cbm.bim_versions WHERE id=$1',[result.id])).is_current,true);
  assert.equal((await one(tx,'SELECT is_current FROM cbm.bim_versions WHERE id=$1',[base.bim])).is_current,false);
 });
 await check('Uncertain IFC writes block a second model writer',async tx=>{
  const t=await assigned(tx),c=await completion(tx,t);await tx.query("SELECT set_config('cbm.actor_id',$1,true)",[String(base.fm)]);await tx.query('SELECT cbm.decide_approval($1,\'APPROVED\')',[c.approval]);
  const job=await one(tx,'SELECT id FROM cbm.ifc_sync_jobs WHERE approval_request_id=$1',[c.approval]);const a=await one(tx,'SELECT * FROM cbm.start_ifc_sync($1,\'request\')',[job.id]);
  await tx.query('SELECT cbm.finish_ifc_sync($1,NULL,NULL,\'lost receipt\')',[a.id]);
  await reject(tx,'SELECT cbm.start_ifc_sync($1,\'retry\')',[job.id],/ready job/i);
 });
 await check('Audit is append-only and automatic history omits secrets and message bodies',async tx=>{
  const t=await dispatch(tx),o=await offer(tx,t);const events=(await tx.query('SELECT * FROM cbm.audit_events WHERE ticket_id=$1',[t.id])).rows;
  assert.ok(events.length>5);assert.ok(!JSON.stringify(events).includes(o.token));assert.ok(!JSON.stringify(events).includes('Test body'));
  await reject(tx,"UPDATE cbm.audit_events SET details='{}' WHERE id=$1",[events[0].id],/immutable/i);
  await reject(tx,'DELETE FROM cbm.audit_events WHERE id=$1',[events[0].id],/history/i);
  await reject(tx,'TRUNCATE cbm.audit_events',[],/history/i);
 });
 await check('Agent context omits secret digests, body and operational scripts',async tx=>{
  const t=await dispatch(tx);await offer(tx,t);const s=JSON.stringify(await one(tx,'SELECT * FROM cbm.dispatch_context WHERE ticket_id=$1',[t.id]));
  for(const forbidden of ['token_digest','Test body','next_actions','recipient_address'])assert.ok(!s.includes(forbidden));
 });
 await check('Rome business dates skip weekends and preserve local appointment hours',async tx=>{
  assert.equal(String((await one(tx,"SELECT cbm.business_date('2026-03-27',1)::text AS d")).d),'2026-03-30');
  const t=await dispatch(tx),o=await offer(tx,t);assert.equal((await one(tx,"SELECT (appointment_start AT TIME ZONE 'Europe/Rome')::time::text AS h FROM cbm.offers WHERE id=$1",[o.id])).h,'08:00:00');
 });
 // Clock-boundary fixtures are backdated by the test owner only. Guards are
 // re-enabled before exercising operations; the enclosing transaction rolls back.
 await check('An expired offer cannot accept even before the recovery worker runs',async tx=>{
  const t=await dispatch(tx,2),o=await offer(tx,t);
  await tx.exec('ALTER TABLE cbm.offers DISABLE TRIGGER USER');
  await tx.query("UPDATE cbm.offers SET reserved_at=statement_timestamp()-interval '50 hours',sent_at=statement_timestamp()-interval '49 hours',expires_at=statement_timestamp()-interval '1 hour',token_expires_at=statement_timestamp()-interval '1 hour' WHERE id=$1",[o.id]);
  await tx.exec('ALTER TABLE cbm.offers ENABLE TRIGGER USER');
  await reject(tx,'SELECT cbm.record_offer_response($1,$2,\'ACCEPT\')',[o.public_reference,o.token],/expired/i);
  assert.equal((await one(tx,'SELECT cbm.expire_offers($1) AS n',[t.dispatch])).n,1);
 });
 await check('A timely persisted acceptance survives delayed processing after its deadline',async tx=>{
  const t=await dispatch(tx,2),o=await offer(tx,t);const r=await one(tx,'SELECT cbm.record_offer_response($1,$2,\'ACCEPT\') AS id',[o.public_reference,o.token]);
  await tx.exec('ALTER TABLE cbm.offers DISABLE TRIGGER USER; ALTER TABLE cbm.offer_responses DISABLE TRIGGER USER');
  await tx.query("UPDATE cbm.offers SET reserved_at=statement_timestamp()-interval '50 hours',sent_at=statement_timestamp()-interval '49 hours',expires_at=statement_timestamp()-interval '1 hour',token_expires_at=statement_timestamp()-interval '1 hour' WHERE id=$1",[o.id]);
  await tx.query("UPDATE cbm.offer_responses SET received_at=clock_timestamp()-interval '2 hours' WHERE id=$1",[r.id]);
  await tx.exec('ALTER TABLE cbm.offers ENABLE TRIGGER USER; ALTER TABLE cbm.offer_responses ENABLE TRIGGER USER');
  await reject(tx,'SELECT cbm.expire_offers($1)',[t.dispatch],/responses/i);
  assert.ok((await one(tx,'SELECT cbm.process_responses($1) AS id',[t.dispatch])).id);
 });
 await check('Approval timeout is distinct from rejection and preserves pending ticket',async tx=>{
  const t=await assigned(tx),c=await completion(tx,t);
  await tx.exec('ALTER TABLE cbm.approval_requests DISABLE TRIGGER USER');
  await tx.query("UPDATE cbm.approval_requests SET requested_at=clock_timestamp()-interval '73 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[c.approval]);
  await tx.exec('ALTER TABLE cbm.approval_requests ENABLE TRIGGER USER');
  await tx.query("SELECT set_config('cbm.actor_id',$1,true)",[String(base.fm)]);
  await reject(tx,'SELECT cbm.decide_approval($1,\'APPROVED\')',[c.approval],/expired/i);
  await tx.query('SELECT cbm.expire_approval($1)',[c.approval]);
  assert.equal((await one(tx,'SELECT status FROM cbm.tickets WHERE id=$1',[t.id])).status,'PENDING_APPROVAL');
  assert.equal((await one(tx,'SELECT status FROM cbm.approval_requests WHERE id=$1',[c.approval])).status,'EXPIRED');
 });
 await check('Five-minute lost-receipt watchdog persists an uncertain delivery halt',async tx=>{
  const t=await dispatch(tx),m=await message(tx,t,'TEST_NOTICE');const a=await one(tx,"SELECT * FROM cbm.claim_message($1,'test')",[m]);
  await tx.exec('ALTER TABLE cbm.message_attempts DISABLE TRIGGER USER');
  await tx.query("UPDATE cbm.message_attempts SET claimed_at=clock_timestamp()-interval '6 minutes' WHERE id=$1",[a.id]);
  await tx.exec('ALTER TABLE cbm.message_attempts ENABLE TRIGGER USER');
  assert.equal((await one(tx,'SELECT cbm.mark_overdue_deliveries() AS n')).n,1);
  assert.equal((await one(tx,'SELECT halted FROM cbm.dispatch_cases WHERE id=$1',[t.dispatch])).halted,true);
 });
 await check('Confirmed unsent notice can be retried only after FM reconciliation and resume',async tx=>{
  const t=await dispatch(tx),m=await message(tx,t,'TEST_NOTICE');const a=await one(tx,"SELECT * FROM cbm.claim_message($1,'test')",[m]);await tx.query('SELECT cbm.record_delivery($1,NULL,\'timeout\')',[a.id]);
  await tx.query("SELECT set_config('cbm.actor_id',$1,true)",[String(base.fm)]);
  await reject(tx,'SELECT cbm.resume_dispatch($1,\'reviewed\')',[t.dispatch],/Resolve/i);
  await tx.query('SELECT cbm.reconcile_delivery($1,false,NULL,\'Provider confirms no send\')',[a.id]);
  await tx.query('SELECT cbm.resume_dispatch($1,\'Delivery reconciled\')',[t.dispatch]);
  const b=await one(tx,"SELECT * FROM cbm.claim_message($1,'test')",[m]);assert.equal(b.attempt_number,2);
 });
 await check('Acknowledged messages cannot be reset for duplicate delivery',async tx=>{
  const t=await dispatch(tx);const m=await message(tx,t,'TEST_NOTICE');await send(tx,m);
  await reject(tx,"UPDATE cbm.messages SET status='PENDING' WHERE id=$1",[m],/Terminal/i);
  await reject(tx,"SELECT cbm.claim_message($1,'test')",[m],/claim/i);
 });
 await check('Three execution failures halt an initialized dispatch',async tx=>{
  const t=await dispatch(tx);
  for(let n=1;n<=3;n++)assert.equal((await one(tx,'SELECT cbm.record_dispatch_failure($1,\'Tool unavailable\') AS n',[t.id])).n,n);
  const d=await one(tx,'SELECT halted,next_recovery_at FROM cbm.dispatch_cases WHERE id=$1',[t.dispatch]);assert.equal(d.halted,true);assert.equal(d.next_recovery_at,null);
 });
 await check('Exhausted shortlist escalates but available candidates block premature escalation',async tx=>{
  const t=await dispatch(tx,2);await reject(tx,'SELECT cbm.escalate_dispatch($1)',[t.dispatch],/candidates/i);
  for(let i=0;i<5;i++){const o=await offer(tx,t,i);await tx.query('SELECT cbm.record_offer_response($1,$2,\'DECLINE\')',[o.public_reference,o.token]);await tx.query('SELECT cbm.process_responses($1)',[t.dispatch]);}
  await tx.query('SELECT cbm.escalate_dispatch($1)',[t.dispatch]);assert.equal((await one(tx,'SELECT status FROM cbm.tickets WHERE id=$1',[t.id])).status,'ESCALATED');
 });
 await check('Offer and response foreign keys cannot cross dispatch boundaries',async tx=>{
  const t=await dispatch(tx),other=await dispatch(tx),o=await offer(tx,t);
  await reject(tx,"INSERT INTO cbm.offer_responses(offer_id,dispatch_id,decision,receipt_order,verification_basis) VALUES($1,$2,'ACCEPT',1,'TOKEN')",[o.id,other.dispatch],/invalid/i);
 });
 await check('Failed migration transaction leaves no partial application schema',async()=>{
  const isolated=new PGlite();try{
   let failed=false;try{await isolated.transaction(tx=>tx.exec(fs.readFileSync(path.join(root,'database/migrations/001_tables.sql'),'utf8')+'\nSELECT nonexistent_migration_function();'));}catch{failed=true;}
   assert.equal(failed,true);assert.equal((await one(isolated,"SELECT to_regnamespace('cbm') AS n")).n,null);
  }finally{await isolated.close();}
 });
 await check('Direct early expiry and forged processed responses cannot skip dispatch policy',async tx=>{
  const t=await dispatch(tx),o=await offer(tx,t);
  await reject(tx,"UPDATE cbm.offers SET state='EXPIRED',terminal_at=clock_timestamp() WHERE id=$1",[o.id],/deadline/i);
  await reject(tx,"UPDATE cbm.offers SET state='DECLINED',terminal_at=clock_timestamp() WHERE id=$1",[o.id],/response/i);
  const r=await one(tx,'SELECT cbm.record_offer_response($1,$2,\'ACCEPT\') AS id',[o.public_reference,o.token]);
  await reject(tx,"UPDATE cbm.offer_responses SET processing_state='APPLIED',processed_at=clock_timestamp() WHERE id=$1",[r.id],/outcome/i);
  await reject(tx,"UPDATE cbm.offer_responses SET processing_state='SUPERSEDED',processed_at=clock_timestamp() WHERE id=$1",[r.id],/assignment/i);
 });
 await check('Urgent scheduling cannot be postponed in a direct dispatch insert',async tx=>{
  const t=await ticket(tx,5);
  await reject(tx,"INSERT INTO cbm.dispatch_cases(ticket_id,severity_snapshot,max_active_offers,urgent_start,urgent_end) VALUES($1,5,2,clock_timestamp()+interval '5 days',clock_timestamp()+interval '5 days 2 hours')",[t.id],/next business day/i);
 });
 await check('New schema coexists with legacy public tables without changing them',async()=>{
  const isolated=new PGlite();try{
   await isolated.exec(fs.readFileSync(path.join(root,'database/schema.sql'),'utf8'));
   const old=await one(isolated,'SELECT count(*)::int AS n FROM public.technicians');
   for(const file of migrations)await isolated.transaction(tx=>tx.exec(fs.readFileSync(path.join(root,'database/migrations',file),'utf8')));
   assert.equal((await one(isolated,'SELECT count(*)::int AS n FROM public.technicians')).n,old.n);
   assert.equal((await one(isolated,'SELECT count(*)::int AS n FROM cbm.technician_profiles')).n,0);
  }finally{await isolated.close();}
 });
 const report={passed:results.length,tests:results,domain_tables:tables.length,sql_runtime:'PGlite 0.5.8',live_postgres_server_tested:false,parallel_server_sessions_tested:false,live_n8n_or_providers_called:false,migrations:migrations.map(file=>({file,sha256:hash(fs.readFileSync(path.join(root,'database/migrations',file)))}))};
 fs.writeFileSync(path.join(root,'database/validation-report.json'),JSON.stringify(report,null,2)+'\n');
 await db.close();console.log(`\n${results.length} database tests passed.`);
}
main().catch(async e=>{console.error(e.message);if(e.where)console.error(e.where);if(e.stack)console.error(e.stack);if(db)await db.close();process.exitCode=1;});
