# Ready for WF2

The saved checkpoint contains the complete local `cbm_demo` database and IFC
model volume at the end of WF1, with an assigned ticket and unused upload link.
It preserves the technician assignment, email-link token, events, counters,
IFC model versions, active-model pointer and maintenance journal.

## Repeat a test

1. Finish or stop the current test execution in n8n. Do not upload during restore.
2. Open PowerShell in this release folder and run:

   ```powershell
   .\scripts\wf2\Wf2Checkpoint.cmd restore --execute
   ```

3. Wait for the restore and service restart to finish.
4. Reopen the original technician email link. Refresh the upload page if open.
5. Submit a fresh report, with a different description or photos if desired.
6. Repeat from step 1 for the next test. Do not rerun WF1 or scripts/demo/Reset-CbmDemo.py.

The command restores ALL local demo tickets, not just one. It briefly stops
n8n and the IFC/knowledge services, backs up the state being replaced, restores
database rows and model files, verifies their contents and the unchanged schema,
and restarts previously running services. A failed restore attempts rollback;
if rollback fails, services stay stopped and a diagnostic file is written.

## Inspect or create

```powershell
.\scripts\wf2\Wf2Checkpoint.cmd status
.\scripts\wf2\Wf2Checkpoint.cmd restore
.\scripts\wf2\Wf2Checkpoint.cmd create
```

`restore` without `--execute` only previews. `create` saves a new dated checkpoint
and selects it as the default, retaining earlier checkpoints. Use it only when
WF1 has finished and no technician report has yet been submitted.
`--checkpoint "absolute folder path"` selects an older checkpoint for restore.

Snapshots and pre-restore backups live in `wf2-checkpoints` beside the scripts.
Keep these private: they contain report-link tokens and the demo data.

## What is outside the checkpoint

n8n workflows, credentials, execution history and trigger polling state remain
current. Google Drive files, sent emails and Supabase data also remain current.
Always submit a fresh report after restoring; do not replay an old execution or
expect an existing Drive file to trigger WF2 again. A queued external upload can
still be processed after restart, so let the preceding test finish first.
If WF2 writes an updated IFC copy to Drive, that copy remains there too; the
local IFC model used by the service is restored.

The original upload link works only until the expiry saved in the checkpoint.
Restoring does not extend it. The tool refuses an expired checkpoint or a
checkpoint whose database schema no longer matches the running demo.
