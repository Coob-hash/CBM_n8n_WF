'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const {credential}=require('../runtime-bindings');
const original=JSON.parse(fs.readFileSync(path.join(root,'wf1_ticket_intake_and_dispatch.json'),'utf8'));
// Live n8n exports can omit the default embedding model. Keep the source
// export explicit so retrieval and ingestion cannot silently diverge.
for(const n of original.nodes.filter(n=>n.type.endsWith('embeddingsOpenAi')))
 if(!n.parameters.model)n.parameters.model='text-embedding-3-small';
original.nodes=original.nodes.filter(n=>!n.name.startsWith('Demo -'));
original.connections=Object.fromEntries(Object.entries(original.connections).filter(([name])=>!name.startsWith('Demo -')));
const workflow=structuredClone(original), c=workflow.connections;
const y=Math.min(...original.nodes.map(n=>n.position[1]))-1550;
const id=name=>crypto.createHash('sha256').update('cbm-demo-documents:'+name).digest('hex').slice(0,32);
const add=(name,type,parameters,x,dy=0,version=1,extra={})=>{
 const n={name,id:id(name),type,typeVersion:version,position:[x,y+dy],parameters,...extra};workflow.nodes.push(n);return n;
};
const connect=(from,to,out=0,type='main')=>{
 c[from]??={};c[from][type]??=[];while(c[from][type].length<=out)c[from][type].push([]);
 c[from][type][out].push({node:to,type,index:0});
};
const pg=(name,query,params,x,dy=0)=>add(name,'n8n-nodes-base.postgres',{
 operation:'executeQuery',query,options:{queryReplacement:params,queryBatching:'single'}
},x,dy,2.6,{credentials:{postgres:credential('knowledgePostgres')}});
const code=(name,jsCode,x,dy=0)=>add(name,'n8n-nodes-base.code',{jsCode},x,dy,2);
const condition=(name,expression,x,dy=0)=>add(name,'n8n-nodes-base.if',{conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict'},conditions:[{id:id(name+'condition'),leftValue:expression,rightValue:true,operator:{type:'boolean',operation:'true',singleValue:true}}],combinator:'and'},options:{}},x,dy,2);

add('Demo - Load Technical Sheets','n8n-nodes-base.manualTrigger',{},0);
add('Demo - Source Settings','n8n-nodes-base.set',{assignments:{assignments:[
 {id:id('folder'),name:'sourceDirectory',value:'={{ $env.CBM_TECHNICAL_SHEETS_DIR }}',type:'string'},
 {id:id('ocr'),name:'ocrModel',value:'baidu/Unlimited-OCR',type:'string'},
 {id:id('revision'),name:'pipelineRevision',value:'demo-unlimited-ocr-v2',type:'string'}
]},options:{}},220,0,3.4);
add('Demo - Read Local PDFs','n8n-nodes-base.readWriteFile',{
 operation:'read',fileSelector:'={{ $("Demo - Source Settings").first().json.sourceDirectory + "/*.pdf" }}',options:{dataPropertyName:'data'}
},440,0,1.1);
add('Demo - One PDF at a Time','n8n-nodes-base.splitInBatches',{batchSize:1,options:{}},660,0,3);
const prepare=`const item=$input.first();
const data=await this.helpers.getBinaryDataBuffer(0,'data');
if(data.length>50*1024*1024)throw new Error('PDF exceeds the configured 50 MB document limit');
if(data.subarray(0,5).toString()!=='%PDF-')throw new Error('Source is not a PDF');
const fileName=String(item.binary.data.fileName||item.json.fileName||'');
if(!fileName)throw new Error('PDF name missing');
const settings=$('Demo - Source Settings').first().json;
return [{json:{...item.json,fileName,
 source_key:settings.sourceDirectory+'/'+fileName,pipeline_revision:settings.pipelineRevision,
 ocr_request:{filename:fileName,pdf_b64:data.toString('base64')}},binary:item.binary}];`;
code('Demo - Prepare PDF Input',prepare,880,180);
add('Demo - Fingerprint PDF','n8n-nodes-base.crypto',{
 action:'hash',type:'SHA256',binaryData:true,binaryPropertyName:'data',dataPropertyName:'source_sha256',encoding:'hex'
},1100,180,2);
const check=`SELECT gen_random_uuid()::text AS import_id,clock_timestamp()::text AS started_at,
 NOT EXISTS(SELECT 1 FROM public.cbm_demo_technical_documents
 WHERE metadata->>'library'='technical_sheets_demo' AND metadata->>'source_key'=$1
 AND metadata->>'source_sha256'=$2 AND metadata->>'pipeline_revision'=$3
 AND metadata->>'embedding_model'='text-embedding-3-small'
 AND metadata->>'active'='true' AND metadata->>'complete'='true') AS should_import;`;
pg('Demo - Check Existing Import',check,'={{ [$json.source_key,$json.source_sha256,$json.pipeline_revision] }}',1320,180);
condition('Demo - Import Needed?','={{ $json.should_import === true }}',1540,180);
add('Demo - OCR Text Tables and Figures','n8n-nodes-base.httpRequest',{
 method:'POST',url:'={{ $env.OCR_SERVICE_URL.replace(/\\/+$/, "") + "/ocr" }}',
 sendBody:true,specifyBody:'json',jsonBody:'={{ JSON.stringify($("Demo - Fingerprint PDF").item.json.ocr_request) }}',
 options:{timeout:7200000,response:{response:{responseFormat:'json'}}}
},1760,180,4.2,{retryOnFail:true,maxTries:2,waitBetweenTries:10000});

function buildChunks(response,source,receipt){
 if(!Array.isArray(response.pages)||!response.pages.length)throw new Error('OCR returned no pages; no vectors will be published');
 const pages=[...response.pages].sort((a,b)=>a.index-b.index);
 if(pages.some((p,i)=>!Number.isInteger(p.index)||p.index!==i))throw new Error('OCR page sequence is incomplete');
 if(response.usage_info?.pages_processed!=null&&response.usage_info.pages_processed!==pages.length)throw new Error('OCR page count mismatch');
 const chunks=[],limit=3500;let inheritedHeading='';
 const splitWords=(text,max)=>{
   const parts=[];text=text.trim();while(text){let at=text.length<=max?text.length:text.lastIndexOf(' ',max);if(at<=0)at=max;parts.push(text.slice(0,at).trim());text=text.slice(at).trim();}return parts;
 };
 for(const page of pages){
   let markdown=String(page.markdown||'');const images=page.images||[];
   // Some OCR releases return separate table bodies referenced from page markdown.
   for(const table of page.tables||[]){
     if(typeof table.content!=='string')throw new Error('Table body missing on page '+(page.index+1));
     markdown+='\n\n'+table.content;
   }
   const imageReferences=[...markdown.matchAll(/!\[[^\]]*\]\(([^)]*)\)/g)].map(m=>m[1]);
   if(imageReferences.some(ref=>!images.some(img=>String(img.id)===ref)&&!(page.tables||[]).some(t=>String(t.id)===ref)))throw new Error('An image reference has no visual annotation record on page '+(page.index+1));
   const headings=(markdown.match(/^#{1,6}\s+.+$/gm)||[]).join(' / ');
   if(headings)inheritedHeading=headings.slice(0,500);
   const pageContext=(inheritedHeading+'\n'+markdown.split('\n').filter(l=>l.trim()&&!l.trim().startsWith('|')&&!l.trim().startsWith('![')).slice(0,8).join('\n')).slice(0,650);
   const emit=(body,kind,extra={})=>{
     const prefix='DEMO LIBRARY - not linked to an installed IFC object.\nSource: '+source.fileName+' | PDF page '+(page.index+1)+'\n'+pageContext+'\n\n';
     if(!body.trim())return;
     if(body.length>limit)throw new Error('Unexpected oversized content block');
     const chunk_id=receipt.import_id+':'+(chunks.length+1);
     chunks.push({content:prefix+body,metadata:{library:'technical_sheets_demo',demo_only:'true',active:'false',complete:'false',
       source_key:source.source_key,source_file:source.fileName,source_sha256:source.source_sha256,
       pipeline_revision:source.pipeline_revision,embedding_model:'text-embedding-3-small',
       extraction_model:String(response.model||'baidu/Unlimited-OCR'),page:String(page.index+1),content_kind:kind,
       import_id:receipt.import_id,ingestion_started:receipt.started_at,chunk_id,
       section:inheritedHeading,figure_id:extra.figure_id||'',uncertainties:extra.uncertainties||'',
       review_status:extra.uncertainties?'needs_review':'machine_extracted'}});
   };
   // Keep tables together when possible; repeat headers on oversized-table continuations.
   const blocks=[];let accumulated=[],tableMode=null;
   const flush=()=>{if(accumulated.length)blocks.push(accumulated.join('\n'));accumulated=[];tableMode=null;};
   for(const line of markdown.replace(/!\[[^\]]*\]\([^)]*\)/g,'').split('\n')){
     if(!line.trim()){flush();continue;}
     const isTable=line.trim().startsWith('|');if(tableMode!==null&&tableMode!==isTable)flush();
     tableMode=isTable;accumulated.push(line);
   }flush();
   for(const block of blocks){
     if(!block.trim())continue;
     const rows=block.trim().split('\n');
     if(rows.length>2&&rows.every(l=>l.trim().startsWith('|'))){
       const header=rows.slice(0,2).join('\n');let part=header;
       if(header.length>limit/2)throw new Error('Table header too wide; review source page');
       for(const row of rows.slice(2)){
         if(header.length+row.length+1>limit)throw new Error('Table row too wide; review source page');
         if(part.length+row.length+1>limit){emit(part,'table');part=header;}
         part+='\n'+row;
       }emit(part,'table');
     }else for(const part of splitWords(block,limit))emit(part,'text');
   }
   for(const figure of images){
     let annotation=figure.image_annotation;
     if(typeof annotation==='string'){try{annotation=JSON.parse(annotation);}catch{throw new Error('Malformed visual annotation on page '+(page.index+1));}}
     if(!annotation||['kind','description','visible_text','uncertainties'].some(k=>typeof annotation[k]!=='string'))throw new Error('Visual annotation missing on page '+(page.index+1)+'; no silent text-only import');
     const text='Figure '+String(figure.id||'')+' ('+annotation.kind+')\nVision interpretation: '+annotation.description+'\nVisible labels and units: '+annotation.visible_text+'\nUncertainty: '+(annotation.uncertainties||'none reported; machine extraction requires review');
     for(const part of splitWords(text,limit))emit(part,'figure',{figure_id:String(figure.id||''),uncertainties:annotation.uncertainties});
   }
   if(!markdown.trim()&&!images.length)emit('No text or figures extracted on this page. Inspect the source PDF before treating this page as blank.','empty_page',{uncertainties:'No extracted page content'});
 }
 if(!chunks.length)throw new Error('No indexable chunks');
 return {import_id:receipt.import_id,source_key:source.source_key,source_sha256:source.source_sha256,
   started_at:receipt.started_at,pages:pages.length,expected_chunks:chunks.length,chunks};
}
code('Demo - Build Citable Multimodal Chunks',buildChunks.toString()+`\nreturn [{json:buildChunks($json,$('Demo - Fingerprint PDF').item.json,$('Demo - Check Existing Import').item.json)}];`,1980,180);
code('Demo - Chunks To Items','return $json.chunks.map(json=>({json}));',2200,180);
// Nested loop resets for each new PDF but retains state while returning from insertion.
add('Demo - One Chunk at a Time','n8n-nodes-base.splitInBatches',{batchSize:1,options:{reset:'={{ $prevNode.name === "Demo - Chunks To Items" }}'}},2420,180,3);
add('Demo - Supabase Insert Vectors','@n8n/n8n-nodes-langchain.vectorStoreSupabase',{
 mode:'insert',tableName:{__rl:true,value:'cbm_demo_technical_documents',mode:'id'},options:{}
},2640,360,1.3,{credentials:{supabaseApi:credential('supabase')}});
add('Demo - OpenAI Embeddings','@n8n/n8n-nodes-langchain.embeddingsOpenAi',{model:'text-embedding-3-small',options:{}},2520,640,1.2,{credentials:{openAiApi:credential('openai')}});
const keys=['library','demo_only','active','complete','source_key','source_file','source_sha256','pipeline_revision','embedding_model','extraction_model','page','content_kind','import_id','ingestion_started','chunk_id','section','figure_id','uncertainties','review_status'];
add('Demo - Technical Document Loader','@n8n/n8n-nodes-langchain.documentDefaultDataLoader',{
 dataType:'json',jsonMode:'expressionData',jsonData:'={{ $json.content }}',textSplittingMode:'custom',
 options:{metadata:{metadataValues:keys.map(name=>({name,value:`={{ $json.metadata.${name} }}`}))}}
},2820,640,1.1);
add('Demo - Preserve Prepared Chunks','@n8n/n8n-nodes-langchain.textSplitterRecursiveCharacterTextSplitter',{chunkSize:6000,chunkOverlap:0,options:{}},3020,860,1);
// Only DML against an existing vector table. No schema/table/function creation.
const publish=`LOCK TABLE public.cbm_demo_technical_documents IN SHARE ROW EXCLUSIVE MODE;
WITH valid AS MATERIALIZED (
 SELECT NOT EXISTS(SELECT 1 FROM public.cbm_demo_technical_documents d
 WHERE d.metadata->>'library'='technical_sheets_demo' AND d.metadata->>'source_key'=$2
 AND d.metadata->>'active'='true' AND d.metadata->>'complete'='true'
 AND (d.metadata->>'ingestion_started')::timestamptz>$3::timestamptz) AS newest,
 (SELECT count(*) FROM public.cbm_demo_technical_documents WHERE metadata->>'import_id'=$1)=jsonb_array_length($4::jsonb)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements($4::jsonb) x WHERE NOT EXISTS(
 SELECT 1 FROM public.cbm_demo_technical_documents d WHERE d.metadata->>'import_id'=$1
 AND d.metadata->>'chunk_id'=x#>>'{metadata,chunk_id}' AND d.content=x->>'content'
 AND d.metadata @> (x->'metadata'))) AS intact
), retired AS (
 UPDATE public.cbm_demo_technical_documents SET metadata=metadata||'{"active":"false"}'::jsonb
 WHERE metadata->>'library'='technical_sheets_demo' AND metadata->>'source_key'=$2
 AND metadata->>'import_id'<>$1 AND (SELECT newest AND intact FROM valid) RETURNING id
), activated AS (
 UPDATE public.cbm_demo_technical_documents SET metadata=metadata||'{"active":"true","complete":"true"}'::jsonb
 WHERE metadata->>'import_id'=$1 AND (SELECT newest AND intact FROM valid) RETURNING id
)
SELECT CASE WHEN NOT intact THEN 'INCOMPLETE' WHEN NOT newest THEN 'SUPERSEDED' ELSE 'IMPORTED' END AS status,
 (SELECT count(*) FROM activated) AS chunks FROM valid;`;
