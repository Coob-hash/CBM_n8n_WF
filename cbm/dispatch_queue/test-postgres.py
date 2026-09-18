"""Real PostgreSQL concurrency check. Targets only the disposable named container."""
import concurrent.futures
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
CONTAINER = 'cbm-dispatch-queue-check-20260916'

def sql(text):
    result = subprocess.run(['docker','exec','-i',CONTAINER,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','cbm_test','-d','cbm_test'], input=text, encoding='utf-8', capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()

for file in ['../../database/schema.sql','../../database/schema_dispatch_functions.sql','../../database/intake/schema_intake.sql','../../database/dispatch_queue/schema_queue.sql','../../database/dispatch_queue/schema_context.sql']:
    sql((ROOT / file).read_text(encoding='utf-8'))

sql("""INSERT INTO tickets(status,description,required_skill,severity,created_at)
SELECT 'LOCALIZED','Disposable claim test','carpentry',2,clock_timestamp()-i*interval '1 minute'
FROM generate_series(1,17) i;
UPDATE tickets SET status='LOCALIZED',dispatch_authorized_at=clock_timestamp();""")

def claim(_):
    return json.loads(sql("SELECT coalesce(json_agg(b),'[]'::json) FROM cbm_claim_dispatch_batch(5) b;"))

with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    batches = list(pool.map(claim, range(4)))
ids = [row['ticketId'] for batch in batches for row in batch]
assert len(ids) == 17 and len(set(ids)) == 17, batches
assert sorted(map(len,batches)) == [2,5,5,5], batches
assert claim(None) == []

first=batches[0][0]
def start(worker):
    # IDs and tokens came from the disposable DB; no external strings enter this query.
    return json.loads(sql(f"SELECT cbm_start_dispatch_work({int(first['ticketId'])},'{first['leaseToken']}'::uuid,'worker-{worker}');"))
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    starts=list(pool.map(start,range(2)))
assert sum(x['accepted'] for x in starts)==1, starts
report={'postgres':'16','simultaneous_batches':4,'batch_sizes':list(map(len,batches)),'distinct_claims':len(set(ids)),'duplicate_claims':0,'accepted_workers_for_one_claim':1}
(ROOT/'../../validation/postgres-concurrency.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report))
