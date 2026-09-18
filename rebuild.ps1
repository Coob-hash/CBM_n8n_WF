param([string]$Python = '', [switch]$BuildOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Push-Location $PSScriptRoot
try {
    if (-not $Python) {
        $localPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
        if (Test-Path -LiteralPath $localPython) { $Python = $localPython }
        else { $Python = (Get-Command python -ErrorAction Stop).Source }
    }
    $logDirectory = Join-Path $PSScriptRoot 'output\validation'
    New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
    $results = [System.Collections.Generic.List[object]]::new()
    function Run-Check([string]$Name, [string]$Exe, [string[]]$Arguments, [bool]$IsTest=$false) {
        $lines = & $Exe @Arguments 2>&1
        $code = $LASTEXITCODE
        $text = ($lines | ForEach-Object { "$_" }) -join "`n"
        $text | Set-Content -LiteralPath (Join-Path $logDirectory ($Name + '.log')) -Encoding utf8
        $count = [regex]::Matches($text, '(?m)^\s*PASS(?:\s|$)').Count
        $unit = [regex]::Match($text, 'Ran (\d+) tests?')
        if ($unit.Success) { $count += [int]$unit.Groups[1].Value }
        $results.Add([pscustomobject]@{suite=$Name;exitCode=$code;passedChecks=$count;test=$IsTest;log=('output/validation/'+$Name+'.log')})
        if ($code -ne 0) { Write-Output $text; throw "$Name failed (exit $code)" }
        Write-Output "$Name passed $(if ($IsTest) { '(' + $count + ' checks)' })"
    }
    # WF1 is the reviewed source export after the direct Phase-A and intake
    # refactor. Refresh only its deterministic document-ingestion overlay;
    # the pre-refactor Phase-B generator remains a historical migration tool.
    Run-Check 'refresh-wf1-demo-overlay' 'node' @('demo_ingestion/build.js')
    Run-Check 'build-wf2' $Python @('wf2/build_wf2.py')
    Run-Check 'build-wf3' $Python @('wf3/build_wf3.py')
    if ($BuildOnly) { return }
    Run-Check 'setup-pglite' 'node' @('phase_b/setup-test-runtime.js')
    Run-Check 'setup-pgvector' 'node' @('knowledge/setup-test-runtime.js')
    Run-Check 'dispatch' 'node' @('phase_b/test-dispatch.js') $true
    Run-Check 'demo-ingestion' 'node' @('demo_ingestion/test.js') $true
    Run-Check 'knowledge' 'node' @('knowledge/test_knowledge.js') $true
    Run-Check 'database-design' 'node' @('database/tests/test_database.js') $true
    Run-Check 'database-migrate' $Python @('database/tests/test_migrate.py') $true
    Run-Check 'knowledge-extract' $Python @('-m','unittest','knowledge.test_extract') $true
    Run-Check 'wf2-structure' $Python @('wf2/validate_wf2.py') $true
    Run-Check 'wf2-nodes' 'node' @('wf2/test_wf2_nodes.mjs') $true
    Run-Check 'wf2-migration' 'node' @('wf2/test_migration.mjs') $true
    Run-Check 'wf3-structure' $Python @('wf3/validate_wf3.py') $true
    Run-Check 'wf3-nodes' 'node' @('wf3/test_wf3_nodes.mjs') $true
    Run-Check 'wf3-queries' 'node' @('wf3/test_wf3_queries.mjs') $true
    Run-Check 'services' $Python @('tests/test_services.py') $true
    Run-Check 'http-smoke' $Python @('tests/smoke_http.py') $true
    Run-Check 'reproducible' $Python @('tests/check_reproducible.py') $true
    $total = ($results | Where-Object test | Measure-Object -Property passedChecks -Sum).Sum
    $validationDirectory=Join-Path $PSScriptRoot 'validation'
    New-Item -ItemType Directory -Force -Path $validationDirectory | Out-Null
    [pscustomobject]@{release='2026.09.14';generatedAt=[DateTime]::UtcNow.ToString('o');passedChecks=$total;allPassed=$true;suites=$results;liveN8nTested=$false;liveExternalProvidersTested=$false} |
        ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $validationDirectory 'release-validation.json') -Encoding utf8
    Write-Output "Release validation passed: $total checks."
} finally { Pop-Location }
