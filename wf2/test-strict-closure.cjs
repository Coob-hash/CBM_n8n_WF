const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const app=path.resolve(__dirname,'..');
const {PGlite}=require(path.join(app,'phase_b/.test-runtime/pglite/dist/index.cjs'));
const wf=JSON.parse(fs.readFileSync(path.join(app,'n8n_wf2_completion_approval_ifc_update.json')));
const helper=JSON.parse(fs.readFileSync(path.join(__dirname,'workflows/log_ifc_maintenance.json')));
const notices=JSON.parse(fs.readFileSync(path.join(__dirname,'workflows/notify_fm.json')));
const node=(name)=>wf.nodes.find(n=>n.name===name);
const db=new PGlite();let checks=0;
const check=(label,condition)=>{assert(condition,label);checks++;console.log('PASS '+label);};
const query=async(sql,params=[]) => (await db.query(sql,params)).rows;
const outcome=async c=>(await query('SELECT cbm_wf2_closure_outcome($1::jsonb) AS x',[c]))[0].x;
const close=async c=>(await query(node('close_ticket').parameters.query,[c]))[0].result;
const claim=async(c,noticeRecipient)=>(await query('SELECT cbm_wf2_claim_notice($1::jsonb) AS x',[{...c,noticeRecipient}]))[0].x;
const record=async (r,id,status='SENT')=>(await query('SELECT cbm_wf2_record_notice($1::jsonb) AS x',[{...r,send_status:status,message_id:id}]))[0].x;
const event=async(tid,event,payload)=>query('INSERT INTO ticket_events(ticket_id,event,payload) VALUES($1,$2,$3)',[tid,event,payload]);
async function fixture(decision='APPROVED'){
 const t=(await query("INSERT INTO tickets(status,technician_id,approval_id) VALUES('PENDING_APPROVAL',1,gen_random_uuid()) RETURNING *"))[0];
 const c={ticketId:t.id,approvalId:t.approval_id,operationKey:`wf2:${t.id}:${t.approval_id}`,decision,fmEmail:'fm@example.com',rejectionReason:'FM rejected the completion.'};
 await event(t.id,'CBM_WF2_APPROVAL',{approval_id:t.approval_id,decision});return c;
}
async function main(){
 for(const file of ['schema.sql','schema_wf2_completion.sql','schema_release_review.sql','schema_wf2_strict_closure.sql','schema_wf2_strict_closure.sql'])await db.exec(fs.readFileSync(path.join(app,file),'utf8'));
 check('migration is idempotent',true);
 const c=await fixture();
 check('no IFC receipt blocks closure',(await close(c)).status==='BLOCKED');
 await event(c.ticketId,'CBM_WF2_ATTEMPT',{operation_key:c.operationKey,outcome:'FAILED'});
 check('failed IFC attempt blocks closure',(await close(c)).status==='BLOCKED');
 await event(c.ticketId,'CBM_WF2_IFC_RESULT',{operation_key:c.operationKey,outcome:'SKIPPED'});
 check('skipped IFC update blocks closure',(await close(c)).status==='BLOCKED');
 await query('UPDATE tickets SET ifc_new_version=$2 WHERE id=$1',[c.ticketId,'model_v2.ifc']);
 check('version without success proof blocks closure',(await close(c)).status==='BLOCKED');
 await event(c.ticketId,'CBM_WF2_IFC_RESULT',{operation_key:'old-cycle',outcome:'SUCCEEDED',version_file:'model_v2.ifc'});
 check('old IFC receipt cannot authorize closure',(await close(c)).status==='BLOCKED');
 await event(c.ticketId,'CBM_WF2_IFC_RESULT',{operation_key:c.operationKey,outcome:'SUCCEEDED',version_file:'different.ifc'});
 check('mismatched IFC version blocks closure',(await close(c)).status==='BLOCKED');
 let guarded=false;try{await query("UPDATE tickets SET status='CLOSED',closed_at=now() WHERE id=$1",[c.ticketId]);}catch(e){guarded=/Closure requires/.test(e.message);}
 check('database trigger rejects direct closure without proof',guarded);
 check('premature closure email is blocked',(await claim(c,'technician')).send_status==='BLOCKED');
 const persist=helper.nodes.find(n=>n.name==='Persist IFC Result').parameters.query;
 const saved=(await query(persist,[c.ticketId,c.approvalId,'model_v2.ifc','SUCCEEDED',c.operationKey,'IFC wrote the version']))[0];
 check('real helper persistence returns success',saved.status==='SUCCEEDED');
 check('successful IFC update allows closure',(await close(c)).status==='CLOSED');
 check('close is idempotent',(await close(c)).changed===false);
 check('CLOSED alone is not settled',!(await outcome(c)).settled);
 await query(node('update_technician_stats').parameters.query,[c]);
 await query(node('update_technician_stats').parameters.query,[c]);
 check('stats increment exactly once',(await query('SELECT jobs_completed FROM technicians WHERE id=1'))[0].jobs_completed===1);
 const fm=await claim(c,'fm');check('FM notice can be claimed once',fm.send_status==='SEND');
 check('unconfirmed claim prevents duplicate sends',(await claim(c,'fm')).send_status==='UNCONFIRMED');
 await record(fm,null);check('no Gmail ID cannot settle',(await outcome(c)).settled===false);
 await record(fm,'gmail-fm-1');check('Gmail message ID creates FM receipt',(await claim(c,'fm')).send_status==='SENT');
 check('missing technician receipt prevents settlement',!(await outcome(c)).settled);
 const tech=await claim(c,'technician');await record(tech,'gmail-tech-1');
 check('all required objectives settle approval',(await outcome(c)).settled===true);
 await record(tech,'gmail-tech-1');
 check('receipt recording is idempotent',(await query("SELECT count(*)::int AS n FROM ticket_events WHERE ticket_id=$1 AND event='CBM_WF2_NOTICE'",[c.ticketId]))[0].n===2);
 check('stale approval cannot settle',!(await outcome({...c,approvalId:'00000000-0000-4000-8000-000000000000'})).settled);
 const reject=await fixture('REJECTED');
 check('rework notice blocked before state change',(await claim(reject,'technician')).send_status==='BLOCKED');
 await query(node('reopen_for_rework').parameters.query,[reject]);
 check('REWORK without technician notice is incomplete',!(await outcome(reject)).settled);
 await event(reject.ticketId,'CBM_WF2_NOTICE',{approval_id:'old',notice_key:'technician:rework',source:'GMAIL_API',outcome:'SENT',message_id:'old-message',recipient:'mario.rossi@example.com'});
 await event(reject.ticketId,'CBM_WF2_NOTICE',{approval_id:reject.approvalId,notice_key:'technician:rework',outcome:'SENT'});
 check('old and agent-written claims are not receipts',!(await outcome(reject)).settled);
 const rc=await claim(reject,'technician');await record(rc,'gmail-rework-1');
 check('rejection settles with required technician receipt',(await outcome(reject)).settled);
 check('FM closure notice is not sent for rejection',(await claim(reject,'fm')).send_status==='BLOCKED');
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const gmailSource=notices.nodes.find(n=>n.name==='Validate Gmail Receipt').parameters.jsCode;
 const norm=async response=>(await new AsyncFunction('$input','$',gmailSource)({first:()=>({json:response})},()=>({first:()=>({json:tech})})))[0].json;
 check('Gmail error cannot become SENT',(await norm({error:{message:'unauthorized'}})).send_status==='UNCONFIRMED');
 check('empty Gmail output cannot become SENT',(await norm({})).send_status==='UNCONFIRMED');
 check('Gmail success retains provider message ID',(await norm({id:'real-message'})).message_id==='real-message');
 const ifcSource=helper.nodes.find(n=>n.name==='Normalize IFC Result').parameters.jsCode;
 const normalizeIfc=async response=>(await new AsyncFunction('$json','$',ifcSource)(response,()=>({first:()=>({json:{ifc_global_id:'asset-1',context:c}})})))[0].json;
 check('missing IFC element fails closed',(await normalizeIfc({skipped:true})).status==='FAILED');
 check('wrong IFC element fails closed',(await normalizeIfc({global_id:'asset-2',version_file:'model_v2.ifc'})).status==='FAILED');
 check('matching IFC service response succeeds',(await normalizeIfc({global_id:'asset-1',version_file:'model_v2.ifc'})).status==='SUCCEEDED');
 check('agent audit tool cannot forge notice events',!node('record_attempt').parameters.query.includes('CBM_WF2_NOTICE'));
 check('settled gate uses database verdict',node('Closure Settled?').parameters.conditions.conditions[0].leftValue==='={{ $json.settled === true }}');
 for(const flow of [wf,helper,notices]){
  const names=new Set(flow.nodes.map(n=>n.name));
  for(const [from,c] of Object.entries(flow.connections)){assert(names.has(from));for(const list of Object.values(c))for(const branch of list)for(const edge of branch)assert(names.has(edge.node),edge.node);}
 }
 console.log(`${checks} strict closure checks passed.`);await db.close();
}
main().catch(async e=>{console.error(e);await db.close();process.exitCode=1;});
