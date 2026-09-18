param([string]$Deployment='C:\Users\USER\Desktop\n8n_deploy')
$ErrorActionPreference='Stop'
$payload=Join-Path $PSScriptRoot 'validation-wf2-chat-approval\import.json'
$flows=@(Get-Content -Raw -LiteralPath $payload|ConvertFrom-Json)
$ids=@('5quLJucpa0K4jWZS','cbmWf3ApprovalMail')
if($flows.Count -ne 2 -or @($flows|Where-Object{$_.id -notin $ids}).Count){throw 'Unexpected workflow targets'}
Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'database\wf2\review-mail.sql') | docker exec -i n8n_deploy-cbm-postgres-1 psql -U cbm_app -d cbm_demo -v ON_ERROR_STOP=1 -q
if($LASTEXITCODE -ne 0){throw 'Migration failed'}
docker cp $payload 'n8n_v1:/tmp/cbm-wf2-shared-review.json'
if($LASTEXITCODE -ne 0){throw 'Workflow copy failed'}
docker exec n8n_v1 n8n import:workflow --input=/tmp/cbm-wf2-shared-review.json
if($LASTEXITCODE -ne 0){throw 'Workflow import failed'}
$utf8=New-Object Text.UTF8Encoding $false
foreach($root in @($PSScriptRoot,$Deployment)){
 foreach($rel in @('cbm\app\n8n_wf2_completion_approval_ifc_update.json','cbm\workflows-configured\n8n_wf2_completion_approval_ifc_update.json')){
  [IO.File]::WriteAllText((Join-Path $root $rel),($flows[0]|ConvertTo-Json -Depth 100),$utf8)
 }
 foreach($rel in @('cbm\workflows-configured\cbmWf3ApprovalMail.json','cbm\app\wf3\actions\workflows\cbmWf3ApprovalMail.json')){
  [IO.File]::WriteAllText((Join-Path $root $rel),($flows[1]|ConvertTo-Json -Depth 100),$utf8)
 }
}
foreach($rel in @('TICKET_STATE_REFERENCE.md','cbm\app\wf2\shared_review.py','database\wf2\review-mail.sql','cbm\app\wf2\SHARED_FM_REVIEW.md','cbm\app\wf2\validate_wf2.py','cbm\app\wf2\test_shared_review.py','cbm\app\wf2\check-shared-review.cjs')){
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot $rel) -Destination (Join-Path $Deployment $rel) -Force
}
Write-Output 'Imported only WF2 and its shared approval email helper. Publish the helper, then WF2. No workflow was executed by this installer.'
