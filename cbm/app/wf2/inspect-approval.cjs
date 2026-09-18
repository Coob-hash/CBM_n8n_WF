const fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('C:/Users/USER/Desktop/n8n_test/database.sqlite',{readOnly:true});
const dir=path.resolve(__dirname,'../../../validation-wf2-chat-approval');fs.mkdirSync(dir,{recursive:true});
for(const id of ['5quLJucpa0K4jWZS','cbmWf3ApprovalMail']){
 const r=db.prepare('SELECT id,name,active,nodes,connections,settings,staticData,pinData FROM workflow_entity WHERE id=?').get(id);
 const w={...r,active:!!r.active};for(const k of ['nodes','connections','settings','staticData','pinData'])w[k]=r[k]?JSON.parse(r[k]):{};
 const file=path.join(dir,id+'.before.json');if(!fs.existsSync(file))fs.writeFileSync(file,JSON.stringify(w,null,2));
 if(id==='5quLJucpa0K4jWZS'){
  console.log(JSON.stringify({id,active:w.active,nodes:w.nodes.map(n=>({name:n.name,type:n.type,disabled:n.disabled})),connections:w.connections}));
  console.log(JSON.stringify(w.nodes.filter(n=>/FM Approval|FM Decision|Approval Expired|Closure Context|Set Pending Approval|Approved\?|Verify Closure Outcome/.test(n.name))));
  console.log(JSON.stringify({recent:db.prepare('SELECT id,status,mode,startedAt,stoppedAt,waitTill FROM execution_entity WHERE workflowId=? ORDER BY id DESC LIMIT 6').all(id)}));
 }
}
