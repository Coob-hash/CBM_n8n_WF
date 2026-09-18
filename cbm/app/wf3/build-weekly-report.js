// Turn the single JSON document the query returned into the report.
//
// Every figure here was computed by SQL. Nothing in this node counts anything:
// it groups, sorts and formats, so the numbers in the email are the numbers in
// the database and the model that writes the covering paragraph later cannot
// change them.
const r = $input.first().json.report || {};
const w = $('Report Window').first().json;

const totals = r.totals || {};
const byStatus = r.by_status || [];
const changes = r.changes || [];
const stale = r.stale || [];
const staleDays = r.stale_days || 30;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const day = (s) => (s ? new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Rome',dateStyle:'medium'}).format(new Date(s)) : '');

// --- status changes, grouped into one row per ticket ----------------------
// A ticket that moved RECEIVED -> ASSIGNED -> WORK_DONE in one week is one line
// showing the path, not three lines the manager has to reassemble.
const byTicket = new Map();
for (const c of changes) {
  const key = c.ticket_id;
  if (!byTicket.has(key)) {
    byTicket.set(key, {
      ticket_id: key,
      description: c.description || '',
      ifc_name: c.ifc_name || '',
      ifc_storey: c.ifc_storey || '',
      technician_name: c.technician_name || '',
      current_status: c.current_status || '',
      age_days: c.age_days,
      first_from: c.status_from,
      steps: [],
      last_at: c.changed_at,
    });
  }
  const row = byTicket.get(key);
  row.steps.push(c.status_to);
  row.current_status = c.current_status || row.current_status;
  row.last_at = c.changed_at;
}

const movedTickets = Array.from(byTicket.values())
  .sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)));

for (const m of movedTickets) {
  m.path = [m.first_from == null ? 'NEW' : m.first_from].concat(m.steps).join(' -> ');
  m.closed_this_week = m.steps.includes('CLOSED');
  m.still_open = !['CLOSED', 'DUPLICATE', 'REJECTED'].includes(m.current_status);
  // A ticket that moved this week but is already past the stale threshold is
  // still overdue: movement is not progress.
  m.overdue = m.still_open && Number(m.age_days) >= staleDays;
}

const staleIds = new Set(stale.map((s) => s.id));
const movedIds = new Set(movedTickets.map((m) => m.ticket_id));
// Overdue and untouched all week: the worst category, listed first.
for (const s of stale) {
  s.moved_this_week = movedIds.has(s.id);
}
const stalled = stale.filter((s) => !s.moved_this_week);

const subject = '[CBM] Weekly maintenance report ' + w.periodLabel
  + ' - ' + movedTickets.length + ' updated, ' + stale.length + ' over '
  + staleDays + ' days';

// Inline styles and table layouts keep the report usable in email clients.
const th = 'scope="col" style="padding:11px 14px;text-align:left;background:#eef2f6;border-bottom:1px solid #dce4ec;color:#475569;font-size:11px;font-weight:700;letter-spacing:0.4px"';
const td = 'style="padding:14px;vertical-align:top;border-bottom:1px solid #e7edf3;font-size:13px;line-height:1.6;overflow-wrap:anywhere;word-break:break-word"';
const muted = 'style="margin-top:5px;color:#64748b;font-size:12px;line-height:1.5"';
const palettes = {
  CLOSED: ['#e6f4ed', '#166534'],
  ASSIGNED: ['#e8f0fc', '#1e40af'],
  DISPATCHING: ['#e8f0fc', '#1e40af'],
  WORK_DONE: ['#e6f4ed', '#166534'],
  PENDING_AUTHORIZATION: ['#fff4dc', '#854d0e'],
  PENDING_APPROVAL: ['#fff4dc', '#854d0e'],
  REWORK: ['#fce9e7', '#9f2525'],
  ESCALATED: ['#fce9e7', '#9f2525'],
  NEEDS_TRIAGE: ['#fff4dc', '#854d0e'],
};
const label = (status) => String(status || 'Unknown').toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
const badge = (status) => {
  const [bg, fg] = palettes[status] || ['#edf1f5', '#475569'];
  return '<span style="display:inline-block;padding:3px 8px;border-radius:4px;background:' + bg
    + ';color:' + fg + ';font-size:11px;line-height:1.5;font-weight:700">' + esc(label(status)) + '</span>';
};
const table = (headers, rows) => !rows ? '' :
  '<table width="100%" cellpadding="0" cellspacing="0" style="width:100%;table-layout:fixed;border-collapse:collapse;margin:12px 0 0;border:1px solid #e7edf3">'
  + '<thead><tr>' + headers.map(h => '<th ' + th + '>' + esc(h) + '</th>').join('') + '</tr></thead>'
  + '<tbody>' + rows + '</tbody></table>';
