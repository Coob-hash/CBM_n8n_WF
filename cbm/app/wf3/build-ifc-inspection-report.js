// Read-only inspection: the HTML and downloaded IFC must describe the same file.
const r = $('Read Latest IFC Maintenance').first().json;
if (r.source !== 'IFC' || !Array.isArray(r.assets)) throw new Error('Invalid IFC inspection response');
const interventions = $('Read IFC Intervention Details').first().json.interventions;
if (!Array.isArray(interventions)) throw new Error('Invalid intervention details response');
const details = a => interventions.find(t => String(t.ticket_id) === String(a.last_ticket_id) && t.ifc_global_id === a.global_id);
const item = $input.first();
const file = await this.helpers.getBinaryDataBuffer(0, 'ifc');
const hash = require('crypto').createHash('sha256').update(file).digest('hex');
if (hash !== r.version_sha256) throw new Error('Downloaded IFC does not match the inspected version');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rows = r.assets.map(a => `<article><h2>${esc(a.name || a.global_id)}</h2>
  <p class="muted">${esc(a.ifc_class)} · ${esc(a.location || 'Location not recorded')}<br>GlobalId: <code>${esc(a.global_id)}</code></p>
  <dl><dt>Latest ticket</dt><dd>#${esc(a.last_ticket_id)}</dd>
  <dt>Maintenance date</dt><dd>${esc(a.last_maintenance_date)}</dd>
  <dt>Technician</dt><dd>${esc(a.last_technician || 'Not recorded')}</dd>
  <dt>Condition</dt><dd>${esc(a.condition)}</dd><dt>Approved by</dt><dd>${esc(a.approved_by || 'Not recorded')}</dd></dl>
  <h3>Latest intervention — technician report</h3>
  <p class="description">${esc(details(a)?.work_performed || details(a)?.report_text || 'No matching technician report is available. See the IFC description below.')}</p>
  ${details(a)?.work_performed ? `<dl><dt>Work date</dt><dd>${esc(details(a).work_date)}</dd><dt>Findings</dt><dd>${esc(details(a).findings)}</dd>
    <dt>Checks</dt><dd>${esc(details(a).checks)}</dd><dt>Remaining issues</dt><dd>${esc(details(a).remaining_issues)}</dd>
    <dt>Ticket status</dt><dd>${esc(details(a).status)}</dd></dl>` : ''}
  <details><summary>Description stored in the IFC</summary><p class="description">${esc(a.last_description || 'No description recorded')}</p>
  <p class="muted">This is the exact IFC property. Older records can contain the original fault description. The work performed above comes from the technician report linked to the same approved IFC operation.</p></details>
  <details><summary>IFC intervention history (${esc(a.history_count)} records)</summary>
  ${a.history.map(h => `<section><strong>Ticket #${esc(h.ticket_id)} · ${esc(h.date)}</strong>
    <p>${esc(h.technician)} · ${esc(h.condition)}</p><p class="description">${esc(h.description)}</p></section>`).join('')}
  ${a.history_truncated ? '<p>Showing the latest 20 records. Download the IFC for the complete history.</p>' : ''}</details></article>`).join('');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>IFC maintenance inspection</title><style>
body{margin:0;background:#eef3f6;color:#203447;font:16px/1.6 Arial,sans-serif}main{max-width:1040px;margin:auto;padding:32px 22px}
header{background:#18334d;color:white;padding:30px;border-radius:12px}h1{margin:5px 0 12px;font-size:30px}h2{font-size:21px;overflow-wrap:anywhere}
.eyebrow{letter-spacing:2px;font-size:12px}.stats{display:flex;gap:24px;flex-wrap:wrap;margin-top:20px}.stats strong{font-size:25px}
article{background:white;padding:25px 30px;margin:22px 0;border-radius:12px;border:1px solid #dbe5eb}.muted,footer{color:#607386;font-size:14px}
dl{display:grid;grid-template-columns:160px 1fr;gap:6px 18px}dt{font-weight:bold}dd{margin:0;overflow-wrap:anywhere}
.description{white-space:pre-wrap;overflow-wrap:anywhere}code{overflow-wrap:anywhere}summary{cursor:pointer;color:#236456}
section{border-top:1px solid #dbe5eb;padding-top:15px;margin-top:15px}.notice{padding:16px;background:#fff4d8;border-radius:8px}
@media(max-width:600px){dl{grid-template-columns:1fr}dd{margin-bottom:10px}header,article{padding:20px}}
</style></head><body><main><header><div class="eyebrow">CBM / IFC MAINTENANCE</div><h1>Maintained assets</h1>
<div>Model: <strong>${esc(r.version_file)}</strong><br>Inspected: ${esc(r.inspected_at)}</div>
<div class="stats"><div><strong>${esc(r.total_maintained_assets)}</strong> maintained assets</div><div><strong>${esc(r.total_interventions)}</strong> recorded interventions</div></div></header>
${r.has_more ? '<p class="notice">This preview is limited to 500 assets. Use the chat tool pagination or download the IFC for all records.</p>' : ''}
${rows || '<article>No assets have a CBM_MaintenanceLog property set in this model.</article>'}
<footer>Read directly from ${esc(r.property_set)} in the IFC file. These entries record IFC updates; check ticket_lookup for the current ticket status.
<p>Download the <strong>ifc</strong> attachment in this n8n node to inspect geometry and properties in an IFC viewer. Select the asset by GlobalId and open CBM_MaintenanceLog.</p>
<p>SHA-256: <code>${esc(r.version_sha256)}</code></p></footer></main></body></html>`;
return [{json:{...r,interventions},binary:{...item.binary,
  maintenance_report:await this.helpers.prepareBinaryData(Buffer.from(html,'utf8'),'ifc-maintenance-report.html','text/html')}}];
