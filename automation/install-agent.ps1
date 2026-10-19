# install-agent.ps1 — one-time setup so this PC refreshes the site automatically.
#
#   * clones the three scraper repos into .\vendor\<role>
#   * creates one Python virtualenv per role in .\vendor\venvs\<role>
#   * registers a Windows Scheduled Task that runs every 15 minutes, at logon and
#     at startup, with "start when available" so it catches up whenever the PC
#     comes on (you never have to be online at 7 AM)
#
# Run it once from the portal repo:
#     powershell -ExecutionPolicy Bypass -File .\automation\install-agent.ps1
#
# Re-run it any time to update environments. Add -SkipTask to only install deps.

[CmdletBinding()]
param(
    [string]$PortalDir = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
    [string]$PythonExe = "python",
    [string]$TaskName = "JobHunt India Agent",
    [int]$IntervalMinutes = 15,
    [switch]$SkipTask,
    [switch]$InstallBrowsers
)

$ErrorActionPreference = "Stop"

function Write-Step($message) { Write-Host "`n==> $message" -ForegroundColor Cyan }

$PortalDir = (Resolve-Path $PortalDir).Path
$vendorDir = Join-Path $PortalDir "vendor"
$venvDir = Join-Path $vendorDir "venvs"

if (-not (Test-Path (Join-Path $PortalDir "profiles"))) {
    throw "PortalDir '$PortalDir' does not contain a profiles\ folder. Pass -PortalDir."
}

Write-Step "Preparing folders"
New-Item -ItemType Directory -Force -Path $vendorDir | Out-Null
New-Item -ItemType Directory -Force -Path $venvDir | Out-Null

$roles = Get-ChildItem (Join-Path $PortalDir "profiles") -Filter *.json |
    ForEach-Object { $_.BaseName }

foreach ($role in $roles) {
    $profile = Get-Content (Join-Path $PortalDir "profiles\$role.json") -Raw | ConvertFrom-Json
    $repoDir = Join-Path $vendorDir $role
    $venvPath = Join-Path $venvDir $role
    $venvPython = Join-Path $venvPath "Scripts\python.exe"

    Write-Step "Role '$role'"
    if ($profile.repo -and -not (Test-Path $repoDir)) {
        Write-Host "cloning $($profile.repo) ..."
        git clone --depth 1 "https://github.com/$($profile.repo).git" $repoDir
    } elseif (Test-Path $repoDir) {
        Write-Host "updating $repoDir ..."
        git -C $repoDir pull --ff-only --quiet
    }

    if (-not (Test-Path $venvPython)) {
        Write-Host "creating virtualenv ..."
        & $PythonExe -m venv $venvPath
    }

    $requirements = Join-Path $repoDir "requirements.txt"
    if (Test-Path $requirements) {
        Write-Host "installing $requirements ..."
        & $venvPython -m pip install --quiet --upgrade pip
        & $venvPython -m pip install --quiet -r $requirements
    } else {
        Write-Host "no requirements.txt; installing defaults ..."
        & $venvPython -m pip install --quiet --upgrade pip
        & $venvPython -m pip install --quiet requests beautifulsoup4 lxml urllib3
    }

    if ($profile.playwright -and $InstallBrowsers) {
        Write-Host "installing Chromium for Playwright ..."
        & $venvPython -m playwright install chromium
    }
}

if ($SkipTask) {
    Write-Host "`nDependencies ready. Skipping scheduled task (-SkipTask)." -ForegroundColor Yellow
    exit 0
}

Write-Step "Registering scheduled task '$TaskName'"
$scriptPath = Join-Path $PortalDir "automation\run-agent.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""

$triggers = @(
    (New-ScheduledTaskTrigger -AtStartup),
    (New-ScheduledTaskTrigger -AtLogOn),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes))
)

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 6)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings `
    -Description "Refresh JobHunt India job data from this PC (all sources)." -Force | Out-Null

Write-Host "`nInstalled." -ForegroundColor Green
Write-Host "The task runs every $IntervalMinutes minutes, at logon and at startup."
Write-Host "It only scrapes when the published data is older than a few hours."
Write-Host "Logs: $vendorDir\agent.log"
Write-Host "`nTest it now:  powershell -ExecutionPolicy Bypass -File `"$scriptPath`""