const stripe = (i) => 'style="background:' + (i % 2 ? '#f8fafc' : '#ffffff') + '"';
const asset = (ticket) => '<div style="font-weight:700;color:#18334d">#' + esc(ticket.ticket_id ?? ticket.id) + '</div>'
  + '<div style="margin-top:3px">' + esc(ticket.ifc_name || String(ticket.description || '').slice(0, 80)) + '</div>'
  + (ticket.ifc_storey ? '<div ' + muted + '>' + esc(ticket.ifc_storey) + '</div>' : '');
const title = (text, detail = '') => '<h2 style="margin:0;color:#18334d;font-size:17px;line-height:1.4;font-weight:700">'
  + esc(text) + '</h2>' + (detail ? '<p style="margin:6px 0 0;color:#64748b;font-size:13px;line-height:1.6">' + esc(detail) + '</p>' : '');
const empty = (text) => '<p style="margin:12px 0 0;padding:14px 16px;background:#f1f7f4;border-left:3px solid #2f855a;color:#365b48;font-size:13px;line-height:1.6">' + esc(text) + '</p>';
const section = (html) => '<div style="margin:28px 0 0">' + html + '</div>';
const metric = (value, name, detail, colour) => '<td width="33.33%" style="padding:14px 10px;text-align:center;vertical-align:top;border:1px solid #dce4ec;background:#f8fafc">'
  + '<div style="font-size:28px;line-height:1.2;font-weight:700;color:' + colour + '">' + esc(value) + '</div>'
  + '<div style="margin-top:6px;font-size:12px;font-weight:700;color:#334155">' + esc(name) + '</div>'
  + '<div style="margin-top:3px;font-size:11px;color:#64748b">' + esc(detail) + '</div></td>';

const statusRows = byStatus.map((s, i) => '<tr ' + stripe(i) + '><td ' + td + '>' + badge(s.status)
  + '</td><td ' + td + '><strong>' + esc(s.tickets) + '</strong></td></tr>').join('');
const changeRows = movedTickets.map((m, i) => '<tr ' + stripe(i) + '>'
  + '<td ' + td + '>' + asset(m) + '</td>'
  + '<td ' + td + '>' + badge(m.current_status)
  + '<div ' + muted + '>' + [m.first_from == null ? 'NEW' : m.first_from].concat(m.steps).map(s => esc(label(s))).join(' &rarr; ') + '</div>'
  + (m.overdue ? '<div style="margin-top:6px;font-size:11px;font-weight:700;color:#9f2525">Open for ' + esc(m.age_days) + ' days</div>' : '')
  + '</td><td ' + td + '>' + esc(m.technician_name || 'Unassigned') + '</td></tr>').join('');
const staleRows = stale.map((s, i) => '<tr ' + stripe(i) + '>'
  + '<td ' + td + '>' + asset(s) + '<div ' + muted + '>' + esc(s.technician_name || 'Unassigned') + '</div></td>'
  + '<td ' + td + '>' + badge(s.status) + '<div style="margin-top:7px;font-weight:700;color:#9f2525">' + esc(s.age_days) + ' days open</div></td>'
  + '<td ' + td + '>' + (s.moved_this_week ? 'Status changed this week' : 'No status change this week')
  + '<div ' + muted + '>' + esc(s.days_since_last_change) + ' days since last update</div></td></tr>').join('');

