const src = $input.first().json;
const p = typeof src.context === 'string' ? JSON.parse(src.context) : src.context;
const actions = ['approve_intervention','reject_intervention','resend_approval_email','approve_completion','request_rework'];
if (!p || !actions.includes(p.action)) throw new Error('Unknown FM action');
if (!Number.isSafeInteger(p.ticketId) || p.ticketId < 1) throw new Error('A positive ticket ID is required');
if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(p.approvalId || '')) throw new Error('Read the current approval ID with ticket_lookup');
if (typeof p.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(p.expectedUpdatedAt))) throw new Error('Read the current timestamp with ticket_lookup');
if (!['FM_CHAT','FM_EMAIL_LINK'].includes(p.actor) || p.truncated !== false) throw new Error('Incomplete authenticated FM request');
for (const key of ['requestId','sessionId','question']) if (typeof p[key] !== 'string' || !p[key].trim()) throw new Error('Missing '+key);
const reason = String(p.reason || '').trim();
if (['reject_intervention','request_rework'].includes(p.action) && reason.length < 2) throw new Error('Ask the FM for a rejection/rework reason');
if (reason.length > 2000 || p.question.length > 1500) throw new Error('Request is too long; ask for a shorter request');
return [{json:{action:p.action,ticketId:p.ticketId,approvalId:p.approvalId,expectedUpdatedAt:p.expectedUpdatedAt,
 reason,actor:p.actor,truncated:false,requestId:p.requestId.slice(0,150),sessionId:p.sessionId.slice(0,150),question:p.question}}];
