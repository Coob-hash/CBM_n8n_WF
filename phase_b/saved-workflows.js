'use strict';
const sql=require('./queries');
const {operationSource}=require('./operations');

function buildSavedWorkflows({config,node,code,pg,condition,connect,id,knowledge}) {
  const {knowledge:knowledgeConfig,...dispatchConfig}=config;
  const definitions={
    initialize:['Dispatch - Initialize Ticket','Prepare Initial Dispatch',[]],
    offer_next:['Dispatch - Send Technician Offer','Reserve Technician Offer',[{name:'technicianId',type:'number'},{name:'knowledgeChunkIds',type:'string'}]],
    send_notices:['Dispatch - Send Notice','Claim Selected Notice',[{name:'noticeKey',type:'string'}]],
    process_events:['Dispatch - Process Responses','Apply Responses and Expiry',[]],
    escalate:['Dispatch - Escalate Ticket','Prepare Escalation',[]],
    ack:['Dispatch - Record Email Receipt','Apply Gmail Receipt',[{name:'receipt',type:'object'}]],
    failure:['Dispatch - Record Incomplete Execution','Record Failure',[]]
  };
  const workflowIds=Object.fromEntries(Object.keys(definitions).map(op=>[op,config.workflowIds?.[op]||id('saved-workflow:'+op)]));
  if(new Set(Object.values(workflowIds)).size!==Object.keys(definitions).length)throw new Error('Saved workflow IDs must be unique.');
  for(const value of Object.values(workflowIds))if(!/^[A-Za-z0-9_-]{1,128}$/.test(value))throw new Error('Invalid saved workflow ID.');
  const fields=op=>[{name:'ticketId',type:'string'},{name:'sourceKey',type:'string'},...definitions[op][2]];
  const mapping=(op,values)=>({mappingMode:'defineBelow',value:values,matchingColumns:[],schema:fields(op).map(f=>({id:f.name,displayName:f.name,type:f.type,required:true,defaultMatch:false,display:true,canBeUsedToMatch:true})),attemptToConvertTypes:false,convertFieldsToString:false});
  const reference=op=>({__rl:true,value:workflowIds[op],mode:'id',cachedResultName:definitions[op][0]});
  const bound={ticketId:'={{ String($("Phase B Context").first().json.ticketId || "") }}',sourceKey:'={{ $("Phase B Context").first().json.sourceKey || "" }}'};
  function execute(name,op,x,y,values=bound) {
    return node(name,'n8n-nodes-base.executeWorkflow',{source:'database',workflowId:reference(op),workflowInputs:mapping(op,values),mode:'once',options:{waitForSubWorkflow:true}},x,y,1.2);
  }
  const workflows=[];
  for(const [op,[name,prepareName]] of Object.entries(definitions)) {
    const trigger='When Executed by Another Workflow';
    const request=`$('${trigger}').first().json`;
    const prepared=`$('${prepareName}').item.json`;
    const nodes=[node(trigger,'n8n-nodes-base.executeWorkflowTrigger',{inputSource:'workflowInputs',workflowInputs:{values:fields(op)}},0,0,1.1)];
    const connections={};let entry=trigger;
    if(op==='failure') {
      nodes.push(pg('Record Uninitialized Failure',sql.INIT_FAILURE,`={{ [JSON.stringify(${request})] }}`,220,0));
      connect(connections,entry,'Record Uninitialized Failure');entry='Record Uninitialized Failure';
    }
    nodes.push(pg('Load Ticket State',sql.LOAD,`={{ [JSON.stringify(${request})] }}`,440,0));
    if(op==='offer_next')nodes.push(knowledge.knowledgePg('Verify Selected Technical Sources',require('../knowledge/nodes').OFFER,
      `={{ [$("Load Ticket State").item.json.context.ticket?.ifc_global_id || "",${request}.knowledgeChunkIds || "[]"] }}`,550,-180,{onError:'continueRegularOutput'}));
    const rowSource=op==='offer_next'?`{...$('Load Ticket State').item.json.context,knowledge:$json.knowledge || {status:'UNAVAILABLE',chunks:[]}}`:'$json.context';
    const prepare=operationSource(op)+`\nconst input=${request};\nif(!input.ticketId&&!input.sourceKey)throw new Error('A bound ticket or source identifier is required');\nconst request={...input,operation:${JSON.stringify(op)},config:${JSON.stringify(dispatchConfig)}};\nconst row=${rowSource};\nconst d=runOperation(request,row);\nreturn [{json:{...d,ticketId:row.ticket?.id,revision:row.revision,assigning:row.ticket?.status!=='ASSIGNED'&&d.state?.status==='ASSIGNED'}}];`;
    nodes.push(code(prepareName,prepare,660,0));
    nodes.push(condition('State Changed?','={{ $json.write === true }}',880,0));
    nodes.push(pg('Commit Change',sql.COMMIT,'={{ [$json.ticketId,$json.revision,JSON.stringify($json.state),$json.assigning] }}',1100,0));
    nodes.push(condition('Commit Succeeded?','={{ $json.applied === true }}',1320,0));
    nodes.push(code('Retry Conflict',`if($runIndex>=4)throw new Error('Concurrent update retry limit reached. No uncommitted email was sent.');\nreturn [{json:${request}}];`,1320,220));
    connect(connections,entry,'Load Ticket State');
    if(op==='offer_next'){connect(connections,'Load Ticket State','Verify Selected Technical Sources');connect(connections,'Verify Selected Technical Sources',prepareName);}
    else connect(connections,'Load Ticket State',prepareName);
    connect(connections,prepareName,'State Changed?');
    connect(connections,'State Changed?','Commit Change');connect(connections,'Commit Change','Commit Succeeded?');
    connect(connections,'Commit Succeeded?','Retry Conflict',1);connect(connections,'Retry Conflict','Load Ticket State');
    const sends=['offer_next','send_notices'].includes(op);
    const after=sends?'Email Claimed?':'Return Current Context';
    connect(connections,'State Changed?',after,1);connect(connections,'Commit Succeeded?',after);
    if(sends) {
      nodes.push(condition('Email Claimed?',`={{ !!${prepared}.mail }}`,1540,0));
      nodes.push(node('Gmail - Send Claimed Email','n8n-nodes-base.gmail',{resource:'message',operation:'send',sendTo:`={{ ${prepared}.mail.to }}`,subject:`={{ ${prepared}.mail.subject }}`,emailType:'html',message:`={{ ${prepared}.mail.html }}`,options:{appendAttribution:false}},1760,0,2.1,{credentials:{gmailOAuth2:{id:config.gmailCredentialId,name:config.gmailCredentialName}},onError:'continueRegularOutput',retryOnFail:false}));
      nodes.push(execute('Record Gmail Receipt','ack',1980,0,{
        ticketId:`={{ String(${prepared}.ticketId) }}`,sourceKey:`={{ ${request}.sourceKey || "" }}`,
        receipt:`={{ {key:${prepared}.mail.key,claim:${prepared}.mail.claim,message_id:typeof $json.id === 'string' ? $json.id : null} }}`
      }));
      connect(connections,'Email Claimed?','Gmail - Send Claimed Email');connect(connections,'Email Claimed?','Return Current Context',1);
      connect(connections,'Gmail - Send Claimed Email','Record Gmail Receipt');connect(connections,'Record Gmail Receipt','Return Current Context');
    }
    nodes.push(pg('Return Current Context',sql.PUBLIC_RESULT,`={{ [JSON.stringify(${request}),JSON.stringify(${prepared}.feedback || null)] }}`,2200,0));
    workflows.push({id:workflowIds[op],name,active:false,nodes,connections,settings:{executionOrder:'v1',timezone:'Europe/Rome',callerPolicy:'workflowsFromSameOwner'}});
  }
  const descriptions={
    initialize:['initialize_dispatch','Initialize the shortlist, appointment policy and pending opening notice for an existing uninitialized ticket. Does not create the ticket or send mail.'],
    offer_next:['send_offer','Reserve and send one offer to the technician ID you supply. Inspect context and choose the next unoffered eligible ID in the fixed shortlist order. The operation checks ranking, capacity, opening receipt, pending responses and deadlines atomically.'],
    send_notices:['send_notice','Deliver one pending notice identified by noticeKey from the current context. Use opening for the FM opening message; other keys identify assignment, withdrawal or escalation notices. The workflow records claims and Gmail receipts.'],
    process_events:['process_events','Apply validated technician responses in persisted order and expire overdue offers. Commits one winner and queues confirmations and withdrawals. Does not send those notices.'],
    escalate:['escalate','Escalate unresolved dispatch when no valid live offer remains and the shortlist is exhausted or the urgent appointment has started. Queues an FM notice. Database and policy checks reject premature escalation.']
  };
  const tools=Object.entries(descriptions).map(([op,[name,description]],index)=>{
    const values={...bound};
    if(op==='offer_next'){
      values.technicianId='={{ $fromAI("technician_id", "The next unoffered eligible technician ID in the fixed shortlist returned by get_context", "number") }}';
      values.knowledgeChunkIds='={{ $fromAI("knowledge_chunk_ids", "JSON array of up to three exact metadata.chunk_id strings selected from Radiator Technical Knowledge results for this ticket. Use [] when search is unavailable or no excerpt is relevant. Never invent IDs or send free-text specifications.", "string", "[]") }}';
    }
    if(op==='send_notices')values.noticeKey='={{ $fromAI("notice_key", "Exact key of the pending notice selected from get_context, for example opening or assigned:fm", "string") }}';
    return node(name,'@n8n/n8n-nodes-langchain.toolWorkflow',{name,description,source:'database',workflowId:reference(op),workflowInputs:mapping(op,values)},2520+index*220,280,2.1);
  });
  return {workflows,workflowIds,tools,execute,definitions};
}
module.exports={buildSavedWorkflows};
