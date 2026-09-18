"""Integration tests against ONLY the disposable localhost:55439 PostgreSQL.

Start cbm/tests/compose.yaml with project cbm-intake-validation first.
No provider requests, mail, or production database access.
"""
import concurrent.futures
import json
import unittest
import uuid
import psycopg
from psycopg.types.json import Jsonb

DSN='host=127.0.0.1 port=55439 dbname=cbm_demo user=cbm_app password=disposable-postgres-test-password'
GUID='3kcZF9AH16IwPfuL_CGFlR'

def connection():return psycopg.connect(DSN,autocommit=True)

class IntakeDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.db=connection()
        self.db.execute('TRUNCATE cbm_intake_outbox,cbm_it_issues,cbm_capture_attempts,cbm_intake_reports,ticket_events,tickets RESTART IDENTITY CASCADE')
    def tearDown(self):self.db.close()
    def one(self,q,args=()):return self.db.execute(q,args).fetchone()[0]
    def begin(self,file='first',report=None,email='reporter@test.invalid',db=None):
        return (db or self.db).execute('SELECT cbm_capture_begin(%s)',(Jsonb(dict(file_id=file,report_id=report,reporter_email=email,photo_url='https://drive.test.invalid/'+file,execution_id='test-only')),)).fetchone()[0]
    def fail(self,report,file,reason='VPS_POSE_UNRESOLVED'):
        return self.one('SELECT cbm_capture_failed(%s,%s,%s)',(report,file,reason))
    def identify(self,rid,file,guid=GUID,db=None):
        request={'sourceKey':'untrusted-source-overridden','triage':{'triageValid':True,'element':{'global_id':guid,'ifc_class':'IfcBuildingElementProxy','name':'Radiator'},
        'position':{'x':0,'y':0,'z':0},'confidence':0.8,'severity':3,'required_skill':'hvac','description':'Reported issue, test only','category':'heating','reporterEmail':'overridden@test.invalid','mapCode':'MAP_J964JX6MGEGO'}}
        return (db or self.db).execute('SELECT cbm_capture_identified(%s,%s,%s)',(rid,file,Jsonb(request))).fetchone()[0]
    def ticket(self,tid):
        return self.one('SELECT to_jsonb(t) FROM tickets t WHERE id=%s',(tid,))
    def decide(self,t,decision='approve'):
        return self.one('SELECT cbm_authorize_dispatch(%s,%s,%s,%s)',(t['id'],t['dispatch_authorization_id'],t['dispatch_authorization_token'],decision))

    def test_four_captures_create_one_bug_and_no_maintenance_ticket(self):
        rid=None
        for i,reason in enumerate(['CAPTURE_NORMALIZATION_FAILED','VPS_POSE_UNRESOLVED','PROVIDER_OR_SERVICE_ERROR','ASSET_IDENTIFICATION_UNRESOLVED'],1):
            c=self.begin('photo'+str(i),rid);rid=c['report_id']
            self.assertEqual(c['attempt'],i)
            f=self.fail(rid,'photo'+str(i),reason)
            self.assertEqual(f['retries_remaining'],4-i)
            self.assertEqual(f['state'],'AWAITING_PHOTO' if i<4 else 'IT_ISSUE')
        self.assertEqual(self.one('SELECT count(*) FROM cbm_it_issues'),1)
        self.assertEqual(self.one('SELECT count(*) FROM tickets'),0)
        self.assertEqual(self.one("SELECT count(*) FROM cbm_intake_outbox WHERE kind='RETRY'"),3)
        self.assertEqual(self.one("SELECT count(*) FROM cbm_intake_outbox WHERE kind='IT_BUG'"),1)
        self.assertFalse(self.begin('photo4',rid)['process'])
        self.assertFalse(self.begin('photo5',rid)['process'])
        self.assertFalse(self.fail(rid,'photo4')['changed'])
        self.assertEqual(self.one('SELECT attempts FROM cbm_intake_reports WHERE id=%s',(rid,)),4)
        self.assertEqual(len(self.one('SELECT diagnostics FROM cbm_it_issues')['attempts']),4)

    def test_success_on_last_retry_waits_for_fm_and_db_blocks_dispatch(self):
        rid=None
        for i in range(1,4):
            c=self.begin('photo'+str(i),rid);rid=c['report_id'];self.fail(rid,'photo'+str(i))
        self.begin('photo4',rid);result=self.identify(rid,'photo4');t=self.ticket(result['ticket_id'])
        self.assertEqual(t['status'],'PENDING_AUTHORIZATION')
        self.assertIsNone(t['technician_id']);self.assertIsNone(t['dispatch_authorized_at'])
        self.assertEqual(t['reporter_email'],'reporter@test.invalid')
        self.assertEqual(t['photo_before_url'],'https://drive.test.invalid/photo4')
        self.assertEqual(self.one('SELECT count(*) FROM cbm_it_issues'),0)
        for status in ['LOCALIZED','DISPATCHING','ASSIGNED','WORK_DONE','PENDING_APPROVAL']:
            with self.assertRaises(psycopg.errors.RaiseException):
                self.db.execute('UPDATE tickets SET status=%s WHERE id=%s',(status,t['id']))
        with self.assertRaises(psycopg.errors.RaiseException):
            self.db.execute('UPDATE tickets SET requires_dispatch_authorization=false WHERE id=%s',(t['id'],))
        self.assertTrue(self.decide(t)['approved'])
        self.assertEqual(self.ticket(t['id'])['status'],'LOCALIZED')
        self.assertFalse(self.decide(t)['applied'])
        self.assertFalse(self.decide(t,'reject')['applied'])
        self.assertEqual(self.one("SELECT count(*) FROM ticket_events WHERE event='CBM_DISPATCH_AUTHORIZATION'"),1)
        # Authorization survives the subsequent completion-acceptance state.
        self.db.execute("UPDATE tickets SET status='PENDING_APPROVAL' WHERE id=%s",(t['id'],))
        self.assertIsNotNone(self.ticket(t['id'])['dispatch_authorized_at'])

    def test_rejection_never_dispatches_and_allows_a_later_request(self):
        c=self.begin();t=self.ticket(self.identify(c['report_id'],'first')['ticket_id'])
        self.assertFalse(self.decide(t,'reject')['approved'])
        self.assertEqual(self.ticket(t['id'])['status'],'REJECTED')
        with self.assertRaises(psycopg.errors.RaiseException):self.db.execute("UPDATE tickets SET status='LOCALIZED' WHERE id=%s",(t['id'],))
        c2=self.begin('later');t2=self.ticket(self.identify(c2['report_id'],'later')['ticket_id'])
        self.assertNotEqual(t2['id'],t['id']);self.assertEqual(t2['status'],'PENDING_AUTHORIZATION')
        self.assertEqual(self.one("SELECT count(*) FROM cbm_intake_outbox WHERE kind='REJECTED'"),1)

    def test_duplicate_file_and_concurrent_retries_do_not_increment_twice(self):
        rid=str(uuid.uuid4())
        def begin(file):
            with connection() as db:return self.begin(file,rid,db=db)
        with concurrent.futures.ThreadPoolExecutor(2) as pool:results=list(pool.map(begin,['same','same']))
        self.assertEqual(sum(r['process'] for r in results),1)
        self.fail(rid,'same')
        with concurrent.futures.ThreadPoolExecutor(2) as pool:results=list(pool.map(begin,['nextA','nextB']))
        self.assertEqual(sum(r['process'] for r in results),1)
        self.assertEqual(self.one('SELECT attempts FROM cbm_intake_reports WHERE id=%s',(rid,)),2)
        with self.assertRaises(psycopg.errors.RaiseException):self.begin('other-person',rid,'someoneelse@test.invalid')

    def test_simultaneous_asset_reports_create_one_pending_job(self):
        a=self.begin('A');b=self.begin('B')
        def finish(pair):
            with connection() as db:return self.identify(*pair,db=db)
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            results=list(pool.map(finish,[(a['report_id'],'A'),(b['report_id'],'B')]))
        self.assertEqual(len({r['ticket_id'] for r in results}),1)
        self.assertEqual(sum(r['duplicate'] for r in results),1)
        self.assertEqual(self.one("SELECT count(*) FROM cbm_intake_outbox WHERE kind='AUTHORIZATION'"),1)
        self.assertEqual(self.one('SELECT count(*) FROM tickets'),1)

    def test_expired_links_never_approve_and_recovery_renews_them(self):
        c=self.begin();t=self.ticket(self.identify(c['report_id'],'first')['ticket_id'])
        invalid={**t,'dispatch_authorization_token':'0'*64}
        self.assertFalse(self.decide(invalid)['applied'])
        self.assertFalse(self.decide(t,'invalid')['applied'])
        self.db.execute("UPDATE tickets SET dispatch_authorization_expires_at=clock_timestamp()-interval '1 second'")
        self.assertFalse(self.decide(t)['applied'])
        self.one('SELECT cbm_intake_recover()');fresh=self.ticket(t['id'])
        self.assertNotEqual(t['dispatch_authorization_id'],fresh['dispatch_authorization_id'])
        self.assertFalse(self.decide(t)['applied']);self.assertTrue(self.decide(fresh)['applied'])

    def test_crash_recovery_and_outbox_claims_are_durable(self):
        c=self.begin()
        self.db.execute("UPDATE cbm_capture_attempts SET started_at=clock_timestamp()-interval '11 minutes'")
        self.one('SELECT cbm_intake_recover()')
        self.assertEqual(self.one('SELECT state FROM cbm_intake_reports'),'AWAITING_PHOTO')
        def claim(_):
            with connection() as db:return db.execute('SELECT * FROM cbm_intake_claim_notice()').fetchall()
        with concurrent.futures.ThreadPoolExecutor(2) as pool:rows=list(pool.map(claim,[1,2]))
        self.assertEqual(sum(len(x) for x in rows),1)
        self.db.execute("UPDATE cbm_intake_outbox SET claimed_at=clock_timestamp()-interval '6 minutes'")
        self.one('SELECT cbm_intake_recover()')
        self.assertEqual(self.one('SELECT status FROM cbm_intake_outbox'),'UNCERTAIN')
        self.assertEqual(self.one('SELECT count(*) FROM cbm_intake_claim_notice()'),0)
        self.db.close();self.db=connection()
        self.assertEqual(self.one('SELECT attempts FROM cbm_intake_reports'),1)

if __name__=='__main__':unittest.main(verbosity=2)
