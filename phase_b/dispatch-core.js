/* Pure dispatch policy. Embedded into n8n Code nodes by build-workflow.js.
 * Time, candidate rows, randomness and current state come from PostgreSQL.
 * The agent chooses operations, never SQL, recipients, tokens or assignments.
 */
'use strict';

function dispatchPolicy(request, row) {
  const now = new Date(row.now);
  const iso = d => new Date(d).toISOString();
  const clone = x => JSON.parse(JSON.stringify(x));
  const ticket = row.ticket;
  const op = request.operation;
  const config = request.config;
  if (!ticket) return {write: false, result: {outcome: 'NO_TICKET', next_actions: ['create_ticket']}};
  let state = row.state ? clone(row.state) : null;
  const before = JSON.stringify(state);
  let mail = null;
  let response = null;
  const terminal = !['LOCALIZED', 'DISPATCHING'].includes(ticket.status);
  const active = o => ['SENDING', 'LIVE', 'UNCERTAIN'].includes(o.status);
  const candidates = row.candidates || [];
  const urgent = Number(ticket.severity) >= 4;
  const cap = urgent ? 2 : 1;
  const notices = () => Object.values(state.messages);
  const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const event = (type, detail = {}) => state.audit.push({type, at: iso(now), ...detail});
  const localDate = d => new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/Rome', year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
  function addDays(date, count, business = false) {
    let d = new Date(date + 'T12:00:00Z');
    for (let n = 0; n < count;) {
      d.setUTCDate(d.getUTCDate() + 1);
      if (!business || ![0, 6].includes(d.getUTCDay())) n++;
    }
    return d.toISOString().slice(0, 10);
  }
  function atRome(date, hour) {
    const target = Date.parse(`${date}T${String(hour).padStart(2,'0')}:00:00Z`);
    let guess = target;
    // Obtain the offset for the target date, including DST, without host timezone assumptions.
    for (let i = 0; i < 3; i++) {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/Rome', year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess)).map(p => [p.type,p.value]));
      const displayed = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
      guess += target - displayed;
    }
    return new Date(guess);
  }
  const safeUrl = url => /^https:\/\//i.test(String(url)) ? e(url) : '';
  const detail = () => `<p><b>Element:</b> ${e(ticket.ifc_name)} (${e(ticket.ifc_class)})<br><b>Issue:</b> ${e(ticket.description)}<br><b>Severity:</b> ${e(ticket.severity)}/5</p>${safeUrl(ticket.photo_before_url) ? `<p><a href="${safeUrl(ticket.photo_before_url)}">Before photo</a></p>` : ''}`;
  function queue(key, to, subject, html, offerId = null) {
    if (!state.messages[key]) state.messages[key] = {key, to, subject, html, offer_id:offerId, status:'PENDING'};
  }
  function claim(message) {
    if (!message || message.status !== 'PENDING') return;
    message.status = 'SENDING';
    message.claim = row.nonce;
    message.claimed_at = iso(now);
    mail = {...message};
    event('NOTICE_CLAIMED', {key:message.key});
  }
  function block(reason) {
    state.halted = true;
    state.error = reason;
    event('OPERATOR_ACTION_REQUIRED', {reason});
  }
  function applyInbox() {
    for (const item of row.inbox || []) {
      if (Number(item.id) <= Number(state.response_cursor)) continue;
      state.response_cursor = Number(item.id);
      const p = item.payload;
      const offer = state.offers.find(o => o.id === p.offer_id);
      const timely = offer && Date.parse(item.created_at) < Date.parse(offer.expires_at);
      if (!offer || !active(offer) || !timely || state.status !== 'DISPATCHING' || terminal) {
        event('RESPONSE_IGNORED', {response_id:item.id, reason:'stale_or_expired'});
        continue;
      }
      if (p.decision === 'deny') {
        offer.status = 'DENIED';
        event('OFFER_DENIED', {offer_id:offer.id, response_id:item.id});
      } else if (p.decision === 'accept') {
        // Recheck eligibility at assignment; a disabled technician cannot win.
        if (!candidates.some(c => Number(c.technician_id) === offer.technician_id)) {
          offer.status = 'INELIGIBLE';
          queue(`ineligible:${offer.id}`, offer.email, `[CBM] Ticket #${ticket.id}: offer withdrawn`, '<p>Your eligibility for this job has changed. This offer is no longer available.</p>');
          continue;
        }
        offer.status = 'ACCEPTED';
        state.status = 'ASSIGNED';
        state.assignee = offer.technician_id;
        state.scheduled_date = offer.date;
        state.scheduled_slot = offer.slot;
        event('OFFER_ACCEPTED', {offer_id:offer.id, response_id:item.id, technician_id:offer.technician_id});
        queue('assigned:technician', offer.email, `[CBM] Confirmed - ticket #${ticket.id}`, `<p>The job is assigned to you.</p><p>${e(offer.date)}, ${e(offer.slot)} (Europe/Rome).</p><p>After completing the work, upload the after-photo to <b>02_completed_snapshots</b> as <b>TICKET-${ticket.id}_after.jpg</b>.</p>`);
        queue('assigned:fm', config.fmEmail, `[CBM] Ticket #${ticket.id} assigned`, `<p>${e(offer.full_name)} accepted ticket #${ticket.id} for ${e(offer.date)}, ${e(offer.slot)} (Europe/Rome).</p><p>All other outstanding offers are withdrawn.</p>`);
        for (const other of state.offers.filter(o => o.id !== offer.id && active(o))) {
          other.status = 'WITHDRAWN';
          queue(`withdraw:${other.id}`, other.email, `[CBM] Ticket #${ticket.id}: offer withdrawn`, '<p>Another technician accepted this job. Your offer is no longer available; no action is required.</p>');
        }
      }
    }
    for (const offer of state.offers.filter(o => active(o) && Date.parse(o.expires_at) <= now.getTime())) {
      offer.status = 'EXPIRED';
      event('OFFER_EXPIRED', {offer_id:offer.id});
    }
  }
  if (!state) {
    if (op !== 'initialize') return {write:false, result:{ticket_id:ticket.id, outcome:'UNINITIALIZED',next_actions:['create_ticket']}};
    const date = addDays(localDate(new Date(ticket.created_at)), urgent ? 1 : 2, true);
    state = {version:1, source_key:request.sourceKey, status:ticket.status, urgent, cap,
      urgent_start: urgent ? iso(atRome(date, 8)) : null, original_date:date,
      shortlist:candidates.slice(0,5).map(c => Number(c.technician_id)), offers:[], messages:{},
      response_cursor:0, audit:[], halted:false, failures:0, config:clone(config)};
    event('DISPATCH_INITIALIZED');
    queue('opening', config.fmEmail, `[CBM] New ticket #${ticket.id}: ${String(ticket.category || '').slice(0,80)}`, `<h3>New maintenance ticket #${ticket.id}</h3>${detail()}<p>Eligible technicians will now be contacted automatically.</p>`);
  }
  // Downstream workflows own terminal status transitions. Never roll one back.
  if (terminal) state.status = ticket.status;
  const pendingInbox = (row.inbox || []).some(i => Number(i.id) > state.response_cursor);
  if (op === 'process_events') applyInbox();
  if (op === 'failure') {
    state.failures++;
    state.error = 'Agent/tool execution incomplete. Inspect the n8n execution.';
    if (state.failures >= 3) block(state.error);
  }
  // A lost send receipt is not permission to send again.
  if (op !== 'read') {
    for (const message of notices()) {
      if (message.status === 'SENDING' && now - Date.parse(message.claimed_at) > 300000 && !(op === 'ack' && request.receipt?.key === message.key)) {
        message.status = 'UNCERTAIN';
        const offer = state.offers.find(o => o.id === message.offer_id);
        if (offer && active(offer)) offer.status = 'UNCERTAIN';
        block(`Delivery receipt missing for ${message.key}. Do not resend without reconciliation.`);
      }
    }
  }
  if (op === 'ack') {
    const receipt = request.receipt;
    const message = state.messages[receipt.key];
    if (message && message.claim === receipt.claim && ['SENDING','UNCERTAIN'].includes(message.status)) {
      const offer = state.offers.find(o => o.id === message.offer_id);
      if (receipt.message_id) {
        message.status = 'SENT'; message.message_id = receipt.message_id; message.sent_at = iso(now);
        if (offer && active(offer)) {
          offer.status = 'LIVE'; offer.sent_at = iso(now);
          // Gmail acknowledgement establishes the ordinary 48-hour response window.
          // The email says 48h from sending; urgent offers include their exact earlier cutoff.
          offer.expires_at = iso(Math.min(now.getTime()+48*3600000, urgent ? Date.parse(state.urgent_start) : Infinity));
        }
        event('NOTICE_SENT', {key:message.key, message_id:receipt.message_id});
      } else {
        message.status = 'UNCERTAIN';
        if (offer && active(offer)) offer.status = 'UNCERTAIN';
        block(`Gmail delivery uncertain for ${message.key}. Inspect the provider before retrying.`);
      }
    }
  }
  const available = () => state.shortlist.filter(id => !state.offers.some(o => o.technician_id === id) && candidates.some(c => Number(c.technician_id) === id));
  const needExpiry = () => state.offers.some(o => active(o) && Date.parse(o.expires_at) <= now.getTime());
  if (!state.halted && !pendingInbox && !needExpiry() && !terminal) {
    if (op === 'send_opening') claim(state.messages.opening);
    if (op === 'offer_next' && state.messages.opening.status === 'SENT' && ['LOCALIZED','DISPATCHING'].includes(state.status)) {
      const ids = available();
      const canOffer = state.offers.filter(active).length < cap && ids.length && (!urgent || now < Date.parse(state.urgent_start));
      if (canOffer) {
        const c = candidates.find(c => Number(c.technician_id) === ids[0]);
        const deadline = new Date(Math.min(now.getTime()+48*3600000, urgent ? Date.parse(state.urgent_start) : Infinity));
        let date = state.original_date;
        if (!urgent) {
          // Ordinary offers retain a full 48h response window and a future fixed slot.
          // A 10-minute send margin avoids scheduling at a nearly coincident cutoff.
          const earliest = new Date(deadline.getTime()+600000);
          if (atRome(date,14) <= earliest) {
            date = localDate(earliest);
            while ([0,6].includes(new Date(date+'T12:00:00Z').getUTCDay()) || atRome(date,14) <= earliest) date = addDays(date,1);
          }
        }
        const offer = {id:row.nonce, token:row.token, technician_id:Number(c.technician_id), full_name:c.full_name, email:c.email,
          date, slot:urgent ? '08:00-10:00':'14:00-16:00', status:'SENDING', reserved_at:iso(now), expires_at:iso(deadline)};
        state.offers.push(offer); state.status = 'DISPATCHING';
        const query = `ticket=${ticket.id}&offer=${encodeURIComponent(offer.id)}&token=${encodeURIComponent(offer.token)}`;
        const base = config.callbackBase.replace(/\/$/,'');
        const accept = `${base}/cbm-wf1-offer?${query}&decision=accept`;
        const deny = `${base}/cbm-wf1-offer?${query}&decision=deny`;
        const cutoff = urgent ? `Respond within 48 hours, or before ${e(new Date(state.urgent_start).toLocaleString('en-GB',{timeZone:'Europe/Rome'}))} (Europe/Rome), whichever is earlier.` : 'Respond within 48 hours of sending. The date and slot are fixed.';
        queue(`offer:${offer.id}`, offer.email, `[CBM] Job offer - ticket #${ticket.id}`, `<h3>Maintenance job offer</h3><p>Hello ${e(c.full_name)},</p>${detail()}<p><b>Date:</b> ${e(date)} <b>Slot:</b> ${e(offer.slot)} (Europe/Rome). Fixed, no rescheduling.</p><p>${cutoff}</p><p><a href="${e(accept)}">ACCEPT</a> | <a href="${e(deny)}">DENY</a></p><p>Confirm your choice on the page that opens. An offer is not an assignment until confirmed. For urgent work, another technician may receive an offer; the first valid acceptance wins.</p>`,offer.id);
        claim(state.messages[`offer:${offer.id}`]);
        event('OFFER_RESERVED',{offer_id:offer.id,technician_id:offer.technician_id});
      }
    }
    if (op === 'escalate' && !state.offers.some(active) && (available().length === 0 || (urgent && now >= Date.parse(state.urgent_start)))) {
      state.status = 'ESCALATED';
      state.reason = urgent && now >= Date.parse(state.urgent_start) ? 'URGENT_APPOINTMENT_REACHED' : 'CANDIDATES_EXHAUSTED';
      queue('escalated:fm',config.fmEmail,`[CBM] Ticket #${ticket.id} ESCALATED`,`<p>Manual dispatch is required for ticket #${ticket.id}.</p><p>Reason: ${e(state.reason)}.</p>${detail()}`);
      event('DISPATCH_ESCALATED',{reason:state.reason});
    }
  }
  if (op === 'send_notices' && !state.halted) claim(notices().find(m => m.status === 'PENDING' && m.key !== 'opening' && !m.key.startsWith('offer:')));

  const needsProcess = (row.inbox || []).some(i => Number(i.id) > state.response_cursor) || needExpiry();
  const inflight = notices().filter(m => m.status === 'SENDING');
  const pendingNotices = notices().some(m => m.status === 'PENDING' && m.key !== 'opening' && !m.key.startsWith('offer:'));
  let actions = [];
  if (needsProcess) actions.push('process_events');
  if (!state.halted) {
    if (state.messages.opening.status === 'PENDING' && !terminal) actions.push('send_opening');
    if (pendingNotices) actions.push('send_notices');
    if (!needsProcess && !terminal && ['LOCALIZED','DISPATCHING'].includes(state.status) && state.messages.opening.status === 'SENT') {
      if (state.offers.filter(active).length < cap && available().length && (!urgent || now < Date.parse(state.urgent_start))) actions.push('offer_next');
      if (!state.offers.some(active) && (!available().length || (urgent && now >= Date.parse(state.urgent_start)))) actions.push('escalate');
    }
  }
  let nextWake = null;
  if (actions.length) nextWake = iso(now);
  else {
    const wakes = [...state.offers.filter(active).map(o => Date.parse(o.expires_at)), ...inflight.map(m => Date.parse(m.claimed_at)+300001)];
    if (wakes.length) nextWake = iso(Math.min(...wakes));
  }
  if (op === 'failure' && !state.halted) nextWake = iso(now.getTime()+60000);
  state.next_wake = nextWake;
  // Audit is stored with each append-only state event. Keep each snapshot bounded.
  state.audit = state.audit.slice(-60);
  response = {ticket_id:ticket.id, outcome:state.halted ? 'OPERATOR_ACTION_REQUIRED' : actions.length ? 'ACTION_REQUIRED' : state.status === 'ASSIGNED' ? 'ASSIGNED' : state.status === 'ESCALATED' ? 'ESCALATED' : 'WAITING',
    status:state.status, next_actions:actions, next_wake:nextWake, error:state.halted ? state.error : null,
    urgent, max_live_offers:cap, offers:state.offers.map(({token,...o}) => o),
    notices:notices().map(m => ({key:m.key,status:m.status,message_id:m.message_id || null})),
    candidates:state.shortlist.map(id => {const c = candidates.find(c=>Number(c.technician_id)===id);return c ? {technician_id:id,full_name:c.full_name,open_jobs:c.open_jobs,last_assigned_at:c.last_assigned_at,rating:c.rating} : {technician_id:id,eligible:false};})};
  return {write:op !== 'read' && JSON.stringify(state) !== before, state, mail, result:response};
}

if (typeof module !== 'undefined') module.exports = {dispatchPolicy};
