// Assemble the email. The narrative chain runs with continueRegularOutput, so a
// model outage costs the opening paragraph and nothing else: the tables below it
// are already built and the report still goes out on time.
const b = $('Build Weekly Report').first().json;

let narrative = '';
try {
  narrative = String($input.first().json.text || '').trim();
} catch (e) {
  narrative = '';
}

// A model that ignored the instructions and emitted JSON or a heading is not
// worth printing above the manager's figures.
if (narrative.startsWith('{') || narrative.startsWith('#') || narrative.length > 1200) {
  narrative = '';
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const opening = narrative
  ? '<div style="padding:16px 18px;background:#f3f6f9;border-left:3px solid #738fa6">'
    + '<div style="margin-bottom:6px;color:#475569;font-size:11px;letter-spacing:0.6px;font-weight:700">WEEK AT A GLANCE</div>'
    + '<p style="margin:0;color:#334155;font-size:14px;line-height:1.7">' + esc(narrative) + '</p></div>'
  : '<p style="margin:0;padding:12px 16px;background:#f3f6f9;color:#64748b;font-size:13px;line-height:1.6">'
    + 'The written summary is unavailable for this run. The ticket tables are shown below.</p>';

const generated = new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/Rome', dateStyle:'medium', timeStyle:'short'}).format(new Date(b.generated_at));
const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
  + '<title>Weekly maintenance report</title></head>'
  + '<body style="margin:0;padding:0;background:#edf2f6;color:#334155;font-family:Arial,Helvetica,sans-serif">'
  + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;background:#edf2f6"><tr><td align="center" style="padding:20px 8px">'
  + '<!--[if mso]><table role="presentation" width="820" cellpadding="0" cellspacing="0"><tr><td><![endif]-->'
  + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:820px;border-collapse:collapse;background:#ffffff;border:1px solid #dce4ec">'
  + '<tr><td style="padding:26px 22px;background:#18334d;border-top:4px solid #74b3a0">'
  + '<div style="font-size:11px;line-height:1.4;font-weight:700;letter-spacing:1.5px;color:#c6d8e4">CBM &nbsp;/&nbsp; FACILITY MANAGEMENT</div>'
  + '<h1 style="margin:10px 0 8px;font-size:26px;line-height:1.25;font-weight:700;color:#ffffff">Weekly maintenance report</h1>'
  + '<p style="margin:0;color:#d4e0e9;font-size:12px;line-height:1.6">' + esc(b.period_label) + '</p></td></tr>'
  + '<tr><td style="padding:22px 18px 28px">' + opening + b.body_html + '</td></tr>'
  + '<tr><td style="padding:16px 18px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:11px;line-height:1.7;color:#64748b">'
  + '<strong style="color:#475569">Generated ' + esc(generated) + ' (Europe/Rome)</strong><br>'
  + 'Status changes come from the recorded ticket history. Use the FM dashboard chat to explore individual tickets and their full history.'
  + '</td></tr></table><!--[if mso]></td></tr></table><![endif]-->'
  + '</td></tr></table></body></html>';


return [{
  json: {
    subject: b.subject,
    html,
    narrative_used: narrative.length > 0,
    record: {
      period_start: b.facts.period_start,
      period_end: b.facts.period_end,
      changed: b.changed_count,
      overdue: b.stale_count,
      overdue_untouched: b.stalled_count,
      opened: b.facts.opened_in_window,
      closed: b.facts.closed_in_window,
      open_now: b.facts.open_now,
      narrative_used: narrative.length > 0,
    },
  },
}];