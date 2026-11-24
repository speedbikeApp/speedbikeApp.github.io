# Upload this PC's work: commit everything (except tasks/), bump the version, merge in what other PCs uploaded, push to GitHub.
# Run:  powershell -ExecutionPolicy Bypass -File tools\upload.ps1 ["what changed"]
# Pushing to main updates the live website within a minute. The game server is NOT redeployed (do that on Render when server/ or js/physics.js changed).
param([string]$Message = "Sync from $env:COMPUTERNAME")
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
function Invoke-Git { git @args; if ($LASTEXITCODE) { throw "git $args failed" } }

$changes = git status --porcelain -- . ':!tasks'
if ($changes) {
  node tools/bump-version.mjs; if ($LASTEXITCODE) { throw 'version bump failed' }
  Invoke-Git add -A -- . ':!tasks'
  Write-Host 'Uploading:'; git diff --cached --stat
  Invoke-Git -c user.name=speedbikeApp -c user.email=noreply.speedbike@gmail.com commit -q -m "$Message`n`nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
}
Invoke-Git fetch -q origin
git pull -q --rebase origin main
if ($LASTEXITCODE) { git rebase --abort; throw 'Another PC changed the same lines. Nothing was pushed; your commit is kept locally. Resolve by hand.' }
if (-not (git log --oneline origin/main..HEAD)) { Write-Host 'Nothing to upload: GitHub already has everything.'; exit 0 }
Invoke-Git push -q origin main
Write-Host "Uploaded $(git log -1 --format=%h). Website updates in about a minute; the server was not redeployed."
