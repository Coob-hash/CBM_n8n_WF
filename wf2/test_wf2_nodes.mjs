// Behavioural tests for WF2's Code nodes, run against the JavaScript actually
// stored in the workflow export rather than a copy of it.
//
// The n8n surfaces each node touches are mocked: $input, $(), and
// this.helpers.getBinaryDataBuffer.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const wf = JSON.parse(fs.readFileSync(
  path.join(HERE, '..', 'n8n_wf2_completion_approval_ifc_update.json'), 'utf8'));
const src = (name) => wf.nodes.find(n => n.name === name).parameters.jsCode;

let failed = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) { failed++; if (detail !== undefined) console.log('          got:', detail); }
};

// Run a Code node body with mocked context.
async function run(code, { input = {}, nodes = {}, binary = null } = {}) {
  const $input = {
    first: () => ({ json: input, binary: binary ? { data: {} } : undefined }),
  };
  const $ = (name) => {
    if (!(name in nodes)) {
      throw new Error(`No node named "${name}" was executed in this run`);
    }
    return { first: () => ({ json: nodes[name] }) };
  };
  const helpers = { getBinaryDataBuffer: async () => binary };
  const fn = new Function('$input', '$', 'require',
    `return (async function () { ${code} }).call(this);`);
  return fn.call({ helpers }, $input, $, (m) => {
    if (m === 'pdf-parse') return globalThis.__pdfStub;
    throw new Error('module not allowlisted: ' + m);
  });
}

// ---------------------------------------------------------------------------
console.log('\n1. Extract Ticket ID - report mandatory, photo ignored on its own');
{
  const code = src('Extract Ticket ID');
  const pdf = await run(code, { input: { name: 'TICKET-42.pdf', id: 'f1', webViewLink: 'http://d/f1' } });
  check('a report PDF is accepted', pdf.length === 1 && pdf[0].json.ticket_id === 42);
  check('report file id is carried', pdf[0]?.json.report_file_id === 'f1');
  check('upload_kind is REPORT', pdf[0]?.json.upload_kind === 'REPORT');

  for (const name of ['TICKET-42.jpg', 'TICKET-42.png', 'TICKET-42.heic']) {
    const r = await run(code, { input: { name, id: 'p1' } });
    check(`a lone photo (${name}) ends the run quietly`, Array.isArray(r) && r.length === 0);
  }
  const other = await run(code, { input: { name: 'notes.docx', id: 'x' } });
  check('an unrelated file ends the run quietly', other.length === 0);

  const noRef = await run(code, { input: { name: 'report.pdf', id: 'f2' } });
  check('a PDF with no TICKET reference is passed on unmatched',
        noRef.length === 1 && noRef[0].json.matched === false);

  for (const [name, id] of [['ticket_7.pdf', 7], ['TICKET 13.pdf', 13], ['TICKET-999.PDF', 999]]) {
    const r = await run(code, { input: { name, id: 'f' } });
    check(`filename variant ${name} -> ticket ${id}`, r[0]?.json.ticket_id === id, r[0]?.json.ticket_id);
  }
}

// ---------------------------------------------------------------------------
console.log('\n2. Extract Report Text - PDF quality gating');
{
  const code = src('Extract Report Text');
  const ctx = { 'Extract Ticket ID': { ticket_id: 42, report_file_id: 'f1' } };

  globalThis.__pdfStub = async () => ({ text: 'Replaced the cartridge and tested the valve. No leaks remain.', numpages: 1 });
  const ok = await run(code, { nodes: ctx, binary: Buffer.from('x') });
  check('a readable report is OK', ok[0].json.report_quality === 'OK');
  check('word count is reported', ok[0].json.report_words === 10, ok[0].json.report_words);

  globalThis.__pdfStub = async () => ({ text: '   \n  ', numpages: 1 });
  const empty = await run(code, { nodes: ctx, binary: Buffer.from('x') });
  check('a scanned/empty PDF is EMPTY, not OK', empty[0].json.report_quality === 'EMPTY');

  globalThis.__pdfStub = async () => { throw new Error('bad xref table'); };
  const bad = await run(code, { nodes: ctx, binary: Buffer.from('x') });
  check('an unparseable PDF is PARSE_ERROR', bad[0].json.report_quality === 'PARSE_ERROR');
  check('the parse error is recorded', /bad xref/.test(bad[0].json.report_parse_error));
  check('the node does not throw', true);
}

// ---------------------------------------------------------------------------
console.log('\n3. Build Assessment Input - photo optional');
{
  const code = src('Build Assessment Input');
  const base = {
    'Extract Report Text': { report_text: 'Valve replaced.', report_quality: 'OK', report_words: 2,
                             report_file_id: 'f1', report_link: 'http://d/f1' },
    'Fetch Ticket': { id: 42, ifc_name: 'Radiator', description: 'leaking',
                      technician_name: 'Mario', technician_email: 'm@x.com' },
  };
  const noPhoto = await run(code, { nodes: base });
  check('runs with no vision node executed', noPhoto.length === 1);
  check('photo_supplied is false', noPhoto[0].json.photo_supplied === false);
  check('vision is null', noPhoto[0].json.vision === null);
  check('prompt states the report stands alone',
        /No photograph was supplied/.test(noPhoto[0].json.vision_summary));

  const withPhoto = await run(code, { nodes: { ...base,
    'Parse Verification': { repair_verified: true, ai_confidence: 0.8, observations: 'looks fixed',
                            after_file_id: 'a1', after_link: 'http://d/a1' } } });
  check('photo_supplied is true when vision ran', withPhoto[0].json.photo_supplied === true);
  check('vision verdict is carried', withPhoto[0].json.vision.repair_verified === true);
  check('prompt includes the image verdict',
        /repair_verified=true/.test(withPhoto[0].json.vision_summary));
}

