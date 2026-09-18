'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {patch}=require('./patch-workflows');
const root=path.resolve(__dirname,'../..'),validation=path.join(root,'validation');
const dir=path.join(validation,'before-workflows');
const workflows=fs.readdirSync(dir).filter(f=>f.endsWith('.json')).flatMap(f=>JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')));
const manifest=JSON.parse(fs.readFileSync('C:/Users/USER/Desktop/n8n_deploy/cbm/workflows-configured/workflow-ids.json','utf8'));
const byName=new Map(workflows.map(w=>[w.name.replace(/^\[.*?\] /,''),w]));
const mapping={},replacements={};
for(const [file,oldId] of Object.entries(manifest)){
 const source=JSON.parse(fs.readFileSync(path.join(root,'cbm/app',file),'utf8'));
 const w=byName.get(source.name);if(!w)throw new Error('Missing saved workflow: '+source.name);
 assert.equal(w.active,false,'Refusing to overwrite a now-active workflow');
 mapping[file]=w.id;replacements[oldId]=w.id;replacements[source.id]=w.id;
}
const before=new Map(workflows.map(w=>[w.id,JSON.parse(JSON.stringify(w))]));
const updated=workflows.map(w=>{
 w=patch(w);
 let text=JSON.stringify(w);for(const [oldId,newId] of Object.entries(replacements))text=text.split(oldId).join(newId);w=JSON.parse(text);
 // Import as a new draft of the same workflow; keep the editor layout and bound credentials.
 delete w.versionId;delete w.activeVersionId;delete w.versionMetadata;delete w.shared;
 w.active=false;return w;
});
const wf1=updated.find(w=>w.nodes.some(n=>n.name==='Dispatch Agent'));
const postgres=wf1.nodes.find(n=>n.name==='Read Dispatch Memory').credentials;
const gmail=workflows.flatMap(w=>w.nodes).find(n=>n.credentials?.gmailOAuth2)?.credentials;
const separateKnowledge=new Set(['Verify Selected Technical Sources','Demo - Check Existing Import','Demo - Publish Complete Document']);
const addedCredentials=[];
for(const w of updated.filter(w=>w===wf1||w.name.includes('] Dispatch - ')))for(const n of w.nodes){
 if(Object.keys(n.credentials||{}).length)continue;
 if(/postgres(Tool)?$/.test(n.type)&&!separateKnowledge.has(n.name))n.credentials=JSON.parse(JSON.stringify(postgres));
 else if(n.type==='n8n-nodes-base.gmail'&&gmail)n.credentials=JSON.parse(JSON.stringify(gmail));
 else if(n.type==='@n8n/n8n-nodes-langchain.vectorStoreSupabase')n.credentials={supabaseApi:{id:'vwpdbfFtXMR4D7Nh',name:'Supabase account 3'}};
 else if(n.type==='@n8n/n8n-nodes-langchain.embeddingsOpenAi')n.credentials={openAiApi:{id:'f0y7IjBcxpOEn1zU',name:'OpenAI account'}};
 if(n.credentials)addedCredentials.push({workflow:w.name,node:n.name});
}
const allIds=new Set(updated.map(w=>w.id)),refReport=[];
for(const w of updated){
 assert.equal(new Set(w.nodes.map(n=>n.name)).size,w.nodes.length,'Duplicate node names: '+w.name);
 const names=new Set(w.nodes.map(n=>n.name));
 for(const [from,out] of Object.entries(w.connections)){
  assert.ok(names.has(from),'Missing source node: '+from);
  for(const channels of Object.values(out))for(const a of channels)for(const e of a)assert.ok(names.has(e.node),'Missing target: '+e.node);
 }
 for(const n of w.nodes){
  const old=before.get(w.id).nodes.find(x=>x.id===n.id);if(old&&Object.keys(old.credentials||{}).length)assert.deepEqual(n.credentials,old.credentials,'Credential changed: '+n.name);
  if(n.parameters.jsCode)new (Object.getPrototypeOf(async function(){}).constructor)(n.parameters.jsCode);
  const ref=n.parameters.workflowId?.value;if(ref&&!ref.startsWith('=')){assert.ok(allIds.has(ref),'Missing workflow: '+ref);refReport.push({workflow:w.name,node:n.name,target:ref});}
 }
 if(w.settings.errorWorkflow)assert.ok(allIds.has(w.settings.errorWorkflow),'Missing error workflow');
}
fs.writeFileSync(path.join(validation,'installed-workflows.json'),JSON.stringify(updated,null,2)+'\n');
fs.writeFileSync(path.join(root,'cbm/imported-workflow-ids.json'),JSON.stringify(mapping,null,2)+'\n');
fs.writeFileSync(path.join(validation,'helper-references.json'),JSON.stringify(refReport,null,2)+'\n');
fs.writeFileSync(path.join(validation,'added-credential-bindings.json'),JSON.stringify(addedCredentials,null,2)+'\n');
console.log(JSON.stringify({workflows:updated.length,verifiedHelperReferences:refReport.length,wf1NodesBefore:before.get(mapping['wf1_ticket_intake_and_dispatch.json']).nodes.length,wf1NodesAfter:updated.find(w=>w.id===mapping['wf1_ticket_intake_and_dispatch.json']).nodes.length,allInactive:true,credentialsPreserved:true}));
