param([string]$Deployment='C:\Users\USER\Desktop\n8n_deploy',[switch]$SkipServiceBuild)
$ErrorActionPreference='Stop'
# Scripts live in scripts/<group>/; the paths below are relative to the repository root.
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
# Installs the current WF3: FM actions, the guarded ticket-action helper and the IFC maintenance
# inspection tool. Supersedes Install-Wf3IfcInspection.ps1, whose WF3 export predates these actions.
$payload=Join-Path $RepoRoot 'validation-wf3-actions\wf3-actions-import.json'
$flows=@(Get-Content -Raw -LiteralPath $payload|ConvertFrom-Json)
$ids=@('658IWGwRtDMsPri7','cbmWf3TicketAction','cbmWf3ApprovalMail')
if($flows.Count -ne 3 -or @($flows|Where-Object{$_.id -notin $ids}).Count){throw 'Unexpected workflow targets'}
# The approval mail helper in this payload is older; Install-Wf2SharedReview.ps1 owns its current version.
$flows=@($flows|Where-Object{$_.id -ne 'cbmWf3ApprovalMail'})
$helperPath=Join-Path $RepoRoot 'cbm\app\wf3\workflows\inspect_ifc_maintenance.json'
$helper=Get-Content -LiteralPath $helperPath -Raw|ConvertFrom-Json
if($helper.id -ne 'cbmWf3IfcInspect' -or $helper.active){throw 'Unexpected IFC helper target'}
if($flows[0].id -ne '658IWGwRtDMsPri7' -or $flows[0].active){throw 'Unexpected WF3 target or activation state'}

$files=@('docs\wf3\WF3_FM_ACTIONS.md','docs\wf3\WF3_IFC_INSPECTION.md','cbm\app\ifc_service.py',
 'cbm\app\wf3\build_wf3.py','cbm\app\wf3\validate_wf3.py','cbm\app\wf3\README.md',
 'cbm\app\wf3\ifc_inspection.py','cbm\app\wf3\normalize-ifc-request.js','cbm\app\wf3\build-ifc-tool-result.js',
 'cbm\app\wf3\workflows\inspect_ifc_maintenance.json','cbm\app\wf3\test_ifc_inspection.py',
 'cbm\app\wf3\test_ifc_tool.mjs','cbm\app\wf3\test_wf3_nodes.mjs',
 'database\wf3\ifc-interventions.sql','database\wf3\actions\schema.sql')
$actionRoot=Join-Path $RepoRoot 'cbm\app\wf3\actions'
$files+=@(Get-ChildItem -LiteralPath $actionRoot -File -Recurse|Where-Object{$_.FullName -notmatch '__pycache__'}|ForEach-Object{$_.FullName.Substring($RepoRoot.Length+1)})
foreach($relative in $files){
 $target=Join-Path $Deployment $relative
 New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target)|Out-Null
 Copy-Item -LiteralPath (Join-Path $RepoRoot $relative) -Destination $target -Force
}

Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'database\wf3\actions\schema.sql') | docker exec -i n8n_deploy-cbm-postgres-1 psql -U cbm_app -d cbm_demo -v ON_ERROR_STOP=1 -q
if($LASTEXITCODE -ne 0){throw 'WF3 migration failed; workflow import stopped'}

if(-not $SkipServiceBuild){
 $compose=@('compose','--project-directory',$Deployment,'--env-file',(Join-Path $Deployment '.env'),'--env-file',(Join-Path $Deployment 'cbm\cbm.env'),'-f',(Join-Path $Deployment 'docker-compose.yml'))
 docker @compose build ifc-init
 if($LASTEXITCODE -ne 0){throw 'IFC image build failed'}
 docker @compose up -d --no-deps --force-recreate ifc-service
 if($LASTEXITCODE -ne 0){throw 'IFC service recreation failed'}
}

# WF3 calls the IFC helper as a tool, so import the helper first.
docker cp $helperPath 'n8n_v1:/tmp/cbm-wf3-ifc-helper.json'
if($LASTEXITCODE -ne 0){throw 'Helper copy failed'}
docker exec n8n_v1 n8n import:workflow --input=/tmp/cbm-wf3-ifc-helper.json
if($LASTEXITCODE -ne 0){throw 'Helper import failed'}
$utf8=New-Object Text.UTF8Encoding $false
$staged=Join-Path ([IO.Path]::GetTempPath()) 'cbm-wf3-actions.json'
[IO.File]::WriteAllText($staged,(ConvertTo-Json -InputObject $flows -Depth 100),$utf8)
docker cp $staged 'n8n_v1:/tmp/cbm-wf3-actions.json'
if($LASTEXITCODE -ne 0){throw 'Workflow copy failed'}
docker exec n8n_v1 n8n import:workflow --input=/tmp/cbm-wf3-actions.json
if($LASTEXITCODE -ne 0){throw 'Workflow import failed'}

foreach($root in @($RepoRoot,$Deployment)){
 foreach($rel in @('cbm\app\n8n_wf3_fm_dashboard.json','cbm\workflows-configured\n8n_wf3_fm_dashboard.json')){
  [IO.File]::WriteAllText((Join-Path $root $rel),($flows[0]|ConvertTo-Json -Depth 100),$utf8)
 }
 [IO.File]::WriteAllText((Join-Path $root 'cbm\workflows-configured\cbmWf3TicketAction.json'),($flows[1]|ConvertTo-Json -Depth 100),$utf8)
 Copy-Item -LiteralPath $helperPath -Destination (Join-Path $root 'cbm\workflows-configured\inspect_ifc_maintenance.json') -Force
}
Write-Output 'Imported WF3, its guarded ticket-action helper and the IFC inspection helper; existing inactive state retained. Publish the helpers, then WF3, in the n8n editor. No workflow was executed by this installer.'
