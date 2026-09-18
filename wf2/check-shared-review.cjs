const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const dir=path.resolve(__dirname,'../../../validation-wf2-chat-approval');
const db=new DatabaseSync('C:/Users/USER/Desktop/n8n_test/database.sqlite',{readOnly:true});
const ids=['5quLJucpa0K4jWZS','cbmWf3ApprovalMail'];
const hash=r=>crypto.createHash('sha256').update(JSON.stringify([r.nodes,r.connections,r.settings])).digest('hex');
const rows=db.prepare('SELECT id,nodes,connections,settings,active,versionId,activeVersionId FROM workflow_entity').all();
const hashes=Object.fromEntries(rows.map(r=>[r.id,hash(r)]));
const baseline=path.join(dir,'all-workflow-hashes.before.json');
if(process.argv.includes('--after')){
 const old=JSON.parse(fs.readFileSync(baseline));
 for(const [id,h] of Object.entries(old))if(!ids.includes(id))assert.equal(hashes[id],h,'unrelated workflow changed '+id);
 for(const id of ids){const r=rows.find(r=>r.id===id);assert(r.active,'must be active '+id);assert.equal(r.versionId,r.activeVersionId,'latest must be published '+id);}
 console.log('Only the two intended workflow definitions changed; latest versions published.');
}else{
 if(!fs.existsSync(baseline))fs.writeFileSync(baseline,JSON.stringify(hashes,null,2));
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 for(const id of ids){
  const old=JSON.parse(fs.readFileSync(path.join(dir,id+'.before.json'))),w=JSON.parse(fs.readFileSync(path.join(dir,id+'.updated.json')));
  const live=rows.find(r=>r.id===id);assert.deepEqual(JSON.parse(live.nodes),old.nodes,'live nodes changed since snapshot');assert.deepEqual(JSON.parse(live.connections),old.connections,'live edges changed since snapshot');
  const names=new Set(w.nodes.map(n=>n.name));assert.equal(names.size,w.nodes.length);
  for(const [src,spec] of Object.entries(w.connections)){assert(names.has(src));for(const bs of Object.values(spec))for(const b of bs)for(const e of b)assert(names.has(e.node));}
  for(const n of w.nodes){if(n.parameters.jsCode)new AsyncFunction(n.parameters.jsCode);for(const m of JSON.stringify(n.parameters).matchAll(/\$\(['"]([^'"]+)['"]\)/g))assert(names.has(m[1]),n.name+' references '+m[1]);}
  for(const n of old.nodes.filter(n=>/Tool|lmChat/.test(n.type)||n.name==='Closure Supervisor')){
   const newer=w.nodes.find(x=>x.name===n.name);assert.deepEqual(newer.parameters,n.parameters);assert.deepEqual(newer.credentials,n.credentials);
  }
 }
 console.log('Graphs, JavaScript, unchanged models/tools/credentials and fresh live baselines passed.');
}
console.log(JSON.stringify({unfinishedWf2:db.prepare("SELECT id,status,mode,waitTill FROM execution_entity WHERE workflowId=? AND status IN ('running','waiting','new')").all(ids[0])}));
