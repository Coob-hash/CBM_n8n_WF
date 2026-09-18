#Requires -Version 7.3
param([string]$SettingsFile = '')
$ErrorActionPreference = 'Stop'
# Scripts live in scripts/<group>/; the paths below are relative to the repository root.
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-StrictMode -Version Latest
# The saved app exports already contain the reviewed workflow logic and canvas.
# Preparation updates deployment bindings without replaying older structural migrations.
& node (Join-Path $RepoRoot 'cbm\app\wf2\apply-strict-closure.cjs') (Join-Path $RepoRoot 'cbm\app\n8n_wf2_completion_approval_ifc_update.json') (Join-Path $RepoRoot 'cbm\app\wf2\workflows\log_ifc_maintenance.json') (Join-Path $RepoRoot 'cbm\app\wf2\workflows\notify_fm.json')
if ($LASTEXITCODE -ne 0) { throw 'WF2 strict closure overlay failed.' }
& node (Join-Path $RepoRoot 'cbm\app\technician_portal\apply.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Technician portal link overlay failed.' }
& node (Join-Path $RepoRoot 'cbm\patch-credential-bindings.js')
if ($LASTEXITCODE -ne 0) { throw 'Credential binding overlay failed.' }
if (-not $SettingsFile) { $SettingsFile = Join-Path $RepoRoot 'cbm\demo.local.json' }
if (-not (Test-Path -LiteralPath $SettingsFile)) { throw 'Copy cbm\demo.example.json to cbm\demo.local.json and enter your demo FM email and Drive folder IDs.' }
$settings = Get-Content -LiteralPath $SettingsFile -Raw | ConvertFrom-Json
if ($settings.fmEmail -notmatch '^[^\s"<>@]+@[^\s"<>@]+\.[^\s"<>@]+$' -or $settings.fmEmail -match 'REPLACE') { throw 'Enter a controlled real FM email.' }
$itEmail = if ($settings.PSObject.Properties['itEmail']) { [string]$settings.itEmail } else { 'giuseppe.desiderio123@gmail.com' }
if ($itEmail -notmatch '^[^\s"<>@]+@[^\s"<>@]+\.[^\s"<>@]+$' -or $itEmail -match 'REPLACE') { throw 'Enter the IT notification email.' }
foreach ($field in @('incomingFolderId','completedFolderId')) {
    if ($settings.$field -notmatch '^[A-Za-z0-9_-]+$' -or $settings.$field -match 'REPLACE') { throw "Enter a real $field." }
}
$domainLine = Get-Content -LiteralPath (Join-Path $RepoRoot '.env') | Where-Object { $_ -match '^\s*NGROK_DOMAIN=' } | Select-Object -First 1
$domain = (($domainLine -split '=',2)[1]).Trim().Trim('"').Trim("'")
if ($domain -notmatch '^[A-Za-z0-9.-]+$') { throw 'NGROK_DOMAIN must contain the hostname without https:// or a path.' }
$app = Join-Path $RepoRoot 'cbm\app'
$out = Join-Path $RepoRoot 'cbm\workflows-configured'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$paths = @('wf1_ticket_intake_and_dispatch.json','n8n_wf2_completion_approval_ifc_update.json','n8n_wf3_fm_dashboard.json','knowledge\sync_workflow.json','knowledge\error_workflow.json','technician_portal\workflow.json')
$paths += Get-ChildItem -LiteralPath (Join-Path $app 'phase_b\workflows') -Filter '*.json' | Sort-Object Name | ForEach-Object { 'phase_b\workflows\' + $_.Name }
$paths += Get-ChildItem -LiteralPath (Join-Path $app 'wf2\workflows') -Filter '*.json' | Sort-Object Name | ForEach-Object { 'wf2\workflows\' + $_.Name }
$newIds = @{}
$replacements = @{}
$installedIds = @{}
$installedMap = Join-Path $RepoRoot 'cbm\imported-workflow-ids.json'
if (Test-Path -LiteralPath $installedMap) {
    $installedIds = Get-Content -LiteralPath $installedMap -Raw | ConvertFrom-Json -AsHashtable
}
$number = 0
foreach ($relative in $paths) {
    $number++
    $newIds[$relative] = if ($installedIds.ContainsKey($relative)) { $installedIds[$relative] } else { 'cbmDispatch20260916' + $number.ToString('00') }
    $original = Get-Content -LiteralPath (Join-Path $app $relative) -Raw | ConvertFrom-Json -Depth 100
    if ($original.PSObject.Properties['id'] -and $original.id) { $replacements[[string]$original.id] = $newIds[$relative] }
}
foreach ($relative in $paths) {
    $text = Get-Content -LiteralPath (Join-Path $app $relative) -Raw
    $text = $text.Replace('REPLACE_N8N_HOST',$domain).Replace('REPLACE_FM_EMAIL@example.com',$settings.fmEmail).Replace('facility.manager@example.com',$settings.fmEmail)
    $text = $text.Replace('replace_n8n_host', $domain)
    $text = $text.Replace('REPLACE_IT_EMAIL@example.com',$itEmail)
    $text = $text.Replace('REPLACE_FOLDER_ID_01_INCOMING_SNAPSHOTS',$settings.incomingFolderId).Replace('REPLACE_COMPLETED_FOLDER_ID',$settings.completedFolderId)
    $text = $text.Replace('http://127.0.0.1:8001/knowledge/snapshot','http://knowledge-service:8001/knowledge/snapshot')
    foreach ($oldId in $replacements.Keys) { $text = $text.Replace($oldId,$replacements[$oldId]) }
    $workflow = $text | ConvertFrom-Json -Depth 100
    $workflow | Add-Member -NotePropertyName id -NotePropertyValue $newIds[$relative] -Force
    $workflow | Add-Member -NotePropertyName active -NotePropertyValue $false -Force
    $workflow.name = '[CBM OpenRouter Vision 2026.09.16] ' + $workflow.name
    if (-not $workflow.PSObject.Properties['settings']) { $workflow | Add-Member -NotePropertyName settings -NotePropertyValue ([pscustomobject]@{}) }
    $workflow.settings | Add-Member -NotePropertyName timezone -NotePropertyValue 'Europe/Rome' -Force
    foreach ($property in @('activeVersionId','versionId')) { $workflow.PSObject.Properties.Remove($property) }
    $text = $workflow | ConvertTo-Json -Depth 100
    $destination = Join-Path $out $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    [IO.File]::WriteAllText($destination,$text,(New-Object Text.UTF8Encoding $false))
}
[IO.File]::WriteAllText((Join-Path $out 'workflow-ids.json'),($newIds | ConvertTo-Json),(New-Object Text.UTF8Encoding $false))
Write-Output "Prepared $($paths.Count) inactive workflow templates under $out."
Write-Output 'Existing installation IDs are used when cbm/imported-workflow-ids.json exists; otherwise exports use a separate namespace. Credential references are applied from cbm/app/runtime-bindings.json; check any reported missing bindings before activation. Nothing was imported, published or emailed.'
