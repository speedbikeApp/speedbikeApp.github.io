# Download the latest version from GitHub onto this PC.
# Run:  powershell -ExecutionPolicy Bypass -File tools\download.ps1
# First time on a new PC (needs git + Node.js):
#   git clone https://github.com/speedbikeApp/speedbikeApp.github.io.git "Speed Bike"
#   then run this script once inside it (installs the server packages).
# tasks/ and server/data are never on GitHub, so copy them by hand if that PC needs them.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (git status --porcelain -- . ':!tasks') {
  Write-Host 'This PC has changes that are not uploaded:'; git status --short -- . ':!tasks'
  throw 'Run tools\upload.ps1 first (or discard them). Nothing was downloaded.'
}
$lock = (git rev-parse HEAD:server/package-lock.json)
git pull -q --rebase origin main
if ($LASTEXITCODE) { git rebase --abort; throw 'Could not merge with GitHub. Nothing changed.' }
if (-not (Test-Path server/node_modules) -or $lock -ne (git rev-parse HEAD:server/package-lock.json)) {
  Push-Location server; npm ci; $code = $LASTEXITCODE; Pop-Location
  if ($code) { throw 'npm ci failed in server/' }
}
Write-Host "Up to date: $(git log -1 --format='%h %s' | ForEach-Object { $_.Substring(0, [Math]::Min(90, $_.Length)) })"
