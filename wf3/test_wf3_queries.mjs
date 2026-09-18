// Run WF3's SQL against a real PostgreSQL engine (PGlite).
//
// Every query tested here is read out of the workflow export, so this exercises
// what would actually be imported into n8n rather than a transcription of it.
// The fixture is a small ticket history with controlled ages, which is what the
// dashboard's answers are made of: "open for 45 days" has to be 45.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const { createRequire } = await import('node:module');
const { PGlite } = createRequire(import.meta.url)(
  path.join(ROOT, 'phase_b', '.test-runtime', 'pglite', 'dist', 'index.cjs'));

const wf = JSON.parse(fs.readFileSync(path.join(ROOT, 'n8n_wf3_fm_dashboard.json'), 'utf8'));
const q = (name) => wf.nodes.find((n) => n.name === name).parameters.query;
const sqlFile = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let failed = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) { failed++; if (detail !== undefined) console.log('          got:', detail); }
};
const arg = (o) => [JSON.stringify(o)];

// ---------------------------------------------------------------------------
console.log('\n1. the migration, and the dependency it declares');
{
  const bare = new PGlite();
  await bare.exec(sqlFile('schema.sql'));
  let guarded = '';
  try {
    await bare.exec(sqlFile('schema_wf3_dashboard.sql'));
  } catch (e) { guarded = e.message; }
  check('applying WF3 before WF2 fails with an instruction, not a missing column',
        /schema_wf2_completion\.sql/.test(guarded), guarded || 'it applied');
  await bare.close();
}

const db = new PGlite();
await db.exec(sqlFile('schema.sql'));
await db.exec(sqlFile('schema_wf2_completion.sql'));
await db.exec(sqlFile('schema_wf3_dashboard.sql'));
await db.exec(sqlFile('schema_release_review.sql'));
await db.exec(sqlFile('intake/schema_intake.sql'));
await db.exec(sqlFile('schema_wf2_strict_closure.sql'));
await db.exec(sqlFile('technician_portal/schema.sql'));
await db.exec(sqlFile('wf3/actions/schema.sql'));
// This suite exercises dashboard reads and status-audit behavior. Initial
// authorization policy is covered by the intake/action suites.
await db.exec('ALTER TABLE tickets DISABLE TRIGGER cbm_dispatch_authorization_guard');
await db.exec('ALTER TABLE tickets DISABLE TRIGGER wf2_require_successful_ifc');
check('the migration applies on top of WF2', true);

let twice = true;
try { await db.exec(sqlFile('schema_wf3_dashboard.sql')); } catch (e) { twice = false; console.log('   ', e.message); }
check('the migration is idempotent (applies twice)', twice);

// ---------------------------------------------------------------------------
console.log('\n2. the status-change trigger records transitions, and only transitions');
const tech = {};
for (const r of (await db.query('SELECT id, full_name FROM technicians')).rows) {
  tech[r.full_name] = r.id;
}

