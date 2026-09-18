param([string]$Deployment='C:\Users\USER\Desktop\n8n_deploy')
$ErrorActionPreference='Stop'
$payload=Join-Path $PSScriptRoot 'validation-wf3-actions\wf3-actions-import.json'
$flows=@(Get-Content -Raw -LiteralPath $payload|ConvertFrom-Json)
$ids=@('658IWGwRtDMsPri7','cbmWf3TicketAction','cbmWf3ApprovalMail')
if($flows.Count -ne 3 -or @($flows|Where-Object{$_.id -notin $ids}).Count){throw 'Unexpected workflow targets'}
Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'database\wf3\actions\schema.sql') | docker exec -i n8n_deploy-cbm-postgres-1 psql -U cbm_app -d cbm_demo -v ON_ERROR_STOP=1 -q
if($LASTEXITCODE -ne 0){throw 'WF3 migration failed; workflow import stopped'}
docker cp $payload 'n8n_v1:/tmp/cbm-wf3-actions.json'
if($LASTEXITCODE -ne 0){throw 'Workflow copy failed'}
docker exec n8n_v1 n8n import:workflow --input=/tmp/cbm-wf3-actions.json
if($LASTEXITCODE -ne 0){throw 'Workflow import failed'}
$utf8=New-Object Text.UTF8Encoding $false
foreach($root in @($PSScriptRoot,$Deployment)){
 foreach($rel in @('cbm\app\n8n_wf3_fm_dashboard.json','cbm\workflows-configured\n8n_wf3_fm_dashboard.json')){
  $target=Join-Path $root $rel
  [IO.File]::WriteAllText($target,($flows[0]|ConvertTo-Json -Depth 100),$utf8)
 }
 foreach($helper in $flows|Select-Object -Skip 1){
  [IO.File]::WriteAllText((Join-Path $root ('cbm\workflows-configured\'+$helper.id+'.json')),($helper|ConvertTo-Json -Depth 100),$utf8)
 }
}
$files=@('WF3_FM_ACTIONS.md','cbm\app\wf3\build_wf3.py','cbm\app\wf3\validate_wf3.py')
$actionRoot=Join-Path $PSScriptRoot 'cbm\app\wf3\actions'
$files+=@(Get-ChildItem -LiteralPath $actionRoot -File -Recurse|Where-Object{$_.FullName -notmatch '__pycache__'}|ForEach-Object{$_.FullName.Substring($PSScriptRoot.Length+1)})
foreach($relative in $files){
 $target=Join-Path $Deployment $relative
 New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target)|Out-Null
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot $relative) -Destination $target -Force
}
Write-Output 'Imported only WF3 and its two new helpers. Publish WF3 and Completion Approval Email in the n8n editor to load the new version without restarting n8n. No workflow was executed by this installer.'
