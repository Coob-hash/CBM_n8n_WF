#Requires -Version 7.3
param([string]$Deployment='C:\Users\USER\Desktop\n8n_deploy')
$ErrorActionPreference='Stop'
$evidence=Join-Path $PSScriptRoot 'validation-phase-b-context'
$mapping=Get-Content -LiteralPath (Join-Path $evidence 'source-file-map.json') -Raw|ConvertFrom-Json -AsHashtable
$workflows=@(Get-Content -LiteralPath (Join-Path $evidence 'installed-workflows.json') -Raw|ConvertFrom-Json -Depth 100)
if($workflows.Count-ne 12-or @($workflows|Where-Object active).Count){throw 'Unexpected workflow update set'}
foreach($relative in $mapping.Keys){
    foreach($folder in @('app','workflows-configured')){
        $target=Join-Path $Deployment ('cbm\'+$folder+'\'+$relative)
        $saved=Join-Path $evidence ('before-deployment-files\'+$folder+'\'+$relative)
        if((Test-Path -LiteralPath $target)-and -not(Test-Path -LiteralPath $saved)){
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $saved)|Out-Null
            Copy-Item -LiteralPath $target -Destination $saved
        }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target)|Out-Null
        if($folder-eq 'app'){
            Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('cbm\app\'+$relative)) -Destination $target -Force
        }else{
            $workflow=@($workflows|Where-Object id -eq $mapping[$relative])
            if($workflow.Count-ne 1){throw 'Workflow mapping is not unique'}
            [IO.File]::WriteAllText($target,($workflow[0]|ConvertTo-Json -Depth 100),[Text.UTF8Encoding]::new($false))
        }
    }
}
docker cp (Join-Path $evidence 'installed-workflows.json') 'n8n_v1:/tmp/cbm-phase-b-context-workflows.json'
if($LASTEXITCODE-ne 0){throw 'Workflow copy failed'}
docker exec n8n_v1 n8n import:workflow --input=/tmp/cbm-phase-b-context-workflows.json
if($LASTEXITCODE-ne 0){throw 'Workflow import failed'}
Write-Output 'Saved Phase B configuration and consistent local ticket-database bindings. All workflows remain inactive drafts.'
