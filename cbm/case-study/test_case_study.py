"""Offline checks on disposable copies of the actual office IFC and case requests."""
import base64, hashlib, io, json, os
from pathlib import Path
import shutil, sys, tempfile, unittest
from unittest.mock import patch
import numpy as np
from PIL import Image
from fastapi.testclient import TestClient
import ifcopenshell

CBM=Path(__file__).resolve().parents[1]
CASE=CBM/'case-study'
sys.path[:0]=[str(CBM),str(CBM/'app')]
import ifc_service as service
from demo_api import app
from initialize_model import initialize
from knowledge.extract import extract_snapshot
from calibrate_registration import kabsch, apply, FLIP_X

class CaseStudyTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.case=self.root/'case'
        shutil.copytree(CASE,self.case,ignore=shutil.ignore_patterns('validation','__pycache__','upload-ready'))
        self.models=self.root/'models'
        self.env=patch.dict(os.environ,{'CBM_CASE_STUDY_DIR':str(self.case),'IFC_MODEL_DIR':str(self.models)})
        self.env.start()
        self.original_globals=(service.MODEL_DIR,service.POINTER_FILE,service.AUDIT_FILE)
        service.MODEL_DIR=self.models; service.POINTER_FILE=self.models/'active_model.txt'; service.AUDIT_FILE=self.models/'maintenance_audit.jsonl'
        initialize()
        self.client=TestClient(app)
        self.profile=json.loads((self.case/'profile.json').read_text(encoding='utf-8'))

    def tearDown(self):
        self.client.close()
        service.MODEL_DIR,service.POINTER_FILE,service.AUDIT_FILE=self.original_globals
        self.env.stop(); self.temp.cleanup()

    def test_original_ifc_import_and_restart_are_lossless(self):
        initial=(self.models/'office_v1.ifc').read_bytes()
        self.assertEqual(hashlib.sha256(initial).hexdigest(),self.profile['ifc_source_sha256'])
        initialize()
        self.assertEqual((self.models/'office_v1.ifc').read_bytes(),initial)
        assets=self.client.get('/elements').json()
        self.assertEqual(assets['count'],13)
        for gid in self.profile['primary_targets'].values():
            self.assertEqual(self.client.get('/elements/'+gid).json()['ifc_class'],'IfcBuildingElementProxy')

    def test_real_ifc2x3_maintenance_replay_and_knowledge_snapshot(self):
        gid=self.profile['primary_targets']['radiator']
        data={'ticket_id':987,'operation_key':'isolated:office:987','technician':'Test only',
              'approved_by':'Test FM','description':'Isolated schema compatibility check'}
        first=self.client.post('/elements/'+gid+'/maintenance',json=data)
        self.assertEqual(first.status_code,200,first.text)
        self.assertEqual(first.json()['version_file'],'office_v2.ifc')
        self.assertEqual(self.client.post('/elements/'+gid+'/maintenance',json=data).json(),first.json())
        updated=ifcopenshell.open(str(self.models/'office_v2.ifc'))
        initial=ifcopenshell.open(str(self.models/'office_v1.ifc'))
        self.assertEqual(updated.schema,'IFC2X3')
        self.assertEqual({e.GlobalId for e in updated.by_type('IfcElement')},{e.GlobalId for e in initial.by_type('IfcElement')})
        self.assertEqual(len(updated.by_type('IfcShapeRepresentation')),len(initial.by_type('IfcShapeRepresentation')))
        self.assertIn('CBM_MaintenanceLog',self.client.get('/elements/'+gid).json()['psets'])
        initialize()
        self.assertEqual((self.models/'active_model.txt').read_text(),'office_v2.ifc')
        catalog=self.root/'catalog.json'; catalog.write_text('{"approved":true,"document_dir":".","products":[],"assets":[]}')
        snapshot=extract_snapshot(catalog,self.models)
        self.assertEqual(snapshot['model_sha256'],hashlib.sha256((self.models/'office_v2.ifc').read_bytes()).hexdigest())
        self.assertEqual(snapshot['chunks'],[])
        self.assertEqual(hashlib.sha256((self.models/'office_v1.ifc').read_bytes()).hexdigest(),self.profile['ifc_source_sha256'])

    def test_unregistered_pose_and_legacy_nearest_never_assign(self):
        body={'x':0,'y':0,'z':0,'map_code':self.profile['map_code']}
        result=self.client.post('/case-study/resolve',json=body).json()
        self.assertFalse(result['found']); self.assertEqual(result['reason'],'REGISTRATION_REQUIRED')
        result=self.client.post('/case-study/resolve',json={**body,'map_code':'WRONG'}).json()
        self.assertEqual(result['reason'],'MAP_CODE_MISMATCH')
        self.assertFalse(self.client.post('/elements/nearest',json={'x':0,'y':0,'z':0}).json()['found'])

    def test_registered_camera_supplies_automatic_agent_candidates(self):
        reg=json.loads((self.case/'registration.json').read_text())
        reg.update(approved=True,matrix=np.eye(4).tolist(),evidence='Isolated identity test, not real map calibration')
        (self.case/'registration.json').write_text(json.dumps(reg))
        asset=next(x for x in self.profile['assets'] if x['global_id']==self.profile['primary_targets']['radiator'])
        x,y,z=asset['position_m']
        result=self.client.post('/case-study/resolve',json={'x':x,'y':y,'z':z,'map_code':self.profile['map_code']}).json()
        self.assertFalse(result['found']); self.assertIsNone(result['global_id'])
        self.assertEqual(result['reason'],'AUTOMATIC_IDENTIFICATION_REQUIRED')
        self.assertFalse(result['requires_fm_confirmation'])
        self.assertEqual(result['candidates'][0]['global_id'],asset['global_id'])
        reg['matrix'][0][0]=-1
        (self.case/'registration.json').write_text(json.dumps(reg))
        self.assertFalse(self.client.get('/case-study/status').json()['registration_verified'])

    def test_all_eleven_requests_bind_intrinsics_to_exact_pixels(self):
        data=self.client.get('/case-study/queries').json()
        self.assertEqual(len(data['captures']),11)
        manifest=json.loads((self.case/'query-verified/queries.json').read_text())
        for entry,capture in zip(manifest['captures'],data['captures']):
            request=capture['request']; camera=entry['camera']
            self.assertEqual(request['mapCode'],'MAP_J964JX6MGEGO')
            self.assertIs(request['isRightHanded'],True)
            self.assertEqual(set(request['cameraIntrinsics']),{'fx','fy','px','py'})
            image=Image.open(io.BytesIO(base64.b64decode(request['queryImage'].split(',',1)[1])))
            self.assertEqual(image.size,(request['resolution']['width'],request['resolution']['height']))
            self.assertEqual(max(image.size),1280); self.assertEqual(len(image.getexif()),0)
            self.assertFalse(camera['calibrated']); self.assertFalse(camera['accuracy_verified'])
            self.assertEqual(camera['source'],'EXIF_ESTIMATE')

    def test_registration_fit_rejects_collinear_points_and_handles_x_mirror(self):
        a=np.array([[0,0,0],[2,0,0],[0,3,0],[0,0,4]],dtype=float)
        b=apply(FLIP_X,a)+np.array([1,2,3])
        matrix=kabsch(apply(FLIP_X,a),b)@FLIP_X
        self.assertTrue(np.allclose(apply(matrix,a),b))
        with self.assertRaises(ValueError): kabsch(np.array([[0,0,0],[1,0,0],[2,0,0]]),np.array([[0,0,0],[1,0,0],[2,0,0]]))

if __name__=='__main__':
    unittest.main()
