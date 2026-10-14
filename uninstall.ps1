<#
.SYNOPSIS
  Remove dsh-blender-studio from a DSH profile.

.DESCRIPTION
  Undoes install.ps1: removes the managed block from cordis.patch.yml and deletes the
  node_modules junction. The Blender add-on is kept unless -RemoveAddon is given.

.EXAMPLE
  ./uninstall.ps1
.EXAMPLE
  ./uninstall.ps1 -RemoveAddon
#>
[CmdletBinding()]
param(
  [string]$ProfilePath = '',
  [switch]$RemoveAddon
)

$ErrorActionPreference = 'Stop'
$PluginName = 'dsh-blender-studio'
$ScriptDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($ScriptDir)) {
  $CommandPath = $MyInvocation.MyCommand.Path
  if (-not [string]::IsNullOrEmpty($CommandPath)) { $ScriptDir = Split-Path -Parent $CommandPath }
}
if ([string]::IsNullOrEmpty($ScriptDir)) { $ScriptDir = (Get-Location).Path }
$Begin = '# >>> dsh-blender-studio managed block >>>'
$End = '# <<< dsh-blender-studio managed block <<<'

function Resolve-ProfilePath {
  if ($ProfilePath) { return (Resolve-Path -LiteralPath $ProfilePath).Path }
  if ($env:DSH_PROFILE_DIR -and (Test-Path -LiteralPath $env:DSH_PROFILE_DIR)) { return (Resolve-Path -LiteralPath $env:DSH_PROFILE_DIR).Path }
  $candidates = @()
  if ($env:DSH_HOME) { $candidates += (Join-Path $env:DSH_HOME 'profiles\desktop') }
  if ($env:USERPROFILE) { $candidates += (Join-Path $env:USERPROFILE '.dsh-beta\profiles\desktop') }
  foreach ($candidate in $candidates) { if (Test-Path -LiteralPath $candidate) { return (Resolve-Path -LiteralPath $candidate).Path } }
  throw 'Cannot find a DSH profile. Pass -ProfilePath explicitly.'
}

$profile = Resolve-ProfilePath
Write-Host ''
Write-Host "Removing $PluginName from $profile" -ForegroundColor White

$patchFile = Join-Path $profile 'cordis.patch.yml'
if (Test-Path -LiteralPath $patchFile) {
  $text = [System.IO.File]::ReadAllText($patchFile)
  if ($text.Contains($Begin) -and $text.Contains($End)) {
    Copy-Item -LiteralPath $patchFile -Destination "$patchFile.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$PluginName-remove" -Force
    $pattern = '(?s)\r?\n?' + [regex]::Escape($Begin) + '.*?' + [regex]::Escape($End)
    $text = [regex]::Replace($text, $pattern, '')
    [System.IO.File]::WriteAllText($patchFile, $text, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host '  [OK] managed block removed from cordis.patch.yml' -ForegroundColor Green
  } else {
    Write-Host '  [!] no managed block found - nothing to do there' -ForegroundColor Yellow
  }
}

$link = Join-Path (Join-Path $profile 'node_modules') $PluginName
if (Test-Path -LiteralPath $link) {
  $item = Get-Item -LiteralPath $link -Force
  # 目录联接只删链接本身，绝不递归删除目标（否则会删掉插件仓库）
  if ($item.LinkType) {
    try { $item.Delete() } catch { cmd /c rmdir "$link" | Out-Null }
  } else {
    Remove-Item -LiteralPath $link -Recurse -Force
  }
  Write-Host "  [OK] removed $link" -ForegroundColor Green
} else {
  Write-Host '  [!] node_modules link not present' -ForegroundColor Yellow
}

if ($RemoveAddon) {
  $addonScript = Join-Path $ScriptDir 'addon\uninstall-addon.ps1'
  if (Test-Path -LiteralPath $addonScript) { & $addonScript }
  else { Write-Host '  [!] addon/uninstall-addon.ps1 not found' -ForegroundColor Yellow }
}

Write-Host ''
Write-Host 'Restart DSH to unload the plugin.' -ForegroundColor White