const sections = [];
sections.push('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;table-layout:fixed;border-collapse:collapse;margin-top:22px"><tr>'
  + metric(totals.opened_in_window || 0, 'Opened', 'This reporting period', '#18334d')
  + metric(totals.closed_in_window || 0, 'Closed', 'This reporting period', '#166534')
  + metric(totals.open_now || 0, 'Open now', 'Across all tickets', '#18334d')
  + '</tr></table>');
sections.push(section(title('Current ticket status', (totals.tickets_all_time || 0) + ' tickets recorded across the full history.')
  + (byStatus.length ? table(['Status', 'Tickets'], statusRows) : empty('No tickets have been recorded yet.'))));
sections.push(section(title('Activity this week', movedTickets.length + ' tickets changed status during this reporting period.')
  + (movedTickets.length ? table(['Ticket / asset', 'Status / progress', 'Technician'], changeRows) : empty('No ticket changed status during this period.'))));
sections.push(section('<div style="padding:14px 16px;background:' + (stale.length ? '#fff4ed' : '#f1f7f4')
  + ';border-left:3px solid ' + (stale.length ? '#c46a30' : '#2f855a') + '">'
  + title('Open longer than ' + staleDays + ' days', stale.length
    ? stale.length + ' tickets need attention. ' + stalled.length + ' had no status change this week.'
    : 'No tickets have been outstanding beyond this threshold.')
  + '</div>' + (stale.length ? table(['Ticket / asset', 'Status / age', 'Recent activity'], staleRows) : '')));
const body = sections.join('');


// --- what the model is allowed to see -------------------------------------
// Figures only, already computed. The paragraph it writes is a covering note on
// these numbers; it is given nothing it could use to invent a different set.
const facts = {
  period: w.periodLabel,
  period_start: w.periodStart,
  period_end: w.periodEnd,
  stale_days: staleDays,
  opened_in_window: totals.opened_in_window || 0,
  closed_in_window: totals.closed_in_window || 0,
  open_now: totals.open_now || 0,
  tickets_all_time: totals.tickets_all_time || 0,
  tickets_changed_status: movedTickets.length,
  tickets_closed_this_week: movedTickets.filter((m) => m.closed_this_week).length,
  overdue_total: stale.length,
  overdue_untouched_this_week: stalled.length,
  oldest_overdue_days: stale.length ? Math.max.apply(null, stale.map((s) => Number(s.age_days) || 0)) : 0,
  by_status: byStatus,
  overdue_tickets: stale.slice(0, 10).map((s) => ({
    id: s.id, status: s.status, age_days: s.age_days,
    technician: s.technician_name || 'unassigned',
    element: s.ifc_name || '', moved_this_week: s.moved_this_week,
  })),
};

const narrative_prompt = [
  'You are writing the opening paragraph of a facility maintenance report for the',
  'facility manager. The figures below are already final and were computed from the',
  'database. Write three or four sentences of plain prose.',
  '',
  'Rules:',
  '- Use only the figures given. Do not introduce any number that is not below.',
  '- Say what changed this week, then what needs the manager\'s attention.',
  '- Name at most three specific ticket numbers, chosen from overdue_tickets.',
  '- No greeting, no sign-off, no bullet points, no headings, no markdown.',
  '- If nothing moved and nothing is overdue, say so in one sentence.',
  '',
  'FIGURES:',
  JSON.stringify(facts, null, 2),
].join('\n');

return [{
  json: {
    subject,
    body_html: body,
    period_label: w.periodLabel,
    generated_at: w.generatedAt,
    changed_count: movedTickets.length,
    stale_count: stale.length,
    stalled_count: stalled.length,
    stale_days: staleDays,
    facts,
    narrative_prompt,
  },
}];