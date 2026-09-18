const r = $input.first().json.result || {};
const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const shell = body => '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CBM · FM decision</title><style>body{font:17px system-ui;background:#f1f5f9;color:#172033;margin:0;padding:32px}main{max-width:680px;margin:auto;background:white;padding:32px;border-radius:16px}h1{font-size:25px}button{padding:12px 20px;border:0;border-radius:7px;background:#12594c;color:white;font-size:16px;cursor:pointer}button[value=reject]{background:#9b341c}textarea{display:block;width:95%;min-height:90px;margin:14px 0;padding:10px}small{color:#536173}.buttons{display:flex;gap:14px;flex-wrap:wrap}</style><main>'+body+'</main></html>';
let body;
if (r.valid === true) {
 body = '<small>CBM · Completion approval / Approvazione completamento</small><h1>Ticket #'+esc(r.ticketId)+'</h1><p>'+esc(r.ifc_name)+'</p><p>'+esc(r.description)+'</p><p>Approve the completed work to update the IFC and close the ticket, or request rework with a reason. Opening this page makes no change.</p><form method="post" action="/webhook/cbm-wf3-completion-approval"><input type="hidden" name="emailId" value="'+esc(r.emailId)+'"><input type="hidden" name="token" value="'+esc(r.token)+'"><label>Reason for rework / Motivo della rilavorazione<textarea name="reason" maxlength="2000"></textarea></label><div class="buttons"><button name="decision" value="approve">Approve / Approva</button><button name="decision" value="reject">Request rework / Rilavorazione</button></div></form><p><small>A successful IFC update is required before closure.</small></p>';
} else if (r.outcome) {
 const status = r.ticket_status || r.status || '';
 body = '<h1>'+esc(r.outcome)+'</h1><p>Ticket #'+esc(r.ticketId || '')+' · '+esc(status)+'</p><p>'+esc(r.reason || '')+'</p>';
 if (r.missing_operations?.length) body += '<p>Still incomplete: '+esc(r.missing_operations.join(', '))+'. Use the FM chat to inspect and retry the recorded decision.</p>';
 body += '<p>You can close this page and check the ticket in the FM chat.</p>';
} else body = '<h1>Approval unavailable</h1><p>'+esc(r.reason || 'Invalid, expired, or already used approval link.')+'</p>';
return [{json:{html:shell(body),statusCode:r.valid===false?409:200}}];
