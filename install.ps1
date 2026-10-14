<#
.SYNOPSIS
  Install dsh-blender-studio into a DSH profile (Windows / PowerShell).

.DESCRIPTION
  Three idempotent steps:
    1. Link this repository into <Profile>/node_modules/dsh-blender-studio (directory junction,
       so a later 'git pull' here updates the installed plugin).
    2. Add or refresh a managed block in <Profile>/cordis.patch.yml that loads the plugin.
       The previous file is backed up next to it before any change.
    3. Copy the Blender add-on (addon/dsh_blender_bridge) into the Blender user add-on folder
       (skip with -SkipAddon, or do only this with -AddonOnly).

  Restart DSH afterwards, then enable "DSH Blender Bridge" inside Blender
  (Edit > Preferences > Add-ons).

.EXAMPLE
  ./install.ps1
.EXAMPLE
  ./install.ps1 -ProfilePath "$env:USERPROFILE\.dsh-beta\profiles\desktop" -Port 9880
.EXAMPLE
  ./install.ps1 -AddonOnly -BlenderPath "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"
#>
[CmdletBinding()]
param(
  [string]$ProfilePath = '',
  [string]$BlenderPath = '',
  [int]$Port = 9880,
  [switch]$SkipAddon,
  [switch]$AddonOnly
)

$ErrorActionPreference = 'Stop'
$RepoRoot = $PSScriptRoot
if ([string]::IsNullOrEmpty($RepoRoot)) {
  $CommandPath = $MyInvocation.MyCommand.Path
  if (-not [string]::IsNullOrEmpty($CommandPath)) { $RepoRoot = Split-Path -Parent $CommandPath }
}
if ([string]::IsNullOrEmpty($RepoRoot)) { $RepoRoot = (Get-Location).Path }
$PluginName = 'dsh-blender-studio'
$Begin = '# >>> dsh-blender-studio managed block >>>'
$End = '# <<< dsh-blender-studio managed block <<<'
$NewLine = [char]10

function Write-Step([string]$text) { Write-Host "  $text" -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host "  [OK] $text" -ForegroundColor Green }
function Write-Note([string]$text) { Write-Host "  [!] $text" -ForegroundColor Yellow }

function Resolve-ProfilePath {
  if ($ProfilePath) { return (Resolve-Path -LiteralPath $ProfilePath).Path }
  if ($env:DSH_PROFILE_DIR -and (Test-Path -LiteralPath $env:DSH_PROFILE_DIR)) { return (Resolve-Path -LiteralPath $env:DSH_PROFILE_DIR).Path }
  $candidates = @()
  if ($env:DSH_HOME) { $candidates += (Join-Path $env:DSH_HOME 'profiles\desktop') }
  if ($env:USERPROFILE) {
    $candidates += (Join-Path $env:USERPROFILE '.dsh-beta\profiles\desktop')
    $candidates += (Join-Path $env:USERPROFILE '.dsh\profiles\desktop')
  }
  foreach ($candidate in $candidates) { if (Test-Path -LiteralPath $candidate) { return (Resolve-Path -LiteralPath $candidate).Path } }
  throw 'Cannot find a DSH profile. Pass -ProfilePath explicitly, for example <DSH_HOME>/profiles/desktop.'
}

function Remove-LinkOrDirectory([string]$path) {
  # 目录联接必须只删链接本身：PowerShell 5.1 的 Remove-Item -Recurse 可能跟进目标，
  # 那样会把插件仓库的内容一起删掉。DirectoryInfo.Delete() 只移除重解析点。
  $item = Get-Item -LiteralPath $path -Force
  if ($item.LinkType) {
    try { $item.Delete() } catch { cmd /c rmdir "$path" | Out-Null }
  } else {
    Remove-Item -LiteralPath $path -Recurse -Force
  }
  if (Test-Path -LiteralPath $path) { throw "Failed to remove $path" }
}

