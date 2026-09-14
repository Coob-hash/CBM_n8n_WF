'use strict';

// Each saved workflow contains only its own operation and dependencies.
// The model receives facts, never a generated list of tool calls to follow.
const active = o => ['SENDING','LIVE','UNCERTAIN'].includes(o.status);
const terminal = t => !['LOCALIZED','DISPATCHING'].includes(t.status);
const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function audit(c,type,detail={}) {c.state.audit.push({type,at:c.now.toISOString(),...detail});}
function queue(c,key,to,subject,html,offerId=null) {c.state.messages[key] ||= {key,to,subject,html,offer_id:offerId,status:'PENDING'};}
function claim(c,m) {
  if(!m||m.status!=='PENDING')return;
  Object.assign(m,{status:'SENDING',claim:c.row.nonce,claimed_at:c.now.toISOString()});
  c.mail={...m};audit(c,'NOTICE_CLAIMED',{key:m.key});
}
function block(c,reason) {c.state.halted=true;c.state.error=reason;audit(c,'OPERATOR_ACTION_REQUIRED',{reason});}
function context(request,row) {
  const state=row.state?JSON.parse(JSON.stringify(row.state)):null;
  const c={request,row,state,ticket:row.ticket,now:new Date(row.now),before:JSON.stringify(state),mail:null,config:state?.config||request.config,feedback:null};
  if(state) {
    state.audit ||= [];state.messages ||= {};state.offers ||= [];
    if(terminal(row.ticket))state.status=row.ticket.status;
    for(const m of Object.values(state.messages)) {
      if(m.status==='SENDING'&&c.now-Date.parse(m.claimed_at)>300000&&!(request.operation==='ack'&&request.receipt?.key===m.key)) {
        m.status='UNCERTAIN';const o=state.offers.find(o=>o.id===m.offer_id);if(o&&active(o))o.status='UNCERTAIN';
        block(c,`Delivery receipt missing for ${m.key}. Reconcile with Gmail before resending.`);
      }
    }
  }
  return c;
}
function facts(c) {
  const {state:s,ticket:t,row,now}=c;
  if(!t)return {ticket_id:null,outcome:'NO_TICKET',initialized:false};
  if(!s)return {ticket_id:t.id,outcome:Number(row.init_failures||0)>=3?'OPERATOR_ACTION_REQUIRED':'UNINITIALIZED',initialized:false};
  const offers=s.offers,notices=Object.values(s.messages),candidates=row.candidates||[];
  const available=s.shortlist.filter(id=>!offers.some(o=>o.technician_id===id)&&candidates.some(c=>Number(c.technician_id)===id));
  const pending=(row.inbox||[]).filter(i=>Number(i.id)>Number(s.response_cursor));
  const expired=offers.filter(o=>active(o)&&Date.parse(o.expires_at)<=now.getTime()),live=offers.filter(active);
  const urgent=Number(t.severity)>=4,cap=urgent?2:1,opening=s.messages.opening?.status;
  const beforeAppointment=!urgent||now.getTime()<Date.parse(s.urgent_start),dispatchOpen=!terminal(t);
  // Outcome verification is separate from the agent's choice of tools.
  const unfinished=pending.length>0||expired.length>0||notices.some(m=>m.status==='PENDING'&&!m.key.startsWith('offer:')&&(m.key!=='opening'||dispatchOpen))||
    (dispatchOpen&&opening==='SENT'&&((live.length<cap&&available.length>0&&beforeAppointment)||(live.length===0&&(available.length===0||!beforeAppointment))));
  const wakes=[...live.map(o=>Date.parse(o.expires_at)),...notices.filter(m=>m.status==='SENDING').map(m=>Date.parse(m.claimed_at)+300001)];
  const nextWake=s.halted?null:unfinished?now.toISOString():wakes.length?new Date(Math.min(...wakes)).toISOString():null;
  return {ticket_id:t.id,initialized:true,status:t.status,dispatch_status:s.status,
    outcome:s.halted?'OPERATOR_ACTION_REQUIRED':unfinished?'ACTION_REQUIRED':s.status==='ASSIGNED'?'ASSIGNED':s.status==='ESCALATED'?'ESCALATED':'WAITING',
    now:now.toISOString(),urgent,max_live_offers:cap,active_offer_count:live.length,urgent_start:s.urgent_start,original_date:s.original_date,
    opening_status:opening,pending_response_count:pending.length,expired_offer_count:expired.length,next_wake:nextWake,
    available_candidate_ids:available,error:s.halted?s.error:null,
    offers:offers.map(({token,...o})=>o),notices:notices.map(m=>({key:m.key,status:m.status,message_id:m.message_id||null})),
    candidates:s.shortlist.map(id=>{const v=candidates.find(x=>Number(x.technician_id)===id);return v?{technician_id:id,full_name:v.full_name,eligible:true,open_jobs:v.open_jobs,last_assigned_at:v.last_assigned_at,rating:v.rating}:{technician_id:id,eligible:false};})};
}
function finish(c) {
  const result=facts(c);if(c.feedback)result.operation_result=c.feedback;
  if(c.state){c.state.next_wake=c.request.operation==='failure'&&!c.state.halted?new Date(c.now.getTime()+60000).toISOString():result.next_wake;c.state.audit=c.state.audit.slice(-60);}
  return {write:c.request.operation!=='read'&&!!c.state&&JSON.stringify(c.state)!==c.before,state:c.state,mail:c.mail,result,feedback:c.feedback};
}
function reject(c,reason) {c.feedback={performed:false,reason};return finish(c);}
function localDate(d) {return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Rome',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);}
function addDays(date,count,business=false) {
  const d=new Date(date+'T12:00:00Z');for(let n=0;n<count;){d.setUTCDate(d.getUTCDate()+1);if(!business||![0,6].includes(d.getUTCDay()))n++;}return d.toISOString().slice(0,10);
}
function atRome(date,hour) {
  const target=Date.parse(`${date}T${String(hour).padStart(2,'0')}:00:00Z`);let guess=target;
  for(let i=0;i<3;i++){
    const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Rome',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess)).map(p=>[p.type,p.value]));
    guess+=target-Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
  }return new Date(guess);
}
function details(c) {
  const t=c.ticket,e=escapeHtml;return `<p><b>Element:</b> ${e(t.ifc_name)} (${e(t.ifc_class)})<br><b>Issue:</b> ${e(t.description)}<br><b>Severity:</b> ${e(t.severity)}/5</p>`+
    (/^https:\/\//i.test(t.photo_before_url||'')?`<p><a href="${e(t.photo_before_url)}">Before photo</a></p>`:'');
}
function technicalDetails(snapshot) {
  if(snapshot.status!=='VERIFIED'||!snapshot.chunks?.length)return '<h4>Technical information</h4><p>No verified technical excerpt is available for this invitation. Confirm the installed product and its documentation before work.</p>';
  return '<h4>Technical information — source excerpts</h4>'+snapshot.chunks.map(d=>{
    const m=d.metadata,e=escapeHtml;
    const link=/^https:\/\//i.test(m.source_url||'')?` — <a href="${e(m.source_url)}">Document</a>`:'';
    return `<blockquote style="white-space:pre-wrap">${e(d.content)}</blockquote><p><small>Source: ${e(m.source_title)}; revision ${e(m.source_revision)}; page ${e(m.page)}${link}</small></p>`;
  }).join('');
}
function initialize(request,row) {
  const c=context(request,row);if(!c.ticket||c.state)return finish(c);
  if(terminal(c.ticket))return reject(c,'TICKET_ALREADY_TERMINAL');
  const urgent=Number(c.ticket.severity)>=4,date=addDays(localDate(new Date(c.ticket.created_at)),urgent?1:2,true);
  c.state={version:2,source_key:request.sourceKey,status:c.ticket.status,urgent,cap:urgent?2:1,urgent_start:urgent?atRome(date,8).toISOString():null,original_date:date,
    shortlist:(row.candidates||[]).slice(0,5).map(x=>Number(x.technician_id)),offers:[],messages:{},response_cursor:0,audit:[],halted:false,failures:0,config:JSON.parse(JSON.stringify(request.config))};
  audit(c,'DISPATCH_INITIALIZED');queue(c,'opening',c.config.fmEmail,`[CBM] New ticket #${c.ticket.id}: ${String(c.ticket.category||'').slice(0,80)}`,
    `<h3>New maintenance ticket #${c.ticket.id}</h3>${details(c)}<p>Eligible technicians will now be contacted automatically.</p>`);return finish(c);
}
function offer(request,row) {
  const c=context(request,row),s=c.state;if(!s)return finish(c);const f=facts(c);
  if(s.halted||terminal(c.ticket))return reject(c,'DISPATCH_NOT_OPEN');
  if(f.pending_response_count||f.expired_offer_count)return reject(c,'RESPONSES_OR_EXPIRY_NOT_PROCESSED');
  if(f.opening_status!=='SENT')return reject(c,'OPENING_NOT_SENT');
  if(f.active_offer_count>=f.max_live_offers)return reject(c,'OFFER_CAPACITY_FULL');
  if(f.urgent&&c.now.getTime()>=Date.parse(s.urgent_start))return reject(c,'URGENT_APPOINTMENT_REACHED');
  if(!f.available_candidate_ids.length)return reject(c,'NO_ELIGIBLE_CANDIDATES');
  const id=Number(request.technicianId);
  if(!Number.isInteger(id)||id!==f.available_candidate_ids[0])return reject(c,'TECHNICIAN_MUST_BE_NEXT_RANKED_ELIGIBLE_CANDIDATE');
  let selected;
  try{selected=JSON.parse(request.knowledgeChunkIds||'[]');}catch{return reject(c,'INVALID_KNOWLEDGE_SELECTION');}
  if(!Array.isArray(selected)||selected.length>3||selected.some(x=>typeof x!=='string')||new Set(selected).size!==selected.length)return reject(c,'INVALID_KNOWLEDGE_SELECTION');
  const knowledge=JSON.parse(JSON.stringify(row.knowledge||{status:'UNAVAILABLE',chunks:[]}));
  if(knowledge.status==='INVALID_SELECTION')return reject(c,'STALE_OR_WRONG_ASSET_KNOWLEDGE');
  if(knowledge.status==='VERIFIED'&&(knowledge.ifc_global_id!==c.ticket.ifc_global_id||knowledge.chunks.length!==selected.length||knowledge.chunks.some((d,i)=>d.metadata.ifc_global_id!==c.ticket.ifc_global_id||d.metadata.chunk_id!==selected[i])))return reject(c,'STALE_OR_WRONG_ASSET_KNOWLEDGE');
  if(knowledge.status!=='VERIFIED')knowledge.chunks=[];
  const tech=row.candidates.find(x=>Number(x.technician_id)===id);
  const deadline=new Date(Math.min(c.now.getTime()+48*3600000,f.urgent?Date.parse(s.urgent_start):Infinity));let date=s.original_date;
  if(!f.urgent){const earliest=new Date(deadline.getTime()+600000);if(atRome(date,14)<=earliest){date=localDate(earliest);while([0,6].includes(new Date(date+'T12:00:00Z').getUTCDay())||atRome(date,14)<=earliest)date=addDays(date,1);}}
  const o={id:row.nonce,token:row.token,technician_id:id,full_name:tech.full_name,email:tech.email,date,slot:f.urgent?'08:00-10:00':'14:00-16:00',status:'SENDING',reserved_at:c.now.toISOString(),expires_at:deadline.toISOString()};
  o.technical_knowledge=knowledge;
  s.offers.push(o);s.status='DISPATCHING';
  const url=c.config.callbackBase.replace(/\/$/,'')+`/cbm-wf1-offer?ticket=${c.ticket.id}&offer=${encodeURIComponent(o.id)}&token=${o.token}`;
  const cutoff=f.urgent?`Respond within 48 hours or before ${escapeHtml(new Date(s.urgent_start).toLocaleString('en-GB',{timeZone:'Europe/Rome'}))} (Europe/Rome), whichever is earlier.`:'Respond within 48 hours of sending.';
  queue(c,`offer:${o.id}`,o.email,`[CBM] Job offer - ticket #${c.ticket.id}`,`<h3>Maintenance job offer</h3><p>Hello ${escapeHtml(o.full_name)},</p>${details(c)}${technicalDetails(knowledge)}<p><b>Date:</b> ${o.date} <b>Slot:</b> ${o.slot} (Europe/Rome). Fixed, no rescheduling.</p><p>${cutoff}</p><p><a href="${escapeHtml(url+'&decision=accept')}">ACCEPT</a> | <a href="${escapeHtml(url+'&decision=deny')}">DENY</a></p><p>Confirm on the page that opens. This is an offer, not an assignment. For urgent work, another technician may receive an offer; the first valid persisted acceptance wins.</p>`,o.id);
  claim(c,s.messages[`offer:${o.id}`]);audit(c,'OFFER_RESERVED',{offer_id:o.id,technician_id:id});return finish(c);
}
function notice(request,row) {
  const c=context(request,row);if(!c.state)return finish(c);if(c.state.halted)return reject(c,'DELIVERY_REQUIRES_RECONCILIATION');
  const key=request.noticeKey,m=c.state.messages[key];if(!m||key.startsWith('offer:'))return reject(c,'UNKNOWN_NOTICE_KEY');
  if(m.status!=='PENDING')return reject(c,'NOTICE_NOT_PENDING');if(key==='opening'&&terminal(c.ticket))return reject(c,'TICKET_ALREADY_TERMINAL');claim(c,m);return finish(c);
}
function processEvents(request,row) {
  const c=context(request,row),s=c.state;if(!s)return finish(c);
  for(const item of row.inbox||[]){
    if(Number(item.id)<=Number(s.response_cursor))continue;s.response_cursor=Number(item.id);
    const p=item.payload,o=s.offers.find(x=>x.id===p.offer_id);
    if(!o||!active(o)||Date.parse(item.created_at)>=Date.parse(o.expires_at)||s.status!=='DISPATCHING'||terminal(c.ticket)){audit(c,'RESPONSE_IGNORED',{response_id:item.id});continue;}
    if(p.decision==='deny'){o.status='DENIED';audit(c,'OFFER_DENIED',{offer_id:o.id});continue;}if(p.decision!=='accept')continue;
    if(!(row.candidates||[]).some(x=>Number(x.technician_id)===o.technician_id)){o.status='INELIGIBLE';queue(c,`ineligible:${o.id}`,o.email,`[CBM] Ticket #${c.ticket.id}: offer withdrawn`,'<p>Your eligibility for this job has changed. This offer is no longer available.</p>');continue;}
    o.status='ACCEPTED';Object.assign(s,{status:'ASSIGNED',assignee:o.technician_id,scheduled_date:o.date,scheduled_slot:o.slot});audit(c,'OFFER_ACCEPTED',{offer_id:o.id,response_id:item.id,technician_id:o.technician_id});
    queue(c,'assigned:technician',o.email,`[CBM] Confirmed - ticket #${c.ticket.id}`,`<p>The job is assigned to you for ${o.date}, ${o.slot} (Europe/Rome).</p><p>After completing the work, upload the after-photo to <b>02_completed_snapshots</b> as <b>TICKET-${c.ticket.id}_after.jpg</b>.</p>`);
    queue(c,'assigned:fm',c.config.fmEmail,`[CBM] Ticket #${c.ticket.id} assigned`,`<p>${escapeHtml(o.full_name)} accepted for ${o.date}, ${o.slot} (Europe/Rome).</p><p>Other outstanding offers are withdrawn.</p>`);
    for(const other of s.offers.filter(x=>x.id!==o.id&&active(x))){other.status='WITHDRAWN';queue(c,`withdraw:${other.id}`,other.email,`[CBM] Ticket #${c.ticket.id}: offer withdrawn`,'<p>Another technician accepted this job. Your offer is no longer available; no action is required.</p>');}
  }
  for(const o of s.offers.filter(o=>active(o)&&Date.parse(o.expires_at)<=c.now.getTime())){o.status='EXPIRED';audit(c,'OFFER_EXPIRED',{offer_id:o.id});}return finish(c);
}
function escalate(request,row) {
  const c=context(request,row),s=c.state;if(!s)return finish(c);const f=facts(c);
  if(s.halted||terminal(c.ticket)||f.pending_response_count||f.expired_offer_count||f.active_offer_count)return reject(c,'ESCALATION_PRECONDITIONS_NOT_MET');
  if(f.available_candidate_ids.length&&(!f.urgent||c.now.getTime()<Date.parse(s.urgent_start)))return reject(c,'ELIGIBLE_CANDIDATES_REMAIN');
  s.status='ESCALATED';s.reason=f.urgent&&c.now.getTime()>=Date.parse(s.urgent_start)?'URGENT_APPOINTMENT_REACHED':'CANDIDATES_EXHAUSTED';
  queue(c,'escalated:fm',c.config.fmEmail,`[CBM] Ticket #${c.ticket.id} ESCALATED`,`<p>Manual dispatch is required. Reason: ${s.reason}.</p>${details(c)}`);audit(c,'DISPATCH_ESCALATED',{reason:s.reason});return finish(c);
}
function acknowledge(request,row) {
  const c=context(request,row),s=c.state;if(!s)return finish(c);const r=request.receipt,m=s.messages[r?.key];
  if(!m||m.claim!==r.claim||!['SENDING','UNCERTAIN'].includes(m.status))return reject(c,'RECEIPT_DOES_NOT_MATCH_PENDING_CLAIM');
  const o=s.offers.find(x=>x.id===m.offer_id);
  if(typeof r.message_id==='string'&&r.message_id){
    Object.assign(m,{status:'SENT',message_id:r.message_id,sent_at:c.now.toISOString()});
    if(o&&active(o))Object.assign(o,{status:'LIVE',sent_at:c.now.toISOString(),expires_at:new Date(Math.min(c.now.getTime()+48*3600000,Number(c.ticket.severity)>=4?Date.parse(s.urgent_start):Infinity)).toISOString()});audit(c,'NOTICE_SENT',{key:m.key,message_id:r.message_id});
  }else{m.status='UNCERTAIN';if(o&&active(o))o.status='UNCERTAIN';block(c,`Gmail delivery uncertain for ${m.key}. Inspect the provider before retrying.`);}return finish(c);
}
function failure(request,row) {
  const c=context(request,row);if(!c.state)return finish(c);c.state.failures++;c.state.error='Agent/tool execution incomplete. Inspect the n8n execution.';if(c.state.failures>=3)block(c,c.state.error);return finish(c);
}
function read(request,row) {return finish(context(request,row));}
const operations={initialize,offer_next:offer,send_notices:notice,process_events:processEvents,escalate,ack:acknowledge,failure,read};
function dispatchPolicy(request,row) {
  if(request.operation==='send_opening')return notice({...request,noticeKey:'opening'},row);
  if(!operations[request.operation])throw new Error('Unknown dispatch operation');return operations[request.operation](request,row);
}
function operationSource(operation) {
  const common=[active,terminal,audit,block,context,facts,finish,reject];
  const extra={initialize:[escapeHtml,queue,localDate,addDays,atRome,details],offer_next:[escapeHtml,queue,claim,localDate,addDays,atRome,details,technicalDetails],send_notices:[claim],process_events:[escapeHtml,queue],escalate:[escapeHtml,queue,details],ack:[],failure:[],read:[]};
  return [...common,...extra[operation],operations[operation]].map(fn=>fn.toString().startsWith('function')?fn.toString():`const ${fn.name} = ${fn.toString()};`).join('\n\n')+`\nconst runOperation = ${operations[operation].name};`;
}
module.exports={dispatchPolicy,operationSource};
