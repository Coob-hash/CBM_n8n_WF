const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const wf=JSON.parse(fs.readFileSync(path.join(__dirname,'../n8n_wf2_completion_approval_ifc_update.json')));
const source=name=>wf.nodes.find(n=>n.name===name).parameters.jsCode;
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const report={ticket_id:42,report_file_id:'report42',report_link:'https://drive.google.com/file/d/report42/view'};
const ticket={id:42,technician_id:1,before_file_id:'before42'};
let checks=0;
async function run(name,{response,input={},nodes={},binary={data:{id:'before-binary'}}}={}){
 const fn=new AsyncFunction('$input','$','$env',source(name));
 const look={ 'Extract Ticket ID':{json:report}, 'Fetch Ticket':{json:ticket},...nodes };
 return (await fn.call({helpers:{
  getBinaryDataBuffer:async()=>Buffer.from('%PDF-1.7'),
  prepareBinaryData:async(bytes,fileName,mimeType)=>({data:bytes.toString('base64'),fileName,mimeType}),
  httpRequest:async opt=>{assert.equal(opt.url,'http://ifc-service:8000/reports/extract');if(response instanceof Error)throw response;return response;}
 }},{first:()=>({json:input,binary})},name=>{if(!look[name])throw Error('Node did not execute');return {first:()=>look[name]};},{IFC_SERVICE_URL:'http://ifc-service:8000/'}))[0];
}
async function main(){
 const text='Replaced the cartridge and tested the valve. No leaks remain.';
 for(const photo_status of ['NONE','AMBIGUOUS','ERROR']){
  const x=await run('Extract Report Text and Photo',{response:{text,numpages:2,photo_status,photo_error:photo_status==='NONE'?null:'check photo'}});
  assert.equal(x.json.report_quality,'OK');assert.equal(x.json.report_words,10);assert.equal(x.json.photo_available,false);assert.equal(x.binary.data,undefined);checks++;
  const assessment=await run('Build Assessment Input',{nodes:{'Extract Report Text and Photo':x}});
  assert.equal(assessment.json.photo_supplied,photo_status==='NONE'?false:null);checks++;
 }
 const photo={base64:Buffer.from([255,216,255,217]).toString('base64'),mime_type:'image/jpeg',source:'PDF_ATTACHMENT',page:null};
 const x=await run('Extract Report Text and Photo',{response:{text,numpages:2,photo_status:'OK',photo}});
 assert.equal(x.json.photo_available,true);assert.equal(x.binary.data.mimeType,'image/jpeg');assert.equal(x.json.after_file_id,null);checks++;
 const nodes={'Extract Report Text and Photo':x};
 const pair=await run('Prepare Verification Images',{nodes});assert(pair.binary.before_photo);assert(pair.binary.data);assert(pair.json.images_ready);checks++;
 const failed=await run('Prepare Verification Images',{nodes,input:{error:'Drive unavailable'},binary:{}});assert.equal(failed.json.images_ready,false);checks++;
 const noBefore=await run('Build Assessment Input',{nodes:{...nodes,'Fetch Ticket':{json:{...ticket,before_file_id:null}}}});assert.match(noBefore.json.vision_summary,/no BEFORE/);assert.equal(noBefore.json.photo_supplied,true);checks++;
 const completed=await run('Build Assessment Input',{nodes:{...nodes,'Parse Verification':{json:{repair_verified:true,ai_confidence:.8,observations:'Door now aligned.'}}}});assert.equal(completed.json.vision.repair_verified,true);checks++;
 const verdict=await run('Parse Completion Assessment',{input:{text:JSON.stringify({work_complete:true,confidence:.8,recommended_status:'PENDING_APPROVAL',summary:'Door repaired.'})},nodes:{'Build Assessment Input':completed}});
 assert.equal(verdict.json.verification.photo_source,'PDF_ATTACHMENT');assert.equal(verdict.json.verification.vision.repair_verified,true);checks++;
 for(const response of [new Error('unreadable'),{text:'',numpages:1,photo_status:'NONE'},{text,numpages:2}]){
  const r=await run('Extract Report Text and Photo',{response});
  if(response instanceof Error)assert.equal(r.json.report_quality,'PARSE_ERROR');
  else if(!response.text)assert.equal(r.json.report_quality,'EMPTY');
  else {assert.equal(r.json.photo_status,'ERROR');assert.equal(r.json.report_quality,'OK');}checks++;
 }
 for(const name of ['TICKET-42.jpg','unrelated.txt']){assert.equal(await run('Extract Ticket ID',{input:{name}}),undefined);checks++;}
 assert.equal((await run('Extract Ticket ID',{input:{name:'TICKET-42.pdf',id:'r'}})).json.ticket_id,42);checks++;
 const all=JSON.stringify(wf);assert(!all.includes('Find AFTER Photo'));assert(!all.includes('Report Reminder Needed?'));checks++;
 console.log(`${checks} PDF submission contract checks passed.`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
