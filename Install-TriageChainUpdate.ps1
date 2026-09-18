#Requires -Version 7.3
param([string]$Deployment='C:\Users\USER\Desktop\n8n_deploy')
$ErrorActionPreference='Stop'
$evidence=Join-Path $PSScriptRoot 'validation-triage-chain'
$files=@('Apply-CbmCompatibility.ps1','READ-ME-TRIAGE-CHAIN.md','cbm\app\wf1_ticket_intake_and_dispatch.json',
 'cbm\openrouter\patch-workflows.js','cbm\openrouter\patch-native-triage.js','cbm\openrouter\validators.js','cbm\openrouter\triage-output-schema.json')
foreach($relative in $files){
 $target=Join-Path $Deployment $relative
 $saved=Join-Path $evidence ('before-deployment-files\'+$relative)
 if((Test-Path -LiteralPath $target)-and -not(Test-Path -LiteralPath $saved)){
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $saved)|Out-Null
  Copy-Item -LiteralPath $target -Destination $saved
 }
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot $relative) -Destination $target -Force
}
$installed=Get-Content -LiteralPath (Join-Path $evidence 'installed-workflow.json') -Raw|ConvertFrom-Json -Depth 100
if(@($installed).Count-ne 1-or $installed[0].id-ne 'YZb99Du8CBtsSy7f'-or $installed[0].active){throw 'Unexpected workflow target'}
$configured=Join-Path $Deployment 'cbm\workflows-configured\wf1_ticket_intake_and_dispatch.json'
$saved=Join-Path $evidence 'before-deployment-files\configured-wf1.json'
if(-not(Test-Path -LiteralPath $saved)){Copy-Item -LiteralPath $configured -Destination $saved}
[IO.File]::WriteAllText($configured,($installed[0]|ConvertTo-Json -Depth 100),(New-Object Text.UTF8Encoding $false))
docker cp (Join-Path $evidence 'installed-workflow.json') 'n8n_v1:/tmp/cbm-triage-chain.json'
if($LASTEXITCODE-ne 0){throw 'Workflow copy failed'}
docker exec n8n_v1 n8n import:workflow --input=/tmp/cbm-triage-chain.json
if($LASTEXITCODE-ne 0){throw 'Workflow import failed'}
Write-Output 'Imported the source WF1 draft with native IFC matching chain. No workflow was published or executed.'
