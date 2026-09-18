param([string]$Deployment='C:\Users\USER\Desktop\n8n_deploy',[switch]$SkipServiceBuild)
$ErrorActionPreference='Stop'
$evidence=Join-Path $PSScriptRoot 'validation-wf3-agent-tool'
$payload=Join-Path $evidence 'updated-workflow.json'
$wf=@(Get-Content -LiteralPath $payload -Raw|ConvertFrom-Json)[0]
$helperPath=Join-Path $PSScriptRoot 'cbm\app\wf3\workflows\inspect_ifc_maintenance.json'
$helper=Get-Content -LiteralPath $helperPath -Raw|ConvertFrom-Json
if($wf.id -ne '658IWGwRtDMsPri7' -or $wf.active){throw 'Unexpected WF3 target or activation state'}
if($helper.id -ne 'cbmWf3IfcInspect' -or $helper.active){throw 'Unexpected IFC helper target'}
$files=@('cbm\app\ifc_service.py','cbm\app\wf3\ifc_inspection.py',
 'cbm\app\wf3\normalize-ifc-request.js','cbm\app\wf3\build-ifc-tool-result.js',
 'database\wf3\ifc-interventions.sql','cbm\app\wf3\workflows\inspect_ifc_maintenance.json',
 'cbm\app\wf3\build_wf3.py','cbm\app\wf3\README.md',
 'cbm\app\wf3\validate_wf3.py','cbm\app\wf3\test_ifc_inspection.py',
 'cbm\app\wf3\test_ifc_tool.mjs','cbm\app\wf3\test_wf3_nodes.mjs','WF3_IFC_INSPECTION.md')
foreach($relative in $files){
 $target=Join-Path $Deployment $relative
 $backup=Join-Path $evidence ('before-deployment\'+$relative)
 if((Test-Path -LiteralPath $target)-and -not(Test-Path -LiteralPath $backup)){
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backup)|Out-Null
  Copy-Item -LiteralPath $target -Destination $backup
 }
 New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target)|Out-Null
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot $relative) -Destination $target -Force
}
if(-not $SkipServiceBuild){
docker compose --project-directory $Deployment --env-file (Join-Path $Deployment '.env') --env-file (Join-Path $Deployment 'cbm\cbm.env') -f (Join-Path $Deployment 'docker-compose.yml') build ifc-init
if($LASTEXITCODE-ne 0){throw 'IFC image build failed'}
docker compose --project-directory $Deployment --env-file (Join-Path $Deployment '.env') --env-file (Join-Path $Deployment 'cbm\cbm.env') -f (Join-Path $Deployment 'docker-compose.yml') up -d --no-deps --force-recreate ifc-service
if($LASTEXITCODE-ne 0){throw 'IFC service recreation failed'}
}
docker cp $helperPath 'n8n_v1:/tmp/cbm-wf3-ifc-helper.json'
if($LASTEXITCODE-ne 0){throw 'Helper copy failed'}
docker exec n8n_v1 n8n import:workflow --input=/tmp/cbm-wf3-ifc-helper.json
if($LASTEXITCODE-ne 0){throw 'Helper import failed'}
docker cp $payload 'n8n_v1:/tmp/cbm-wf3-ifc.json'
if($LASTEXITCODE-ne 0){throw 'Workflow copy failed'}
docker exec n8n_v1 n8n import:workflow --input=/tmp/cbm-wf3-ifc.json
if($LASTEXITCODE-ne 0){throw 'WF3 import failed'}
foreach($root in @($PSScriptRoot,$Deployment)){
 Copy-Item -LiteralPath $helperPath -Destination (Join-Path $root 'cbm\workflows-configured\inspect_ifc_maintenance.json') -Force
 foreach($relative in @('cbm\app\n8n_wf3_fm_dashboard.json','cbm\workflows-configured\n8n_wf3_fm_dashboard.json')){
  $target=Join-Path $root $relative
  $json=$wf|ConvertTo-Json -Depth 100
  [IO.File]::WriteAllText($target,$json,(New-Object Text.UTF8Encoding $false))
 }
}
Write-Output 'WF3 updated in place and the IFC helper imported. Existing inactive state retained. No workflow was executed by this installer.'
