const access=$json.context;
if(access.status!=='OK')return [{json:{result:access}}];
try{
 const body=$('Submit Technician Report').first().json.body;
 const report=JSON.parse(String(body.report||''));
 const limits={findings:[1,3000],work_performed:[20,6000],materials:[0,2000],checks:[1,4000],remaining_issues:[1,4000],photo_caption:[0,500]};
 for(const [key,[min,max]] of Object.entries(limits)){
  if(typeof (report[key]??'')!=='string')throw new Error('Invalid '+key);
  report[key]=String(report[key]||'').trim();if(report[key].length<min||report[key].length>max)throw new Error('Check '+key);
 }
 if(report.declaration!==true||!['PASSED','FAILED','NOT_PERFORMED'].includes(report.check_result)||!['COMPLETED','PARTIAL','NOT_COMPLETED'].includes(report.outcome)||!/^\d{4}-\d{2}-\d{2}$/.test(report.work_date))throw new Error('Complete the date, results and confirmation');
 for(const [key,value] of Object.entries(access.fields))if(String(report[key]??'')!==String(value??''))throw new Error('Ticket details changed. Reopen the assigned link.');
 if(typeof body.pdfB64!=='string'||body.pdfB64.length>12*1024*1024||!/^[A-Za-z0-9+/]+={0,2}$/.test(body.pdfB64))throw new Error('Invalid report PDF');
 const buf=Buffer.from(body.pdfB64,'base64');
 if(buf.length>8*1024*1024||buf.subarray(0,5).toString()!=='%PDF-')throw new Error('Report must be a PDF up to 8 MiB');
 const base=String($env.IFC_SERVICE_URL||'').replace(/\/+$/,'');
 const parsed=await this.helpers.httpRequest({method:'POST',url:base+'/reports/extract',json:true,body:{pdfB64:body.pdfB64},timeout:60000});
 const normalize=v=>String(v||'').normalize('NFC').replace(/\s+/g,' ').trim();
 for(const key of ['technician_name','technician_email','reported_issue','work_performed','checks'])if(!normalize(parsed.text).includes(normalize(report[key])))throw new Error('PDF does not match the form. Generate it again.');
 if(report.photoSupplied===true&&(parsed.photo_status!=='OK'||!report.photo_caption))throw new Error('The intervention photo could not be read. Select it again.');
 const safe={schema_version:'1.0',...access.fields,work_date:report.work_date,check_result:report.check_result,outcome:report.outcome,declaration:true,photoSupplied:report.photoSupplied===true};
 for(const key of Object.keys(limits))safe[key]=report[key];
 const request={ticketId:access.ticketId,token:body.token,pdf_sha256:require('crypto').createHash('sha256').update(buf).digest('hex'),report:safe};
 return [{json:{valid:true,request},binary:{data:await this.helpers.prepareBinaryData(buf,'TICKET-'+access.ticketId+'.pdf','application/pdf')}}];
}catch(e){return [{json:{valid:false,result:{status:'INVALID',detail:String(e.message||e).slice(0,240)}}}];}
