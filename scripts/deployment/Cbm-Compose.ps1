#Requires -Version 7.3
# Preserve Docker flags verbatim; a named parameter would capture abbreviations like -d.
$composeArguments = @($args)
$ErrorActionPreference = 'Stop'
# Scripts live in scripts/<group>/; the paths below are relative to the repository root.
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Push-Location $RepoRoot
try {
    if (-not (Test-Path -LiteralPath 'cbm\cbm.env')) { throw 'Run .\scripts\deployment\Initialize-Cbm.ps1 first.' }
    & docker compose --project-name n8n_deploy --env-file .env --env-file cbm/cbm.env -f docker-compose.yml @composeArguments
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose failed (exit $LASTEXITCODE)." }
} finally { Pop-Location }
