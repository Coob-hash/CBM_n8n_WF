#Requires -Version 7.3
param([Parameter(Mandatory=$true)][string]$Email1, [string]$Email2 = '')
$ErrorActionPreference = 'Stop'
# Scripts live in scripts/<group>/; the paths below are relative to the repository root.
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$emails = @(@($Email1,$Email2) | Where-Object { $_ } | ForEach-Object { $_.Trim().ToLowerInvariant() } | Select-Object -Unique)
foreach ($email in $emails) {
    $address = [System.Net.Mail.MailAddress]::new($email)
    if ($address.Address -cne $email -or $email -match '@example\.(com|org|net)$') { throw 'Supply real, controlled demo mailbox addresses.' }
}
$values = for ($index=0; $index -lt $emails.Count; $index++) {
    $safeEmail = $emails[$index].Replace("'","''")
    "('Demo Technician $($index+1)','$safeEmail',ARRAY['plumbing','hvac','electrical','carpentry','general'],'building-A',4.5,true)"
}
$emailList = ($emails | ForEach-Object { "'"+$_.Replace("'","''")+"'" }) -join ','
$sql = @"
INSERT INTO technicians (full_name,email,skills,zone,rating,active)
VALUES $($values -join ',')
ON CONFLICT (email) DO UPDATE SET full_name=EXCLUDED.full_name, skills=EXCLUDED.skills,
zone=EXCLUDED.zone,rating=EXCLUDED.rating,active=true;
SELECT id, full_name, active FROM technicians WHERE email IN ($emailList);
"@
Push-Location $RepoRoot
try {
    $sql | & docker compose --project-name n8n_deploy --env-file .env --env-file cbm/cbm.env -f docker-compose.yml exec -T cbm-postgres psql -U cbm_app -d cbm_demo -v ON_ERROR_STOP=1
    if ($LASTEXITCODE -ne 0) { throw 'Could not configure demo technicians.' }
    Write-Output "Configured $($emails.Count) distinct technician identity/identities. Repeating the same email uses one identity."
} finally { Pop-Location }
