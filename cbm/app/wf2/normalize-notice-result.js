// Gmail output is the only source of a send receipt; the agent supplies none.
const claim = $('Claim Closure Notice').first().json;
const response = $input.first().json;
const sent = !response.error && typeof response.id === 'string' && response.id.trim().length > 0;
return [{json:{ticket_id:claim.ticket_id,approval_id:claim.approval_id,
  notice_key:claim.notice_key,claim_id:claim.claim_id,
  send_status:sent?'SENT':'UNCONFIRMED',message_id:sent?response.id:null,
  error:sent?null:String(response.error?.message||response.error||'Gmail returned no message ID; inspect the execution before retrying').slice(0,1000)}}];
