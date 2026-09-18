#Requires -Version 7.3
param()
$ErrorActionPreference = 'Stop'
$workflowPath = Join-Path $PSScriptRoot 'cbm\app\n8n_wf2_completion_approval_ifc_update.json'
$workflow = Get-Content -LiteralPath $workflowPath -Raw | ConvertFrom-Json -Depth 100
$nodes = @($workflow.nodes | Where-Object { $_.name -in @('Extract Report Text','Extract Report Text and Photo') })
if ($nodes.Count -ne 1 -or $nodes[0].type -ne 'n8n-nodes-base.code') { throw 'Unexpected WF2 report-extraction node; review the application copy.' }
$nodes[0].parameters.jsCode = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'cbm\extract-report.js') -Raw
[IO.File]::WriteAllText($workflowPath,($workflow | ConvertTo-Json -Depth 100),(New-Object Text.UTF8Encoding $false))
Write-Output 'Applied Python report extraction to the deployment copy of WF2.'
& node (Join-Path $PSScriptRoot 'cbm\app\wf2\apply-report-submission.cjs') $workflowPath
if ($LASTEXITCODE -ne 0) { throw 'WF2 PDF submission overlay failed.' }
& node (Join-Path $PSScriptRoot 'cbm\app\wf2\apply-strict-closure.cjs') $workflowPath (Join-Path $PSScriptRoot 'cbm\app\wf2\workflows\log_ifc_maintenance.json') (Join-Path $PSScriptRoot 'cbm\app\wf2\workflows\notify_fm.json')
if ($LASTEXITCODE -ne 0) { throw 'WF2 strict closure overlay failed.' }

$wf1Path = Join-Path $PSScriptRoot 'cbm\app\wf1_ticket_intake_and_dispatch.json'
$wf1 = Get-Content -LiteralPath $wf1Path -Raw | ConvertFrom-Json -Depth 100
$patch = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'cbm\case-study\wf1-node-patches.json') -Raw | ConvertFrom-Json -Depth 100
$intake = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'cbm\intake\workflow-patch.json') -Raw | ConvertFrom-Json -Depth 100
foreach ($entry in $patch) {
    # OpenRouter owns this stage now; its overlay is reapplied below.
    if ($entry.name -eq 'Vision Triage (Claude)' -and @($wf1.nodes | Where-Object name -eq 'Observe Room Image').Count -eq 1) { continue }
    $target = @($wf1.nodes | Where-Object name -eq $entry.name)
    if ($target.Count -eq 0 -and $entry.name -in $intake.remove) { continue }
    if ($target.Count -ne 1) { throw "Missing case-study workflow node: $($entry.name)" }
    $target[0].parameters = $entry.parameters
}
[IO.File]::WriteAllText($wf1Path,($wf1 | ConvertTo-Json -Depth 100),(New-Object Text.UTF8Encoding $false))
Write-Output 'Applied the case-study capture and MultiSet request compatibility layer.'

# Apply the intake overlay last, including when an older builder is rerun.
$intake = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'cbm\intake\workflow-patch.json') -Raw | ConvertFrom-Json -Depth 100
$upsert = foreach ($node in $intake.upsert) {
    $existing = @($wf1.nodes | Where-Object name -eq $node.name)
    if ($existing.Count -eq 1) {
        # Rebuilding behavior must preserve the user's canvas and credential bindings.
        foreach ($property in @('id','position','credentials')) {
            if ($existing[0].PSObject.Properties[$property]) {
                $node | Add-Member -NotePropertyName $property -NotePropertyValue $existing[0].$property -Force
            }
        }
    }
    $node
}
$wf1.nodes = @($wf1.nodes | Where-Object { $_.name -notin $intake.remove -and $_.name -notin $intake.upsert.name }) + @($upsert)
$nativeChains = @($wf1.nodes | Where-Object type -eq '@n8n/n8n-nodes-langchain.chainLlm' | ForEach-Object name)
$nativeLinks = @{}
foreach ($connection in $wf1.connections.PSObject.Properties) {
    foreach ($channel in $connection.Value.PSObject.Properties) {
        if ($channel.Name -in @('ai_languageModel','ai_outputParser')) {
            $targets = @($channel.Value | ForEach-Object { $_ | Where-Object { $_.node -in $nativeChains } })
            if ($targets.Count -gt 0) { $nativeLinks[$connection.Name] = $connection.Value }
        }
    }
}
$wf1.connections = $intake.connections
foreach ($name in $nativeLinks.Keys) {
    $wf1.connections | Add-Member -NotePropertyName $name -NotePropertyValue $nativeLinks[$name] -Force
}
$wf1.settings = $intake.settings
[IO.File]::WriteAllText($wf1Path,($wf1 | ConvertTo-Json -Depth 100),(New-Object Text.UTF8Encoding $false))
Write-Output 'Applied persistent capture retries, IT escalation, automatic target selection and mandatory FM authorization before dispatch.'

# Preserve single-ticket dispatch when preparation or an older builder is rerun.
& node (Join-Path $PSScriptRoot 'cbm\dispatch_queue\patch-workflows.js')
if ($LASTEXITCODE -ne 0) { throw 'Single-ticket dispatch overlay failed.' }
& node (Join-Path $PSScriptRoot 'cbm\openrouter\patch-workflows.js')
if ($LASTEXITCODE -ne 0) { throw 'OpenRouter vision overlay failed.' }

# Reapply credential references after all structural overlays.
& node (Join-Path $PSScriptRoot 'cbm\patch-credential-bindings.js')
if ($LASTEXITCODE -ne 0) { throw 'Credential binding overlay failed.' }
& node (Join-Path $PSScriptRoot 'cbm\app\technician_portal\apply.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Technician portal link overlay failed.' }
