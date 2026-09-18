"""Run in the existing IFC image; temporary model files only."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import ifcopenshell
import ifcopenshell.api
from fastapi.testclient import TestClient
import ifc_service as service


class InspectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.model = ifcopenshell.file(schema='IFC4')
        self.asset = self.model.create_entity('IfcWall', GlobalId=ifcopenshell.guid.new(), Name='Test <asset>')
        self.model.write(str(self.root / 'office_v1.ifc'))
        (self.root / 'active_model.txt').write_text('office_v1.ifc')
        self.patch = patch.multiple(service, MODEL_DIR=self.root, POINTER_FILE=self.root / 'active_model.txt')
        self.patch.start()
        self.client = TestClient(service.app)

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def add_history(self, history):
        pset = ifcopenshell.api.run('pset.add_pset', self.model, product=self.asset, name=service.PSET_NAME)
        ifcopenshell.api.run('pset.edit_pset', self.model, pset=pset, properties={
            'LastTicketId': '7', 'LastMaintenanceDate': '2026-09-17T10:00:00Z',
            'LastDescription': 'Replaced valve', 'ConditionStatus': 'Repaired',
            'History': json.dumps(history)})
        self.model.write(str(self.root / 'office_v1.ifc'))

    def test_empty_model_and_unknown_asset(self):
        r = self.client.get('/maintenance').json()
        self.assertEqual(r['assets'], [])
        self.assertEqual(r['total_maintained_assets'], 0)
        self.assertEqual(self.client.get('/maintenance', params={'global_id': ifcopenshell.guid.new()}).status_code, 404)

    def test_history_filter_pagination_and_immutable_download(self):
        self.add_history([{'ticket_id': str(i), 'description': 'Work'} for i in range(25)])
        before = (self.root / 'office_v1.ifc').read_bytes()
        r = self.client.get('/maintenance', params={'global_id': self.asset.GlobalId}).json()
        self.assertEqual(r['assets'][0]['last_description'], 'Replaced valve')
        self.assertEqual(r['total_interventions'], 25)
        self.assertTrue(r['assets'][0]['history_truncated'])
        self.assertEqual(r['assets'][0]['history'][0]['ticket_id'], '24')
        self.assertEqual(len(r['assets'][0]['history']), 20)
        self.assertEqual(self.client.get('/maintenance?offset=1').json()['assets'], [])
        self.model.write(str(self.root / 'office_v2.ifc'))
        (self.root / 'active_model.txt').write_text('office_v2.ifc')
        download = self.client.get('/models/office_v1.ifc/download')
        self.assertEqual(download.content, before)
        self.assertEqual(hashlib.sha256(download.content).hexdigest(), r['version_sha256'])
        self.assertEqual((self.root / 'office_v1.ifc').read_bytes(), before)
        self.assertEqual(self.client.get('/maintenance').json()['version_file'], 'office_v2.ifc')

    def test_invalid_history_and_download_paths_fail_closed(self):
        self.add_history({'not': 'a list'})
        self.assertEqual(self.client.get('/maintenance').status_code, 500)
        self.assertEqual(self.client.get('/models/active_model.txt/download').status_code, 400)
        self.assertEqual(self.client.get('/maintenance?limit=501').status_code, 422)
        with tempfile.NamedTemporaryFile(suffix='.ifc') as outside:
            (self.root / 'outside.ifc').symlink_to(outside.name)
            self.assertEqual(self.client.get('/models/outside.ifc/download').status_code, 404)

    def test_several_assets_sort_filter_and_pin_version(self):
        self.add_history([{'ticket_id': '7'}])
        # 11:00+02 is older than 10:00Z, despite its larger textual hour.
        older = self.model.create_entity('IfcDoor', GlobalId=ifcopenshell.guid.new(), Name='Office door')
        newest = self.model.create_entity('IfcWall', GlobalId=ifcopenshell.guid.new(), Name='Office wall')
        for element, when in [(older, '2026-09-17T11:00:00+02:00'),
                              (newest, '2026-09-17T12:00:00Z')]:
            ps = ifcopenshell.api.run('pset.add_pset', self.model, product=element, name=service.PSET_NAME)
            ifcopenshell.api.run('pset.edit_pset', self.model, pset=ps, properties={
                'LastTicketId': '8', 'LastMaintenanceDate': when, 'History': '[{"ticket_id":"8"}]'})
        self.model.write(str(self.root / 'office_v1.ifc'))
        first = self.client.get('/maintenance?limit=2').json()
        self.assertEqual([x['global_id'] for x in first['assets']], [newest.GlobalId, self.asset.GlobalId])
        self.assertTrue(first['has_more'])
        self.assertEqual(first['total_maintained_assets'], 3)
        self.model.remove(older)
        self.model.write(str(self.root / 'office_v2.ifc'))
        (self.root / 'active_model.txt').write_text('office_v2.ifc')
        page2 = self.client.get('/maintenance', params={'limit': 2, 'offset': 2, 'model_version': first['version_file']}).json()
        self.assertEqual(page2['assets'][0]['name'], 'Office door')
        self.assertFalse(page2['has_more'])
        self.assertEqual(page2['version_sha256'], first['version_sha256'])
        filtered = self.client.get('/maintenance', params={'global_ids': self.asset.GlobalId + ',' + newest.GlobalId}).json()
        self.assertEqual(len(filtered['assets']), 2)
        self.assertEqual(self.client.get('/maintenance?search=OFFICE').json()['total_maintained_assets'], 1)
        self.assertEqual(self.client.get('/maintenance?global_ids=invalid').status_code, 422)
        self.assertEqual(self.client.get('/maintenance?model_version=../office_v1.ifc').status_code, 400)


if __name__ == '__main__':
    unittest.main()
