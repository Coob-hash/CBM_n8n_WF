import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const normalizeCode = readFileSync(new URL('./normalize-ifc-request.js', import.meta.url), 'utf8');
const resultCode = readFileSync(new URL('./build-ifc-tool-result.js', import.meta.url), 'utf8');
const normalize = input => new Function('$input', normalizeCode)({first:()=>({json:input})})[0].json;
const result = (r, request, rows) => new Function('$', '$input', resultCode)(
  name=>({first:()=>({json:name==='Read IFC Maintenance'?r:request})}),
  {first:()=>({json:{interventions:rows}})})[0].json;
assert.equal(normalize({}).limit, 1);
assert.equal(normalize({limit:55}).limit, 20);
assert.equal(normalize({limit:55}).requested_limit, 55);
assert.throws(()=>normalize({limit:0}));
assert.throws(()=>normalize({offset:-1}));
assert.throws(()=>normalize({global_ids:'not-json'}));
assert.throws(()=>normalize({global_ids:['invalid']}));
assert.throws(()=>normalize({model_version:'../other.ifc'}));
const ids = ['0'.repeat(22), '1'.repeat(22), '2'.repeat(22)];
assert.equal(normalize({global_ids:JSON.stringify([ids[0],ids[0],ids[1]])}).global_ids, ids.slice(0,2).join(','));
const r = {source:'IFC',version_file:'office_v2.ifc',version_sha256:'a'.repeat(64),
  order:'last_maintenance_date_desc_global_id_desc',total_maintained_assets:3,total_interventions:3,
  offset:0,has_more:false,global_ids_filter:[],search:'',assets:ids.map((id,i)=>({global_id:id,
    last_ticket_id:String(i+1),last_description:'Original fault '+i,history_count:1}))};
const rows = [{ticket_id:2,ifc_global_id:ids[1],matches_current_approval:false,work_performed:'Wrong approval'},
  {ticket_id:1,ifc_global_id:ids[0],matches_current_approval:true,work_performed:'Replaced valve',status:'CLOSED'},
  {ticket_id:3,ifc_global_id:ids[2],matches_current_approval:true,report_text:'x'.repeat(1800)}];
let actual = result(r,normalize({limit:5}),rows);
assert.equal(actual.count,3);
assert.deepEqual(actual.assets.map(a=>a.global_id),ids);
assert.equal(actual.assets[0].work_performed,'Replaced valve');
assert.equal(actual.assets[1].work_performed,null);
assert.equal(actual.assets[1].intervention_source,'IFC_properties_only');
assert.equal(actual.assets[2].report_excerpt.length,1600);
assert.equal(actual.assets[2].report_text_truncated,true);
assert.equal(actual.assets[0].ifc_description,'Original fault 0');
actual = result({...r,assets:r.assets.slice(0,1),has_more:true},normalize({}),rows);
assert.equal(actual.next_offset,1);
assert.equal(actual.count,1);
actual = result({...r,assets:[],has_more:false,total_maintained_assets:0},normalize({limit:5}),[]);
assert.equal(actual.count,0);
assert.equal(actual.next_offset,null);
console.log('IFC helper: default/latest, several assets, pagination, filters, matched evidence and truncation passed');
