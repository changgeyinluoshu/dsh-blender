<#
.SYNOPSIS
  Remove the DSH Blender Bridge add-on from Blender's user add-on folder.
#>
[CmdletBinding()]
param(
  [string]$AddonsDir = ''
)
$ErrorActionPreference = 'Stop'
$AddonName = 'dsh_blender_bridge'
$root = Join-Path $env:APPDATA 'Blender Foundation\Blender'
$targets = @()
if ($AddonsDir) { $targets += (Join-Path $AddonsDir $AddonName) }
elseif (Test-Path -LiteralPath $root) {
  Get-ChildItem -LiteralPath $root -Directory | ForEach-Object { $targets += (Join-Path $_.FullName "scripts\addons\$AddonName") }
}
$removed = 0
foreach ($target in $targets) {
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force; Write-Host "  [OK] removed $target" -ForegroundColor Green; $removed++ }
}
if ($removed -eq 0) { Write-Host '  [!] no installed add-on found' -ForegroundColor Yellow }