// ---------------------------------------------------------------------------
console.log('\n4. Parse Completion Assessment - the model proposes, the node decides');
{
  const code = src('Parse Completion Assessment');
  const nodes = (q = 'OK', vision = null) => ({
    'Build Assessment Input': { ticket_id: 42, report_quality: q, report_words: 20,
      report_text: 'text', report_file_id: 'f1', report_link: 'l', photo_supplied: !!vision,
      vision, technician_name: 'Mario', technician_email: 'm@x.com',
      object_type: 'Radiator', damage_description: 'leaking' },
    'Fetch Ticket': { id: 42, ifc_global_id: 'GUID', technician_id: 3 },
  });
  const say = (o) => ({ text: JSON.stringify(o) });

  const good = await run(code, { input: say({ work_complete: true, confidence: 0.9,
    recommended_status: 'PENDING_APPROVAL', summary: 'done', concerns: '' }), nodes: nodes() });
  check('a credible report reaches PENDING_APPROVAL',
        good[0].json.resolved_status === 'PENDING_APPROVAL');

  const rework = await run(code, { input: say({ work_complete: false, confidence: 0.4,
    recommended_status: 'REWORK', summary: 'incomplete' }), nodes: nodes() });
  check('an incomplete report reaches REWORK', rework[0].json.resolved_status === 'REWORK');

  const invented = await run(code, { input: say({ work_complete: true, confidence: 1,
    recommended_status: 'CLOSED', summary: 'closing it myself' }), nodes: nodes() });
  check('an invented status is refused and becomes REWORK',
        invented[0].json.resolved_status === 'REWORK', invented[0].json.resolved_status);
  check('the refusal reason is recorded',
        /unrecognised status/i.test(invented[0].json.observations), invented[0].json.observations);

  const garbage = await run(code, { input: { text: 'I think the repair looks fine!' }, nodes: nodes() });
  check('unparseable output becomes REWORK, never PENDING_APPROVAL',
        garbage[0].json.resolved_status === 'REWORK');

  const unreadable = await run(code, { input: say({ work_complete: true, confidence: 0.95,
    recommended_status: 'PENDING_APPROVAL', summary: 'looks done' }), nodes: nodes('EMPTY') });
  check('an unreadable report cannot pass, whatever the model says',
        unreadable[0].json.resolved_status === 'REWORK');
  check('the override reason names the report quality',
        /could not be read/i.test(unreadable[0].json.observations), unreadable[0].json.observations);

  const triage = await run(code, { input: say({ work_complete: false, confidence: 0.6,
    recommended_status: 'NEEDS_TRIAGE', summary: 'wrong diagnosis' }), nodes: nodes() });
  check('NEEDS_TRIAGE is allowed', triage[0].json.resolved_status === 'NEEDS_TRIAGE');

  const quoted = await run(code, { input: say({ work_complete: true, confidence: 0.9,
    recommended_status: 'PENDING_APPROVAL', summary: "it's fixed", concerns: '' }), nodes: nodes() });
  check('single quotes are escaped for SQL',
        quoted[0].json.verification_sql.includes("it''s fixed"));
  check('verification records whether a photo was supplied',
        JSON.parse(quoted[0].json.verification_sql.replace(/''/g, "'")).photo_supplied === false);
}

// ---------------------------------------------------------------------------
console.log('\n5. Closure Context - one bounded path for both decisions');
{
  const code = src('Closure Context');
  const assessment = { id: 42, ifc_global_id: 'GUID', technician_id: 3, technician_name: 'Mario',
    technician_email: 'm@x.com', object_type: 'Radiator', damage_description: 'leaking',
    observations: 'done', report_link: 'l', after_link: '', photo_supplied: false };

  const approved = await run(code, { nodes: {
    'FM Approval (Email + Wait)': { data: { approved: true } },
    'Parse Completion Assessment': assessment } });
  check('approval yields decision APPROVED', approved[0].json.decision === 'APPROVED');
  check('approved objectives are the five closure steps',
        approved[0].json.objectives.length === 5 &&
        approved[0].json.objectives.includes('log_ifc_maintenance'));
  check('attempt budget is 3', approved[0].json.attemptBudget === 3);

  const rejected = await run(code, { nodes: {
    'FM Approval (Email + Wait)': { data: { approved: false } },
    'Parse Completion Assessment': assessment } });
  check('rejection yields decision REJECTED', rejected[0].json.decision === 'REJECTED');
  check('rejected objectives are rework and notify',
        JSON.stringify(rejected[0].json.objectives) ===
        JSON.stringify(['reopen_for_rework', 'notify_technician_rework']));

  const timedOut = await run(code, { nodes: {
    'FM Approval (Email + Wait)': {},
    'Parse Completion Assessment': assessment } });
  check('a missing approval payload is treated as REJECTED, not approved',
        timedOut[0].json.decision === 'REJECTED');
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
