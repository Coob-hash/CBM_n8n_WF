#Requires -Version 7.3
param([string]$Deployment = 'C:\Users\USER\Desktop\n8n_deploy')
$ErrorActionPreference = 'Stop'
# Scripts live in scripts/<group>/; the paths below are relative to the repository root.
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$backup = Join-Path $RepoRoot 'validation\before-deployment-files'
$files = @('scripts\workflows\Apply-CbmCompatibility.ps1','scripts\workflows\Prepare-CbmWorkflows.ps1','docker-compose.yml','cbm\imported-workflow-ids.json','cbm\app\wf1_ticket_intake_and_dispatch.json')
foreach ($folder in @('cbm\dispatch_queue','database\dispatch_queue','cbm\app\phase_b\workflows')) {
    $files += Get-ChildItem -LiteralPath (Join-Path $RepoRoot $folder) -File | ForEach-Object { Join-Path $folder $_.Name }
}
foreach ($file in @('queries.js','operations.js','system-message.txt','saved-workflows.js','test-dispatch.js')) { $files += 'cbm\app\phase_b\' + $file }
foreach ($relative in $files) {
    $source = Join-Path $RepoRoot $relative
    $target = Join-Path $Deployment $relative
    $saved = Join-Path $backup $relative
    if ((Test-Path -LiteralPath $target) -and -not (Test-Path -LiteralPath $saved)) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $saved) | Out-Null
        Copy-Item -LiteralPath $target -Destination $saved
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Force
}
& (Join-Path $Deployment 'scripts\workflows\Prepare-CbmWorkflows.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Preparation failed' }
# The current installation exports retain the user's layout and known credential bindings.
$installed = Get-Content -LiteralPath (Join-Path $RepoRoot 'validation\installed-workflows.json') -Raw | ConvertFrom-Json -Depth 100
$mapping = Get-Content -LiteralPath (Join-Path $RepoRoot 'cbm\imported-workflow-ids.json') -Raw | ConvertFrom-Json -AsHashtable
foreach ($relative in $mapping.Keys) {
    $workflow = @($installed | Where-Object id -eq $mapping[$relative])
    if ($workflow.Count -ne 1) { throw "Expected one saved workflow for $relative" }
    $target = Join-Path $Deployment ('cbm\workflows-configured\' + $relative)
    [IO.File]::WriteAllText($target,($workflow[0] | ConvertTo-Json -Depth 100),(New-Object Text.UTF8Encoding $false))
}
foreach ($name in @('schema_queue.sql','schema_context.sql')) {
    docker cp (Join-Path $RepoRoot "database\dispatch_queue\$name") "n8n_deploy-cbm-postgres-1:/tmp/cbm-dispatch-$name"
    if ($LASTEXITCODE -ne 0) { throw 'SQL copy failed' }
    docker exec n8n_deploy-cbm-postgres-1 psql -X -v ON_ERROR_STOP=1 -U cbm_app -d cbm_demo -f "/tmp/cbm-dispatch-$name"
    if ($LASTEXITCODE -ne 0) { throw "Migration failed: $name" }
}
docker cp (Join-Path $RepoRoot 'validation\installed-workflows.json') 'n8n_v1:/tmp/cbm-dispatch-updated-workflows.json'
if ($LASTEXITCODE -ne 0) { throw 'Workflow copy failed' }
docker exec n8n_v1 n8n import:workflow --input=/tmp/cbm-dispatch-updated-workflows.json
if ($LASTEXITCODE -ne 0) { throw 'Workflow import failed' }
Write-Output 'Dispatch migration and 14 inactive workflow drafts installed. No workflow was published or executed.'
