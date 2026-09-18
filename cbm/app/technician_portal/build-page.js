const access=$json.context;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
if(access.status!=='OK'){
 const messages={SUBMITTED:'Rapporto già inviato / Report already submitted.',UNCONFIRMED:'Invio da verificare. Contatta il FM prima di riprovare / Submission requires verification. Contact the FM before retrying.',NOT_OPEN:'Il ticket non accetta un nuovo rapporto / This ticket is not accepting another report.'};
 return [{json:{httpCode:access.status==='SUBMITTED'?200:403,html:'<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CBM report</title><body style="font:18px system-ui;max-width:700px;margin:60px auto;padding:24px"><h1>Rapporto tecnico / Technician report</h1><p>'+esc(messages[access.status]||'Link non valido o scaduto / Invalid or expired link. Request a new link from the FM.')+'</p></body></html>'}}];
}
const base=String($env.IFC_SERVICE_URL||'').replace(/\/+$/,'');
const template=await this.helpers.httpRequest({method:'GET',url:base+'/reports/template',json:true,timeout:15000});
const auth=$('Technician Report Page').first().json.query;
const context={fields:access.fields,ticketId:access.ticketId,token:auth.token,submitUrl:'https://bonanza-progress-hangover.ngrok-free.dev/webhook/cbm-technician-report'};
return [{json:{httpCode:200,html:template.html.replace('<!-- CBM_BOUND_CONTEXT -->','<script id="cbm-bound-context" type="application/json">'+JSON.stringify(context).replace(/</g,'\\u003c')+'</script>')}}];
