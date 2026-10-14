<#
.SYNOPSIS
  Copy the bundled Blender add-on (dsh_blender_bridge) into Blender's user add-on folder.

.DESCRIPTION
  Finds Blender (argument, environment, PATH, then common install folders), works out the
  matching user add-on directory, and copies the add-on over any older copy.
  Blender 4.2+ users can instead use Blender's own 'Install from Disk' with the zip produced
  by 'npm run pack:addon'.

.EXAMPLE
  ./install-addon.ps1
.EXAMPLE
  ./install-addon.ps1 -BlenderPath "D:\steam\steamapps\common\Blender\blender.exe" -Enable
.EXAMPLE
  ./install-addon.ps1 -AddonsDir "$env:APPDATA\Blender Foundation\Blender\5.2\scripts\addons"
#>
[CmdletBinding()]
param(
  [string]$BlenderPath = '',
  [string]$AddonsDir = '',
  [switch]$Enable
)

$ErrorActionPreference = 'Stop'
$Source = Join-Path $PSScriptRoot 'dsh_blender_bridge'
$AddonName = 'dsh_blender_bridge'

function Write-Ok([string]$text) { Write-Host "  [OK] $text" -ForegroundColor Green }
function Write-Note([string]$text) { Write-Host "  [!] $text" -ForegroundColor Yellow }

function Find-Blender {
  $candidates = @()
  if ($BlenderPath) { $candidates += $BlenderPath }
  if ($env:DSH_BLENDER_EXECUTABLE) { $candidates += $env:DSH_BLENDER_EXECUTABLE }
  if ($env:BLENDER_EXECUTABLE) { $candidates += $env:BLENDER_EXECUTABLE }
  $onPath = Get-Command blender -ErrorAction SilentlyContinue
  if ($onPath) { $candidates += $onPath.Source }
  $roots = @()
  if ($env:ProgramFiles) { $roots += (Join-Path $env:ProgramFiles 'Blender Foundation') }
  if (${env:ProgramFiles(x86)}) { $roots += (Join-Path ${env:ProgramFiles(x86)} 'Blender Foundation') }
  $roots += @('D:\Program Files\Blender Foundation', 'D:\Blender', 'D:\steam\steamapps\common', 'D:\SteamLibrary\steamapps\common', 'C:\Program Files (x86)\Steam\steamapps\common')
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $direct = Join-Path $root 'blender.exe'
    if (Test-Path -LiteralPath $direct) { $candidates += $direct }
    Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | ForEach-Object {
      $nested = Join-Path $_.FullName 'blender.exe'
      if (Test-Path -LiteralPath $nested) { $candidates += $nested }
    }
  }
  foreach ($candidate in $candidates) { if ($candidate -and (Test-Path -LiteralPath $candidate)) { return (Resolve-Path -LiteralPath $candidate).Path } }
  return $null
}

function Get-BlenderShortVersion([string]$exe) {
  try {
    $first = (& $exe --version 2>$null | Select-Object -First 1)
    if ($first -match '([0-9]+\.[0-9]+)') { return $Matches[1] }
  } catch { }
  return $null
}

function Resolve-AddonsDir([string]$shortVersion) {
  if ($AddonsDir) { return $AddonsDir }
  $root = Join-Path $env:APPDATA 'Blender Foundation\Blender'
  if (-not (Test-Path -LiteralPath $root)) {
    if (-not $shortVersion) { throw 'Blender was not found and no -AddonsDir was given. Install Blender first or pass -AddonsDir.' }
    return (Join-Path $root "$shortVersion\scripts\addons")
  }
  $versions = Get-ChildItem -LiteralPath $root -Directory | Sort-Object Name -Descending
  if ($shortVersion) {
    $match = $versions | Where-Object { $_.Name -eq $shortVersion } | Select-Object -First 1
    if ($match) { return (Join-Path $match.FullName 'scripts\addons') }
  }
  if ($versions.Count -gt 0) { return (Join-Path $versions[0].FullName 'scripts\addons') }
  if ($shortVersion) { return (Join-Path $root "$shortVersion\scripts\addons") }
  throw 'No Blender version folder found under the user config. Pass -AddonsDir explicitly.'
}

if (-not (Test-Path -LiteralPath $Source)) { throw "Add-on sources not found: $Source" }

$exe = Find-Blender
$shortVersion = if ($exe) { Get-BlenderShortVersion $exe } else { $null }
if ($exe) { Write-Host "  blender    : $exe (version $shortVersion)" }
else { Write-Note 'Blender executable not found - using the newest user add-on folder' }

$target = Resolve-AddonsDir $shortVersion
$targetPlugin = Join-Path $target $AddonName
New-Item -ItemType Directory -Path $target -Force | Out-Null
if (Test-Path -LiteralPath $targetPlugin) { Remove-Item -LiteralPath $targetPlugin -Recurse -Force }
Copy-Item -LiteralPath $Source -Destination $targetPlugin -Recurse -Force
Get-ChildItem -LiteralPath $targetPlugin -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -LiteralPath $targetPlugin -Recurse -File -Include '*.pyc' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Write-Ok "Add-on installed: $targetPlugin"

if ($Enable -and $exe) {
  $expr = "import addon_utils,bpy;addon_utils.enable('$AddonName',default_set=True);bpy.ops.wm.save_userpref();print('DSH_ADDON_ENABLED')"
  # Blender 会把日志写到 stderr，Stop 模式下 2>&1 管道会误判成致命错误。
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = & $exe --background --python-expr $expr 2>&1 | Out-String
  $ErrorActionPreference = $previousPreference
  if ($output -match 'DSH_ADDON_ENABLED') { Write-Ok 'Add-on enabled in Blender user preferences' }
  else { Write-Note 'Could not confirm the automatic enable - tick it manually in Blender' }
}

Write-Host ''
Write-Host 'Next: open Blender > Edit > Preferences > Add-ons, search for "DSH Blender Bridge" and tick it.'
Write-Host 'The bridge then listens on 127.0.0.1:9880; its status is shown in the 3D viewport sidebar (N) under the DSH tab.'
