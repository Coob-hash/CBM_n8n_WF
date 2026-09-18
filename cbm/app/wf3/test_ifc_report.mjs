import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const code = fs.readFileSync(new URL('./build-ifc-inspection-report.js',import.meta.url),'utf8');
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const file = Buffer.from('ISO-10303-21; test fixture');
const response = {source:'IFC',property_set:'CBM_MaintenanceLog',version_file:'office_v2.ifc',
 version_sha256:crypto.createHash('sha256').update(file).digest('hex'),inspected_at:'2026-09-17T12:00:00Z',
 total_maintained_assets:1,total_interventions:1,has_more:false,
 assets:[{global_id:'example',name:'Radiator <script>bad()</script>',ifc_class:'IfcSpaceHeater',
 last_ticket_id:'1',last_description:'Replaced valve & tested',history_count:1,
 history:[{ticket_id:'1',description:'Valve replacement'}]}]};
const helpers={getBinaryDataBuffer:async()=>file,prepareBinaryData:async(buf,fileName,mimeType)=>({data:buf.toString('base64'),fileName,mimeType})};
const run=r=>new AsyncFunction('$input','$','require','Buffer',code).call({helpers},
 {first:()=>({binary:{ifc:{data:file.toString('base64')}}})},name=>({first:()=>({json:name==='Read IFC Intervention Details' ? {interventions:[{ticket_id:1,ifc_global_id:'example',work_performed:'Sostituzione Valvola',status:'CLOSED'}]} : r})}),require,Buffer);
const result=(await run(response))[0];
const html=Buffer.from(result.binary.maintenance_report.data,'base64').toString();
assert(html.includes('office_v2.ifc'));
assert(html.includes('Replaced valve &amp; tested'));
assert(html.includes('Sostituzione Valvola'));
assert(!html.includes('<script>bad()'));
assert(html.includes('Radiator &lt;script&gt;'));
assert.equal(result.binary.ifc.data,file.toString('base64'));
await assert.rejects(run({...response,version_sha256:'wrong'}),/does not match/);
assert(Buffer.from((await run({...response,assets:[],total_maintained_assets:0}))[0].binary.maintenance_report.data,'base64').toString().includes('No assets have'));
console.log('PASS: IFC identity/hash, HTML escaping, intervention content, IFC attachment, empty inventory and mismatch rejection.');