function Install-NodeModulesLink([string]$profile) {
  $nodeModules = Join-Path $profile 'node_modules'
  if (-not (Test-Path -LiteralPath $nodeModules)) { New-Item -ItemType Directory -Path $nodeModules | Out-Null }
  $link = Join-Path $nodeModules $PluginName
  if (Test-Path -LiteralPath $link) {
    $item = Get-Item -LiteralPath $link -Force
    $target = [string]$item.Target
    if ($target -is [array]) { $target = [string]$target[0] }
    $same = $false
    if ($target) {
      $normalized = $target
      # Windows PowerShell 5.1 报告的联接目标可能带 Global\ 、\??\ 或 \\?\ 前缀
      if ($normalized.StartsWith('Global\')) { $normalized = $normalized.Substring(7) }
      if ($normalized.StartsWith('\??\')) { $normalized = $normalized.Substring(4) }
      elseif ($normalized.StartsWith('\\?\')) { $normalized = $normalized.Substring(4) }
      try { $normalized = (Resolve-Path -LiteralPath $normalized).Path } catch { }
      $same = ($normalized.TrimEnd('\') -ieq $RepoRoot.TrimEnd('\'))
    }
    if ($same) { Write-Ok 'node_modules link already points here'; return $link }
    Write-Step "Replacing existing entry: $link"
    Remove-LinkOrDirectory $link
  }
  New-Item -ItemType Junction -Path $link -Target $RepoRoot | Out-Null
  Write-Ok "Linked $link -> $RepoRoot"
  return $link
}

function Update-CordisPatch([string]$profile) {
  $patchFile = Join-Path $profile 'cordis.patch.yml'
  if (-not (Test-Path -LiteralPath $patchFile)) {
    New-Item -ItemType File -Path $patchFile | Out-Null
    Write-Note 'cordis.patch.yml did not exist and was created'
  }
  $backup = "$patchFile.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$PluginName"
  Copy-Item -LiteralPath $patchFile -Destination $backup -Force
  Write-Ok "Backed up cordis.patch.yml to $(Split-Path -Leaf $backup)"

  $block = @"
$Begin
# Managed by install.ps1 - change it through the script, not by hand.
- insert:
    - id: blender-studio
      name: $PluginName
      config:
        enabled: true
        host: 127.0.0.1
        port: $Port
$End
"@

  $text = [System.IO.File]::ReadAllText($patchFile)
  if ($text.Contains($Begin) -and $text.Contains($End)) {
    $pattern = [regex]::Escape($Begin) + '(?s).*?' + [regex]::Escape($End)
    $text = [regex]::Replace($text, $pattern, $block)
    Write-Ok 'Refreshed the managed block in cordis.patch.yml'
  } elseif ($text -match ('(?m)^\s*name:\s*[''\"]?' + [regex]::Escape($PluginName) + '[''\"]?\s*$')) {
    Write-Note 'cordis.patch.yml already references the plugin outside the managed block - left untouched'
    return
  } else {
    if ($text.Length -gt 0 -and -not $text.EndsWith($NewLine)) { $text += $NewLine }
    $text += $NewLine + $block + $NewLine
    Write-Ok 'Added the managed block to cordis.patch.yml'
  }
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($patchFile, $text, $utf8NoBom)
}

Write-Host ''
Write-Host 'dsh-blender-studio installer' -ForegroundColor White
Write-Host "  repository : $RepoRoot"

if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'lib\index.js'))) {
  throw "This script must live next to the plugin sources (lib/index.js not found under $RepoRoot)."
}

if (-not $AddonOnly) {
  $profile = Resolve-ProfilePath
  Write-Host "  profile    : $profile"
  Write-Host ''
  Write-Step 'Step 1/3 - link the plugin into the profile'
  Install-NodeModulesLink $profile | Out-Null
  Write-Step 'Step 2/3 - register the plugin in cordis.patch.yml'
  Update-CordisPatch $profile
}

if (-not $SkipAddon) {
  Write-Step 'Step 3/3 - install the Blender add-on'
  $addonScript = Join-Path $RepoRoot 'addon\install-addon.ps1'
  if (Test-Path -LiteralPath $addonScript) { & $addonScript -BlenderPath $BlenderPath }
  else { Write-Note 'addon/install-addon.ps1 not found - copy addon/dsh_blender_bridge manually' }
}

Write-Host ''
Write-Host 'Done. Next steps:' -ForegroundColor White
Write-Host '  1. Restart DSH so the plugin loads.'
Write-Host '  2. In Blender: Edit > Preferences > Add-ons > enable "DSH Blender Bridge".'
Write-Host '  3. In DSH call blender_status, or just ask: build a table in Blender.'
Write-Host ''
