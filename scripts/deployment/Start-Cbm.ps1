#Requires -Version 7.3
param([string]$VerifiedRollbackImage = '')
$ErrorActionPreference = 'Stop'
# Scripts live in scripts/<group>/; the paths below are relative to the repository root.
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-StrictMode -Version Latest
Push-Location $RepoRoot
try {
    & '.\scripts\deployment\Initialize-Cbm.ps1'
    & '.\scripts\deployment\Cbm-Compose.ps1' config --quiet
    $containerId = [string](& docker ps -aq --filter 'name=^/n8n_v1$')
    if ($LASTEXITCODE -ne 0 -or -not $containerId) { throw 'Expected existing n8n_v1 was not found; inspect the deployment before starting.' }
    $mountJson = & docker inspect n8n_v1 --format '{{json .Mounts}}'
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect existing n8n mounts.' }
    $mount = @($mountJson | ConvertFrom-Json) | Where-Object Destination -eq '/home/node/.n8n'
    $source = [IO.Path]::GetFullPath('C:\Users\USER\Desktop\n8n_test')
    if (-not $mount -or ([IO.Path]::GetFullPath($mount.Source)) -ne $source) { throw 'The running n8n storage differs from the inspected baseline. Stop and reconcile the paths.' }
    $oldImage = (& docker inspect n8n_v1 --format '{{.Image}}').Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not capture the existing image.' }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = Join-Path $RepoRoot ('backups\before-start-' + $stamp)
    New-Item -ItemType Directory -Path $backup | Out-Null
    $rollbackTag = 'cbm-n8n-rollback:' + $stamp
    # Retain the image before a same-tag rebuild can replace its manifest reference.
    $rollbackSource = if ($VerifiedRollbackImage) { $VerifiedRollbackImage } else { $oldImage }
    & docker image tag $rollbackSource $rollbackTag
    if ($LASTEXITCODE -ne 0) { throw 'Could not retain the old image.' }
    # Build before stopping anything. Dependency failures leave the current n8n running.
    & '.\scripts\deployment\Cbm-Compose.ps1' build n8n task-runners ifc-init unlimited-ocr-adapter
    Copy-Item -LiteralPath '.env' -Destination (Join-Path $backup '.env')
    Copy-Item -LiteralPath 'cbm\cbm.env' -Destination (Join-Path $backup 'cbm.env')
    Copy-Item -LiteralPath 'docker-compose.yml' -Destination (Join-Path $backup 'docker-compose.yml')
    [pscustomobject]@{source=$source;rollbackImage=$rollbackTag;imageId=$oldImage;rollbackSource=$rollbackSource;createdAt=[DateTime]::UtcNow.ToString('o')} |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backup 'backup.json') -Encoding utf8
    Write-Output 'Stopping n8n briefly for a consistent SQLite and file-storage backup.'
    & docker stop --timeout 60 n8n_v1
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop n8n for its backup.' }
    try {
        Copy-Item -LiteralPath $source -Destination (Join-Path $backup 'n8n-data') -Recurse
    } catch {
        & docker start n8n_v1 | Out-Null
        throw
    }
    Write-Output "Consistent n8n backup: $backup"
    & '.\scripts\deployment\Cbm-Compose.ps1' up -d
    for ($attempt=0; $attempt -lt 20; $attempt++) {
        & '.\scripts\deployment\Cbm-Compose.ps1' exec -T cbm-postgres pg_isready -U cbm_app -d cbm_demo | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Seconds 2
    }
    & '.\scripts\deployment\Apply-CbmIntakeMigration.ps1'
    & '.\scripts\deployment\Cbm-Compose.ps1' ps -a
    Write-Output 'The extension is started. Existing published workflows resume; the CBM templates are not imported or activated by this script.'
    Write-Output 'Run .\scripts\deployment\Test-Cbm.ps1, then follow the tutorial credential and import steps.'
} finally { Pop-Location }
