#Requires -Version 7.3
param()
$ErrorActionPreference = 'Stop'
# Scripts live in scripts/<group>/; the paths below are relative to the repository root.
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Push-Location $RepoRoot
try {
    $ready = $false
    for ($attempt=0; $attempt -lt 30; $attempt++) {
        try { $null = Invoke-RestMethod -Uri 'http://127.0.0.1:5678/healthz/readiness' -TimeoutSec 3; $ready=$true; break }
        catch { Start-Sleep -Seconds 2 }
    }
    if (-not $ready) { throw 'n8n did not become ready. Inspect Cbm-Compose.ps1 logs --tail 50 n8n.' }
    & '.\scripts\deployment\Cbm-Compose.ps1' ps -a
    & '.\scripts\deployment\Cbm-Compose.ps1' exec -T n8n n8n --version
    & '.\scripts\deployment\Cbm-Compose.ps1' exec -T task-runners /usr/local/bin/node -e 'const p=require("/opt/runners/task-runner-javascript/node_modules/pdf-parse/package.json"); if(p.version!=="2.4.5")throw new Error("Unexpected legacy compatibility package"); console.log("Existing pdf-parse "+p.version+" compatibility retained; CBM uses Python pypdf");'
    & '.\scripts\deployment\Cbm-Compose.ps1' exec -T ifc-service python -c 'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8000/health",timeout=10).read().decode())'
    & '.\scripts\deployment\Cbm-Compose.ps1' exec -T knowledge-service python -c 'import os,json,urllib.request; r=urllib.request.Request("http://127.0.0.1:8001/knowledge/snapshot",headers={"X-CBM-Knowledge-Key":os.environ["CBM_KNOWLEDGE_KEY"]}); s=json.load(urllib.request.urlopen(r,timeout=10)); print("Knowledge snapshot OK; chunks:",len(s["chunks"]))'
    & '.\scripts\deployment\Cbm-Compose.ps1' exec -T n8n node -e 'fetch("http://ifc-service:8000/health").then(r=>{if(!r.ok)throw new Error("IFC HTTP "+r.status);return r.json()}).then(j=>console.log("n8n-to-IFC network OK: "+j.active_model)).catch(e=>{console.error(e.message);process.exit(1)});'
    & '.\scripts\deployment\Cbm-Compose.ps1' exec -T n8n node -e 'fetch("http://unlimited-ocr-adapter:8002/health").then(r=>{if(!r.ok)throw new Error("OCR adapter HTTP "+r.status);return r.json()}).then(j=>{if(!j.model_ready)throw new Error("Unlimited OCR model is not ready");console.log("n8n-to-Unlimited-OCR network OK: "+j.model)}).catch(e=>{console.error(e.message);process.exit(1)});'
    & '.\scripts\deployment\Cbm-Compose.ps1' exec -T ifc-service python -c 'import json,urllib.request; s=json.load(urllib.request.urlopen("http://127.0.0.1:8000/case-study/status")); a=json.load(urllib.request.urlopen("http://127.0.0.1:8000/elements")); assert s["map_code"]=="MAP_J964JX6MGEGO"; assert a["count"]==13; assert any(e["global_id"]=="3kcZF9AH16IwPfuL_CGFlR" and e["ifc_class"]=="IfcBuildingElementProxy" for e in a["elements"]); print("Office IFC verified: 13 maintainable assets; registration verified:",s["registration_verified"]);'
    & '.\scripts\deployment\Cbm-Compose.ps1' exec -T cbm-postgres psql -U cbm_app -d cbm_demo -v ON_ERROR_STOP=1 -c 'SELECT current_database(), to_regclass(''public.tickets'') AS tickets, to_regclass(''public.ticket_events'') AS events;'
    & '.\scripts\deployment\Cbm-Compose.ps1' exec -T cbm-postgres psql -X -U cbm_app -d cbm_demo -v ON_ERROR_STOP=1 -c 'DO $check$ BEGIN IF to_regclass(''public.cbm_intake_reports'') IS NULL OR to_regclass(''public.cbm_it_issues'') IS NULL OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname=''cbm_dispatch_authorization_guard'' AND tgenabled=''O'') THEN RAISE EXCEPTION ''Run Apply-CbmIntakeMigration.ps1''; END IF; END $check$;'
    Write-Output 'Infrastructure and intake migration checks passed. Run the supplied n8n Runtime Check workflow to verify Code-node execution through the runner.'
} finally { Pop-Location }
