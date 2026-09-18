// Behavioural tests for WF3's Code nodes, run against the JavaScript actually
// stored in the workflow export rather than a copy of it.
//
// The n8n surfaces these nodes touch are mocked: $input and $().

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const wf = JSON.parse(fs.readFileSync(
  path.join(HERE, '..', 'n8n_wf3_fm_dashboard.json'), 'utf8'));
const src = (name) => wf.nodes.find((n) => n.name === name).parameters.jsCode;

let failed = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) { failed++; if (detail !== undefined) console.log('          got:', detail); }
};

function run(code, { input = {}, nodes = {} } = {}) {
  const $input = { first: () => ({ json: input }) };
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`No node named "${name}" was executed in this run`);
    return { first: () => ({ json: nodes[name] }) };
  };
  return new Function('$input', '$', `return (function () { ${code} })();`)($input, $);
}

// ---------------------------------------------------------------------------
console.log('\n1. FM Chat Context - normalise the turn, fix the date anchors');
{
  const code = src('FM Chat Context');

  const r = run(code, { input: { chatInput: '  Which  tickets\nare  overdue? ', sessionId: 'fm-1' } });
  const c = r[0].json;
  check('whitespace is collapsed', c.question === 'Which tickets are overdue?', c.question);
  check('the session id is carried', c.sessionId === 'fm-1');
  check('a real question sets asked', c.asked === true);
  check('nothing was truncated', c.truncated === false);

  const empty = run(code, { input: { chatInput: '   ', sessionId: 'fm-1' } })[0].json;
  check('a blank turn does not count as asked', empty.asked === false);

  const noSession = run(code, { input: { chatInput: 'hi' } })[0].json;
  check('a missing session id falls back rather than throwing',
        noSession.sessionId === 'fm-default');

  const long = run(code, { input: { chatInput: 'x'.repeat(4000), sessionId: 's' } })[0].json;
  check('an over-long question is cut to 1500 characters', long.question.length === 1500);
  check('truncation is reported', long.truncated === true);

  const t = (s) => Date.parse(s);
  check('week_start is exactly 7 days before now',
        Math.round((t(c.now) - t(c.week_start)) / 86400000) === 7);
  check('month_start is exactly 30 days before now',
        Math.round((t(c.now) - t(c.month_start)) / 86400000) === 30);
  check('stale_days agrees with the report', c.stale_days === 30);
  check('today is a bare date', /^\d{4}-\d{2}-\d{2}$/.test(c.today), c.today);

  // A session id long enough to be abusive is bounded, not rejected.
  const bigSession = run(code, { input: { chatInput: 'q', sessionId: 'z'.repeat(500) } })[0].json;
  check('the session id is bounded', bigSession.sessionId.length === 120);
}

// ---------------------------------------------------------------------------
console.log('\n2. Empty Question Reply - no model call for an empty turn');
{
  const r = run(src('Empty Question Reply'))[0].json;
  check('it answers with examples', /status of ticket 42/.test(r.output));
  check('it mentions the month threshold', /after a month/.test(r.output));
}

// ---------------------------------------------------------------------------
console.log('\n3. Chat Response - the answer survives an agent failure');
{
  const code = src('Chat Response');
  const ctx = { sessionId: 'fm-1', truncated: false };

  const ok = run(code, { nodes: {
    'FM Chat Context': ctx,
    'FM Dashboard Agent': { output: 'Ticket #42 is ASSIGNED to Mario Rossi.' } } })[0].json;
  check('the agent answer is returned', ok.output === 'Ticket #42 is ASSIGNED to Mario Rossi.');
  check('the session id is echoed', ok.sessionId === 'fm-1');

  const blank = run(code, { nodes: {
    'FM Chat Context': ctx, 'FM Dashboard Agent': { output: '' } } })[0].json;
  check('an empty agent output becomes an explanation, not an empty bubble',
        blank.output.length > 60);
  check('the explanation states that nothing was changed',
        /only reads/.test(blank.output), blank.output);

  const crashed = run(code, { nodes: { 'FM Chat Context': ctx } })[0].json;
  check('an agent that did not run at all is handled', /could not complete/.test(crashed.output));

  const cut = run(code, { nodes: {
    'FM Chat Context': { ...ctx, truncated: true },
    'FM Dashboard Agent': { output: 'Answer.' } } })[0].json;
  check('a truncated question is disclosed to the asker', /1500/.test(cut.output));
}