const mk = async (status, ageDays, extra = {}) => {
  const r = await db.query(
    `INSERT INTO tickets(status, description, category, ifc_name, ifc_storey, ifc_global_id,
                         technician_id, reporter_email)
     VALUES('RECEIVED', $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [extra.description || 'fault', extra.category || 'general', extra.ifc_name || null,
     extra.ifc_storey || null, extra.global_id || null, extra.technician_id || null,
     'reporter@example.com']);
  const id = r.rows[0].id;
  // Back-dating touches no status column, so it fires no event.
  await db.query(
    `UPDATE tickets SET created_at = now() - make_interval(days => $2::int),
                        updated_at = now() - make_interval(days => $2::int)
      WHERE id = $1`, [id, ageDays]);
  return id;
};

const T1 = await mk('RECEIVED', 3, { description: 'leaking valve on the landing',
  category: 'plumbing', ifc_name: 'Radiator-2F', ifc_storey: 'Level 2',
  global_id: 'GUID-RAD-2F', technician_id: tech['Mario Rossi'] });
const T2 = await mk('RECEIVED', 45, { description: 'fire door will not latch',
  category: 'carpentry', ifc_name: 'Door-1F', ifc_storey: 'Level 1',
  global_id: 'GUID-DOOR-1F', technician_id: tech['Lucia Bianchi'] });
const T3 = await mk('RECEIVED', 60, { description: 'draught from window frame',
  category: 'carpentry', ifc_name: 'Window-3F', ifc_storey: 'Level 3', global_id: 'GUID-WIN-3F' });
const T4 = await mk('RECEIVED', 2, { description: 'flickering light', category: 'electrical' });
const T5 = await mk('RECEIVED', 40, { description: 'duplicate of the door report',
  category: 'carpentry', ifc_name: 'Door-1F', global_id: 'GUID-DOOR-1F-DUP' });

const evCount = async (id) => (await db.query(
  `SELECT count(*)::int AS n FROM ticket_events
    WHERE ticket_id = $1 AND event = 'CBM_STATUS_CHANGED'`, [id])).rows[0].n;

await db.query(`UPDATE tickets SET status='ASSIGNED' WHERE id=$1`, [T1]);
check('a status change writes one event', await evCount(T1) === 1);

await db.query(`UPDATE tickets SET status='ASSIGNED' WHERE id=$1`, [T1]);
check('rewriting the same status writes nothing', await evCount(T1) === 1);

await db.query(`UPDATE tickets SET description='leaking valve on the landing (again)' WHERE id=$1`, [T1]);
check('changing another column writes nothing', await evCount(T1) === 1);

const freshness = async (id) => (await db.query(
  `SELECT date_part('day', now() - updated_at)::int AS d FROM tickets WHERE id=$1`, [id])).rows[0].d;
check('a status change moves updated_at even when the writer forgot to',
      await freshness(T1) === 0, await freshness(T1));

await db.query(
  `UPDATE tickets SET status='CLOSED', closed_at = now() - interval '1 day' WHERE id=$1`, [T1]);
check('a second transition is recorded', await evCount(T1) === 2);

const path1 = (await db.query(
  `SELECT payload->>'from' AS f, payload->>'to' AS t FROM ticket_events
    WHERE ticket_id=$1 AND event='CBM_STATUS_CHANGED' ORDER BY id`, [T1])).rows;
check('the event records where the ticket came from and went to',
      path1[0].f === 'RECEIVED' && path1[0].t === 'ASSIGNED'
      && path1[1].f === 'ASSIGNED' && path1[1].t === 'CLOSED', JSON.stringify(path1));

await db.query(`UPDATE tickets SET status='ASSIGNED' WHERE id=$1`, [T2]);
await db.query(`UPDATE tickets SET status='DUPLICATE' WHERE id=$1`, [T5]);

// T3 moved to REWORK long ago: back-date its event so it sits outside the window.
await db.query(`UPDATE tickets SET status='REWORK' WHERE id=$1`, [T3]);
await db.query(
  `UPDATE ticket_events SET created_at = now() - interval '40 days'
    WHERE ticket_id = $1 AND event = 'CBM_STATUS_CHANGED'`, [T3]);

// ---------------------------------------------------------------------------
console.log('\n3. the chat tools answer from the shipped SQL');
{
  const lookup = await db.query(q('ticket_lookup'), arg({ ticketId: T1 }));
  const t1 = lookup.rows[0];
  check('ticket_lookup finds the ticket', lookup.rows.length === 1);
  check('it reports the current status', t1.status === 'CLOSED');
  check('it computes age in days', t1.age_days === 3, t1.age_days);
  check('it joins the technician', t1.technician_name === 'Mario Rossi');
  check('it carries the IFC element', t1.ifc_name === 'Radiator-2F');

  const missing = await db.query(q('ticket_lookup'), arg({ ticketId: 999999 }));
  check('an unknown ticket returns no rows rather than failing', missing.rows.length === 0);

  const all = await db.query(q('ticket_search'), arg({}));
  check('ticket_search with no filters searches the whole history', all.rows.length === 5,
        all.rows.length);
  check('it is newest first', all.rows[0].id === T4, all.rows[0].id);

  const blanks = await db.query(q('ticket_search'), arg({
    status: '', technician: '', element: '', text: '', openedAfter: '', openedBefore: '',
    openOnly: '', limit: '' }));
  check('empty arguments mean "no filter" and never raise a cast error',
        blanks.rows.length === 5, blanks.rows.length);

  const assigned = await db.query(q('ticket_search'), arg({ status: 'assigned' }));
  check('a lowercase status from the model still matches',
        assigned.rows.length === 1 && assigned.rows[0].id === T2, assigned.rows.length);

  const open = await db.query(q('ticket_search'), arg({ openOnly: true }));
  check('open_only excludes CLOSED and DUPLICATE', open.rows.length === 3, open.rows.length);

  const byTech = await db.query(q('ticket_search'), arg({ technician: 'mario' }));
  check('technician matching is partial and case-insensitive',
        byTech.rows.length === 1 && byTech.rows[0].id === T1);

  const byText = await db.query(q('ticket_search'), arg({ text: 'valve' }));
  check('free text searches the description', byText.rows.length === 1);

  const byElement = await db.query(q('ticket_search'), arg({ element: 'Door' }));
  check('element matching finds every ticket on that element', byElement.rows.length === 2,
        byElement.rows.length);

  const byGuid = await db.query(q('ticket_search'), arg({ element: 'GUID-WIN-3F' }));
  check('an exact IFC GlobalId matches too', byGuid.rows.length === 1 && byGuid.rows[0].id === T3);

  const byStorey = await db.query(q('ticket_search'), arg({ element: 'Level 2' }));
  check('the storey is searchable', byStorey.rows.length === 1 && byStorey.rows[0].id === T1);

  const capped = await db.query(q('ticket_search'), arg({ limit: 2 }));
  check('the row limit is honoured', capped.rows.length === 2);

  const overCap = await db.query(q('ticket_search'), arg({ limit: 5000 }));
  check('a limit above the cap does not widen the result', overCap.rows.length === 5);

  const window = await db.query(q('ticket_search'), arg({
    openedAfter: new Date(Date.now() - 7 * 86400000).toISOString() }));
  check('a date bound filters by when the ticket was raised', window.rows.length === 2,
        window.rows.length);

  // A quote and a comment marker travel as data, not as SQL.
  const hostile = await db.query(q('ticket_search'), arg({ text: "'; DROP TABLE tickets; --" }));
  check('an injection attempt is matched as text and finds nothing', hostile.rows.length === 0);
  check('and the table is still there',
        (await db.query('SELECT count(*)::int AS n FROM tickets')).rows[0].n === 5);
}

// ---------------------------------------------------------------------------
console.log('\n4. counts, history, overdue, workload, throughput');
{
  const counts = await db.query(q('ticket_counts'), arg({ scope: 'all' }));
  const total = counts.rows.reduce((a, r) => a + r.tickets, 0);
  check('ticket_counts covers every ticket', total === 5, total);
  const assigned = counts.rows.find((r) => r.status === 'ASSIGNED');
  check('it counts what is old within a status', assigned.open_over_30_days === 1,
        assigned.open_over_30_days);
  check('it counts what arrived recently',
        counts.rows.reduce((a, r) => a + r.opened_last_7_days, 0) === 2);

  const hist = await db.query(q('ticket_history'), arg({ ticketId: T1 }));
  check('ticket_history returns the audit trail', hist.rows.length === 2, hist.rows.length);
  check('newest first', hist.rows[0].status_to === 'CLOSED');
  check('it exposes the transition', hist.rows[0].status_from === 'ASSIGNED');

  const overdue = await db.query(q('overdue_tickets'), arg({}));
  check('overdue_tickets defaults to a month', overdue.rows.length === 2, overdue.rows.length);
  check('oldest first', overdue.rows[0].id === T3);
  check('it reports age and staleness separately',
        overdue.rows[0].age_days === 60 && overdue.rows[0].days_since_last_change === 0,
        `${overdue.rows[0].age_days}/${overdue.rows[0].days_since_last_change}`);
  check('a DUPLICATE is not overdue work',
        !overdue.rows.some((r) => r.id === T5));

  const older = await db.query(q('overdue_tickets'), arg({ olderThanDays: 50 }));
  check('the threshold is honoured', older.rows.length === 1 && older.rows[0].id === T3);

  const load = await db.query(q('technician_workload'), arg({ scope: 'all' }));
  check('technician_workload covers every technician', load.rows.length === 4, load.rows.length);
  const mario = load.rows.find((r) => r.full_name === 'Mario Rossi');
  const lucia = load.rows.find((r) => r.full_name === 'Lucia Bianchi');
  check('a closed ticket is not open work', mario.open_tickets === 0 && mario.closed_tickets === 1);
  check('average days to close is computed from the timestamps',
        Number(mario.avg_days_to_close) === 2, mario.avg_days_to_close);
  check('open work is attributed', lucia.open_tickets === 1);
  check('and flagged when it is old', lucia.open_over_30_days === 1);

  const months = await db.query(q('throughput_stats'), arg({ bucket: 'month', buckets: 12 }));
  check('throughput_stats returns periods', months.rows.length >= 1);
  check('every ticket is counted once across the periods',
        months.rows.reduce((a, r) => a + Number(r.opened), 0) === 5,
        months.rows.map((r) => `${r.period_start}:${r.opened}`).join(' '));
  check('closures are counted separately',
        months.rows.reduce((a, r) => a + Number(r.closed), 0) === 1);
  check('the period unit is reported back', months.rows[0].period === 'month');

  const weeks = await db.query(q('throughput_stats'), arg({}));
  check('it defaults to weekly buckets', weeks.rows[0].period === 'week');

  const insp = await db.query(q('inspect_schema'), arg({ scope: 'all' }));
  check('inspect_schema lists real columns', insp.rows.length > 25, insp.rows.length);
  check('including the ones WF2 added',
        insp.rows.some((r) => r.column_name === 'report_text'));
}

// ---------------------------------------------------------------------------
console.log('\n5. every chat tool is read-only at the engine, not only on inspection');
{
  const connectedTools = Object.entries(wf.connections)
    .filter(([, spec]) => (spec.ai_tool || []).some(
      (br) => (br || []).some((e) => e.node === 'FM Dashboard Agent')))
    .map(([name]) => name);

  const params = {
    ticket_lookup: { ticketId: T1 }, ticket_history: { ticketId: T1 },
    ticket_search: {}, ticket_counts: {}, overdue_tickets: {},
    technician_workload: {}, throughput_stats: {}, inspect_schema: {},
  };
  const toolNames=connectedTools.filter(name=>Object.hasOwn(params,name));
  check('eight read-only SQL tools were found to test', toolNames.length === 8, toolNames.length);
  check('the other six tools are the IFC inspector and five guarded FM actions',
        connectedTools.length===14 && connectedTools.includes('inspect_ifc_maintenance') &&
        ['approve_intervention','reject_intervention','resend_approval_email','approve_completion','request_rework'].every(n=>connectedTools.includes(n)),
        connectedTools.join(', '));
  let readOnlyFailures = [];
  for (const name of toolNames) {
    await db.exec('BEGIN TRANSACTION READ ONLY');
    try {
      await db.query(q(name), arg(params[name] || {}));
    } catch (e) {
      readOnlyFailures.push(`${name}: ${e.message}`);
    }
    await db.exec('ROLLBACK');
  }
  check('every tool runs inside a READ ONLY transaction', readOnlyFailures.length === 0,
        readOnlyFailures.join('; '));

  // The same transaction proves the check has teeth.
  await db.exec('BEGIN TRANSACTION READ ONLY');
  let rejected = false;
  try { await db.query(`UPDATE tickets SET status='CLOSED' WHERE id=$1`, [T4]); }
  catch (e) { rejected = /read-only/i.test(e.message); }
  await db.exec('ROLLBACK');
  check('a write in that same transaction is refused, so the check is meaningful', rejected);
}

// ---------------------------------------------------------------------------
console.log('\n6. the weekly report document');
{
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 7 * 86400000);
  const res = await db.query(q('Collect Weekly Data'), arg({
    periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(), staleDays: 30 }));
  const r = res.rows[0].report;

  check('one row, one document', res.rows.length === 1 && typeof r === 'object');
  check('it carries the window back', String(r.stale_days) === '30');

  check('tickets raised this week are counted', r.totals.opened_in_window === 2,
        r.totals.opened_in_window);
  check('tickets closed this week are counted', r.totals.closed_in_window === 1,
        r.totals.closed_in_window);
  check('open now excludes CLOSED and DUPLICATE', r.totals.open_now === 3, r.totals.open_now);
  check('the whole history is reported', r.totals.tickets_all_time === 5);
  check('overdue work is counted', r.totals.stale_now === 2, r.totals.stale_now);

  const ids = r.changes.map((c) => c.ticket_id);
  check('every transition inside the window is listed', r.changes.length === 4, r.changes.length);
  check('a ticket that moved twice appears twice',
        ids.filter((i) => i === T1).length === 2);
  check('a transition older than the window is excluded', !ids.includes(T3), ids);
  check('changes are ordered oldest first',
        r.changes[0].changed_at <= r.changes[r.changes.length - 1].changed_at);
  check('each change knows where the ticket stands now',
        r.changes.find((c) => c.ticket_id === T1).current_status === 'CLOSED');

  check('the overdue list has both stale tickets', r.stale.length === 2);
  check('oldest first', r.stale[0].id === T3 && r.stale[0].age_days === 60);
  check('it says how long since anything happened',
        r.stale[1].days_since_last_change === 0, r.stale[1].days_since_last_change);
  check('a 40-day-old DUPLICATE is not overdue work', !r.stale.some((s) => s.id === T5));

  const statusSum = r.by_status.reduce((a, s) => a + s.tickets, 0);
  check('the status mix accounts for every ticket', statusSum === 5, statusSum);

  // A window in which nothing happened must still return a usable document.
  const quiet = (await db.query(q('Collect Weekly Data'), arg({
    periodStart: '2020-01-01T00:00:00Z', periodEnd: '2020-01-08T00:00:00Z', staleDays: 30 })))
    .rows[0].report;
  check('a quiet week returns empty arrays, not null',
        Array.isArray(quiet.changes) && quiet.changes.length === 0);
  check('and still reports the standing totals', quiet.totals.open_now === 3);
}

// ---------------------------------------------------------------------------
console.log('\n7. the dashboard records what it did');
{
  const logged = await db.query(q('Log FM Question'),
    ['sess-1', "how many tickets are open? '); DROP TABLE tickets; --", '412']);
  check('a question is logged', logged.rows.length === 1);
  const row = (await db.query(
    `SELECT ticket_id, event, payload FROM ticket_events WHERE event='CBM_WF3_QUERY'`)).rows[0];
  check('it belongs to no ticket', row.ticket_id === null);
  check('the question is stored as data', /DROP TABLE/.test(row.payload.question));
  check('the tables survived it',
        (await db.query('SELECT count(*)::int AS n FROM tickets')).rows[0].n === 5);
  check('the answer length is stored as a number', row.payload.answer_chars === 412);

  await db.query(q('Record Weekly Report'),
    [JSON.stringify({ period_start: 'a', period_end: 'b', changed: 4, overdue: 2,
                      overdue_untouched: 1, opened: 2, closed: 1, open_now: 3,
                      narrative_used: true })]);
  const rep = (await db.query(
    `SELECT payload FROM ticket_events WHERE event='CBM_WF3_REPORT'`)).rows[0];
  check('the weekly run is recorded for audit', rep.payload.changed === 4);
  check('including whether the model wrote the summary', rep.payload.narrative_used === true);
}

console.log('\n8. rejected intervention requests are retained but are not open work');
{
  await db.exec("INSERT INTO tickets(status,description,created_at) VALUES('REJECTED','FM rejected intervention',clock_timestamp()-interval '100 days');");
  const all=await db.query(q('ticket_search'),arg({}));
  const open=await db.query(q('ticket_search'),arg({openOnly:true}));
  check('a rejected request remains in the searchable history',all.rows.some(t=>t.status==='REJECTED'));
  check('a rejected request is excluded from open work',!open.rows.some(t=>t.status==='REJECTED')&&open.rows.length===3);
}
await db.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
