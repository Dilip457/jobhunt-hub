# run-agent.ps1 — invoked by Windows Task Scheduler (and manually).
# Refreshes the published job data from this PC when it is stale.

$ErrorActionPreference = "Continue"

$portal = Split-Path -Parent $PSScriptRoot
$vendor = Join-Path $portal "vendor"
New-Item -ItemType Directory -Force -Path $vendor | Out-Null
$log = Join-Path $vendor "agent.log"

$python = $null
foreach ($candidate in @("python", "py")) {
    $found = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($found) { $python = $found.Source; break }
}
if (-not $python) {
    "[$(Get-Date -Format s)] python not found on PATH; cannot run agent" | Out-File -Append -Encoding utf8 $log
    exit 1
}

"[$(Get-Date -Format s)] starting agent" | Out-File -Append -Encoding utf8 $log
Push-Location $portal
try {
    & $python (Join-Path $PSScriptRoot "agent.py") --portal-dir $portal *>> $log
}
finally {
    Pop-Location
}