// ---------------------------------------------------------------------------
console.log('\n4. Report Window - a fixed, reproducible week');
{
  const w = run(src('Report Window'))[0].json;
  const span = (Date.parse(w.periodEnd) - Date.parse(w.periodStart)) / 86400000;
  check('the window is exactly 7 days', Math.round(span) === 7, span);
  check('the stale threshold is 30 days', w.staleDays === 30);
  check('the window label includes Rome local times and timezone',
        / to .+\(Europe\/Rome\)$/.test(w.periodLabel), w.periodLabel);
  check('the generation time is recorded', !Number.isNaN(Date.parse(w.generatedAt)));
}

// ---------------------------------------------------------------------------
console.log('\n5. Build Weekly Report - group, mark, and count nothing itself');
{
  const code = src('Build Weekly Report');
  const window = { periodLabel: '2026-09-07 to 2026-09-14', periodStart: '2026-09-07T00:00:00Z',
                   periodEnd: '2026-09-14T00:00:00Z', generatedAt: '2026-09-14T07:00:00Z' };

  const report = {
    period_start: window.periodStart, period_end: window.periodEnd, stale_days: 30,
    totals: { tickets_all_time: 120, open_now: 14, opened_in_window: 5,
              closed_in_window: 3, stale_now: 2 },
    by_status: [{ status: 'CLOSED', tickets: 100 }, { status: 'ASSIGNED', tickets: 9 }],
    changes: [
      { ticket_id: 42, changed_at: '2026-09-08T09:00:00Z', status_from: 'RECEIVED',
        status_to: 'ASSIGNED', current_status: 'CLOSED', description: 'leaking valve',
        ifc_name: 'Radiator-2F', technician_name: 'Mario Rossi', age_days: 6 },
      { ticket_id: 42, changed_at: '2026-09-10T09:00:00Z', status_from: 'ASSIGNED',
        status_to: 'CLOSED', current_status: 'CLOSED', description: 'leaking valve',
        ifc_name: 'Radiator-2F', technician_name: 'Mario Rossi', age_days: 6 },
      { ticket_id: 77, changed_at: '2026-09-12T09:00:00Z', status_from: 'ASSIGNED',
        status_to: 'REWORK', current_status: 'REWORK', description: 'door <script>x</script>',
        ifc_name: '', technician_name: 'Giulia Verdi', age_days: 45 },
    ],
    stale: [
      { id: 77, status: 'REWORK', description: 'door', ifc_name: 'Door-1F',
        technician_name: 'Giulia Verdi', age_days: 45, days_since_last_change: 2,
        created_at: '2026-08-01T00:00:00Z', updated_at: '2026-09-12T00:00:00Z' },
      { id: 91, status: 'ASSIGNED', description: 'window', ifc_name: 'Window-3F',
        technician_name: null, age_days: 60, days_since_last_change: 58,
        created_at: '2026-07-16T00:00:00Z', updated_at: '2026-07-18T00:00:00Z' },
    ],
  };

  const b = run(code, { input: { report }, nodes: { 'Report Window': window } })[0].json;

  check('two tickets moved, not three events', b.changed_count === 2, b.changed_count);
  check('a ticket\'s two moves become one path',
        /RECEIVED -&gt; ASSIGNED -&gt; CLOSED/.test(b.body_html) ||
        /Received &rarr; Assigned &rarr; Closed/.test(b.body_html), b.body_html.slice(0, 0));
  check('the overdue count comes from the query', b.stale_count === 2);
  check('tickets that moved this week are excluded from "untouched"',
        b.stalled_count === 1, b.stalled_count);
  check('the subject states both figures',
        /2 updated, 2 over 30 days/.test(b.subject), b.subject);
  check('the period is in the subject', b.subject.includes('2026-09-07 to 2026-09-14'));

  check('an overdue ticket that moved is still marked overdue',
        b.body_html.includes('Open for 45 days'), b.body_html.includes('Open for 45 days'));
  // Ticket 77 has no IFC element, so its raw fault text is what gets rendered.
  check('html in a fault description is escaped',
        !b.body_html.includes('<script>') && b.body_html.includes('&lt;script&gt;'),
        b.body_html.includes('<script>') ? 'unescaped' : 'never rendered');
  check('an unassigned ticket is named as such', /unassigned/i.test(b.body_html));

  // The model may see only figures.
  check('the narrative prompt carries the figures', /"overdue_total": 2/.test(b.narrative_prompt));
  check('the narrative prompt forbids new numbers',
        /Do not introduce any number/.test(b.narrative_prompt));
  check('the narrative prompt does not carry raw fault text',
        !/leaking valve/.test(b.narrative_prompt));
  check('the facts count closures from the change path',
        b.facts.tickets_closed_this_week === 1, b.facts.tickets_closed_this_week);
  check('the oldest overdue age is reported', b.facts.oldest_overdue_days === 60);
  check('the figures are the query\'s, not recomputed',
        b.facts.opened_in_window === 5 && b.facts.closed_in_window === 3);

  // A quiet week must still produce a complete report.
  const quiet = run(code, { input: { report: {
    ...report, changes: [], stale: [],
    totals: { tickets_all_time: 120, open_now: 4, opened_in_window: 0,
              closed_in_window: 0, stale_now: 0 } } },
    nodes: { 'Report Window': window } })[0].json;
  check('a week with no changes still builds a report', quiet.changed_count === 0);
  check('it says so rather than showing an empty table',
        /No ticket changed status/.test(quiet.body_html));
  check('and says nothing is overdue',
        /No tickets have been outstanding/.test(quiet.body_html));

  // A missing document must not throw: the report is the alarm.
  const none = run(code, { input: {}, nodes: { 'Report Window': window } })[0].json;
  check('an empty query result does not throw', none.changed_count === 0);
}

