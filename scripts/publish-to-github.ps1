<#
.SYNOPSIS
  Publish this repository to GitHub (first push).

.DESCRIPTION
  Initialises a git repository if needed, commits everything, sets the remote and pushes.
  Requires the GitHub CLI (gh) for creating the remote repository, or pass an existing -Remote URL.

.EXAMPLE
  ./scripts/publish-to-github.ps1 -Owner my-name -Repo dsh-blender-studio -Public
.EXAMPLE
  ./scripts/publish-to-github.ps1 -Remote https://github.com/me/dsh-blender-studio.git
#>
[CmdletBinding()]
param(
  [string]$Owner = '',
  [string]$Repo = 'dsh-blender-studio',
  [string]$Remote = '',
  [string]$Message = 'dsh-blender-studio 0.1.0',
  [switch]$Public
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location -LiteralPath $Root

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is required.' }
if (-not (Test-Path -LiteralPath '.git')) {
  git init -b main | Out-Null
  Write-Host '  [OK] git repository initialised' -ForegroundColor Green
}

# 让占位符不会跟着一起发布
$placeholder = 'OWNER'
if (-not $Owner) { $Owner = $placeholder }
Write-Host "  publishing as: $Owner/$Repo"

git add -A
$dirty = (git status --porcelain)
if ($dirty) {
  git -c user.name='dsh-blender-studio' -c user.email='noreply@example.com' commit -m $Message | Out-Null
  Write-Host '  [OK] committed' -ForegroundColor Green
} else {
  Write-Host '  [i] nothing to commit' -ForegroundColor Yellow
}

$remoteUrl = $Remote
if (-not $remoteUrl) { $remoteUrl = "https://github.com/$Owner/$Repo.git" }
$existing = (git remote)
if ($existing -contains 'origin') { git remote set-url origin $remoteUrl } else { git remote add origin $remoteUrl }
Write-Host "  [OK] remote origin -> $remoteUrl" -ForegroundColor Green

if ($Owner -ne $placeholder -and (Get-Command gh -ErrorAction SilentlyContinue)) {
  $visibility = if ($Public) { '--public' } else { '--private' }
  gh repo view "$Owner/$Repo" 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    gh repo create "$Owner/$Repo" $visibility --source . --remote origin --push
    Write-Host '  [OK] repository created and pushed' -ForegroundColor Green
    exit 0
  }
}

git push -u origin main
Write-Host ''
Write-Host "Done. Repository: https://github.com/$Owner/$Repo" -ForegroundColor White
