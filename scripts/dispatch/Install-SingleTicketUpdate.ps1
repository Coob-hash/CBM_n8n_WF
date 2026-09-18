#Requires -Version 7.3
param([string]$Deployment = 'C:\Users\USER\Desktop\n8n_deploy')
$ErrorActionPreference = 'Stop'
# Scripts live in scripts/<group>/; the paths below are relative to the repository root.
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$backup = Join-Path $RepoRoot 'validation-single-ticket\before-deployment-files'
$files = @('scripts\workflows\Apply-CbmCompatibility.ps1','scripts\workflows\Prepare-CbmWorkflows.ps1','README.md','docs\dispatch\READ-ME-SINGLE-TICKET.md','docs\dispatch\READ-ME-DISPATCH.md','docs\wf1\READ-ME-OPENROUTER.md','docs\guides\DEPLOYMENT_STATUS.md',
    'cbm\app\wf1_ticket_intake_and_dispatch.json','cbm\app\phase_b\queries.js','cbm\app\phase_b\test-dispatch.js',
    'cbm\dispatch_queue\patch-workflows.js','database\dispatch_queue\schema_queue.sql','cbm\dispatch_queue\system-message.txt','cbm\dispatch_queue\test-queue.js',
    'cbm\openrouter\patch-workflows.js','cbm\openrouter\validators.js','cbm\openrouter\benchmark.js','cbm\openrouter\test-vision.js')
foreach ($relative in $files) {
    $target = Join-Path $Deployment $relative
    $saved = Join-Path $backup $relative
    if ((Test-Path -LiteralPath $target) -and -not (Test-Path -LiteralPath $saved)) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $saved) | Out-Null
        Copy-Item -LiteralPath $target -Destination $saved
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Copy-Item -LiteralPath (Join-Path $RepoRoot $relative) -Destination $target -Force
}
# Keep a backup of every configured export before preparation regenerates them.
$configuredBackup = Join-Path $backup 'cbm\workflows-configured'
if (-not (Test-Path -LiteralPath $configuredBackup)) {
    Copy-Item -LiteralPath (Join-Path $Deployment 'cbm\workflows-configured') -Destination $configuredBackup -Recurse
}
$mapping = Get-Content -LiteralPath (Join-Path $RepoRoot 'cbm\imported-workflow-ids.json') -Raw | ConvertFrom-Json -AsHashtable
foreach ($relative in $mapping.Keys) {
    $saved = Join-Path $backup ('cbm\app\' + $relative)
    if (-not (Test-Path -LiteralPath $saved)) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $saved) | Out-Null
        Copy-Item -LiteralPath (Join-Path $Deployment ('cbm\app\' + $relative)) -Destination $saved
    }
}
& (Join-Path $Deployment 'scripts\workflows\Prepare-CbmWorkflows.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Preparation failed' }
$installed = Get-Content -LiteralPath (Join-Path $RepoRoot 'validation-single-ticket\installed-workflow.json') -Raw | ConvertFrom-Json -Depth 100
if (@($installed).Count -ne 1 -or $installed[0].id -ne 'YZb99Du8CBtsSy7f' -or $installed[0].active) { throw 'Unexpected import target' }
# The installed export retains the latest source canvas, credentials and original name.
$target = Join-Path $Deployment 'cbm\workflows-configured\wf1_ticket_intake_and_dispatch.json'
[IO.File]::WriteAllText($target,($installed[0] | ConvertTo-Json -Depth 100),(New-Object Text.UTF8Encoding $false))
docker cp (Join-Path $RepoRoot 'database\dispatch_queue\schema_queue.sql') 'n8n_deploy-cbm-postgres-1:/tmp/cbm-single-ticket-schema.sql'
if ($LASTEXITCODE -ne 0) { throw 'SQL copy failed' }
docker exec n8n_deploy-cbm-postgres-1 psql -X -v ON_ERROR_STOP=1 -U cbm_app -d cbm_demo -f /tmp/cbm-single-ticket-schema.sql
if ($LASTEXITCODE -ne 0) { throw 'Migration failed' }
docker cp (Join-Path $RepoRoot 'validation-single-ticket\installed-workflow.json') 'n8n_v1:/tmp/cbm-single-ticket-workflow.json'
if ($LASTEXITCODE -ne 0) { throw 'Workflow copy failed' }
docker exec n8n_v1 n8n import:workflow --input=/tmp/cbm-single-ticket-workflow.json
if ($LASTEXITCODE -ne 0) { throw 'Workflow import failed' }
Write-Output 'Imported only the source WF1 draft. User backup untouched. No workflow published or executed.'
