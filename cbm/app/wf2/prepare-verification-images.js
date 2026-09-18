// Keep the extracted AFTER binary; a Drive download produces the BEFORE binary.
const report = $('Extract Report Text and Photo').first();
const item = $input.first();
const before = item.binary?.data;
const after = report.binary?.data;
const ready = !!before && !!after && !item.json.error;
return [{json:{...report.json, images_ready:ready},
  binary:ready ? {before_photo:before, data:after} : {}}];