code('Demo - Collect Document Result',`const doc=$('Demo - Build Citable Multimodal Chunks').itemMatching(0).json;\nreturn [{json:doc,pairedItem:{item:0}}];`,2640,-80);
const publisher=pg('Demo - Publish Complete Document',publish,
 '={{ [$json.import_id,$json.source_key,$json.started_at,JSON.stringify($json.chunks)] }}',2860,-80);
publisher.parameters.options.queryBatching='transaction';
code('Demo - Verify Publication',`const result=$input.all().map(i=>i.json).find(i=>['IMPORTED','SUPERSEDED','INCOMPLETE'].includes(i.status));\nif(!result||result.status==='INCOMPLETE')throw new Error('Vector insertion incomplete or content altered: the document was not published');\nreturn [{json:result}];`,3080,-80);
code('Demo - Import Summary',`const result=$input.all().map(i=>i.json);\nreturn [{json:{library:'technical_sheets_demo',result,linked_to_dispatch_agent:false,message:'Demo document loading finished. Supabase rows retain file hashes, PDF page numbers, text/table/figure kind and machine-extraction warnings.'}}];`,1100,-180);

connect('Demo - Load Technical Sheets','Demo - Source Settings');connect('Demo - Source Settings','Demo - Read Local PDFs');
connect('Demo - Read Local PDFs','Demo - One PDF at a Time');
connect('Demo - One PDF at a Time','Demo - Import Summary',0);connect('Demo - One PDF at a Time','Demo - Prepare PDF Input',1);
connect('Demo - Prepare PDF Input','Demo - Fingerprint PDF');connect('Demo - Fingerprint PDF','Demo - Check Existing Import');connect('Demo - Check Existing Import','Demo - Import Needed?');
connect('Demo - Import Needed?','Demo - OCR Text Tables and Figures');connect('Demo - Import Needed?','Demo - One PDF at a Time',1);
connect('Demo - OCR Text Tables and Figures','Demo - Build Citable Multimodal Chunks');connect('Demo - Build Citable Multimodal Chunks','Demo - Chunks To Items');
connect('Demo - Chunks To Items','Demo - One Chunk at a Time');connect('Demo - One Chunk at a Time','Demo - Collect Document Result',0);
connect('Demo - Collect Document Result','Demo - Publish Complete Document');
connect('Demo - One Chunk at a Time','Demo - Supabase Insert Vectors',1);connect('Demo - Supabase Insert Vectors','Demo - One Chunk at a Time');
connect('Demo - OpenAI Embeddings','Demo - Supabase Insert Vectors',0,'ai_embedding');
connect('Demo - Technical Document Loader','Demo - Supabase Insert Vectors',0,'ai_document');
connect('Demo - Preserve Prepared Chunks','Demo - Technical Document Loader',0,'ai_textSplitter');
connect('Demo - Publish Complete Document','Demo - Verify Publication');connect('Demo - Verify Publication','Demo - One PDF at a Time');
add('Demo - Ingestion Setup','n8n-nodes-base.stickyNote',{content:
`## Independent demo document loader\nRun **Demo - Load Technical Sheets** manually. Reads technical_sheets PDFs; the locally hosted Baidu Unlimited OCR model preserves grounded text, tables and detected figure regions. OpenAI text-embedding-3-small embeds the combined, citable text.\n\n**Separate library only:** cbm_demo_technical_documents. No connection to the dispatch agent or production knowledge. No IFC mapping is invented.\n\n**Configure manually:** existing Supabase table with id UUID default gen_random_uuid(), content TEXT, metadata JSONB, embedding VECTOR(1536); Supabase API credential; PostgreSQL credential pointing to the same Supabase DB; OpenAI credential. OCR requires the Docker services unlimited-ocr and unlimited-ocr-adapter; it does not use an API key. This branch contains no CREATE/ALTER/DROP statements and does not create the database.\n\nRead Local PDFs requires a self-hosted n8n runtime with access to the folder. If n8n runs in Docker/on another machine, mount/copy the folder and change Source Settings. No credentials are embedded.\n\nOnly rows with metadata.active='true' AND metadata.complete='true' form the published demo library. Incomplete/failed imports remain inactive. Unchanged SHA-256 + pipeline revision skips OCR/embedding. Removed local files are not automatically deleted from Supabase. Machine extraction may contain errors; detected figures are marked for review because this OCR model grounds their location but does not replace a full vision description. The original PDFs remain the visual source.\n\nTracked source: demo_ingestion/build.js. The Phase B builder regenerates this branch as its final step. Apply knowledge/demo_schema.sql first and set CBM_TECHNICAL_SHEETS_DIR to the mounted directory.`,
width:1420,height:740,color:6},0,-1020);
add('Demo - Multimodal Extraction Notes','n8n-nodes-base.stickyNote',{content:
`## Why grounded OCR\nThe supplied examples span 336 PDF pages and contain dense rating tables and diagrams. The local adapter renders each PDF page and calls Baidu Unlimited OCR through its vLLM OpenAI-compatible API using the model's required prompt and no-repeat decoding parameters. Grounding tags are removed from readable text while detected figure regions become explicit review-required figure chunks.\n\nEach chunk carries source filename/SHA-256, PDF page, section, content kind and figure ID. Table headers are repeated on long-table continuations. Missing page results or incomplete page sequences fail the import rather than silently publishing partial content. Native Supabase insertion runs one prepared chunk at a time so n8n sub-node metadata cannot drift to another PDF.\n\nModel: https://github.com/baidu/Unlimited-OCR\nServing recipe: https://recipes.vllm.ai/baidu/Unlimited-OCR\nEmbeddings: https://developers.openai.com/api/docs/guides/embeddings`,width:1380,height:570,color:5},1500,-1020);
fs.writeFileSync(path.join(root,'wf1_ticket_intake_and_dispatch.json'),JSON.stringify(workflow,null,2)+'\n');
console.log('Added '+(workflow.nodes.length-original.nodes.length)+' independent demo nodes. Original nodes and connections preserved.');
module.exports={buildChunks,check,publish,prepare};
