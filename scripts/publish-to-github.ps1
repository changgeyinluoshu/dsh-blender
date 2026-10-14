<#
.SYNOPSIS
  Commit and push this repository to GitHub.

.DESCRIPTION
  - Commits pending changes (skip with -SkipCommit).
  - Points origin at the target repository (default https://github.com/changgeyinluoshu/dsh-blender.git).
  - Pushes the current branch. With -Token the credential is used for this push only and is never stored
    in the repository configuration.
  - Retries with the OpenSSL TLS backend when Schannel cannot acquire credentials, which happens in
    some restricted or sandboxed Windows environments (error SEC_E_NO_CREDENTIALS).

.EXAMPLE
  ./scripts/publish-to-github.ps1
.EXAMPLE
  ./scripts/publish-to-github.ps1 -Token ghp_xxxxxxxxxxxx
.EXAMPLE
  ./scripts/publish-to-github.ps1 -Remote https://github.com/me/other-repo.git -Branch main
#>
[CmdletBinding()]
param(
  [string]$Owner = 'changgeyinluoshu',
  [string]$Repo = 'dsh-blender',
  [string]$Remote = '',
  [string]$Token = '',
  [string]$Message = '',
  [string]$Branch = 'main',
  [switch]$SkipCommit,
  [switch]$ForcePush
)

$ErrorActionPreference = 'Stop'

# 脚本位于 scripts/ 下，仓库根是它的上一级。
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not (Test-Path -LiteralPath (Join-Path $Root 'package.json'))) { $Root = (Get-Location).Path }
Set-Location -LiteralPath $Root

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is required.' }
if (-not (Test-Path -LiteralPath '.git')) { git init -b $Branch | Out-Null }
if (-not $Remote) { $Remote = "https://github.com/$Owner/$Repo.git" }

Write-Host ''
Write-Host 'dsh-blender-studio -> GitHub' -ForegroundColor White
Write-Host "  repository : $Remote"

# --- 1. commit -------------------------------------------------------------
if (-not $SkipCommit) {
  git add -A
  if (git status --porcelain) {
    if (-not $Message) { $Message = 'Update ' + (Get-Date -Format 'yyyy-MM-dd HH:mm') }
    git -c user.name='dsh-blender-studio' -c user.email='noreply@example.com' commit -m $Message | Out-Null
    Write-Host '  [OK] committed pending changes' -ForegroundColor Green
  } else {
    Write-Host '  [i] nothing to commit' -ForegroundColor Yellow
  }
}

# --- 2. remote -------------------------------------------------------------
$plain = $Remote
if ((git remote) -contains 'origin') { git remote set-url origin $plain } else { git remote add origin $plain }
Write-Host "  [OK] remote origin -> $plain" -ForegroundColor Green

# --- 3. push ---------------------------------------------------------------
function Invoke-GitPush([string]$url, [string]$sslBackend) {
  $gitArgs = @()
  if ($sslBackend) { $gitArgs += @('-c', "http.sslBackend=$sslBackend") }
  $gitArgs += @('push', $url, ($Branch + ':' + $Branch))
  if ($ForcePush) { $gitArgs += '--force' }
  & git @gitArgs 2>&1 | ForEach-Object { Write-Host ('    ' + $_) }
  return $LASTEXITCODE
}

$pushUrl = $plain
if ($Token) {
  $Token = $Token.Trim()
  if ($Token -notmatch '^(ghp_|github_pat_)') { Write-Host '  [!] this does not look like a GitHub token (ghp_ / github_pat_)' -ForegroundColor Yellow }
  $bare = $plain -replace '^https://', ''
  $pushUrl = 'https://' + $Owner + ':' + $Token + '@' + $bare
}

Write-Host '  pushing (this can take a while) ...' -ForegroundColor Cyan
$code = Invoke-GitPush $pushUrl ''
if ($code -ne 0) {
  Write-Host '  [!] first attempt failed, retrying with the OpenSSL TLS backend' -ForegroundColor Yellow
  $code = Invoke-GitPush $pushUrl 'openssl'
}

# 无论成败，都不把 token 留在配置里
git remote set-url origin $plain 2>$null | Out-Null

Write-Host ''
if ($code -eq 0) {
  Write-Host ("Done: https://github.com/$Owner/$Repo") -ForegroundColor Green
  exit 0
}
Write-Host 'Push failed.' -ForegroundColor Red
Write-Host '  - Repository missing? Create it on GitHub first (https://github.com/new).'
Write-Host '  - Authentication failed? Re-run with a token:  ./scripts/publish-to-github.ps1 -Token ghp_xxx'
Write-Host '  - Private repo or HTTPS blocked? Use SSH:  git remote set-url origin git@github.com:' + $Owner + '/' + $Repo + '.git'
exit $code
