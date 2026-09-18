const r = $('Read IFC Maintenance').first().json;
const request = $('Validate IFC Request').first().json;
const rows = $input.first().json.interventions;
if (r.source !== 'IFC' || !Array.isArray(r.assets) || !Array.isArray(rows))
  throw new Error('Invalid IFC maintenance tool response');
const text = (v, max=1600) => v == null ? null : String(v).slice(0,max);
const assets = r.assets.map(a => {
  const t = rows.find(t => String(t.ticket_id) === String(a.last_ticket_id) && t.ifc_global_id === a.global_id);
  const matched = t?.matches_current_approval === true;
  const fields = {work_performed:matched ? t.work_performed : null,
    findings:matched ? t.findings : null,checks:matched ? t.checks : null,
    remaining_issues:matched ? t.remaining_issues : null,materials:matched ? t.materials : null,
    report_excerpt:matched && !t.work_performed ? t.report_text : null};
  return {global_id:a.global_id,name:text(a.name),ifc_class:a.ifc_class,location:a.location,
    maintenance_date:a.last_maintenance_date,ticket_id:a.last_ticket_id,ticket_status:t?.status || null,
    technician:text(a.last_technician || t?.technician_name),condition:a.condition,approved_by:text(a.approved_by),
    intervention_source:matched && t.work_performed ? 'matched_technician_submission' :
      matched && t.report_text ? 'matched_ticket_report' : 'IFC_properties_only',
    work_date:matched ? t.work_date : null,
    ...Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,text(v)])),
    report_text_truncated:Object.values(fields).some(v=>v != null && String(v).length>1600),
    ifc_description:text(a.last_description),
    ifc_description_truncated:String(a.last_description || '').length>1600,
    recorded_interventions:a.history_count};
});
return [{json:{source:'IFC model properties and matched PostgreSQL technician reports',
 model_version:r.version_file,model_sha256:r.version_sha256,inspected_at:r.inspected_at,
 order:r.order,count:assets.length,total_matching_assets:r.total_maintained_assets,
 total_matching_interventions:r.total_interventions,
 requested_limit:request.requested_limit,page_size:request.limit,offset:r.offset,
 has_more:r.has_more,next_offset:r.has_more ? r.offset+assets.length : null,
 filters:{global_ids:r.global_ids_filter,search:r.search},assets,
 note:'An IFC maintenance entry records a model update. ticket_status is the current database status. ifc_description may be the original fault; work_performed comes from the matched technician report.'}}];
