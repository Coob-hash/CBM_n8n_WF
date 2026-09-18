'use strict';
const fs = require('node:fs'), path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname,name),'utf8');
const edges = (...branches) => ({main:branches.map(b=>b.map(node=>({node,type:'main',index:0})))});
function apply(wf) {
  const get = name => wf.nodes.find(n=>n.name===name);
  const rename = (oldName,newName) => {
    if(!get(oldName)) return;
    get(oldName).name=newName;
    if(wf.connections[oldName]){wf.connections[newName]=wf.connections[oldName];delete wf.connections[oldName];}
    for(const con of Object.values(wf.connections))for(const outs of Object.values(con))for(const targets of outs)for(const target of targets)if(target.node===oldName)target.node=newName;
  };
  const visionTargets = wf.connections['Merge Photos']?.main?.[0] || wf.connections['Verification Images Ready?']?.main?.[0];
  if(!visionTargets?.length) throw Error('No connected image-verification chain');
  rename('Extract Report Text','Extract Report Text and Photo');
  rename('Rename Binary (before_photo)','Prepare Verification Images');
  get('Extract Report Text and Photo').parameters.jsCode = fs.readFileSync(path.join(__dirname,'../extract-report.js'),'utf8');
  get('Extract Ticket ID').parameters.jsCode = `// The PDF is the complete submission; standalone photos do not start completion.\nconst f=$input.first().json,name=String(f.name||'');\nif(!/\\.pdf$/i.test(name))return [];\nconst m=name.match(/^TICKET[-_ ]?(\\d+)(?:_after)?\\.pdf$/i);\nreturn [{json:{matched:!!m,ticket_id:m?Number(m[1]):null,upload_kind:'REPORT',report_file_id:f.id,report_file_name:name,report_link:f.webViewLink||''}}];`;
  const removed = new Set(['Find AFTER Photo','Download AFTER Photo','Merge Photos','Report Upload?','Report Reminder Needed?','Remind Technician - Report Required']);
  wf.nodes=wf.nodes.filter(n=>!removed.has(n.name));
  for(const name of removed) delete wf.connections[name];
  const gate=get('Photo Available?');
  gate.parameters.conditions.conditions[0].leftValue='={{ $json.photo_available === true && $json.report_quality === "OK" && !!$("Fetch Ticket").first().json.before_file_id }}';
  gate.notes='Compare only when the PDF contains a usable AFTER photo and this ticket has a BEFORE photo. Otherwise assess the report with the explicit evidence status.';
  gate.notesInFlow=true;
  get('Download BEFORE Photo').onError='continueRegularOutput';
  get('Prepare Verification Images').parameters.jsCode=read('prepare-verification-images.js');
  if(!get('Verification Images Ready?')){
    const ready=JSON.parse(JSON.stringify(gate));
    Object.assign(ready,{name:'Verification Images Ready?',id:'cbm-wf2-verification-images-ready',position:[-2096,800],notes:'A failed BEFORE download must not discard the report.',notesInFlow:false});
    ready.parameters.conditions.conditions[0].leftValue='={{ $json.images_ready === true }}';
    wf.nodes.push(ready);
  }
  wf.connections['Ticket Open and Assigned?'].main[0]=edges(['Download Report PDF']).main[0];
  wf.connections['Download Report PDF']=edges(['Extract Report Text and Photo']);
  wf.connections['Extract Report Text and Photo']=edges(['Photo Available?']);
  wf.connections['Photo Available?']=edges(['Download BEFORE Photo'],['Build Assessment Input']);
  wf.connections['Download BEFORE Photo']=edges(['Prepare Verification Images']);
  wf.connections['Prepare Verification Images']=edges(['Verification Images Ready?']);
  wf.connections['Verification Images Ready?']={main:[visionTargets,edges(['Build Assessment Input']).main[0]]};
  get('Build Assessment Input').parameters.jsCode=read('build-assessment-input.js');
  get('Parse Verification').parameters.jsCode=`const raw=String($input.first().json.text||'').trim().replace(/^\x60\x60\x60(json)?/i,'').replace(/\x60\x60\x60$/,'').trim();\nlet v;try{v=JSON.parse(raw);}catch{v={observations:'Image comparison returned no readable verdict.'};}\nreturn [{json:{repair_verified:typeof v.repair_verified==='boolean'?v.repair_verified:null,ai_confidence:typeof v.confidence==='number'?Math.max(0,Math.min(1,v.confidence)):0,observations:v.observations||'No usable visual observation.'}}];`;
  let parse=get('Parse Completion Assessment').parameters.jsCode;
  if(!parse.includes('photo_status: input.photo_status')){
    parse=parse.replace('photo_supplied: input.photo_supplied,','photo_supplied: input.photo_supplied,\n  photo_status: input.photo_status, photo_source: input.photo_source, photo_page: input.photo_page, photo_error: input.photo_error,');
    parse=parse.replace('verification_sql: sql(JSON.stringify(verification)),','verification,\n    verification_sql: sql(JSON.stringify(verification)),');
  }
  get('Parse Completion Assessment').parameters.jsCode=parse;
  const pending=get('Set Pending Approval').parameters.options;
  pending.queryReplacement='={{ [$json.id,$json.report_text || "",$json.report_file_id,null,JSON.stringify({...$json.verification,recommended_status:$json.resolved_status})] }}';
  const fm=get('FM Approval (Email + Wait)').parameters;
  fm.message='=Ticket {{ $("Parse Completion Assessment").first().json.id }} awaits your decision. Written report and optional AFTER photo: {{ $("Parse Completion Assessment").first().json.report_link }}<br/>Photo extraction: {{ $("Build Assessment Input").first().json.photo_status }}. {{ $("Build Assessment Input").first().json.vision_summary }}<br/>Assessment recommends: {{ $("Parse Completion Assessment").first().json.resolved_status }}. Timeout does not reject this work. This renewed request has current approval links.';
  for(const name of ['Sticky - Completion','Sticky - Verify'])if(get(name))get(name).parameters.content='## WF2 · one PDF submission\nUpload TICKET-<id>.pdf from the bilingual template. The optional AFTER photo is inside the same PDF. Python extracts text and photo; no Drive image search or upload ordering is needed. A usable AFTER + BEFORE pair enables image comparison. Reports without a photo still receive written assessment and FM review. Ambiguous/unreadable photos are flagged. Explicit FM approval is still required to close the ticket.';
  // The changed segment stays compact; retain all other canvas/model/credential settings.
  get('Extract Report Text and Photo').position=[-2592,128];gate.position=[-2352,128];
  const names=new Set(wf.nodes.map(n=>n.name));
  for(const [source,con] of Object.entries(wf.connections)){
    if(!names.has(source))throw Error('Missing source '+source);
    for(const outs of Object.values(con))for(const targets of outs)for(const target of targets)if(!names.has(target.node))throw Error('Missing target '+target.node);
  }
  const serialized=JSON.stringify(wf);
  for(const name of removed)if(serialized.includes("$('"+name+"')")||serialized.includes('$(\\"'+name+'\\")'))throw Error('Stale node reference '+name);
  return wf;
}
module.exports={apply};
if(require.main===module)for(const filename of process.argv.slice(2)){
  const wf=JSON.parse(fs.readFileSync(filename,'utf8'));apply(wf);fs.writeFileSync(filename,JSON.stringify(wf,null,2)+'\n');
}
