'use strict';
// One-time source upgrade from the preserved 15 September release.
const fs=require('node:fs'),path=require('node:path');
const phase=path.resolve(__dirname,'../app/phase_b');
const old=path.resolve(__dirname,'../../../15_09_2026 CBM Intake Approval Release/cbm/app/phase_b');
const original=require(path.join(old,'queries'));
let q=original.PUBLIC_CONTEXT;
q=q.replace("'ticket_id',t->'id','initialized'",`'ticket',jsonb_build_object('id',t->'id','created_at',t->'created_at','updated_at',t->'updated_at',
 'description',left(t->>'description',1600),'description_truncated',length(t->>'description')>1600,
 'category',t->'category','severity',t->'severity','required_skill',t->'required_skill',
 'asset',jsonb_build_object('ifc_global_id',t->'ifc_global_id','name',t->'ifc_name','class',t->'ifc_class','storey',t->'ifc_storey')),
 'authorization',jsonb_build_object('required',coalesce((t->>'requires_dispatch_authorization')::boolean,false),
 'approved',t->>'dispatch_authorized_at' IS NOT NULL,'approved_at',t->'dispatch_authorized_at'),
 'portfolio',public.cbm_dispatch_portfolio(greatest(0,least(coalesce(($1::jsonb->>'overviewPage')::integer,0),100000))),
 'ticket_id',t->'id','initialized'`);
q=q.replace("WHEN needs_operator OR",`WHEN t->>'status' IN ('CLOSED','REJECTED','DUPLICATE') THEN t->>'status'
 WHEN t->>'status'='PENDING_AUTHORIZATION' OR (coalesce((t->>'requires_dispatch_authorization')::boolean,false) AND t->>'dispatch_authorized_at' IS NULL) THEN 'AWAITING_FM_AUTHORIZATION'
 WHEN needs_operator OR`);
q=q.replace("WHEN s IS NULL THEN 'UNINITIALIZED'", "WHEN s IS NULL AND t->>'status'='LOCALIZED' THEN 'UNINITIALIZED' WHEN s IS NULL THEN t->>'status'");
q=q.replace("jsonb_agg(o-'token')",`jsonb_agg(jsonb_build_object('id',o->'id','technician_id',o->'technician_id','full_name',o->'full_name',
 'date',o->'date','slot',o->'slot','status',o->'status','reserved_at',o->'reserved_at','sent_at',o->'sent_at','expires_at',o->'expires_at',
 'knowledge',jsonb_build_object('status',coalesce(o#>>'{technical_knowledge,status}','UNAVAILABLE'),
 'chunk_ids',coalesce((SELECT jsonb_agg(d#>'{metadata,chunk_id}') FROM jsonb_array_elements(coalesce(o#>'{technical_knowledge,chunks}','[]')) d),'[]'::jsonb))))`);
fs.writeFileSync(path.join(__dirname,'../../database/dispatch_queue/context-query.sql'),q.trim()+'\n');
let js=fs.readFileSync(path.join(old,'queries.js'),'utf8');
js=js.replace(/const PUBLIC_CONTEXT = `[\s\S]*?`;/,"const PUBLIC_CONTEXT = 'SELECT public.cbm_dispatch_context($1::jsonb) AS context;';");
js=js.replace(/const DUE = `[\s\S]*?`;/,"const DUE = 'SELECT * FROM public.cbm_claim_dispatch_batch(5);';");
fs.writeFileSync(path.join(phase,'queries.js'),js);
let ops=fs.readFileSync(path.join(old,'operations.js'),'utf8');
ops=ops.replace("offers:offers.map(({token,...o})=>o)",`offers:offers.map(o=>({id:o.id,technician_id:o.technician_id,full_name:o.full_name,date:o.date,slot:o.slot,status:o.status,reserved_at:o.reserved_at,sent_at:o.sent_at,expires_at:o.expires_at,knowledge:{status:o.technical_knowledge?.status||'UNAVAILABLE',chunk_ids:(o.technical_knowledge?.chunks||[]).map(d=>d.metadata.chunk_id)}}))`);
ops=ops.replace("if(terminal(c.ticket))return reject(c,'TICKET_ALREADY_TERMINAL');", "if(c.ticket.requires_dispatch_authorization&&!c.ticket.dispatch_authorized_at)return reject(c,'AWAITING_FM_AUTHORIZATION');\n  if(terminal(c.ticket))return reject(c,'TICKET_ALREADY_TERMINAL');");
ops=ops.replace('`[CBM] New ticket #${c.ticket.id}:', '`[CBM] Dispatch started for approved ticket #${c.ticket.id}:').replace('<h3>New maintenance ticket #${c.ticket.id}</h3>','<h3>Dispatch started for approved ticket #${c.ticket.id}</h3>');
fs.writeFileSync(path.join(phase,'operations.js'),ops);
fs.copyFileSync(path.join(__dirname,'system-message.txt'),path.join(phase,'system-message.txt'));
require('./build-context');
console.log('Context and operation source upgraded.');
