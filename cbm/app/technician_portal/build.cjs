const fs=require('fs'),path=require('path'),crypto=require('crypto');
const app=path.resolve(__dirname,'..'),cbm=path.resolve(app,'..');
const bindings=JSON.parse(fs.readFileSync(path.join(app,'runtime-bindings.json')));
const pg={postgres:bindings.credentials.ticketPostgres},drive={googleDriveOAuth2Api:bindings.credentials.drive};
const code=name=>fs.readFileSync(path.join(__dirname,name),'utf8');
function node(name,type,parameters,position,typeVersion=2,extra={}){return {id:crypto.createHash('sha256').update('portal:'+name).digest('hex').slice(0,32),name,type,typeVersion,position,parameters,...extra};}
function query(name,sql,replacement,x,y){return node(name,'n8n-nodes-base.postgres',{operation:'executeQuery',query:sql,options:{queryReplacement:replacement}},[x,y],2.6,{credentials:pg});}
function condition(name,expression,x,y){return node(name,'n8n-nodes-base.if',{conditions:{options:{caseSensitive:true,typeValidation:'strict',version:1},combinator:'and',conditions:[{leftValue:expression,rightValue:true,operator:{type:'boolean',operation:'true',singleValue:true}}]},options:{}},[x,y]);}
function respond(name,x,y){return node(name,'n8n-nodes-base.respondToWebhook',{respondWith:'text',responseBody:'={{ $json.html }}',options:{responseCode:'={{ $json.httpCode }}',responseHeaders:{entries:[{name:'Cache-Control',value:'no-store'},{name:'Referrer-Policy',value:'no-referrer'},{name:'X-Content-Type-Options',value:'nosniff'}]}}},[x,y],1.4);}
function webhook(name,method,x,y){return node(name,'n8n-nodes-base.webhook',{httpMethod:method,path:'cbm-technician-report',responseMode:'responseNode',options:{}},[x,y],2.1,{webhookId:crypto.createHash('md5').update(name).digest('hex')});}
const nodes=[
 webhook('Technician Report Page','GET',0,0),
 query('Validate Report Link','SELECT cbm_technician_report_access($1::jsonb) AS context;','={{ [JSON.stringify({ticketId:$json.query?.ticketId,token:$json.query?.token})] }}',240,0),
 node('Build Technician Page','n8n-nodes-base.code',{jsCode:code('build-page.js')},[480,0]),respond('Show Technician Page',720,0),
 webhook('Submit Technician Report','POST',0,450),
 query('Validate Submission Access','SELECT cbm_technician_report_access($1::jsonb) AS context;','={{ [JSON.stringify({ticketId:$json.body?.ticketId,token:$json.body?.token})] }}',240,450),
 node('Prepare Report PDF','n8n-nodes-base.code',{jsCode:code('prepare-pdf.js')},[480,450]),condition('Report Valid?','={{ $json.valid === true }}',720,450),
 query('Claim Report Upload','SELECT cbm_claim_technician_report($1::jsonb) AS result;','={{ [JSON.stringify($json.request)] }}',960,400),condition('Upload Claimed?','={{ $json.result.status === "UPLOAD" }}',1200,400),
 node('Restore Report Binary','n8n-nodes-base.code',{jsCode:"return [{json:$json,binary:$('Prepare Report PDF').first().binary}];"},[1440,350]),
 node('Upload Report to Drive','n8n-nodes-base.googleDrive',{resource:'file',operation:'upload',inputDataFieldName:'data',name:'={{ "TICKET-"+$json.result.ticketId+".pdf" }}',driveId:{__rl:true,value:'My Drive',mode:'list',cachedResultName:'My Drive'},folderId:{__rl:true,value:bindings.completedFolderId,mode:'id'},options:{}},[1680,350],3,{credentials:drive,onError:'continueRegularOutput',alwaysOutputData:true,retryOnFail:false}),
 query('Record Report Upload','SELECT cbm_record_technician_report($1::jsonb) AS result;','={{ [JSON.stringify({submissionId:$("Claim Report Upload").first().json.result.submissionId,fileId:(!$json.error && typeof $json.id === "string")?$json.id:null})] }}',1920,350),
 node('Build Submission Result','n8n-nodes-base.code',{jsCode:code('submission-result.js')},[2160,450]),respond('Show Submission Result',2400,450),
 node('Portal guide','n8n-nodes-base.stickyNote',{content:'## Technician report portal / Rapporto tecnico\nGET validates the ticket-specific email link and opens the bilingual form. POST validates the same assignment, checks the generated PDF, claims one submission for the current approval cycle and uploads it to the existing completed-reports Drive folder. WF2 is triggered by that PDF. No email or FM/IFC action is performed here.\n\nPublish this workflow to enable /webhook/cbm-technician-report. The generic URL without a valid ticket/token is deliberately unavailable. The bearer link expires after 30 days. Claim without a Drive receipt requires operator reconciliation before retrying.',height:260,width:850},[0,-320],1)
];
const connections={};const edge=(a,b,branch=0)=>{connections[a]??={main:[]};while(connections[a].main.length<=branch)connections[a].main.push([]);connections[a].main[branch].push({node:b,type:'main',index:0});};
for(const seq of [['Technician Report Page','Validate Report Link','Build Technician Page','Show Technician Page'],['Submit Technician Report','Validate Submission Access','Prepare Report PDF','Report Valid?','Claim Report Upload','Upload Claimed?','Restore Report Binary','Upload Report to Drive','Record Report Upload','Build Submission Result','Show Submission Result']])for(let i=1;i<seq.length;i++)edge(seq[i-1],seq[i]);
edge('Report Valid?','Build Submission Result',1);edge('Upload Claimed?','Build Submission Result',1);
const workflow={id:'cbmTechnicianPortal20260917',name:'[CBM OpenRouter Vision 2026.09.16] CBM - Technician Report Portal',active:false,nodes,connections,settings:{executionOrder:'v1',timezone:'Europe/Rome'}};
fs.writeFileSync(path.join(__dirname,'workflow.json'),JSON.stringify(workflow,null,2));
let html=fs.readFileSync(path.join(cbm,'templates/technician-report/technician-report.html'),'utf8');
html=html.replace('<!-- PDF_LIBRARY -->','');
html=html.replace("const form=document.getElementById('report-form'),statusBox=document.getElementById('status');",`const form=document.getElementById('report-form'),statusBox=document.getElementById('status');
const bound=JSON.parse(document.getElementById('cbm-bound-context').textContent);
for(const [key,value] of Object.entries(bound.fields)){const el=document.getElementById(key);if(el){el.value=String(value??'');el.readOnly=true;}}
document.getElementById('work_date').value=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Rome',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());`);
html=html.replace('<script>\n\'use strict\';\nconst form=','<!-- CBM_BOUND_CONTEXT -->\n<script>\n\'use strict\';\nconst form=');
if(!html.includes('<!-- CBM_BOUND_CONTEXT -->'))throw new Error('Portal context insertion failed');
html=html.replace('Scarica rapporto PDF / Download report PDF','Invia rapporto / Submit report');
html=html.replace(/<div class="demo">[\s\S]*?<\/div>\s*<p class="privacy">[\s\S]*?<\/p>/,'<div class="demo"><strong>Invio al Facility Manager / Submit for FM review</strong><p>Il modulo crea un PDF con la foto e lo carica nella cartella Drive dei completamenti. Il ticket rimane soggetto alla valutazione e approvazione del FM.</p><p lang="en">The form creates a PDF with your photo and uploads it to the completed-reports Drive folder. WF2 assesses the evidence and requests FM approval.</p></div><p class="privacy">Il link è personale. I dati non inviati si perdono ricaricando la pagina. / Keep this link private. Reloading discards unsent changes.</p>');
const old="try{const bytes=await CBMReport.createReport(values,photoData);download(bytes,'TICKET-'+values.ticket_id+'.pdf','application/pdf');status('PDF scaricato. Il ticket è ancora da valutare dal FM / PDF downloaded. The ticket still requires FM review.');}";
const replacement=`try{
 values.photoSupplied=!!photoData;
 const bytes=await CBMReport.createReport(values,photoData);
 if(bytes.length>8*1024*1024)throw new Error('PDF oltre 8 MiB / PDF exceeds 8 MiB');
 let raw='';for(let i=0;i<bytes.length;i+=32768)raw+=String.fromCharCode(...bytes.subarray(i,i+32768));
 const submit=document.createElement('form');submit.method='POST';submit.action=bound.submitUrl;submit.style.display='none';
 for(const [name,value] of Object.entries({ticketId:String(bound.ticketId),token:bound.token,report:JSON.stringify(values),pdfB64:btoa(raw)})){const input=document.createElement('input');input.type='hidden';input.name=name;input.value=value;submit.appendChild(input);}
 document.body.appendChild(submit);status('Invio in corso / Submitting report...');submit.submit();
 }`;
if(!html.includes(old))throw new Error('Portal submit insertion failed');html=html.replace(old,replacement);
fs.writeFileSync(path.join(cbm,'templates/technician-report/technician-portal.html'),html);
console.log('Built technician portal workflow and bilingual web form.');
