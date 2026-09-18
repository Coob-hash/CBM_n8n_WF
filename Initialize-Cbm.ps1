#Requires -Version 7.3
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$baseEnv = Join-Path $PSScriptRoot '.env'
if (-not (Test-Path -LiteralPath $baseEnv)) { throw 'Keep the original n8n_deploy .env beside this script; do not generate a new encryption key.' }
$baseText = Get-Content -LiteralPath $baseEnv -Raw
foreach ($key in @('N8N_ENCRYPTION_KEY','NGROK_DOMAIN','NGROK_AUTHTOKEN')) {
    if ($baseText -notmatch "(?m)^\s*$key\s*=\s*\S+") { throw "Original .env is missing $key." }
}
$privatePath = Join-Path $PSScriptRoot 'cbm\cbm.env'
if (Test-Path -LiteralPath $privatePath) {
    $privateText = Get-Content -LiteralPath $privatePath -Raw
    foreach ($key in @('CBM_RUNNERS_AUTH_TOKEN','CBM_POSTGRES_PASSWORD','CBM_KNOWLEDGE_KEY')) {
        if ($privateText -notmatch "(?m)^$key=[a-f0-9]{64}\s*$") { throw "Existing cbm.env has an invalid $key; inspect it without replacing persisted passwords blindly." }
    }
    Write-Output 'Existing CBM secrets preserved.'
    return
}
function New-RandomHex {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-','').ToLowerInvariant()
}
$lines = @(
    'CBM_RUNNERS_AUTH_TOKEN=' + (New-RandomHex)
    'CBM_POSTGRES_PASSWORD=' + (New-RandomHex)
    'CBM_KNOWLEDGE_KEY=' + (New-RandomHex)
    'MULTISET_MAP_CODE=MAP_J964JX6MGEGO'
    'AXIS_MODE=identity'
    'MULTISET_TO_IFC_MATRIX=null'
)
[IO.File]::WriteAllText($privatePath, ($lines -join "`n") + "`n", (New-Object Text.UTF8Encoding $false))
Write-Output 'Created private cbm\cbm.env. The original n8n/ngrok .env was preserved.'
