#Requires -Version 7.3
# Preserve Docker flags verbatim; a named parameter would capture abbreviations like -d.
$composeArguments = @($args)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    if (-not (Test-Path -LiteralPath 'cbm\cbm.env')) { throw 'Run .\Initialize-Cbm.ps1 first.' }
    & docker compose --project-name n8n_deploy --env-file .env --env-file cbm/cbm.env -f docker-compose.yml @composeArguments
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose failed (exit $LASTEXITCODE)." }
} finally { Pop-Location }
