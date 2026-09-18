"""Regression tests in a disposable PostgreSQL container; no provider or email calls."""
import concurrent.futures,json,subprocess,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
CONTAINER='cbm-registration-validation-cbm-postgres-1'
def query(sql):
 r=subprocess.run(['docker','exec','-i',CONTAINER,'psql','-X','-U','cbm_app','-d','cbm_demo','-At','-v','ON_ERROR_STOP=1'],input=sql,text=True,capture_output=True)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
def one(sql):return json.loads(query(sql))
def literal(x):return "'"+str(x).replace("'","''")+"'"
def begin(fid='file1',rid=None,ready=True,email='reporter@test.invalid'):
 p=dict(file_id=fid,report_id=rid,reporter_email=email,registration_ready=ready,execution_id='isolated-test',configuration_reason='REGISTRATION_REQUIRED')
 return one('SELECT cbm_capture_begin('+literal(json.dumps(p))+'::jsonb);')
def fail(rid,fid='file1',reason='REGISTRATION_REQUIRED'):
 return one('SELECT cbm_capture_failed('+','.join(literal(v) for v in [rid,fid,reason])+');')
def state(rid):return one('SELECT to_jsonb(r) FROM cbm_intake_reports r WHERE id='+literal(rid)+';')
class Tests(unittest.TestCase):
 def setUp(self):
  query('TRUNCATE cbm_capture_configuration_events,cbm_intake_outbox,cbm_it_issues,cbm_capture_attempts,cbm_intake_reports,ticket_events,tickets RESTART IDENTITY CASCADE;')
 def test_preflight_pauses_and_refunds(self):
  a=begin(ready=False);self.assertFalse(a['process']);self.assertEqual(a['state'],'CONFIGURATION_REQUIRED');self.assertEqual(a['attempts'],0)
  self.assertEqual(query("SELECT count(*) FROM cbm_intake_outbox WHERE kind='RETRY';"),'0')
  self.assertEqual(query("SELECT count(*) FROM cbm_intake_outbox WHERE kind='CONFIGURATION_IT';"),'1')
  self.assertEqual(query('SELECT count(*) FROM tickets;'),'0')
 def test_same_file_waits_then_resumes_once(self):
  a=begin(ready=False);rid=a['report_id'];self.assertFalse(begin(ready=False)['process'])
  b=begin();self.assertTrue(b['process']);self.assertTrue(b['resumed']);self.assertEqual(b['report_id'],rid);self.assertEqual(b['attempt'],1)
  self.assertFalse(begin()['process']);self.assertEqual(state(rid)['attempts'],1)
  self.assertEqual(query("SELECT count(*) FROM cbm_capture_configuration_events WHERE action='RESUMED';"),'1')
 def test_configuration_failure_after_preflight_refunds_once(self):
  a=begin();rid=a['report_id'];self.assertEqual(fail(rid)['attempts'],0)
  self.assertFalse(fail(rid)['changed']);self.assertEqual(state(rid)['attempts'],0)
  self.assertTrue(begin()['resumed'])
  self.assertEqual(fail(rid,reason='REGISTRATION_INVALID')['attempts'],0)
 def test_new_file_cannot_steal_reserved_slot(self):
  a=begin(ready=False);b=begin('file2',a['report_id']);self.assertFalse(b['process']);self.assertEqual(b['reason'],'RESUME_RETAINED_FILE')
  self.assertEqual(query('SELECT count(*) FROM cbm_capture_attempts;'),'1')
 def test_wrong_reporter_or_report_cannot_resume(self):
  a=begin(ready=False)
  with self.assertRaises(RuntimeError):begin(email='another@test.invalid')
  with self.assertRaises(RuntimeError):begin(rid='00000000-0000-0000-0000-000000000000')
  self.assertEqual(state(a['report_id'])['attempts'],0)
 def test_four_real_photo_failures_still_escalate(self):
  rid=None
  for i in range(1,5):
   a=begin('file'+str(i),rid);rid=a['report_id'];f=fail(rid,'file'+str(i),'ASSET_IDENTIFICATION_UNRESOLVED')
   self.assertEqual(f['attempts'],i);self.assertEqual(f['state'],'IT_ISSUE' if i==4 else 'AWAITING_PHOTO')
  self.assertEqual(query('SELECT count(*) FROM cbm_it_issues;'),'1');self.assertFalse(begin('file5',rid)['process'])
 def test_refund_preserves_previous_real_failure(self):
  a=begin();rid=a['report_id'];fail(rid,reason='VPS_POSE_UNRESOLVED')
  b=begin('file2',rid,False);self.assertEqual(b['attempts'],1)
  self.assertEqual(begin('file2',rid)['attempt'],2)
  self.assertEqual(fail(rid,'file2','ASSET_IDENTIFICATION_UNRESOLVED')['attempts'],2)
 def test_historical_execution_reclassification(self):
  a=begin();rid=a['report_id'];fail(rid,reason='VPS_POSE_UNRESOLVED')
  query("UPDATE cbm_capture_attempts SET reason='REGISTRATION_REQUIRED' WHERE file_id='file1';")
  f=one('SELECT cbm_capture_pause_configuration('+literal(rid)+",'file1','REGISTRATION_REQUIRED',true);")
  self.assertTrue(f['changed']);self.assertEqual(f['attempts'],0)
  self.assertEqual(query("SELECT status FROM cbm_intake_outbox WHERE event_key='retry:file1';"),'CANCELLED')
  self.assertEqual(query("SELECT action FROM cbm_capture_configuration_events;"),'RECLASSIFIED')
 def test_concurrent_resume_only_one_claim(self):
  a=begin(ready=False)
  with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:r=list(pool.map(lambda _:begin(),range(8)))
  self.assertEqual(sum(x['process'] for x in r),1);self.assertEqual(state(a['report_id'])['attempts'],1)
 def test_success_after_resume_still_requires_fm(self):
  a=begin(ready=False);rid=a['report_id'];begin()
  p={'triage':{'triageValid':True,'element':{'global_id':'3kcZF9AH16IwPfuL_CGFlR','ifc_class':'IfcBuildingElementProxy','name':'Radiator'},'position':{'x':0,'y':0,'z':0},'confidence':.8,'severity':3,'required_skill':'hvac','description':'Isolated validation only','category':'heating','mapCode':'MAP_J964JX6MGEGO'}}
  r=one('SELECT cbm_capture_identified('+literal(rid)+",'file1',"+literal(json.dumps(p))+'::jsonb);')
  self.assertTrue(r['changed']);self.assertEqual(state(rid)['state'],'IDENTIFIED')
  self.assertEqual(query('SELECT status FROM tickets;'),'PENDING_AUTHORIZATION')
  self.assertFalse(begin()['process'])
if __name__=='__main__':
 migration=(ROOT/'cbm/intake/schema_configuration_pause.sql').read_text()
 query(migration);query(migration)
 suite=unittest.defaultTestLoader.loadTestsFromTestCase(Tests)
 result=unittest.TextTestRunner(verbosity=2).run(suite)
 (ROOT/'validation-registration-fix/database-tests.json').write_text(json.dumps({'tests':result.testsRun,'errors':len(result.errors),'failures':len(result.failures),'isolated_container':CONTAINER},indent=2))
 raise SystemExit(not result.wasSuccessful())
