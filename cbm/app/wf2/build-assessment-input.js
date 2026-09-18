const report = $('Extract Report Text and Photo').first().json;
const ticket = $('Fetch Ticket').first().json;
let vision = null;
try {
  const v = $('Parse Verification').first().json;
  vision = {repair_verified:v.repair_verified, confidence:v.ai_confidence, observations:v.observations};
} catch {}
let summary;
if (vision) summary = `An AFTER photo was extracted from the PDF. Comparison verdict: repair_verified=${vision.repair_verified}, confidence=${vision.confidence}. ${vision.observations}`;
else if (report.photo_status === 'NONE') summary = 'No photograph was supplied. Judge the written report alone.';
else if (report.photo_status !== 'OK') summary = 'Photo extraction could not establish usable evidence (' + report.photo_status + '): ' + (report.photo_error || report.report_parse_error || 'unknown') + '. Do not claim the photo was absent or verified.';
else if (!ticket.before_file_id) summary = 'The PDF contains an AFTER photo, but the ticket has no BEFORE photo reference. No visual comparison was performed.';
else summary = 'The PDF contains an AFTER photo, but image comparison could not be completed. Do not treat the repair as visually verified.';
return [{json:{
  ticket_id:ticket.id, object_type:ticket.object_type || ticket.ifc_name || 'unspecified object',
  damage_description:ticket.damage_description || ticket.description || '',
  technician_name:ticket.technician_name || '', technician_email:ticket.technician_email || '',
  report_text:report.report_text, report_quality:report.report_quality, report_words:report.report_words,
  report_file_id:report.report_file_id, report_link:report.report_link,
  photo_supplied:report.photo_status === 'NONE' ? false : report.photo_status === 'OK' ? true : null,
  photo_status:report.photo_status, photo_source:report.photo_source, photo_page:report.photo_page,
  photo_error:report.photo_error, after_file_id:null, after_link:report.after_link || '',
  vision, vision_summary:summary
}}];
