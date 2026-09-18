'use strict';
function responseJson(response){
 if(response?.error)throw new Error('PROVIDER_OR_SERVICE_ERROR');
 const choice=response?.choices?.[0];
 if(choice?.finish_reason!=='stop'||choice.message?.refusal)throw new Error('MODEL_OUTPUT_INCOMPLETE');
 const content=choice.message?.content;
 if(typeof content!=='string'||content.length>24000)throw new Error('MODEL_OUTPUT_INVALID');
 return JSON.parse(content);
}
function chainResponseJson(response){
 if(response?.error)throw new Error('PROVIDER_OR_SERVICE_ERROR');
 const value=response?.output??response?.text??response;
 const text=typeof value==='string'?value:JSON.stringify(value);
 if(!text||text.length>24000)throw new Error('MODEL_OUTPUT_INVALID');
 return JSON.parse(text);
}
function exact(o,keys){return o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.prototype.hasOwnProperty.call(o,k));}
function str(s,min,max){return typeof s==='string'&&s.trim().length>=min&&s.length<=max;}
function unit(n){return typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1;}
function strings(a,minItems,maxItems,maxLength){return Array.isArray(a)&&a.length>=minItems&&a.length<=maxItems&&a.every(s=>str(s,1,maxLength));}
function validateObservations(response){
 try{
  const v=responseJson(response);
  if(!exact(v,['image_quality','room_summary','target_ambiguous','primary_target_object_id','objects'])||
   !['good','limited','unusable'].includes(v.image_quality)||!str(v.room_summary,1,500)||typeof v.target_ambiguous!=='boolean'||
   !(v.primary_target_object_id===null||str(v.primary_target_object_id,2,3))||!Array.isArray(v.objects)||v.objects.length>16)throw Error('VISION_SCHEMA_INVALID');
  const ids=new Set();
  for(const o of v.objects){
   if(!exact(o,['id','object_type','label','confidence','bbox','visible_features','readable_text','maintenance_evidence'])||
    !/^o[1-9][0-9]?$/.test(o.id)||ids.has(o.id)||
    !['radiator','electrical_outlet','switch','door','window','light','chair','table','cabinet','pipe','valve','hvac_unit','other'].includes(o.object_type)||
    !str(o.label,1,100)||!unit(o.confidence)||!Array.isArray(o.bbox)||o.bbox.length!==4||!o.bbox.every(unit)||o.bbox[0]>=o.bbox[2]||o.bbox[1]>=o.bbox[3]||
    !strings(o.visible_features,1,6,180)||!strings(o.readable_text,0,4,120)||!strings(o.maintenance_evidence,0,4,240))throw Error('VISION_SCHEMA_INVALID');
   ids.add(o.id);
  }
  const target=v.objects.find(o=>o.id===v.primary_target_object_id);
  if(v.primary_target_object_id!==null&&!target)throw Error('VISION_TARGET_INVALID');
  // Recognizing objects does not establish which one the reporter means.
  // Conservatively require a closer photo for a broad scene with several targets.
  const sceneObjects=v.objects.filter(o=>!['pipe','valve'].includes(o.object_type));
  const targetArea=target?(target.bbox[2]-target.bbox[0])*(target.bbox[3]-target.bbox[1]):0;
  const framingUnclear=sceneObjects.length>=3&&targetArea<0.25;
  const clear=v.image_quality!=='unusable'&&!v.target_ambiguous&&!!target&&target.confidence>=0.85&&!framingUnclear;
  return {vision:v,visionValid:true,visionClear:clear,reason:clear?'VISION_ACCEPTED':framingUnclear?'TARGET_FRAMING_UNCLEAR':'ASSET_IDENTIFICATION_UNRESOLVED'};
 }catch(e){return {vision:null,visionValid:false,visionClear:false,reason:/^[A-Z_]+$/.test(e.message)?e.message:'VISION_SCHEMA_INVALID'};}
}
function validateTriage(response,vision,spatial,loc,meta){
 let t={},element=null,reason='TRIAGE_INVALID',triageValid=false;
 try{
  t=responseJson(response);
  if(!exact(t,['identified','global_id','visual_object_id','identification_confidence','identification_evidence','ambiguous','fault_observed','category','severity','description','required_skill'])||
   typeof t.identified!=='boolean'||typeof t.ambiguous!=='boolean'||typeof t.fault_observed!=='boolean'||!unit(t.identification_confidence)||
   !str(t.identification_evidence,1,1200)||!str(t.category,1,200)||!str(t.description,1,4000)||
   !Number.isInteger(t.severity)||t.severity<1||t.severity>5||!['carpentry','plumbing','electrical','hvac','general'].includes(t.required_skill))throw Error('TRIAGE_SCHEMA_INVALID');
  const o=vision?.objects?.find(o=>o.id===t.visual_object_id);
  const matches=(spatial?.candidates||[]).filter(c=>c.global_id===t.global_id);
  if(!t.identified||t.ambiguous||vision?.target_ambiguous||vision?.image_quality==='unusable'||
   !o||o.id!==vision.primary_target_object_id||o.confidence<0.85||matches.length!==1||t.identification_confidence<0.70||
   !str(t.identification_evidence,10,1200))throw Error('ASSET_IDENTIFICATION_UNRESOLVED');
  // The resolver cannot turn a confidently observed door into a radiator, for example.
  const requiredType={IfcDoor:'door',IfcWindow:'window',IfcLightFixture:'light',IfcOutlet:'electrical_outlet',IfcValve:'valve',IfcPipeSegment:'pipe'}[matches[0].ifc_class];
  if(requiredType&&requiredType!==o.object_type)throw Error('IFC_VISUAL_TYPE_MISMATCH');
  if(t.fault_observed&&o.maintenance_evidence.length===0)throw Error('UNSUPPORTED_FAULT_CLAIM');
  if(o.maintenance_evidence.length===0){
   t.fault_observed=false;t.severity=1;t.category='Inspection requested';
   t.description=`Photo shows ${o.label}. No fault can be established from the visible evidence; inspection is requested.`;
  }
  if(!loc?.position||![loc.position.x,loc.position.y,loc.position.z,loc.confidence].every(Number.isFinite))throw Error('VPS_POSE_UNRESOLVED');
  element={...matches[0],found:true,identification_evidence:t.identification_evidence,identification_confidence:t.identification_confidence};
  triageValid=true;reason='TRIAGE_ACCEPTED';
 }catch(e){reason=/^[A-Z_]+$/.test(e.message)?e.message:'TRIAGE_INVALID';}
 // Approved output is an explicit allowlist; model fields cannot overwrite workflow identity/metadata.
 return {...t,triageValid,reason,element,position:loc?.position,confidence:loc?.confidence,
  mapCode:Array.isArray(loc?.mapCodes)?loc.mapCodes[0]:null,reporterEmail:meta?.reporterEmail,photoUrl:meta?.photoUrl};
}
function observationCode(){return [responseJson,exact,str,unit,strings,validateObservations].map(f=>f.toString()).join('\n')+'\nreturn [{json:validateObservations($input.first().json)}];';}
function triageCode({chain=false}={}){
 const decoder=chain?chainResponseJson.toString().replace('function chainResponseJson','function responseJson'):responseJson.toString();
 return [decoder,...[exact,str,unit,validateTriage].map(f=>f.toString())].join('\n')+`\nreturn [{json:validateTriage($input.first().json,$('Validate Room Observations').first().json.vision,$('Find IFC Element').first().json,$('MultiSet - Localize Snapshot').first().json,$('Prepare Image & Metadata').first().json)}];`;
}
module.exports={responseJson,validateObservations,validateTriage,observationCode,triageCode};
