'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {PGlite}=require('../phase_b/.test-runtime/pglite/dist/index.cjs');
const {vector}=require('../phase_b/.test-runtime/pgvector/dist/index.cjs');
const beforeBuild=JSON.parse(fs.readFileSync(path.join(__dirname,'../wf1_ticket_intake_and_dispatch.json')));
beforeBuild.nodes=beforeBuild.nodes.filter(n=>!n.name.startsWith('Demo -'));
beforeBuild.connections=Object.fromEntries(Object.entries(beforeBuild.connections).filter(([n])=>!n.startsWith('Demo -')));
const {buildChunks,check,publish}=require('./build');
const root=path.resolve(__dirname,'..'),tests=[];
const source={fileName:'Synthetic demo.pdf',source_key:'demo/Synthetic demo.pdf',source_sha256:'a'.repeat(64),pipeline_revision:'demo-unlimited-ocr-v2'};
const receipt=()=>({import_id:crypto.randomUUID(),started_at:new Date().toISOString()});
const ocr={model:'test-ocr',pages:[{index:0,markdown:'# Radiator Type X\nConditions: 75/65/20 C\n| Length mm | Output W |\n|---|---|\n| 400 | 550 |\n\n![diagram](img-0.jpeg)',images:[{id:'img-0.jpeg',image_annotation:JSON.stringify({kind:'drawing',description:'Side connection shown',visible_text:'A = 100 mm',uncertainties:'Small symbol unreadable'})}]}],usage_info:{pages_processed:1}};
const run=async(name,fn)=>{await fn();tests.push(name);console.log('PASS '+name);};
let db;
async function main(){
 await run('Existing WF1 nodes, positions, settings and connections preserved exactly',async()=>{
   const before=beforeBuild,after=JSON.parse(fs.readFileSync(path.join(root,'wf1_ticket_intake_and_dispatch.json')));
   assert.deepEqual(after.nodes.slice(0,before.nodes.length),before.nodes);
   for(const [k,v] of Object.entries(before.connections))assert.deepEqual(after.connections[k],v);
   for(const [k,v] of Object.entries(before))if(!['nodes','connections'].includes(k))assert.deepEqual(after[k],v);
   const oldNames=new Set(before.nodes.map(n=>n.name)),newNames=new Set(after.nodes.slice(before.nodes.length).map(n=>n.name));
   assert.equal(newNames.size,22);
   for(const name of newNames)for(const outputs of Object.values(after.connections[name]||{}))for(const output of outputs)for(const edge of output)assert.ok(newNames.has(edge.node));
   assert.ok(after.nodes.filter(n=>newNames.has(n.name)).every(n=>n.position[1]<Math.min(...before.nodes.map(n=>n.position[1]))));
   assert.ok(after.nodes.filter(n=>oldNames.has(n.name)).every(n=>!n.name.startsWith('Demo -')));
 });
 await run('No database creation, schema modification or connection to production knowledge',async()=>{
   const w=JSON.parse(fs.readFileSync(path.join(root,'wf1_ticket_intake_and_dispatch.json')));
   for(const node of w.nodes.filter(n=>n.name.startsWith('Demo -'))){
     if(node.parameters.query){assert.ok(!/\b(CREATE|ALTER|DROP|TRUNCATE)\b/i.test(node.parameters.query));assert.ok(!/\bcbm_knowledge_(head|documents|sources)\b/.test(node.parameters.query));}
     if(node.parameters.tableName)assert.equal(node.parameters.tableName.value,'cbm_demo_technical_documents');
   }
 });
 await run('New Code and expression syntax compile; native OCR/embedding contract is configured',async()=>{
   const w=JSON.parse(fs.readFileSync(path.join(root,'wf1_ticket_intake_and_dispatch.json')));
   const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
   const walk=v=>{if(typeof v==='string'&&v.startsWith('={{'))new Function('$','$json','$prevNode','return ('+v.slice(3,-2).trim()+');');else if(v&&typeof v==='object')Object.values(v).forEach(walk);};
   for(const n of w.nodes.filter(n=>n.name.startsWith('Demo -'))){walk(n.parameters);if(n.type==='n8n-nodes-base.code')new AsyncFunction('$json','$input','$',n.parameters.jsCode);}
   const n=w.nodes.find(n=>n.name==='Demo - OCR Text Tables and Figures');
   assert.ok(n.parameters.url.includes('OCR_SERVICE_URL'));assert.ok(n.parameters.jsonBody.includes('ocr_request'));
   assert.equal(n.authentication,undefined);assert.equal(n.credentials,undefined);
   const settings=w.nodes.find(n=>n.name==='Demo - Source Settings').parameters.assignments.assignments;
   assert.equal(settings.find(v=>v.name==='ocrModel').value,'baidu/Unlimited-OCR');
   assert.equal(w.nodes.find(n=>n.name==='Demo - OpenAI Embeddings').parameters.model,'text-embedding-3-small');
 });
 await run('Tables retain rows, headers, units and conditions; figures include annotation provenance',async()=>{
   const d=buildChunks(ocr,source,receipt());
   const table=d.chunks.find(c=>c.metadata.content_kind==='table'),figure=d.chunks.find(c=>c.metadata.content_kind==='figure');
   assert.ok(table.content.includes('| 400 | 550 |'));assert.ok(table.content.includes('75/65/20 C'));
   assert.ok(figure.content.includes('A = 100 mm'));assert.equal(figure.metadata.figure_id,'img-0.jpeg');
   assert.equal(figure.metadata.review_status,'needs_review');assert.equal(figure.metadata.demo_only,'true');
   assert.ok(d.chunks.every(c=>c.metadata.page==='1'&&c.metadata.source_sha256===source.source_sha256));
 });
 await run('Missing/malformed figure annotations and incomplete page sequences fail closed',async()=>{
   const missing=structuredClone(ocr);missing.pages[0].images=[];assert.throws(()=>buildChunks(missing,source,receipt()),/image reference/);
   const malformed=structuredClone(ocr);malformed.pages[0].images[0].image_annotation='bad';assert.throws(()=>buildChunks(malformed,source,receipt()),/Malformed/);
   assert.throws(()=>buildChunks({...ocr,pages:[{index:1,markdown:'bad'}]},source,receipt()),/sequence/);
   assert.throws(()=>buildChunks({...ocr,usage_info:{pages_processed:2}},source,receipt()),/count mismatch/);
 });
 await run('Large tables split only between rows and repeat header context',async()=>{
   const lines=Array.from({length:300},(_,i)=>'| '+i+' | '+(i*10)+' |');
   const data=buildChunks({pages:[{index:0,markdown:'Context\n| Row | Value |\n|---|---|\n'+lines.join('\n')} ]},source,receipt());
   const tables=data.chunks.filter(c=>c.metadata.content_kind==='table');assert.ok(tables.length>1);
   for(const table of tables){assert.ok(table.content.includes('| Row | Value |'));assert.ok(table.content.length<6000);}
   for(const line of lines)assert.ok(tables.some(c=>c.content.includes(line)));
 });
 db=new PGlite({extensions:{vector}});
 // Disposable validation fixture only; no external PostgreSQL or Supabase connection.
 await db.exec('CREATE EXTENSION vector; CREATE TABLE cbm_demo_technical_documents(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,content text,metadata jsonb,embedding vector(1536));');
 const vec=JSON.stringify([1,...Array(1535).fill(0)]);
 const insert=async c=>db.query('INSERT INTO cbm_demo_technical_documents(content,metadata,embedding) VALUES($1,$2::jsonb,$3::vector)',[c.content,JSON.stringify(c.metadata),vec]);
 const finish=async d=>db.transaction(async tx=>{await tx.exec(publish.slice(0,publish.indexOf(';')+1));return (await tx.query(publish.slice(publish.indexOf(';')+1),[d.import_id,d.source_key,d.started_at,JSON.stringify(d.chunks)])).rows[0];});
 let current;
 await run('Incomplete insert stays inactive; complete import publishes all chunks',async()=>{
   current=buildChunks(ocr,source,receipt());await insert(current.chunks[0]);
   assert.equal((await finish(current)).status,'INCOMPLETE');
   for(const c of current.chunks.slice(1))await insert(c);
   assert.equal((await finish(current)).status,'IMPORTED');
   assert.equal((await db.query("SELECT count(*)::int AS n FROM cbm_demo_technical_documents WHERE metadata->>'active'='true'")).rows[0].n,current.chunks.length);
 });
 await run('Same source hash and pipeline skip processing; changed files reimport',async()=>{
   assert.equal((await db.query(check,[source.source_key,source.source_sha256,source.pipeline_revision])).rows[0].should_import,false);
   assert.equal((await db.query(check,[source.source_key,'b'.repeat(64),source.pipeline_revision])).rows[0].should_import,true);
 });
 await run('Changed document replaces publication without deleting historical chunks',async()=>{
   const next=buildChunks(ocr,{...source,source_sha256:'b'.repeat(64)},receipt());for(const c of next.chunks)await insert(c);
   assert.equal((await finish(next)).status,'IMPORTED');
   const active=(await db.query("SELECT DISTINCT metadata->>'source_sha256' AS hash FROM cbm_demo_technical_documents WHERE metadata->>'active'='true'")).rows;
   assert.deepEqual(active,[{hash:'b'.repeat(64)}]);
   assert.equal((await db.query('SELECT count(*)::int AS n FROM cbm_demo_technical_documents')).rows[0].n,current.chunks.length+next.chunks.length);
 });
 await run('Out-of-order concurrent publication cannot replace a newer completed import',async()=>{
   const old=buildChunks(ocr,source,{import_id:crypto.randomUUID(),started_at:'2020-01-01T00:00:00Z'});for(const c of old.chunks)await insert(c);
   assert.equal((await finish(old)).status,'SUPERSEDED');
 });
 await run('Altered or duplicate stored chunks cannot be published as complete',async()=>{
   const d=buildChunks(ocr,source,receipt());for(const c of d.chunks)await insert(c);await insert(d.chunks[0]);
   assert.equal((await finish(d)).status,'INCOMPLETE');
 });
 await db.close();
 fs.writeFileSync(path.join(__dirname,'validation.json'),JSON.stringify({tests,passed:tests.length,live_providers_called:false,production_database_modified:false},null,2));
 console.log(tests.length+' demo-ingestion checks passed.');
}
main().catch(async e=>{console.error(e.stack);if(db)await db.close();process.exitCode=1;});