// ---------------------------------------------------------------------------
console.log('\n6. Compose Weekly Email - the model can only add, never subtract');
{
  const code = src('Compose Weekly Email');
  const built = {
    subject: '[CBM] Weekly maintenance report', period_label: '2026-09-07 to 2026-09-14',
    generated_at: '2026-09-14T07:00:00Z', body_html: '<h2>Where everything stands</h2><table></table>',
    changed_count: 2, stale_count: 2, stalled_count: 1, stale_days: 30,
    facts: { period_start: 'a', period_end: 'b', opened_in_window: 5, closed_in_window: 3,
             open_now: 14 },
  };

  const good = run(code, { input: { text: 'Five tickets were raised and three closed.' },
                           nodes: { 'Build Weekly Report': built } })[0].json;
  check('the narrative is placed above the figures',
        good.html.indexOf('Five tickets') < good.html.indexOf('Where everything stands'));
  check('the tables are kept verbatim', good.html.includes('<h2>Where everything stands</h2>'));
  check('narrative use is recorded', good.narrative_used === true);
  check('the subject is the built one', good.subject === built.subject);

  const failedModel = run(code, { input: { error: 'rate limited' },
                                  nodes: { 'Build Weekly Report': built } })[0].json;
  check('a model failure still produces the full report',
        failedModel.html.includes('Where everything stands'));
  check('the missing paragraph is admitted', /written summary is unavailable/.test(failedModel.html));
  check('and recorded as unused', failedModel.narrative_used === false);

  const jsonish = run(code, { input: { text: '{"summary": "..."}' },
                              nodes: { 'Build Weekly Report': built } })[0].json;
  check('a model that emitted JSON is discarded', jsonish.narrative_used === false);

  const rambling = run(code, { input: { text: 'x'.repeat(1500) },
                               nodes: { 'Build Weekly Report': built } })[0].json;
  check('a model that ignored the length is discarded', rambling.narrative_used === false);

  const injected = run(code, { input: { text: '<img src=x onerror=alert(1)>' },
                               nodes: { 'Build Weekly Report': built } })[0].json;
  check('model output is escaped before it reaches the email',
        !injected.html.includes('<img'), injected.html.includes('<img'));

  check('the recorded row carries the window and the counts',
        good.record.opened === 5 && good.record.closed === 3 && good.record.overdue === 2);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
