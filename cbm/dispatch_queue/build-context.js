'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../app/phase_b');
const template=path.join(__dirname,'../../database/dispatch_queue/context-query.sql');
if(!fs.existsSync(template))throw new Error('Missing context-query.sql');
const body=fs.readFileSync(template,'utf8').replace(/\$1/g,'p_request').trim().replace(/;$/,'');
fs.writeFileSync(path.join(__dirname,'../../database/dispatch_queue/schema_context.sql'),`-- Apply after schema_queue.sql. Public facts only; the request binds one ticket.\nCREATE OR REPLACE FUNCTION public.cbm_dispatch_context(p_request jsonb) RETURNS jsonb\nLANGUAGE sql VOLATILE AS $context$\nSELECT context FROM (${body}) facts;\n$context$;\n`);
