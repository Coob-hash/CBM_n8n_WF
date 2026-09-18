"""Real IfcOpenShell / FastAPI smoke tests; no external providers."""
import base64
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from fastapi.testclient import TestClient
from PIL import Image
import ifcopenshell
import ifcopenshell.util.element
import ifc_service as service
from knowledge.service import app as knowledge_app
from knowledge.extract import extract_snapshot

def process_write(directory,gid,key):
    import ifc_service as svc
    svc.MODEL_DIR=Path(directory);svc.POINTER_FILE=svc.MODEL_DIR/'active_model.txt';svc.AUDIT_FILE=svc.MODEL_DIR/'maintenance_audit.jsonl'
    return svc.log_maintenance(gid,svc.MaintenanceRequest(ticket_id=key,operation_key=key,description='Synthetic concurrent test'))

class ServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory(prefix='cbm-review-services-')
        cls.folder=Path(cls.temp.name)
        subprocess.run([sys.executable,str(ROOT/'create_sample_ifc.py')],cwd=cls.folder,check=True,capture_output=True)
        cls.pristine=(cls.folder/'models/room_v1.ifc').read_bytes()

    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()

    def setUp(self):
        self.work=tempfile.TemporaryDirectory(prefix='case-',dir=self.folder)
        self.model_dir=Path(self.work.name)/'models';self.model_dir.mkdir()
        (self.model_dir/'room_v1.ifc').write_bytes(self.pristine)
        (self.model_dir/'active_model.txt').write_text('room_v1.ifc')
        self.patches=[patch.object(service,'MODEL_DIR',self.model_dir),patch.object(service,'POINTER_FILE',self.model_dir/'active_model.txt'),patch.object(service,'AUDIT_FILE',self.model_dir/'maintenance_audit.jsonl')]
        for p in self.patches:p.start()
        self.client=TestClient(service.app)
        self.gid=self.client.get('/elements',params={'ifc_class':'IfcSpaceHeater'}).json()['elements'][0]['global_id']

    def tearDown(self):
        self.client.close()
        for p in reversed(self.patches):p.stop()
        self.work.cleanup()

    def write(self,key='wf2:1:approved',**overrides):
        return self.client.post(f'/elements/{self.gid}/maintenance',json={'ticket_id':1,'operation_key':key,'description':'Synthetic repair',**overrides})

    def test_health_and_radiator_localization(self):
        health=self.client.get('/health');self.assertEqual(health.status_code,200)
        self.assertEqual(health.json()['maintainable_elements'],4)
        nearest=self.client.post('/elements/nearest',json={'x':6,'y':1,'z':.6,'max_distance':.1})
        self.assertEqual(nearest.json()['ifc_class'],'IfcSpaceHeater')
        self.assertEqual(nearest.json()['global_id'],self.gid)

    def test_real_exif_ultrawide_normalization(self):
        image=Image.new('RGB',(1600,1200),'white');exif=Image.Exif();exif[41989]=13;exif[274]=6
        data=io.BytesIO();image.save(data,format='JPEG',exif=exif)
        result=self.client.post('/captures/normalize',json={'imageB64':base64.b64encode(data.getvalue()).decode()})
        self.assertEqual(result.status_code,200,result.text)
        camera=result.json()['camera'];self.assertTrue(camera['trusted'],result.text)
        self.assertEqual(max(camera['width'],camera['height']),1280)

    def test_missing_exif_is_rejected_for_manual_triage(self):
        data=io.BytesIO();Image.new('RGB',(100,100)).save(data,format='JPEG')
        result=self.client.post('/captures/normalize',json={'imageB64':base64.b64encode(data.getvalue()).decode()})
        self.assertEqual(result.status_code,422)

    def test_replay_preserves_model_and_original_bytes(self):
        a=self.write();b=self.write();self.assertEqual(a.status_code,200,a.text)
        self.assertEqual(a.json(),b.json());self.assertEqual(len(list(self.model_dir.glob('*.ifc'))),2)
        self.assertEqual((self.model_dir/'room_v1.ifc').read_bytes(),self.pristine)
        self.assertEqual(len((self.model_dir/'maintenance_audit.jsonl').read_text().splitlines()),1)

    def test_conflicting_operation_key_rejected(self):
        self.assertEqual(self.write().status_code,200)
        self.assertEqual(self.write(description='different work').status_code,409)

    def test_concurrent_requests_no_lost_history(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results=list(pool.map(lambda i:self.write(f'wf2:{i}:approval').status_code,range(8)))
        self.assertEqual(results,[200]*8)
        active=(self.model_dir/'active_model.txt').read_text().strip()
        el=ifcopenshell.open(str(self.model_dir/active)).by_guid(self.gid)
        history=json.loads(ifcopenshell.util.element.get_psets(el)['CBM_MaintenanceLog']['History'])
        self.assertEqual(len(history),8)
        self.assertEqual(len({r['operation_key'] for r in history}),8)

    def test_cross_process_writers_share_lock(self):
        with ProcessPoolExecutor(max_workers=2) as pool:
            futures=[pool.submit(process_write,str(self.model_dir),self.gid,f'process:{i}') for i in range(4)]
            results=[f.result(timeout=60) for f in futures]
        self.assertEqual(len({r['version_file'] for r in results}),4)
        self.assertEqual(max(r['history_entries'] for r in results),4)

    def test_interrupted_pointer_publication_recovers_on_replay(self):
        with patch.object(service,'atomic_text',side_effect=OSError('simulated interruption')):
            with self.assertRaises(OSError):self.write()
        self.assertEqual((self.model_dir/'active_model.txt').read_text(),'room_v1.ifc')
        replay=self.write();self.assertEqual(replay.status_code,200,replay.text)
        self.assertEqual((self.model_dir/'active_model.txt').read_text(),replay.json()['version_file'])
        self.assertEqual(len(list(self.model_dir.glob('*.ifc'))),2)

    def test_partial_final_audit_append_recovers(self):
        self.write()
        with open(self.model_dir/'maintenance_audit.jsonl','ab') as handle:handle.write(b'{"partial":')
        self.assertEqual(self.write('wf2:2:approved').status_code,200)
        lines=(self.model_dir/'maintenance_audit.jsonl').read_text().splitlines()
        self.assertEqual(len(lines),2)
        for line in lines:json.loads(line)

    def test_knowledge_http_and_stable_ifc_property_identity(self):
        folder=Path(self.work.name);(folder/'documents').mkdir()
        (folder/'documents/sample.txt').write_text('SYNTHETIC TEST ONLY. A sample radiator maintenance procedure. Inspect the valve and document the repair.')
        catalog={'approved':True,'products':[{'id':'demo','manufacturer':'Synthetic','model':'Test radiator','documents':[{'approved':True,'id':'doc','title':'Synthetic manual','revision':'1','path':'sample.txt'}]}],
            'assets':[{'global_id':self.gid,'product_id':'demo','ifc_class':'IfcSpaceHeater','ifc_type_global_id':None,'properties':[{'pset':'TestSpec','name':'Description'}]}]}
        model=ifcopenshell.open(str(self.model_dir/'room_v1.ifc'))
        ps=ifcopenshell.api.run('pset.add_pset',model,product=model.by_guid(self.gid),name='TestSpec')
        ifcopenshell.api.run('pset.edit_pset',model,pset=ps,properties={'Description':'Stable synthetic specification'})
        model.write(str(self.model_dir/'room_v1.ifc'))
        catalog_file=folder/'catalog.json';catalog_file.write_text(json.dumps(catalog))
        with patch.dict(os.environ,{'CBM_KNOWLEDGE_KEY':'test-only-key','CBM_KNOWLEDGE_CATALOG':str(catalog_file),'IFC_MODEL_DIR':str(self.model_dir)}),TestClient(knowledge_app) as client:
            self.assertEqual(client.get('/knowledge/snapshot').status_code,401)
            before=client.get('/knowledge/snapshot',headers={'X-CBM-Knowledge-Key':'test-only-key'})
            self.assertEqual(before.status_code,200,before.text)
            self.write()
            after=client.get('/knowledge/snapshot',headers={'X-CBM-Knowledge-Key':'test-only-key'})
            self.assertEqual(after.status_code,200,after.text)
            a,b=before.json(),after.json();self.assertNotEqual(a['model_sha256'],b['model_sha256'])
            self.assertEqual([x['metadata']['chunk_id'] for x in a['chunks']],[x['metadata']['chunk_id'] for x in b['chunks']])

if __name__=='__main__':unittest.main(verbosity=2)
