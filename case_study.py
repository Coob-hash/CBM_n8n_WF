"""Case-study provenance, diagnostic requests and automatic-identification candidates."""
import json
import os
from pathlib import Path
import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
import ifc_service as service

router = APIRouter(prefix='/case-study')

def directory():
    return Path(os.environ.get('CBM_CASE_STUDY_DIR', '/app/case-study'))

def profile():
    return json.loads((directory()/'profile.json').read_text(encoding='utf-8'))

def registration():
    p = profile()
    r = json.loads((directory()/'registration.json').read_text(encoding='utf-8'))
    if r.get('approved') is not True:
        return None
    if (r.get('map_code') != p['map_code'] or r.get('ifc_source_sha256') != p['ifc_source_sha256']
        or r.get('input_frame') != 'MULTISET_RHS_Y_UP_METRES' or r.get('output_frame') != 'IFC_PROJECT_METRES'
        or not str(r.get('evidence','')).strip()):
        raise ValueError('Registration identity or evidence is missing/mismatched')
    matrix = np.asarray(r['matrix'], dtype=float)
    if (matrix.shape != (4,4) or not np.isfinite(matrix).all()
        or not np.allclose(matrix[3],[0,0,0,1])
        or not np.allclose(matrix[:3,:3].T@matrix[:3,:3],np.eye(3),atol=1e-5)
        or not np.isclose(np.linalg.det(matrix[:3,:3]),1,atol=1e-5)):
        raise ValueError('Expected a finite rigid RHS-to-IFC transform in metres')
    return matrix

@router.get('/status')
def status():
    p=profile()
    try:
        registered=registration() is not None
        error=None
    except (ValueError,KeyError,TypeError):
        registered=False; error='Invalid registration file'
    return {'case_id':p['case_id'],'map_code':p['map_code'],'query_frame':'MULTISET_RHS_Y_UP_METRES',
        'ifc_source_sha256':p['ifc_source_sha256'],'registration_verified':registered,'registration_error':error,
        'asset_selection':'AUTOMATIC_VPS_AND_VISION','primary_targets':p['primary_targets'],
        'camera_intrinsics':'EXIF_ESTIMATE_NOT_FACTORY_CALIBRATION'}

@router.get('/queries')
def queries():
    manifest=json.loads((directory()/'query-verified/queries.json').read_text(encoding='utf-8'))
    captures=[]
    for capture in manifest['captures']:
        request_path=(directory()/'query-verified'/capture['request_file']).resolve()
        if not request_path.is_relative_to((directory()/'query-verified').resolve()):
            raise HTTPException(500,'Invalid capture manifest path')
        captures.append({'file':capture['file'],'source_sha256':capture['original_sha256'],
            'calibrated':False,'request':json.loads(request_path.read_text())})
    return {'map_code':profile()['map_code'],'captures':captures}

class ResolveRequest(BaseModel):
    x:float=Field(allow_inf_nan=False)
    y:float=Field(allow_inf_nan=False)
    z:float=Field(allow_inf_nan=False)
    map_code:str
    max_distance:float=Field(default=3,gt=0,le=20,allow_inf_nan=False)

@router.post('/resolve')
def resolve(req:ResolveRequest):
    # A device position is not the photographed asset position. Suggestions are
    # spatial candidates for the vision agent, not a final asset identification.
    result={'found':False,'global_id':None,'name':None,'ifc_class':None,'distance':None,
        'reason':'REGISTRATION_REQUIRED','requires_fm_confirmation':False,'candidates':[]}
    if req.map_code != profile()['map_code']:
        return {**result,'reason':'MAP_CODE_MISMATCH'}
    try:
        matrix=registration()
    except (ValueError,KeyError,TypeError):
        return {**result,'reason':'REGISTRATION_INVALID'}
    if matrix is None:
        return result
    point=(matrix@np.array([req.x,req.y,req.z,1.0]))[:3]
    model,path=service._load_model()
    candidates=[]
    for el in service.iter_candidates(model,None):
        pos=service.element_position(el)
        if pos is not None:
            distance=float(np.linalg.norm(pos-point))
            if distance<=req.max_distance:
                candidates.append({'global_id':el.GlobalId,'name':el.Name,'ifc_class':el.is_a(),
                                   'camera_distance_m':round(distance,3)})
    return {**result,'reason':'AUTOMATIC_IDENTIFICATION_REQUIRED','model':path.name,
        'camera_position_ifc_m':point.tolist(),'candidates':sorted(candidates,key=lambda x:x['camera_distance_m'])[:5]}
