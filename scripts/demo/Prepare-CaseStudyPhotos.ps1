#Requires -Version 7.3
param([Parameter(Mandatory=$true)][string]$ReporterEmail,[string]$Photo = '',[string]$ReportId = '')
$ErrorActionPreference = 'Stop'
# Scripts live in scripts/<group>/; the paths below are relative to the repository root.
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$address=[System.Net.Mail.MailAddress]::new($ReporterEmail)
if ($address.Address -cne $ReporterEmail -or $ReporterEmail -match '[_<>"\s]' -or $ReporterEmail -match '@example\.(com|org|net)$') {
    throw 'Use a controlled real address without underscores; WF1 uses underscores as filename separators.'
}
$case=Join-Path $RepoRoot 'cbm\case-study'
$profile=Get-Content -LiteralPath (Join-Path $case 'profile.json') -Raw | ConvertFrom-Json
$manifest=Get-Content -LiteralPath (Join-Path $case 'query-verified\queries.json') -Raw | ConvertFrom-Json -Depth 30
if ($ReportId) {
    $parsedReportId = [guid]::Empty
    if (-not [guid]::TryParseExact($ReportId,'D',[ref]$parsedReportId)) { throw 'ReportId must be the report UUID from the retry message.' }
    if (-not $Photo) { throw 'For a retry, select one different original with -Photo IMG_7915.JPG.' }
}
$captures = @($manifest.captures | Where-Object { -not $Photo -or $_.file -ieq $Photo })
if (-not $captures) { throw 'Photo must match one of the eleven audited original filenames.' }
$out=Join-Path $case 'upload-ready'
New-Item -ItemType Directory -Force -Path $out | Out-Null
foreach ($capture in $captures) {
    $source=Join-Path $profile.original_photo_directory $capture.file
    if ((Get-FileHash -LiteralPath $source).Hash.ToLowerInvariant() -ne $capture.original_sha256) { throw "Source photograph changed: $($capture.file)" }
    $captureReportId = if ($ReportId) { $parsedReportId.ToString('D') } else { [guid]::NewGuid().ToString('D') }
    $reportFolder = Join-Path $out $captureReportId
    New-Item -ItemType Directory -Force -Path $reportFolder | Out-Null
    $name='report_' + $ReporterEmail + '_' + $captureReportId + '_' + [IO.Path]::GetFileNameWithoutExtension($capture.file) + '.jpg'
    Copy-Item -LiteralPath $source -Destination (Join-Path $reportFolder $name) -Force
    Write-Output "Report $captureReportId : $name"
}
Write-Output "Prepared $($captures.Count) original, EXIF-preserving photos in $out"
Write-Output 'Keep the SAME ReportId for the initial photo and all three replacements. Each Drive upload must be a new file.'
Write-Output 'Upload ONE chosen photo to the watched Drive folder after publishing the configured WF1. The script uploads nothing.'
