'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {PGlite}=require('../phase_b/.test-runtime/pglite/dist/index.cjs');
const {vector}=require('../phase_b/.test-runtime/pgvector/dist/index.cjs');
const {dispatchPolicy}=require('../phase_b/operations');
const root=path.resolve(__dirname,'..'),results=[];
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const vec=JSON.stringify([1,...Array(1535).fill(0)]),j=JSON.stringify;
const source=(gid,content='Model TEST ONLY. Maximum pressure: 10 bar.',revision='1')=>({content,metadata:{
 chunk_id:hash(gid+content+revision),ifc_global_id:gid,product_id:'synthetic-product',source_id:'test-datasheet',
 source_title:'Synthetic test datasheet',source_revision:revision,page:'1',source_sha256:hash(content),
 source_url:'https://example.com/test',content_sha256:hash(content),embedding_model:'text-embedding-3-small'
}});
const snapshot=(chunks,revision='1')=>({fingerprint:hash(j(chunks)+revision),model_sha256:hash(revision),observed_at:new Date().toISOString(),embedding_model:'text-embedding-3-small',chunks});
let db;
const one=async(q,p=[])=> (await db.query(q,p)).rows[0];
const begin=async(p)=> (await one('SELECT cbm_begin_knowledge($1::jsonb) AS v',[j(p)])).v;
const publish=async(b,p)=> (await one('SELECT cbm_publish_knowledge($1::uuid,$2) AS v',[b.generation,p.fingerprint])).v;
const insert=async(d)=>one('INSERT INTO cbm_knowledge_documents(content,metadata,embedding) VALUES($1,$2::jsonb,$3::vector) RETURNING id',[d.content,j(d.metadata),vec]);
const search=async(gid)=> (await db.query('SELECT * FROM match_cbm_knowledge($1,4,$2::jsonb)',[vec,j({ifc_global_id:gid,embedding_model:'text-embedding-3-small'})])).rows;
const offer=async(gid,ids)=> (await one('SELECT cbm_offer_knowledge($1,$2::jsonb) AS v',[gid,j(ids)])).v;
const run=async(name,fn)=>{await fn();results.push(name);console.log('PASS '+name);};
async function main(){
 db=new PGlite({extensions:{vector}});
 await db.exec('CREATE ROLE service_role BYPASSRLS; CREATE ROLE anon; CREATE ROLE authenticated;');
 const sql=fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8');
 await db.exec(sql);await db.exec('SET search_path=public,extensions;');
 const a=source('radiator-A'),b=source('radiator-B','Model OTHER. Pressure: 6 bar.');
 let p=snapshot([a,b]),build;
 await run('Missing filter cannot search the entire corpus',async()=>{
   assert.equal((await db.query('SELECT * FROM match_cbm_knowledge($1::vector)',[vec])).rows.length,0);
 });
 await run('Partial embeddings cannot publish and are invisible to retrieval',async()=>{
   build=await begin(p);assert.equal(build.action,'BUILD');assert.equal(build.documents.length,2);
   await insert(build.documents[0]);assert.equal((await search('radiator-A')).length,0);
   await assert.rejects(publish(build,p),/Incomplete/);
   await insert(build.documents[1]);assert.equal((await publish(build,p)).status,'READY');
 });
 await run('Exact asset filtering precedes similarity; metadata survives retrieval',async()=>{
   const rows=await search('radiator-A');assert.equal(rows.length,1);assert.equal(rows[0].content,a.content);
   assert.equal(rows[0].metadata.source_revision,'1');assert.equal((await search('missing')).length,0);
 });
 await run('Supabase service role can search; anonymous users cannot read or invoke the RPC',async()=>{
   await db.exec('SET ROLE service_role');
   assert.equal((await search('radiator-A')).length,1);
   await db.exec('RESET ROLE; SET ROLE anon');
   await assert.rejects(search('radiator-A'),/permission denied/);
   await assert.rejects(db.query('SELECT * FROM cbm_knowledge_documents'),/permission denied/);
   await db.exec('RESET ROLE');
 });
 await run('Wrong asset, fabricated IDs, duplicates and oversized selections are rejected',async()=>{
   for(const ids of [[b.metadata.chunk_id],['invented'],[a.metadata.chunk_id,a.metadata.chunk_id],['1','2','3','4']])
     assert.equal((await offer('radiator-A',ids)).status,'INVALID_SELECTION');
   assert.equal((await offer('radiator-A',[a.metadata.chunk_id])).status,'VERIFIED');
   assert.equal((await offer('radiator-A',[])).status,'NONE_SELECTED');
 });
 await run('Unchanged source is idempotent and does not request embeddings',async()=>{
   assert.equal((await begin({...p,observed_at:new Date().toISOString()})).action,'UNCHANGED');
 });
 await run('Geometry-only revision reuses embeddings; deletions disappear atomically',async()=>{
   p=snapshot([a],'2');build=await begin(p);assert.equal(build.documents.length,0);
   assert.equal((await search('radiator-A')).length,0);await publish(build,p);
   assert.equal((await search('radiator-A')).length,1);assert.equal((await search('radiator-B')).length,0);
 });
 await run('Changed specifications invalidate old IDs and need new embeddings',async()=>{
   const changed=source('radiator-A','Model TEST ONLY. Maximum pressure: 8 bar.','2');
   p=snapshot([changed],'3');build=await begin(p);assert.equal(build.documents.length,1);
   assert.equal((await offer('radiator-A',[a.metadata.chunk_id])).status,'UNAVAILABLE');
   await insert(build.documents[0]);await publish(build,p);
   assert.equal((await offer('radiator-A',[a.metadata.chunk_id])).status,'INVALID_SELECTION');
 });
 await run('Expired synchronization lease fails closed without stale excerpts',async()=>{
   await db.exec("UPDATE cbm_knowledge_head SET verified_at=clock_timestamp()-interval '6 minutes'");
   assert.equal((await search('radiator-A')).length,0);assert.equal((await offer('radiator-A',[])).status,'UNAVAILABLE');
   await begin({...p,observed_at:new Date().toISOString()});assert.equal((await search('radiator-A')).length,1);
 });
 await run('Concurrent build replay is busy; superseded build cannot publish',async()=>{
   const first=snapshot([a],'4'),old=await begin(first);assert.equal((await begin(first)).action,'BUSY');
   const next=snapshot([b],'5'),current=await begin(next);
   await assert.rejects(publish(old,first),/Superseded/);await publish(current,next);
   assert.equal((await search('radiator-A')).length,0);
 });
 await run('Out-of-order and malformed extraction snapshots cannot replace current data',async()=>{
   const stale={...snapshot([a],'6'),observed_at:new Date(Date.now()-10000).toISOString()};
   assert.equal((await begin(stale)).action,'STALE');
   await assert.rejects(begin({chunks:[]}),/Invalid/);
   await assert.rejects(begin({...stale,observed_at:'2000-01-01T00:00:00Z'}),/stale/);
 });
 await run('Publication rejects changed source fingerprint and altered document text',async()=>{
   p=snapshot([source('radiator-C','Unique synthetic specification: 5 bar.')],'7');build=await begin(p);
   await assert.rejects(publish(build,{fingerprint:hash('wrong')}),/mismatched/);
   await insert({...build.documents[0],content:'altered by node'});
   await assert.rejects(publish(build,p),/Incomplete or altered/);
 });
 await run('Offer contains escaped original excerpts, citations and persisted snapshot; caps unchanged',async()=>{
   const now=new Date().toISOString(),gid='radiator-A',doc=source(gid,'TEST ONLY <script>bad()</script> 10 bar');
   const knowledge={status:'VERIFIED',ifc_global_id:gid,chunks:[doc],generation:'test',retrieved_at:now};
   const row={now,nonce:crypto.randomUUID(),token:'test',ticket:{id:1,status:'DISPATCHING',severity:3,ifc_global_id:gid},
     candidates:[{technician_id:1,email:'tech@example.com',full_name:'Test'}],knowledge,
     state:{status:'DISPATCHING',shortlist:[1],offers:[],messages:{opening:{key:'opening',status:'SENT'}},response_cursor:0,audit:[],
       original_date:'2030-01-01',config:{callbackBase:'https://example.com/webhook'}}};
   const request={operation:'offer_next',technicianId:1,knowledgeChunkIds:j([doc.metadata.chunk_id])};
   const decision=dispatchPolicy(request,row);assert.ok(decision.mail.html.includes('&lt;script&gt;'));
   assert.ok(decision.mail.html.includes('10 bar'));assert.ok(decision.mail.html.includes('revision 1'));
   assert.deepEqual(decision.state.offers[0].technical_knowledge,knowledge);
   assert.equal(dispatchPolicy(request,{...row,state:decision.state}).mail,null);
   assert.equal(dispatchPolicy({...request,knowledgeChunkIds:'["wrong"]'},row).result.operation_result.reason,'STALE_OR_WRONG_ASSET_KNOWLEDGE');
   const fallback=dispatchPolicy({...request,knowledgeChunkIds:'[]'},{...row,knowledge:{status:'UNAVAILABLE',chunks:[]}});
   assert.ok(fallback.mail.html.includes('No verified technical excerpt'));assert.ok(!fallback.mail.html.includes('10 bar'));
 });
 await run('Export uses native Supabase/OpenAI nodes, fixed asset filters and one-item ingestion',async()=>{
   const main=JSON.parse(fs.readFileSync(path.join(root,'wf1_ticket_intake_and_dispatch.json')));
   const sync=JSON.parse(fs.readFileSync(path.join(__dirname,'sync_workflow.json')));
   const tool=main.nodes.find(n=>n.name==='Radiator Technical Knowledge');assert.equal(tool.type,'@n8n/n8n-nodes-langchain.vectorStoreSupabase');
   assert.equal(tool.parameters.options.queryName,'match_cbm_knowledge');assert.ok(j(tool.parameters.options.metadata).includes('Read Knowledge Identity'));
   assert.ok(!j(tool.parameters).includes('$fromAI'));
   for(const w of [main,sync]){
     const names=new Set(w.nodes.map(n=>n.name));
     for(const [from,channels] of Object.entries(w.connections)){
       assert.ok(names.has(from));for(const outputs of Object.values(channels))for(const output of outputs)for(const edge of output)assert.ok(names.has(edge.node));
     }
     for(const n of w.nodes.filter(n=>n.type.endsWith('embeddingsOpenAi')))assert.equal(n.parameters.model,'text-embedding-3-small');
     const walk=value=>{
       if(typeof value==='string'&&value.startsWith('={{'))new Function('$','$json','$fromAI','return ('+value.slice(3,-2).trim()+');');
       else if(value&&typeof value==='object')for(const child of Object.values(value))walk(child);
     };
     const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
     for(const n of w.nodes){walk(n.parameters);if(n.type==='n8n-nodes-base.code')new AsyncFunction('$json','$input','$','$runIndex',n.parameters.jsCode);}
   }
   assert.equal(sync.nodes.find(n=>n.name==='One Document At A Time').parameters.batchSize,1);
   assert.equal(sync.nodes.filter(n=>n.type.endsWith('.code')).length,1);
 });
 await run('SQL installer can be rerun without dropping knowledge',async()=>{await db.exec(sql);assert.ok((await one('SELECT count(*) AS n FROM cbm_knowledge_generations')).n>0);});
 await db.close();
 fs.writeFileSync(path.join(__dirname,'validation-report.json'),j({passed:results.length,tests:results,sql_runtime:'PGlite 0.5.8 + pgvector 0.0.9',schema_sha256:hash(sql),live_supabase_tested:false,live_n8n_tested:false,live_openai_called:false})+'\n');
 console.log(results.length+' knowledge tests passed. Synthetic embeddings only.');
}
main().catch(async e=>{console.error(e.stack);if(db)await db.close();process.exitCode=1;});
