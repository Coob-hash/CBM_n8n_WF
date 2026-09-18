const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {PGlite}=require('../phase_b/.test-runtime/pglite/dist/index.cjs');
const db=new PGlite(),app=path.resolve(__dirname,'..');let count=0;
const check=(s,v)=>{assert(v,s);count++;console.log('PASS '+s);};
const q=async(s,p=[])=>(await db.query(s,p)).rows;
const call=async(name,p)=>(await q('SELECT '+name+'($1::jsonb) AS r',[p]))[0].r;
const access=p=>call('cbm_technician_report_access',p);
const claim=p=>call('cbm_claim_technician_report',p);
const issue=async id=>(await q('SELECT cbm_issue_technician_report_link($1) AS r',[id]))[0].r;
async function fixture(){
 const t=(await q("INSERT INTO tickets(status,technician_id,ifc_name,ifc_global_id,description) VALUES('ASSIGNED',1,'Radiator',gen_random_uuid()::text,'A leaking radiator') RETURNING id"))[0];
 await q("INSERT INTO ticket_events(ticket_id,event,payload) VALUES($1,'CBM_DISPATCH_STATE',$2)",[t.id,{status:'ASSIGNED',assignee:1,offers:[{id:'accepted-offer',status:'ACCEPTED',technician_id:1}],messages:{},audit:[]}]);return t.id;
}
async function main(){
 for(const f of ['schema.sql','schema_wf2_completion.sql','schema_release_review.sql','technician_portal/schema.sql','technician_portal/schema.sql'])await db.exec(fs.readFileSync(path.join(app,'../../database',f),'utf8'));
 check('migration is repeatable',true);
 const id=await fixture(),p=await issue(id);check('assigned ticket obtains a private 64-character token',p.token.length===64);
 check('repeated issue reuses the current valid token',(await issue(id)).token===p.token);
 let a=await access(p);check('valid link provides database-owned identity',a.status==='OK'&&a.fields.ticket_id===id&&a.fields.technician_name);
 check('missing token is rejected',(await access({ticketId:id})).status==='UNAVAILABLE');
 check('wrong token is rejected',(await access({...p,token:'a'.repeat(64)})).status==='UNAVAILABLE');
 check('invalid ticket input is rejected',(await access({...p,ticketId:'garbage'})).status==='UNAVAILABLE');
 check('oversized ticket is rejected',(await access({...p,ticketId:'9999999999'})).status==='UNAVAILABLE');
 const second=await fixture();check('token cannot be used for another ticket',(await access({...p,ticketId:second})).status==='UNAVAILABLE');
 await q("UPDATE tickets SET status='PENDING_APPROVAL' WHERE id=$1",[id]);
 check('pending approval blocks another report',(await access(p)).status==='NOT_OPEN');
 check('new link cannot be issued for pending approval',await issue(id)===null);
 await q("UPDATE tickets SET status='ASSIGNED' WHERE id=$1",[id]);
 const request={...p,pdf_sha256:'b'.repeat(64),report:{work_performed:'Synthetic test report'}};
 const claimed=await claim(request);check('first valid submission claims upload',claimed.status==='UPLOAD');
 check('concurrent/repeated submission does not claim another upload',(await claim(request)).status==='UNCONFIRMED');
 check('unconfirmed page never claims success',(await access(p)).status==='UNCONFIRMED');
 let r=await call('cbm_record_technician_report',{submissionId:claimed.submissionId});check('missing Drive ID is unconfirmed',r.status==='UNCONFIRMED');
 r=await call('cbm_record_technician_report',{submissionId:claimed.submissionId,fileId:'drive-demo-file'});check('Drive file ID confirms submission',r.status==='SUBMITTED');
 check('repeated form does not upload a duplicate',(await claim(request)).status==='SUBMITTED');
 check('confirmation page can recognize already submitted report',(await access(p)).status==='SUBMITTED');
 check('portal did not close or approve ticket',(await q('SELECT status FROM tickets WHERE id=$1',[id]))[0].status==='ASSIGNED');
 await q("UPDATE tickets SET status='REWORK',approval_id=gen_random_uuid() WHERE id=$1",[id]);
 check('FM rework starts another submission cycle',(await access(p)).status==='OK');
 check('rework can claim a revised report',(await claim(request)).status==='UPLOAD');
 const third=await fixture(),expired=await issue(third);
 await q("UPDATE ticket_events SET payload=jsonb_set(payload,'{offers,0,report_expires_at}',to_jsonb('2020-01-01T00:00:00Z'::text)) WHERE ticket_id=$1 AND event='CBM_DISPATCH_STATE'",[third]);
 check('expired token is rejected',(await access(expired)).status==='UNAVAILABLE');
 check('operator can issue a new token after expiry',(await issue(third)).token!==expired.token);
 const w=JSON.parse(fs.readFileSync(path.join(__dirname,'workflow.json'))),names=new Set(w.nodes.map(n=>n.name));
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 for(const n of w.nodes)if(n.type.endsWith('.code'))new AsyncFunction('$json','$','$env','$input','require',n.parameters.jsCode);
 for(const [from,ports] of Object.entries(w.connections)){assert(names.has(from));for(const lists of Object.values(ports))for(const edges of lists)for(const e of edges)assert(names.has(e.node));}
 check('portal node code and connections are valid',true);
 const html=fs.readFileSync(path.join(app,'../templates/technician-report/technician-portal.html'),'utf8');
 check('portal embeds binding placeholder once',html.split('<!-- CBM_BOUND_CONTEXT -->').length===2);
 check('submission uses an absolute server-supplied action',html.includes('submit.action=bound.submitUrl'));
 check('ticket identity fields are read-only',html.includes('el.readOnly=true'));
 check('portal includes the existing image attachment renderer',html.includes('cbm-after-photo.jpg'));
 const prep=new AsyncFunction('$json','$','$env','require',fs.readFileSync(path.join(__dirname,'prepare-pdf.js'),'utf8'));
 const denied=await prep({context:{status:'UNAVAILABLE'}},()=>{throw Error('must not read request')},{},require);
 check('invalid access cannot prepare/upload binary',!denied[0].binary&&denied[0].json.result.status==='UNAVAILABLE');
 const bad=await prep({context:{status:'OK'}},()=>({first:()=>({json:{body:{report:'bad json'}}})}),{},require);
 check('malformed form gives validation result',bad[0].json.result.status==='INVALID');
 const {apply}=require('./apply.cjs');
 for(const rel of ['phase_b/workflows/send_notices.json','wf2/workflows/notify_fm.json']){
  const workflow=JSON.parse(fs.readFileSync(path.join(app,rel)));const once=apply(workflow);check(rel+' overlay is idempotent',JSON.stringify(apply(structuredClone(once)))===JSON.stringify(once));
 }
 await db.close();console.log(count+' portal checks passed. No external uploads or emails.');
}
main().catch(async e=>{console.error(e);await db.close();process.exitCode=1;});
