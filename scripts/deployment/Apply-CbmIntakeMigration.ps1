#Requires -Version 7.3
param()
$ErrorActionPreference = 'Stop'
# Scripts live in scripts/<group>/; the paths below are relative to the repository root.
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-StrictMode -Version Latest
Push-Location $RepoRoot
try {
    # Init-directory SQL only runs on an EMPTY volume. Existing databases need this explicit migration.
    & '.\scripts\deployment\Cbm-Compose.ps1' exec -T cbm-postgres pg_isready -U cbm_app -d cbm_demo
    if ($LASTEXITCODE -ne 0) { throw 'The existing CBM PostgreSQL database is not ready.' }
    $backup = Join-Path $RepoRoot ('backups\intake-database-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $backup | Out-Null
    # pg_dump plain SQL is UTF-8 text. Preserve the output before applying changes.
    $dump = & '.\scripts\deployment\Cbm-Compose.ps1' exec -T cbm-postgres pg_dump -U cbm_app -d cbm_demo --no-owner --no-privileges
    if ($LASTEXITCODE -ne 0 -or -not $dump) { throw 'Database backup failed. Migration was not applied.' }
    [IO.File]::WriteAllText((Join-Path $backup 'cbm_demo.sql'),($dump -join "`n")+"`n",(New-Object Text.UTF8Encoding $false))
    # Read the mounted files directly. PowerShell script wrappers do not automatically
    # forward piped SQL to a native process's stdin.
    foreach ($sql in @('/docker-entrypoint-initdb.d/02-dispatch.sql','/docker-entrypoint-initdb.d/07-intake.sql','/docker-entrypoint-initdb.d/08-dispatch-queue.sql','/docker-entrypoint-initdb.d/09-dispatch-context.sql','/docker-entrypoint-initdb.d/10-wf2-strict-closure.sql','/docker-entrypoint-initdb.d/11-technician-portal.sql')) {
        & '.\scripts\deployment\Cbm-Compose.ps1' exec -T cbm-postgres psql -X -U cbm_app -d cbm_demo -v ON_ERROR_STOP=1 -f $sql
        if ($LASTEXITCODE -ne 0) { throw "Migration failed: $sql. Inspect the error; backup: $backup" }
    }
    # Also works before an existing container has been recreated with the new init mount.
    & '.\scripts\deployment\Cbm-Compose.ps1' cp '.\database\intake\schema_configuration_pause.sql' 'cbm-postgres:/tmp/cbm-configuration-pause.sql'
    if ($LASTEXITCODE -ne 0) { throw 'Could not stage the configuration-pause migration.' }
    & '.\scripts\deployment\Cbm-Compose.ps1' exec -T cbm-postgres psql -X -U cbm_app -d cbm_demo -v ON_ERROR_STOP=1 -f /tmp/cbm-configuration-pause.sql
    if ($LASTEXITCODE -ne 0) { throw "Configuration-pause migration failed; backup: $backup" }
    Write-Output "Applied intake migration to the existing persistent database. Backup: $backup"
} finally { Pop-Location }
