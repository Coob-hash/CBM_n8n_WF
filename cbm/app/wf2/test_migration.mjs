// Apply schema.sql then schema_wf2_completion.sql to a real PostgreSQL engine
// (PGlite) and assert the resulting shape, plus the queries WF2 actually runs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const { createRequire } = await import('node:module');
const PGLITE = path.join(ROOT, 'phase_b', '.test-runtime', 'pglite', 'dist', 'index.cjs');
if (!fs.existsSync(PGLITE)) {
  console.error('The PGlite test engine is not installed in this clone.');
  console.error('Run this once, then retry:');
  console.error('    node phase_b/setup-test-runtime.js');
  process.exit(1);
}
const { PGlite } = createRequire(import.meta.url)(PGLITE);

let failed = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) { failed++; if (detail !== undefined) console.log('          got:', detail); }
};

const db = new PGlite();
const sql = (f) => fs.readFileSync(path.join(ROOT, '../../database', f), 'utf8');

console.log('\n1. migration applies to the legacy schema');
await db.exec(sql('schema.sql'));
check('schema.sql applies', true);
await db.exec(sql('schema_wf2_completion.sql'));
check('schema_wf2_completion.sql applies', true);

// Idempotency: applying twice must not fail.
let twice = true;
try { await db.exec(sql('schema_wf2_completion.sql')); } catch (e) { twice = false; console.log('   ', e.message); }
check('migration is idempotent (applies twice)', twice);

console.log('\n2. the columns WF2 writes now exist');
const cols = await db.query(`SELECT table_name, column_name FROM information_schema.columns
  WHERE table_schema='public' AND table_name IN ('tickets','technicians')`);
const have = new Set(cols.rows.map(r => `${r.table_name}.${r.column_name}`));
for (const c of ['tickets.report_text', 'tickets.report_file_id', 'tickets.after_file_id',
                 'tickets.verification', 'tickets.closed_at', 'technicians.jobs_completed']) {
  check(`${c} exists`, have.has(c));
}
check('tickets.ifc_new_version is the version column WF2 now uses',
      have.has('tickets.ifc_new_version'));

console.log('\n3. the statements WF2 runs actually execute');
const tech = await db.query(
  `INSERT INTO technicians(full_name,email,skills) VALUES('Mario','m@x.com','{plumbing}') RETURNING id`);
const tid = tech.rows[0].id;
const tk = await db.query(
  `INSERT INTO tickets(status,description,ifc_name,ifc_global_id,technician_id,photo_before_url)
   VALUES('ASSIGNED','leaking valve','Radiator','GUID-1',$1,'http://b') RETURNING id`, [tid]);
const ticket = tk.rows[0].id;

// Fetch Ticket, as rebuilt: aliases plus the technician join.
const fetched = await db.query(
  `SELECT t.*, t.description AS damage_description, t.ifc_name AS object_type,
          t.photo_before_url AS photo_url, te.full_name AS technician_name,
          te.email AS technician_email
     FROM tickets t LEFT JOIN technicians te ON te.id=t.technician_id
    WHERE t.id=$1 LIMIT 1`, [ticket]);
const row = fetched.rows[0];
check('Fetch Ticket supplies technician_name', row.technician_name === 'Mario', row.technician_name);
check('Fetch Ticket supplies technician_email', row.technician_email === 'm@x.com');
check('Fetch Ticket aliases damage_description', row.damage_description === 'leaking valve');
check('Fetch Ticket aliases object_type', row.object_type === 'Radiator');

// Set Pending Approval, as rebuilt.
await db.query(
  `UPDATE tickets SET status='PENDING_APPROVAL', report_text=$2, report_file_id=$3,
          after_file_id=NULL, verification=$4::jsonb, updated_at=now()
    WHERE id=$1`, [ticket, 'Replaced the valve.', 'f1',
                   JSON.stringify({ source: 'REPORT', photo_supplied: false, work_complete: true })]);
const saved = (await db.query('SELECT report_text,verification,status FROM tickets WHERE id=$1', [ticket])).rows[0];
check('report text is persisted', saved.report_text === 'Replaced the valve.');
check('verification is stored as an object', saved.verification.source === 'REPORT');
check('status moved to PENDING_APPROVAL', saved.status === 'PENDING_APPROVAL');

console.log('\n4. supervisor tools are idempotent and guarded');
const closeSql = `WITH v AS (SELECT $1::jsonb AS p)
UPDATE tickets SET status='CLOSED', closed_at=COALESCE(closed_at, now()),
       ifc_new_version = COALESCE(NULLIF(v.p->>'versionFile',''), ifc_new_version),
       updated_at = now()
  FROM v WHERE tickets.id = (v.p->>'ticketId')::int AND tickets.status <> 'CLOSED'
 RETURNING tickets.id, tickets.status, tickets.closed_at, tickets.ifc_new_version`;
