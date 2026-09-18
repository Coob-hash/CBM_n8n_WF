#Requires -Version 7.3
param([string]$DeploymentDirectory = 'C:\Users\USER\Desktop\n8n_deploy')
$ErrorActionPreference = 'Stop'
# Scripts live in scripts/<group>/; the paths below are relative to the repository root.
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-StrictMode -Version Latest
$target = [IO.Path]::GetFullPath($DeploymentDirectory).TrimEnd('\')
$expected = [IO.Path]::GetFullPath('C:\Users\USER\Desktop\n8n_deploy').TrimEnd('\')
if ($target -ne $expected) { throw 'This extension is configured for the inspected n8n_deploy folder and its n8n_test data mount.' }
if ([IO.Path]::GetFullPath($RepoRoot).TrimEnd('\') -eq $target) { throw 'Run the installer from the separate extension package, not from the destination.' }
foreach ($name in @('.env','docker-compose.yml','Dockerfile')) {
    if (-not (Test-Path -LiteralPath (Join-Path $target $name))) { throw "Missing baseline file: $name" }
}
$envPath = Join-Path $target '.env'
$envHash = (Get-FileHash -LiteralPath $envPath).Hash
$backup = Join-Path $target ('backups\config-before-intake-approval-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup | Out-Null
foreach ($name in @('.env','docker-compose.yml','Dockerfile')) { Copy-Item -LiteralPath (Join-Path $target $name) -Destination (Join-Path $backup $name) }
foreach ($file in (Get-ChildItem -LiteralPath $target -File)) {
    if ($file.Name -notin @('.env','docker-compose.yml','Dockerfile')) { Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $backup $file.Name) }
}
if (Test-Path -LiteralPath (Join-Path $target 'cbm')) {
    Copy-Item -LiteralPath (Join-Path $target 'cbm') -Destination (Join-Path $backup 'cbm') -Recurse
}
$rootFiles = @('Dockerfile','docker-compose.yml','.dockerignore','.gitignore','scripts\deployment\Initialize-Cbm.ps1','scripts\deployment\Cbm-Compose.ps1','scripts\deployment\Start-Cbm.ps1','scripts\deployment\Test-Cbm.ps1','scripts\workflows\Prepare-CbmWorkflows.ps1','scripts\workflows\Apply-CbmCompatibility.ps1','scripts\demo\Set-CbmDemoTechnicians.ps1','README.md','docs\guides\CBM_Demo_Tutorial.md')
$rootFiles += @('scripts\demo\Prepare-CaseStudyPhotos.ps1','docs\guides\CASE_STUDY_GUIDE.md','docs\guides\INTAKE_APPROVAL_GUIDE.md','scripts\deployment\Apply-CbmIntakeMigration.ps1')
foreach ($name in $rootFiles) {
    $from = Join-Path $RepoRoot $name
    if (-not (Test-Path -LiteralPath $from)) { throw "Incomplete extension package: $name" }
}
foreach ($name in $rootFiles) {
    $destination = Join-Path $target $name
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath (Join-Path $RepoRoot $name) -Destination $destination -Force
}
# docker-compose.yml mounts the init SQL from database/.
foreach ($file in (Get-ChildItem -LiteralPath (Join-Path $RepoRoot 'database') -Filter '*.sql' -File -Recurse)) {
    $destination = Join-Path $target ([IO.Path]::GetRelativePath($RepoRoot,$file.FullName))
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
}
$cbmSource = Join-Path $RepoRoot 'cbm'
foreach ($file in (Get-ChildItem -LiteralPath $cbmSource -File -Recurse -Force)) {
    $relative = [IO.Path]::GetRelativePath($cbmSource,$file.FullName)
    if ($relative -eq 'cbm.env' -or $relative -match '^workflows-configured[\\/]' -or $relative -match '^validation[\\/]' -or $relative -match '^demo\.(local|validation)\.json$') { continue }
    if ($relative -match '(^|[\\/])(__pycache__|\.test-runtime)[\\/]' -or $relative -match '^tests[\\/](execution-audit|prepared-exports|intake-)' -or $relative -eq 'tests\all-workflows.json') { continue }
    if ($relative -match '^case-study[\\/]upload-ready[\\/]') { continue }
    $destination = Join-Path (Join-Path $target 'cbm') $relative
    if ($relative -eq 'case-study\registration.json' -and (Test-Path -LiteralPath $destination)) { continue }
    if (($relative -match '^catalog[\\/]' -or $relative -match '^technical_sheets[\\/]') -and (Test-Path -LiteralPath $destination)) { continue }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
}
if ((Get-FileHash -LiteralPath $envPath).Hash -ne $envHash) { throw 'The original .env changed unexpectedly.' }
& (Join-Path $target 'scripts\deployment\Initialize-Cbm.ps1')
$privatePath = Join-Path $target 'cbm\cbm.env'
$private = Get-Content -LiteralPath $privatePath -Raw
if ($private -match '(?m)^MULTISET_MAP_CODE=') {
    $private = [regex]::Replace($private,'(?m)^MULTISET_MAP_CODE=[^\r\n]*','MULTISET_MAP_CODE=MAP_J964JX6MGEGO')
} else { $private += "`nMULTISET_MAP_CODE=MAP_J964JX6MGEGO`n" }
[IO.File]::WriteAllText($privatePath,$private,(New-Object Text.UTF8Encoding $false))
& (Join-Path $target 'scripts\workflows\Apply-CbmCompatibility.ps1')
Write-Output "Installed extension files. Original configuration backup: $backup"
Write-Output 'The existing .env and n8n_test data were preserved. Start-Cbm.ps1 performs the backed-up container update.'