const arg = JSON.stringify({ ticketId: ticket, versionFile: 'room_v2.ifc' });
const first = await db.query(closeSql, [arg]);
check('close_ticket closes the ticket', first.rows.length === 1 && first.rows[0].status === 'CLOSED');
check('close_ticket records the IFC version', first.rows[0].ifc_new_version === 'room_v2.ifc');
const second = await db.query(closeSql, [arg]);
check('close_ticket is idempotent (second call changes nothing)', second.rows.length === 0);

const statsSql = `WITH v AS (SELECT $1::jsonb AS p)
UPDATE technicians SET jobs_completed = jobs_completed + 1
  FROM v WHERE technicians.id = NULLIF(v.p->>'technicianId','')::int
 RETURNING technicians.id, technicians.jobs_completed`;
const s1 = await db.query(statsSql, [JSON.stringify({ technicianId: tid })]);
check('update_technician_stats increments', s1.rows[0].jobs_completed === 1);
const s0 = await db.query(statsSql, [JSON.stringify({ technicianId: null })]);
check('update_technician_stats is safe with no technician', s0.rows.length === 0);

// closed_at guard
let guarded = false;
try {
  await db.query(`UPDATE tickets SET status='REWORK' WHERE id=$1`, [ticket]);
} catch (e) { guarded = /tickets_closed_at_consistent/.test(e.message); }
check('reopening without clearing closed_at is rejected by the CHECK', guarded);

const reopenSql = `WITH v AS (SELECT $1::jsonb AS p)
UPDATE tickets SET status='REWORK', closed_at=NULL,
       fm_reject_reason = COALESCE(NULLIF(v.p->>'reason',''), fm_reject_reason), updated_at=now()
  FROM v WHERE tickets.id=(v.p->>'ticketId')::int AND tickets.status <> 'REWORK'
 RETURNING tickets.id, tickets.status`;
const r1 = await db.query(reopenSql, [JSON.stringify({ ticketId: ticket, reason: 'valve still drips' })]);
check('reopen_for_rework clears closed_at and passes the CHECK', r1.rows[0].status === 'REWORK');
const r2 = await db.query(reopenSql, [JSON.stringify({ ticketId: ticket, reason: 'x' })]);
check('reopen_for_rework is idempotent', r2.rows.length === 0);

console.log('\n5. audit trail for retries');
const recordSql = `INSERT INTO ticket_events(ticket_id, event, payload)
SELECT ($1::jsonb->>'ticketId')::int,
       CASE WHEN upper($1::jsonb->>'kind')='NOTICE' THEN 'CBM_WF2_NOTICE' ELSE 'CBM_WF2_ATTEMPT' END,
       jsonb_build_object('notice_key',$1::jsonb->>'key','operation',$1::jsonb->>'operation',
                          'outcome',$1::jsonb->>'outcome','detail',$1::jsonb->>'detail')
RETURNING id, event`;
const n1 = await db.query(recordSql, [JSON.stringify({ ticketId: ticket, kind: 'NOTICE',
  key: 'technician:closed', operation: 'notify_technician', outcome: 'SUCCEEDED', detail: '' })]);
check('record_attempt writes a NOTICE event', n1.rows[0].event === 'CBM_WF2_NOTICE');
const a1 = await db.query(recordSql, [JSON.stringify({ ticketId: ticket, kind: 'ATTEMPT',
  key: '', operation: 'close_ticket', outcome: 'FAILED', detail: 'column "ifc_version" does not exist' })]);
check('record_attempt writes an ATTEMPT event', a1.rows[0].event === 'CBM_WF2_ATTEMPT');

const notices = await db.query(
  `SELECT payload->>'notice_key' AS notice_key FROM ticket_events
    WHERE ticket_id=$1 AND event='CBM_WF2_NOTICE' ORDER BY id`, [ticket]);
check('check_notice sees the delivered notice', notices.rows[0].notice_key === 'technician:closed');

console.log('\n6. inspect_schema, the agent diagnostic tool');
const insp = await db.query(
  `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
    WHERE table_schema='public' AND table_name IN ('tickets','technicians','ticket_events')
    ORDER BY table_name, ordinal_position`);
check('inspect_schema returns real columns', insp.rows.length > 20, insp.rows.length);
check('inspect_schema would reveal ifc_new_version to a failing agent',
      insp.rows.some(r => r.column_name === 'ifc_new_version'));

await db.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
